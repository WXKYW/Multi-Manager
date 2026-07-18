#[cfg(target_os = "windows")]
mod windows_impl {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;

    use bytes::Bytes;
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
    use rand::random;
    use rtp::codecs::h264::H264Payloader;
    use rtp::header::Header;
    use rtp::packet::Packet;
    use rtp::packetizer::Payloader;
    use serde::Deserialize;
    use serde_json::{json, Value};
    use webrtc::api::interceptor_registry::register_default_interceptors;
    use webrtc::api::media_engine::MediaEngine;
    use webrtc::api::APIBuilder;
    use webrtc::data_channel::data_channel_message::DataChannelMessage;
    use webrtc::data_channel::RTCDataChannel;
    use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
    use webrtc::ice_transport::ice_server::RTCIceServer;
    use webrtc::interceptor::registry::Registry;
    use webrtc::peer_connection::configuration::RTCConfiguration;
    use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
    use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
    use webrtc::peer_connection::RTCPeerConnection;
    use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
    use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
    use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
    use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
    use win_native_media::capture::{self, CaptureConfig};
    use win_native_media::encoder::mf_h264::MfH264Encoder;
    use win_native_media::{CaptureTarget, VideoConfig};
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::System::ProcessStatus::K32EmptyWorkingSet;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    use windows_sys::Win32::UI::Input::Pointer::{
        InitializeTouchInjection, InjectTouchInput, POINTER_FLAG_CANCELED, POINTER_FLAG_DOWN,
        POINTER_FLAG_INCONTACT, POINTER_FLAG_INRANGE, POINTER_FLAG_UP, POINTER_FLAG_UPDATE,
        POINTER_TOUCH_INFO, TOUCH_FEEDBACK_DEFAULT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        PT_TOUCH, TOUCH_MASK_CONTACTAREA, TOUCH_MASK_ORIENTATION, TOUCH_MASK_PRESSURE,
    };

    use crate::protocol::{format_event, EVENT_AGENT_REMOTE_DESKTOP_SIGNAL};
    use crate::OutboundQueues;

    const TARGET_FPS: u32 = 60;
    const KEYFRAME_INTERVAL: u32 = 60;
    const ENCODED_QUEUE_DEPTH: usize = 1;
    const RTP_CLOCK_RATE: u128 = 90_000;
    const RTP_PACKET_MTU: usize = 1_200;
    const RTP_HEADER_SIZE: usize = 12;
    const PEER_DISCONNECT_GRACE: Duration = Duration::from_secs(5);
    const WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

    #[derive(Debug, Deserialize)]
    pub struct StartPayload {
        pub session_id: String,
        pub offer: RTCSessionDescription,
        #[serde(default)]
        pub ice_servers: Vec<IceServerPayload>,
    }

    #[derive(Debug, Deserialize)]
    pub struct IceServerPayload {
        #[serde(default)]
        pub urls: Vec<String>,
        #[serde(default)]
        pub username: String,
        #[serde(default)]
        pub credential: String,
    }

    #[derive(Debug, Deserialize)]
    pub struct SignalPayload {
        pub session_id: String,
        pub signal: Value,
    }

    #[derive(Debug, Deserialize)]
    pub struct StopPayload {
        pub session_id: String,
    }

    struct Session {
        peer: Arc<RTCPeerConnection>,
        stop: Arc<AtomicBool>,
        worker: Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
        enigo: Arc<Mutex<Option<Enigo>>>,
        touch_contact: Arc<Mutex<Option<ActiveTouchContact>>>,
    }

    #[derive(Clone, Copy)]
    enum ActiveTouchContact {
        Native { x: i32, y: i32 },
        Mouse,
    }

    #[derive(Clone, Copy, Default)]
    struct DesktopGeometry {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct StreamProfile {
        fps: u32,
        bitrate: u32,
    }

    impl Default for StreamProfile {
        fn default() -> Self {
            Self {
                fps: 30,
                bitrate: 6_000_000,
            }
        }
    }

    struct EncodedVideoSample {
        data: Vec<u8>,
        timestamp: Duration,
    }

    fn enqueue_encoded_sample(
        tx: &tokio::sync::mpsc::Sender<EncodedVideoSample>,
        sample: EncodedVideoSample,
    ) -> bool {
        match tx.try_send(sample) {
            Ok(()) | Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => true,
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    #[derive(Default)]
    pub struct RemoteDesktopManager {
        sessions: Arc<tokio::sync::Mutex<HashMap<String, Session>>>,
    }

    impl RemoteDesktopManager {
        pub fn new() -> Self {
            Self::default()
        }

        pub async fn start(
            &self,
            payload: StartPayload,
            outbound: OutboundQueues,
        ) -> Result<(), String> {
            self.stop_all().await;

            let mut media_engine = MediaEngine::default();
            media_engine
                .register_default_codecs()
                .map_err(|err| format!("register WebRTC codecs: {err}"))?;
            let registry = register_default_interceptors(Registry::new(), &mut media_engine)
                .map_err(|err| format!("register WebRTC RTP feedback: {err}"))?;
            let api = APIBuilder::new()
                .with_media_engine(media_engine)
                .with_interceptor_registry(registry)
                .build();
            let ice_servers = payload
                .ice_servers
                .into_iter()
                .map(|item| RTCIceServer {
                    urls: item.urls,
                    username: item.username,
                    credential: item.credential,
                    ..Default::default()
                })
                .collect();
            let peer = Arc::new(
                api.new_peer_connection(RTCConfiguration {
                    ice_servers,
                    ..Default::default()
                })
                .await
                .map_err(|err| format!("create WebRTC peer: {err}"))?,
            );
            let stop = Arc::new(AtomicBool::new(false));
            let worker = Arc::new(tokio::sync::Mutex::new(None));
            let stream_started = Arc::new(AtomicBool::new(false));
            let force_keyframe = Arc::new(AtomicBool::new(false));
            let geometry = Arc::new(Mutex::new(DesktopGeometry::default()));
            let stream_profile = Arc::new(Mutex::new(StreamProfile::default()));
            let enigo = Arc::new(Mutex::new(Enigo::new(&Settings::default()).ok()));
            let touch_contact = Arc::new(Mutex::new(None));
            let video_track = Arc::new(TrackLocalStaticRTP::new(
                RTCRtpCodecCapability {
                    mime_type: "video/H264".to_owned(),
                    clock_rate: 90_000,
                    sdp_fmtp_line:
                        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                            .to_owned(),
                    ..Default::default()
                },
                "desktop".to_owned(),
                "api-monitor".to_owned(),
            ));
            let rtp_sender = peer
                .add_track(video_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .map_err(|err| format!("add H.264 video track: {err}"))?;
            let force_keyframe_for_rtcp = force_keyframe.clone();
            tokio::spawn(async move {
                while let Ok((packets, _)) = rtp_sender.read_rtcp().await {
                    if packets.iter().any(|packet| {
                        packet
                            .as_any()
                            .downcast_ref::<PictureLossIndication>()
                            .is_some()
                    }) {
                        force_keyframe_for_rtcp.store(true, Ordering::Release);
                    }
                }
            });

            let session_id_for_ice = payload.session_id.clone();
            let outbound_for_ice = outbound.clone();
            peer.on_ice_candidate(Box::new(move |candidate| {
                let session_id = session_id_for_ice.clone();
                let outbound = outbound_for_ice.clone();
                Box::pin(async move {
                    let Some(candidate) = candidate else { return };
                    if let Ok(candidate) = candidate.to_json() {
                        emit_signal(
                            &outbound,
                            &session_id,
                            Some(json!({
                                "kind": "ice",
                                "candidate": candidate,
                            })),
                            None,
                        )
                        .await;
                    }
                })
            }));

            let sessions_for_peer_state = self.sessions.clone();
            let session_id_for_peer_state = payload.session_id.clone();
            peer.on_peer_connection_state_change(Box::new(move |state| {
                let sessions = sessions_for_peer_state.clone();
                let session_id = session_id_for_peer_state.clone();
                Box::pin(async move {
                    let Some(delay) = peer_shutdown_delay(state) else {
                        return;
                    };
                    tokio::spawn(async move {
                        if !delay.is_zero() {
                            tokio::time::sleep(delay).await;
                        }
                        let should_shutdown = {
                            let sessions = sessions.lock().await;
                            sessions.get(&session_id).is_some_and(|session| {
                                matches!(
                                    session.peer.connection_state(),
                                    RTCPeerConnectionState::Disconnected
                                        | RTCPeerConnectionState::Failed
                                        | RTCPeerConnectionState::Closed
                                )
                            })
                        };
                        if should_shutdown {
                            remove_and_shutdown_session(&sessions, &session_id).await;
                        }
                    });
                })
            }));

            let session_id_for_channel = payload.session_id.clone();
            let outbound_for_channel = outbound.clone();
            let stop_for_channel = stop.clone();
            let stream_started_for_channel = stream_started.clone();
            let force_keyframe_for_channel = force_keyframe.clone();
            let geometry_for_channel = geometry.clone();
            let profile_for_channel = stream_profile.clone();
            let enigo_for_channel = enigo.clone();
            let touch_contact_for_channel = touch_contact.clone();
            let track_for_channel = video_track.clone();
            let worker_for_channel = worker.clone();
            let sessions_for_channel = self.sessions.clone();
            peer.on_data_channel(Box::new(move |channel: Arc<RTCDataChannel>| {
                let reliable = channel.label() == "remote-desktop";
                if !reliable && channel.label() != "remote-pointer" {
                    return Box::pin(async {});
                }
                let session_id = session_id_for_channel.clone();
                let outbound = outbound_for_channel.clone();
                let stop = stop_for_channel.clone();
                let stream_started = stream_started_for_channel.clone();
                let force_keyframe = force_keyframe_for_channel.clone();
                let geometry = geometry_for_channel.clone();
                let profile = profile_for_channel.clone();
                let enigo = enigo_for_channel.clone();
                let touch_contact = touch_contact_for_channel.clone();
                let video_track = track_for_channel.clone();
                let worker = worker_for_channel.clone();
                let sessions = sessions_for_channel.clone();
                Box::pin(async move {
                    let input_enigo = enigo.clone();
                    let input_geometry = geometry.clone();
                    let input_profile = profile.clone();
                    let input_touch_contact = touch_contact.clone();
                    let input_ack_channel = channel.clone();
                    let input_ack_sent = Arc::new(AtomicBool::new(false));
                    channel.on_message(Box::new(move |message: DataChannelMessage| {
                        let enigo = input_enigo.clone();
                        let geometry = input_geometry.clone();
                        let profile = input_profile.clone();
                        let touch_contact = input_touch_contact.clone();
                        let ack_channel = input_ack_channel.clone();
                        let ack_sent = input_ack_sent.clone();
                        Box::pin(async move {
                            if message.is_string {
                                if let Ok(value) = serde_json::from_slice::<Value>(&message.data) {
                                    let pointer_sequence = pointer_message_sequence(&value);
                                    if handle_channel_message(
                                        value,
                                        &enigo,
                                        &geometry,
                                        &profile,
                                        &touch_contact,
                                    ) {
                                        if let Some(sequence) = pointer_sequence {
                                            if let Some(position) = pointer_position_message(
                                                &enigo, &geometry, sequence,
                                            ) {
                                                let _ = ack_channel.send_text(position).await;
                                            }
                                        } else if !ack_sent.swap(true, Ordering::Relaxed) {
                                            let _ = ack_channel
                                                .send_text(json!({"type": "input-ack"}).to_string())
                                                .await;
                                        }
                                    }
                                }
                            }
                        })
                    }));

                    if !reliable {
                        return;
                    }

                    let frame_stop = stop.clone();
                    let frame_started = stream_started.clone();
                    let frame_geometry = geometry.clone();
                    let frame_session_id = session_id.clone();
                    let frame_outbound = outbound.clone();
                    let frame_track = video_track.clone();
                    let frame_force_keyframe = force_keyframe.clone();
                    let frame_worker = worker.clone();
                    channel.on_open(Box::new(move || {
                        let stop = frame_stop.clone();
                        let started = frame_started.clone();
                        let geometry = frame_geometry.clone();
                        let session_id = frame_session_id.clone();
                        let outbound = frame_outbound.clone();
                        let track = frame_track.clone();
                        let force_keyframe = frame_force_keyframe.clone();
                        let worker = frame_worker.clone();
                        Box::pin(async move {
                            emit_signal(&outbound, &session_id, None, Some("connected")).await;
                            if !started.swap(true, Ordering::SeqCst) {
                                let handle = tokio::spawn(stream_desktop(
                                    track,
                                    stop.clone(),
                                    geometry,
                                    profile,
                                    force_keyframe,
                                    outbound,
                                    session_id,
                                ));
                                let mut worker_slot = worker.lock().await;
                                if stop.load(Ordering::Acquire) {
                                    drop(worker_slot);
                                    handle.abort();
                                } else {
                                    *worker_slot = Some(handle);
                                }
                            }
                        })
                    }));

                    let close_stop = stop.clone();
                    let close_session_id = session_id.clone();
                    let close_outbound = outbound.clone();
                    let close_sessions = sessions.clone();
                    channel.on_close(Box::new(move || {
                        let stop = close_stop.clone();
                        let session_id = close_session_id.clone();
                        let outbound = close_outbound.clone();
                        let sessions = close_sessions.clone();
                        Box::pin(async move {
                            stop.store(true, Ordering::Relaxed);
                            emit_signal(&outbound, &session_id, None, Some("closed")).await;
                            remove_and_shutdown_session(&sessions, &session_id).await;
                        })
                    }));
                })
            }));

            self.sessions.lock().await.insert(
                payload.session_id.clone(),
                Session {
                    peer: peer.clone(),
                    stop,
                    worker,
                    enigo,
                    touch_contact,
                },
            );

            let negotiation = async {
                peer.set_remote_description(payload.offer)
                    .await
                    .map_err(|err| format!("set WebRTC offer: {err}"))?;
                let answer = peer
                    .create_answer(None)
                    .await
                    .map_err(|err| format!("create WebRTC answer: {err}"))?;
                peer.set_local_description(answer)
                    .await
                    .map_err(|err| format!("set WebRTC answer: {err}"))?;
                peer.local_description()
                    .await
                    .ok_or_else(|| "WebRTC local answer missing".to_string())
            }
            .await;
            let answer = match negotiation {
                Ok(answer) => answer,
                Err(error) => {
                    self.stop(&payload.session_id).await;
                    return Err(error);
                }
            };
            emit_signal(
                &outbound,
                &payload.session_id,
                Some(json!({"kind": "answer", "sdp": answer})),
                Some("signaling"),
            )
            .await;
            Ok(())
        }

        pub async fn signal(&self, payload: SignalPayload) -> Result<(), String> {
            let peer = {
                let sessions = self.sessions.lock().await;
                sessions
                    .get(&payload.session_id)
                    .map(|session| session.peer.clone())
                    .ok_or_else(|| "remote desktop session not found".to_string())?
            };
            if payload.signal.get("kind").and_then(Value::as_str) == Some("ice") {
                let candidate: RTCIceCandidateInit = serde_json::from_value(
                    payload
                        .signal
                        .get("candidate")
                        .cloned()
                        .unwrap_or(Value::Null),
                )
                .map_err(|err| format!("invalid ICE candidate: {err}"))?;
                peer.add_ice_candidate(candidate)
                    .await
                    .map_err(|err| format!("add ICE candidate: {err}"))?;
            }
            Ok(())
        }

        pub async fn stop(&self, session_id: &str) {
            remove_and_shutdown_session(&self.sessions, session_id).await;
        }

        async fn stop_all(&self) {
            let sessions = {
                let mut sessions = self.sessions.lock().await;
                sessions
                    .drain()
                    .map(|(_, session)| session)
                    .collect::<Vec<_>>()
            };
            for session in sessions {
                shutdown_session(session).await;
            }
        }
    }

    fn peer_shutdown_delay(state: RTCPeerConnectionState) -> Option<Duration> {
        match state {
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => Some(Duration::ZERO),
            RTCPeerConnectionState::Disconnected => Some(PEER_DISCONNECT_GRACE),
            _ => None,
        }
    }

    async fn remove_and_shutdown_session(
        sessions: &Arc<tokio::sync::Mutex<HashMap<String, Session>>>,
        session_id: &str,
    ) {
        let session = sessions.lock().await.remove(session_id);
        if let Some(session) = session {
            shutdown_session(session).await;
        }
    }

    async fn shutdown_session(session: Session) {
        session.stop.store(true, Ordering::Release);
        release_active_touch(&session.touch_contact, &session.enigo);
        let _ = session.peer.close().await;
        if let Some(mut worker) = session.worker.lock().await.take() {
            if tokio::time::timeout(WORKER_SHUTDOWN_TIMEOUT, &mut worker)
                .await
                .is_err()
            {
                worker.abort();
                let _ = worker.await;
            }
        }
        // Media Foundation and D3D keep released frame pages resident for
        // reuse. Once the capture worker is fully gone, return those pages to
        // Windows so the Agent's active working set drops after disconnect.
        unsafe {
            let _ = K32EmptyWorkingSet(GetCurrentProcess());
        }
    }

    async fn emit_signal(
        outbound: &OutboundQueues,
        session_id: &str,
        signal: Option<Value>,
        state: Option<&str>,
    ) {
        let payload = json!({
            "session_id": session_id,
            "signal": signal,
            "state": state,
        });
        let _ = outbound
            .send_normal(format_event(EVENT_AGENT_REMOTE_DESKTOP_SIGNAL, &payload))
            .await;
    }

    async fn stream_desktop(
        track: Arc<TrackLocalStaticRTP>,
        stop: Arc<AtomicBool>,
        geometry: Arc<Mutex<DesktopGeometry>>,
        profile: Arc<Mutex<StreamProfile>>,
        force_keyframe: Arc<AtomicBool>,
        outbound: OutboundQueues,
        session_id: String,
    ) {
        let (sample_tx, mut sample_rx) = tokio::sync::mpsc::channel(ENCODED_QUEUE_DEPTH);
        let capture_stop = stop.clone();
        let capture_geometry = geometry.clone();
        let capture_profile = profile.clone();
        let encoder_task = tokio::task::spawn_blocking(move || {
            capture_and_encode(
                capture_stop,
                capture_geometry,
                capture_profile,
                force_keyframe,
                sample_tx,
            )
        });

        let timestamp_base = random::<u32>();
        let mut sequence_number = random::<u16>();
        let mut payloader = H264Payloader::default();
        while !stop.load(Ordering::Relaxed) {
            let Some(encoded) = sample_rx.recv().await else {
                break;
            };
            let timestamp = capture_timestamp_to_rtp(timestamp_base, encoded.timestamp);
            let packets = match packetize_h264_access_unit(
                &mut payloader,
                &mut sequence_number,
                timestamp,
                Bytes::from(encoded.data),
            ) {
                Ok(packets) => packets,
                Err(_) => break,
            };
            for packet in packets {
                if track.write_rtp(&packet).await.is_err() {
                    stop.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }

        stop.store(true, Ordering::Relaxed);
        // Closing the receiver guarantees the capture worker can observe
        // shutdown even if it is concurrently publishing the final frame.
        drop(sample_rx);
        match encoder_task.await {
            Ok(Ok(())) => {}
            Ok(Err(message)) => {
                emit_signal(
                    &outbound,
                    &session_id,
                    Some(json!({"kind": "error", "message": message})),
                    Some("error"),
                )
                .await;
            }
            Err(err) => {
                emit_signal(
                    &outbound,
                    &session_id,
                    Some(
                        json!({"kind": "error", "message": format!("video worker stopped: {err}")}),
                    ),
                    Some("error"),
                )
                .await;
            }
        }
    }

    fn capture_and_encode(
        stop: Arc<AtomicBool>,
        geometry: Arc<Mutex<DesktopGeometry>>,
        profile: Arc<Mutex<StreamProfile>>,
        force_keyframe: Arc<AtomicBool>,
        sample_tx: tokio::sync::mpsc::Sender<EncodedVideoSample>,
    ) -> Result<(), String> {
        let (session, frames) = capture::start(
            CaptureConfig {
                target: CaptureTarget::Monitor(0),
                capture_cursor: true,
            },
            1,
        )
        .map_err(|err| format!("start Windows Graphics Capture: {err}"))?;
        if let Ok((x, y, width, height)) = capture::monitor_geometry(0) {
            if let Ok(mut current) = geometry.lock() {
                *current = DesktopGeometry {
                    x,
                    y,
                    width,
                    height,
                };
            }
        }

        let mut encoder: Option<MfH264Encoder> = None;
        let mut encoded_size = (0, 0);
        let mut encoded_profile = StreamProfile::default();
        let mut last_encoded_timestamp = Duration::ZERO;
        while !stop.load(Ordering::Relaxed) {
            let frame = match frames.recv_timeout(Duration::from_millis(250)) {
                Ok(frame) => frame,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Windows Graphics Capture stopped unexpectedly".to_string())
                }
            };
            if frame.width == 0 || frame.height == 0 {
                continue;
            }
            if let Ok(mut current) = geometry.lock() {
                current.width = frame.width;
                current.height = frame.height;
            }

            let desired_profile = profile.lock().map(|item| *item).unwrap_or_default();
            if !should_encode_next_frame(
                last_encoded_timestamp,
                frame.timestamp,
                desired_profile.fps,
                sample_tx.capacity() > 0,
            ) {
                continue;
            }
            last_encoded_timestamp = frame.timestamp;

            if encoder.is_none()
                || encoded_size != (frame.width, frame.height)
                || encoded_profile != desired_profile
            {
                let config = video_config(frame.width, frame.height, desired_profile);
                encoder = Some(
                    MfH264Encoder::new(session.device(), config)
                        .map_err(|err| format!("create Media Foundation H.264 encoder: {err}"))?,
                );
                encoded_size = (frame.width, frame.height);
                encoded_profile = desired_profile;
            }

            let mut samples = Vec::new();
            if force_keyframe.swap(false, Ordering::AcqRel) {
                encoder
                    .as_ref()
                    .expect("encoder initialized")
                    .force_keyframe();
            }
            let encode_result = encoder.as_mut().expect("encoder initialized").encode(
                &frame.texture,
                frame.timestamp,
                &mut samples,
            );
            if let Err(encode_error) = encode_result {
                return Err(format!(
                    "Media Foundation H.264 encode failed: {encode_error}"
                ));
            }

            for sample in samples {
                if !enqueue_encoded_sample(
                    &sample_tx,
                    EncodedVideoSample {
                        data: sample.data,
                        timestamp: sample.timestamp,
                    },
                ) {
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    fn video_config(width: u32, height: u32, profile: StreamProfile) -> VideoConfig {
        let pixels = width as u64 * height as u64;
        let native_bitrate = if pixels > 3_686_400 {
            28_000_000
        } else if pixels > 2_073_600 {
            18_000_000
        } else {
            12_000_000
        };
        VideoConfig {
            width,
            height,
            fps: profile.fps.clamp(30, TARGET_FPS),
            bitrate: profile.bitrate.clamp(3_000_000, native_bitrate),
            keyframe_interval: profile.fps.clamp(30, KEYFRAME_INTERVAL),
        }
    }

    fn should_encode_frame(last: Duration, current: Duration, fps: u32) -> bool {
        let target = Duration::from_nanos(1_000_000_000 / fps.clamp(1, TARGET_FPS) as u64);
        // Capture clocks and nominal refresh rates are not exact: a 60 Hz
        // display commonly reports 16.0-16.6 ms deltas. A strict 16.666 ms
        // comparison accidentally discards alternating frames. Keep a narrow
        // tolerance while still allowing 30 FPS profiles to downsample 60 Hz.
        last.is_zero()
            || current.saturating_sub(last) >= target.saturating_sub(Duration::from_millis(2))
    }

    fn should_encode_next_frame(
        last: Duration,
        current: Duration,
        fps: u32,
        queue_has_capacity: bool,
    ) -> bool {
        queue_has_capacity && should_encode_frame(last, current, fps)
    }

    fn capture_timestamp_to_rtp(base: u32, timestamp: Duration) -> u32 {
        let ticks = timestamp.as_nanos().saturating_mul(RTP_CLOCK_RATE) / 1_000_000_000;
        base.wrapping_add(ticks as u32)
    }

    fn packetize_h264_access_unit(
        payloader: &mut H264Payloader,
        sequence_number: &mut u16,
        timestamp: u32,
        access_unit: Bytes,
    ) -> Result<Vec<Packet>, String> {
        let payloads = payloader
            .payload(RTP_PACKET_MTU - RTP_HEADER_SIZE, &access_unit)
            .map_err(|err| format!("packetize H.264 RTP payload: {err}"))?;
        let last = payloads.len().saturating_sub(1);
        Ok(payloads
            .into_iter()
            .enumerate()
            .map(|(index, payload)| {
                let packet = Packet {
                    header: Header {
                        version: 2,
                        marker: index == last,
                        sequence_number: *sequence_number,
                        timestamp,
                        // TrackLocalStaticRTP replaces both values with the
                        // codec negotiated for the active WebRTC binding.
                        payload_type: 0,
                        ssrc: 0,
                        ..Default::default()
                    },
                    payload,
                };
                *sequence_number = sequence_number.wrapping_add(1);
                packet
            })
            .collect())
    }

    fn handle_channel_message(
        value: Value,
        enigo: &Arc<Mutex<Option<Enigo>>>,
        geometry: &Arc<Mutex<DesktopGeometry>>,
        profile: &Arc<Mutex<StreamProfile>>,
        touch_contact: &Arc<Mutex<Option<ActiveTouchContact>>>,
    ) -> bool {
        if value.get("type").and_then(Value::as_str) == Some("video-config") {
            let fps = value
                .get("fps")
                .and_then(Value::as_u64)
                .unwrap_or(TARGET_FPS as u64)
                .clamp(30, TARGET_FPS as u64) as u32;
            let bitrate = value
                .get("bitrate")
                .and_then(Value::as_u64)
                .unwrap_or(12_000_000)
                .clamp(3_000_000, 30_000_000) as u32;
            if let Ok(mut current) = profile.lock() {
                *current = StreamProfile { fps, bitrate };
            }
            return true;
        }
        handle_input(value, enigo, geometry, touch_contact)
    }

    fn handle_input(
        value: Value,
        enigo: &Arc<Mutex<Option<Enigo>>>,
        geometry: &Arc<Mutex<DesktopGeometry>>,
        touch_contact: &Arc<Mutex<Option<ActiveTouchContact>>>,
    ) -> bool {
        let Ok(mut guard) = enigo.lock() else {
            return false;
        };
        let Some(enigo) = guard.as_mut() else {
            return false;
        };
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "pointer" => {
                let geometry = geometry.lock().map(|item| *item).unwrap_or_default();
                let (px, py) = normalized_pointer_position(&value, geometry);
                enigo.move_mouse(px, py, Coordinate::Abs).is_ok()
            }
            "pointer-contact" => {
                let geometry = geometry.lock().map(|item| *item).unwrap_or_default();
                handle_pointer_contact(enigo, &value, geometry)
            }
            "touch-contact" => {
                let geometry = geometry.lock().map(|item| *item).unwrap_or_default();
                handle_touch_contact(enigo, &value, geometry, touch_contact)
            }
            "pointer-relative" => {
                let geometry = geometry.lock().map(|item| *item).unwrap_or_default();
                let (dx, dy) = normalized_pointer_delta(&value, geometry);
                (dx != 0 || dy != 0) && enigo.move_mouse(dx, dy, Coordinate::Rel).is_ok()
            }
            "pointer-query" => true,
            "mouse" => {
                let direction = input_direction(value.get("action").and_then(Value::as_str));
                enigo.button(input_button(&value), direction).is_ok()
            }
            "wheel" => {
                let x = value.get("deltaX").and_then(Value::as_f64).unwrap_or(0.0);
                let y = value.get("deltaY").and_then(Value::as_f64).unwrap_or(0.0);
                let vertical_ok = if y.abs() >= 1.0 {
                    enigo
                        .scroll(
                            (y / 100.0).round().clamp(-12.0, 12.0) as i32,
                            Axis::Vertical,
                        )
                        .is_ok()
                } else {
                    true
                };
                let horizontal_ok = if x.abs() >= 1.0 {
                    enigo
                        .scroll(
                            (x / 100.0).round().clamp(-12.0, 12.0) as i32,
                            Axis::Horizontal,
                        )
                        .is_ok()
                } else {
                    true
                };
                vertical_ok && horizontal_ok
            }
            "key" => {
                let key = browser_key(
                    value.get("key").and_then(Value::as_str).unwrap_or(""),
                    value.get("code").and_then(Value::as_str).unwrap_or(""),
                );
                if let Some(key) = key {
                    enigo
                        .key(
                            key,
                            input_direction(value.get("action").and_then(Value::as_str)),
                        )
                        .is_ok()
                } else {
                    false
                }
            }
            "text" => value
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty() && text.len() <= 4_096)
                .map(|text| enigo.text(text).is_ok())
                .unwrap_or(false),
            _ => false,
        }
    }

    fn normalized_pointer_delta(value: &Value, geometry: DesktopGeometry) -> (i32, i32) {
        let dx = value
            .get("dx")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(-1.0, 1.0);
        let dy = value
            .get("dy")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(-1.0, 1.0);
        (
            (dx * geometry.width.max(1) as f64).round() as i32,
            (dy * geometry.height.max(1) as f64).round() as i32,
        )
    }

    fn normalized_pointer_position(value: &Value, geometry: DesktopGeometry) -> (i32, i32) {
        let x = value
            .get("x")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        let y = value
            .get("y")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        (
            geometry.x + (x * geometry.width.saturating_sub(1) as f64).round() as i32,
            geometry.y + (y * geometry.height.saturating_sub(1) as f64).round() as i32,
        )
    }

    fn pointer_message_sequence(value: &Value) -> Option<u32> {
        matches!(
            value.get("type").and_then(Value::as_str),
            Some("pointer-relative" | "pointer-query")
        )
        .then(|| value.get("sequence").and_then(Value::as_u64).unwrap_or(0) as u32)
    }

    fn input_button(value: &Value) -> Button {
        match value.get("button").and_then(Value::as_u64).unwrap_or(0) {
            1 => Button::Middle,
            2 => Button::Right,
            _ => Button::Left,
        }
    }

    fn handle_pointer_contact(enigo: &mut Enigo, value: &Value, geometry: DesktopGeometry) -> bool {
        let (px, py) = normalized_pointer_position(value, geometry);
        if enigo.move_mouse(px, py, Coordinate::Abs).is_err() {
            return false;
        }
        match value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("move")
        {
            "down" | "press" => enigo.button(input_button(value), Direction::Press).is_ok(),
            "up" | "release" | "cancel" => enigo
                .button(input_button(value), Direction::Release)
                .is_ok(),
            "click" => enigo.button(input_button(value), Direction::Click).is_ok(),
            _ => true,
        }
    }

    fn touch_pointer_flags(action: &str) -> u32 {
        match action {
            "down" | "press" => POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT,
            "up" | "release" => POINTER_FLAG_UP,
            "cancel" => POINTER_FLAG_UP | POINTER_FLAG_CANCELED,
            _ => POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT,
        }
    }

    fn inject_touch_at(action: &str, x: i32, y: i32) -> bool {
        static TOUCH_INJECTION_READY: OnceLock<bool> = OnceLock::new();
        let ready = *TOUCH_INJECTION_READY
            .get_or_init(|| unsafe { InitializeTouchInjection(1, TOUCH_FEEDBACK_DEFAULT) != 0 });
        if !ready {
            return false;
        }
        let mut contact = POINTER_TOUCH_INFO::default();
        contact.pointerInfo.pointerType = PT_TOUCH;
        contact.pointerInfo.pointerId = 1;
        contact.pointerInfo.pointerFlags = touch_pointer_flags(action);
        contact.pointerInfo.ptPixelLocation = POINT { x, y };
        contact.touchMask = TOUCH_MASK_CONTACTAREA | TOUCH_MASK_ORIENTATION | TOUCH_MASK_PRESSURE;
        contact.rcContact = RECT {
            left: x.saturating_sub(2),
            top: y.saturating_sub(2),
            right: x.saturating_add(2),
            bottom: y.saturating_add(2),
        };
        contact.orientation = 90;
        contact.pressure = 32_000;
        unsafe { InjectTouchInput(1, &contact) != 0 }
    }

    fn handle_touch_contact(
        enigo: &mut Enigo,
        value: &Value,
        geometry: DesktopGeometry,
        active_contact: &Arc<Mutex<Option<ActiveTouchContact>>>,
    ) -> bool {
        let action = value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("move");
        let (x, y) = normalized_pointer_position(value, geometry);
        let Ok(mut active) = active_contact.lock() else {
            return false;
        };
        match action {
            "down" | "press" => {
                if let Some(previous) = active.take() {
                    release_touch_mode(previous, enigo);
                }
                if inject_touch_at("down", x, y) {
                    *active = Some(ActiveTouchContact::Native { x, y });
                    true
                } else if handle_pointer_contact(enigo, value, geometry) {
                    *active = Some(ActiveTouchContact::Mouse);
                    true
                } else {
                    false
                }
            }
            "up" | "release" | "cancel" => {
                let Some(previous) = active.take() else {
                    return true;
                };
                match previous {
                    ActiveTouchContact::Native {
                        x: last_x,
                        y: last_y,
                    } => {
                        let released = inject_touch_at(action, x, y);
                        if !released {
                            let _ = inject_touch_at("cancel", last_x, last_y);
                        }
                        released
                    }
                    ActiveTouchContact::Mouse => handle_pointer_contact(enigo, value, geometry),
                }
            }
            _ => match *active {
                Some(ActiveTouchContact::Native { .. }) => {
                    if inject_touch_at("move", x, y) {
                        *active = Some(ActiveTouchContact::Native { x, y });
                        true
                    } else {
                        false
                    }
                }
                Some(ActiveTouchContact::Mouse) => handle_pointer_contact(enigo, value, geometry),
                None => false,
            },
        }
    }

    fn release_touch_mode(contact: ActiveTouchContact, enigo: &mut Enigo) {
        match contact {
            ActiveTouchContact::Native { x, y } => {
                let _ = inject_touch_at("cancel", x, y);
            }
            ActiveTouchContact::Mouse => {
                let _ = enigo.button(Button::Left, Direction::Release);
            }
        }
    }

    fn release_active_touch(
        active_contact: &Arc<Mutex<Option<ActiveTouchContact>>>,
        enigo: &Arc<Mutex<Option<Enigo>>>,
    ) {
        let active = active_contact
            .lock()
            .ok()
            .and_then(|mut contact| contact.take());
        let Some(active) = active else {
            return;
        };
        if let Ok(mut guard) = enigo.lock() {
            if let Some(enigo) = guard.as_mut() {
                release_touch_mode(active, enigo);
            } else if let ActiveTouchContact::Native { x, y } = active {
                let _ = inject_touch_at("cancel", x, y);
            }
        }
    }

    fn pointer_position_message(
        enigo: &Arc<Mutex<Option<Enigo>>>,
        geometry: &Arc<Mutex<DesktopGeometry>>,
        sequence: u32,
    ) -> Option<String> {
        let (x, y) = enigo.lock().ok()?.as_ref()?.location().ok()?;
        let geometry = geometry.lock().ok().map(|item| *item)?;
        let width = geometry.width.saturating_sub(1).max(1) as f64;
        let height = geometry.height.saturating_sub(1).max(1) as f64;
        Some(
            json!({
                "type": "pointer-position",
                "sequence": sequence,
                "x": ((x - geometry.x) as f64 / width).clamp(0.0, 1.0),
                "y": ((y - geometry.y) as f64 / height).clamp(0.0, 1.0),
            })
            .to_string(),
        )
    }

    fn input_direction(action: Option<&str>) -> Direction {
        match action.unwrap_or("") {
            "down" | "press" => Direction::Press,
            "up" | "release" => Direction::Release,
            _ => Direction::Click,
        }
    }

    fn browser_key(key: &str, code: &str) -> Option<Key> {
        Some(match key {
            "Backspace" => Key::Backspace,
            "Tab" => Key::Tab,
            "Enter" => Key::Return,
            "Shift" => Key::Shift,
            "Control" => Key::Control,
            "Alt" => Key::Alt,
            "Meta" => Key::Meta,
            "Escape" => Key::Escape,
            " " => Key::Space,
            "PageUp" => Key::PageUp,
            "PageDown" => Key::PageDown,
            "End" => Key::End,
            "Home" => Key::Home,
            "ArrowLeft" => Key::LeftArrow,
            "ArrowUp" => Key::UpArrow,
            "ArrowRight" => Key::RightArrow,
            "ArrowDown" => Key::DownArrow,
            "Delete" => Key::Delete,
            "F1" => Key::F1,
            "F2" => Key::F2,
            "F3" => Key::F3,
            "F4" => Key::F4,
            "F5" => Key::F5,
            "F6" => Key::F6,
            "F7" => Key::F7,
            "F8" => Key::F8,
            "F9" => Key::F9,
            "F10" => Key::F10,
            "F11" => Key::F11,
            "F12" => Key::F12,
            _ if key.chars().count() == 1 => Key::Unicode(key.chars().next()?),
            _ if code.starts_with("Key") && code.len() == 4 => {
                Key::Unicode(code.chars().nth(3)?.to_ascii_lowercase())
            }
            _ => return None,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn video_profile_is_bounded_for_low_latency_streaming() {
            let config = video_config(
                3_840,
                2_160,
                StreamProfile {
                    fps: 10,
                    bitrate: 50_000_000,
                },
            );
            assert_eq!(config.fps, 30);
            assert_eq!(config.bitrate, 28_000_000);
            assert_eq!(config.keyframe_interval, 30);
        }

        #[test]
        fn mobile_safe_default_profile_limits_startup_pressure() {
            assert_eq!(
                StreamProfile::default(),
                StreamProfile {
                    fps: 30,
                    bitrate: 6_000_000
                }
            );
        }

        #[test]
        fn skips_encoding_when_the_latest_frame_queue_is_full() {
            assert!(!should_encode_next_frame(
                Duration::ZERO,
                Duration::from_millis(16),
                60,
                false,
            ));
        }

        #[test]
        fn failed_peers_shutdown_immediately_while_disconnects_get_a_short_grace() {
            assert_eq!(
                peer_shutdown_delay(RTCPeerConnectionState::Failed),
                Some(Duration::ZERO)
            );
            assert_eq!(
                peer_shutdown_delay(RTCPeerConnectionState::Disconnected),
                Some(PEER_DISCONNECT_GRACE)
            );
            assert_eq!(peer_shutdown_delay(RTCPeerConnectionState::Connected), None);
        }

        #[test]
        fn full_encoded_queue_does_not_block_capture_worker() {
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            assert!(enqueue_encoded_sample(
                &tx,
                EncodedVideoSample {
                    data: vec![1],
                    timestamp: Duration::ZERO,
                }
            ));

            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                let keep_running = enqueue_encoded_sample(
                    &tx,
                    EncodedVideoSample {
                        data: vec![2],
                        timestamp: Duration::ZERO,
                    },
                );
                let _ = done_tx.send(keep_running);
            });

            let completed = done_rx.recv_timeout(Duration::from_millis(100));
            drop(rx);
            worker.join().expect("capture worker should exit");

            assert_eq!(
                completed,
                Ok(true),
                "a full video queue must drop instead of blocking"
            );
        }

        #[test]
        fn keeps_frames_from_a_real_world_60hz_capture_clock() {
            let last = Duration::from_secs(1);
            assert!(should_encode_frame(
                last,
                last + Duration::from_micros(16_100),
                60
            ));
            assert!(!should_encode_frame(
                last,
                last + Duration::from_micros(16_100),
                30
            ));
        }

        #[test]
        fn normalized_touchpad_delta_scales_to_remote_desktop_pixels() {
            let geometry = DesktopGeometry {
                x: -1_920,
                y: 0,
                width: 1_920,
                height: 1_080,
            };
            let delta = normalized_pointer_delta(&json!({"dx": 0.25, "dy": -0.5}), geometry);
            assert_eq!(delta, (480, -540));
        }

        #[test]
        fn normalized_direct_touch_maps_across_offset_desktop_geometry() {
            let geometry = DesktopGeometry {
                x: -1_920,
                y: 100,
                width: 1_920,
                height: 1_080,
            };
            assert_eq!(
                normalized_pointer_position(&json!({"x": 0.0, "y": 0.0}), geometry),
                (-1_920, 100)
            );
            assert_eq!(
                normalized_pointer_position(&json!({"x": 1.0, "y": 1.0}), geometry),
                (-1, 1_179)
            );
            assert_eq!(
                normalized_pointer_position(&json!({"x": 0.5, "y": 0.5}), geometry),
                (-960, 640)
            );
        }

        #[test]
        fn pointer_queries_and_relative_moves_receive_position_sequences() {
            assert_eq!(
                pointer_message_sequence(&json!({"type": "pointer-query", "sequence": 7})),
                Some(7)
            );
            assert_eq!(
                pointer_message_sequence(&json!({"type": "pointer-relative", "sequence": 8})),
                Some(8)
            );
            assert_eq!(
                pointer_message_sequence(&json!({"type": "pointer", "sequence": 9})),
                None
            );
        }

        #[test]
        fn direct_touch_contact_flags_follow_windows_pointer_lifecycle() {
            assert_eq!(
                touch_pointer_flags("down"),
                POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT
            );
            assert_eq!(
                touch_pointer_flags("move"),
                POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT
            );
            assert_eq!(touch_pointer_flags("up"), POINTER_FLAG_UP);
            assert_eq!(
                touch_pointer_flags("cancel"),
                POINTER_FLAG_UP | POINTER_FLAG_CANCELED
            );
        }

        #[test]
        fn sparse_capture_advances_the_current_rtp_timestamp_by_the_real_gap() {
            let base = 0x1234_5678;
            let first = capture_timestamp_to_rtp(base, Duration::from_secs(1));
            let after_pause = capture_timestamp_to_rtp(base, Duration::from_secs(3));
            assert_eq!(after_pause.wrapping_sub(first), 180_000);
        }

        #[test]
        fn sixty_hz_capture_clock_advances_by_1500_rtp_ticks() {
            let base = 77;
            let first = capture_timestamp_to_rtp(base, Duration::ZERO);
            let second = capture_timestamp_to_rtp(base, Duration::from_nanos(16_666_667));
            let third = capture_timestamp_to_rtp(base, Duration::from_nanos(33_333_334));
            assert_eq!(second.wrapping_sub(first), 1_500);
            assert_eq!(third.wrapping_sub(second), 1_500);
        }

        #[test]
        fn capture_clock_wraps_as_a_32_bit_rtp_timestamp() {
            let base = u32::MAX - 10;
            assert_eq!(
                capture_timestamp_to_rtp(base, Duration::from_secs(1)),
                base.wrapping_add(90_000)
            );
        }

        #[test]
        fn h264_access_unit_uses_one_timestamp_and_marks_only_the_last_packet() {
            let mut access_unit = vec![
                0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x06, 0xe2, 0, 0, 0, 1,
                0x65,
            ];
            access_unit.extend(std::iter::repeat(0x55).take(2_500));
            let mut payloader = H264Payloader::default();
            let mut sequence = u16::MAX;
            let packets = packetize_h264_access_unit(
                &mut payloader,
                &mut sequence,
                123_456,
                Bytes::from(access_unit),
            )
            .expect("packetize access unit");

            assert!(packets.len() >= 3);
            assert!(packets
                .iter()
                .all(|packet| packet.header.timestamp == 123_456));
            assert!(packets[..packets.len() - 1]
                .iter()
                .all(|packet| !packet.header.marker));
            assert!(packets.last().expect("last packet").header.marker);
            assert_eq!(packets[0].header.sequence_number, u16::MAX);
            assert_eq!(packets[1].header.sequence_number, 0);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod unsupported {
    use serde::Deserialize;
    use serde_json::Value;

    use crate::OutboundQueues;

    #[derive(Debug, Deserialize)]
    pub struct StartPayload {
        pub session_id: String,
    }

    #[derive(Debug, Deserialize)]
    pub struct SignalPayload {
        pub session_id: String,
        pub signal: Value,
    }

    #[derive(Debug, Deserialize)]
    pub struct StopPayload {
        pub session_id: String,
    }

    #[derive(Default)]
    pub struct RemoteDesktopManager;

    impl RemoteDesktopManager {
        pub fn new() -> Self {
            Self
        }
        pub async fn start(
            &self,
            _payload: StartPayload,
            _outbound: OutboundQueues,
        ) -> Result<(), String> {
            Err("remote desktop is only supported on Windows".to_string())
        }
        pub async fn signal(&self, payload: SignalPayload) -> Result<(), String> {
            let _ = (payload.session_id, payload.signal);
            Ok(())
        }
        pub async fn stop(&self, _session_id: &str) {}
    }
}

#[cfg(not(target_os = "windows"))]
pub use unsupported::*;
#[cfg(target_os = "windows")]
pub use windows_impl::*;
