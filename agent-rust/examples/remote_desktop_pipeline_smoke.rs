#[cfg(target_os = "windows")]
fn main() {
    use std::time::{Duration, Instant};

    use enigo::{Coordinate, Enigo, Mouse, Settings};
    use win_native_media::capture::{self, CaptureConfig};
    use win_native_media::encoder::mf_h264::MfH264Encoder;
    use win_native_media::{CaptureTarget, VideoConfig};

    const FRAME_COUNT: usize = 120;
    let (session, frames) = capture::start(
        CaptureConfig {
            target: CaptureTarget::Monitor(0),
            capture_cursor: true,
        },
        1,
    )
    .expect("start Windows Graphics Capture");
    let first = frames
        .recv_timeout(Duration::from_secs(5))
        .expect("receive first GPU frame");
    let config = VideoConfig {
        width: first.width,
        height: first.height,
        fps: 60,
        bitrate: 12_000_000,
        keyframe_interval: 60,
    };
    let mut encoder = MfH264Encoder::new_with(session.device(), config, true)
        .expect("create hardware Media Foundation H.264 encoder");
    let started = Instant::now();
    let mut encode_elapsed = Duration::ZERO;
    let mut access_units = 0usize;
    let mut bytes = 0usize;
    let mut mouse = Enigo::new(&Settings::default()).expect("initialize mouse stimulus");
    for (index, frame) in std::iter::once(first)
        .chain(frames.into_iter())
        .take(FRAME_COUNT)
        .enumerate()
    {
        let mut output = Vec::new();
        let encode_started = Instant::now();
        encoder
            .encode(&frame.texture, frame.timestamp, &mut output)
            .expect("hardware encode GPU frame");
        encode_elapsed += encode_started.elapsed();
        access_units += output.len();
        bytes += output.iter().map(|sample| sample.data.len()).sum::<usize>();
        let delta = if index % 2 == 0 { 1 } else { -1 };
        mouse
            .move_mouse(delta, 0, Coordinate::Rel)
            .expect("move cursor to stimulate desktop updates");
    }
    let elapsed = started.elapsed();
    let fps = FRAME_COUNT as f64 / elapsed.as_secs_f64();
    assert!(access_units > 0, "encoder produced no H.264 access units");
    println!(
        "WGC + hardware MF H.264: {}x{}; {:.1} capture FPS; {:.2} ms encode; {} access units; {} bytes",
        config.width,
        config.height,
        fps,
        encode_elapsed.as_secs_f64() * 1000.0 / FRAME_COUNT as f64,
        access_units,
        bytes
    );
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("remote desktop pipeline smoke is Windows-only");
}
