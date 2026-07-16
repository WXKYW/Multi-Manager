import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { ChevronUp, DesktopDisplay, Maximize2, Menu, RefreshCw, X } from '../components/Icons.jsx';

const ICE_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];
const SIGNAL_POLL_MS = 300;

function serverIdFromPath() {
  const match = window.location.pathname.match(/^\/remote-desktop\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}

function authHeaders(json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    'x-admin-password': localStorage.getItem('admin_password') || '',
  };
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return payload.data ?? payload;
}

function stateLabel(state) {
  const labels = {
    initializing: '正在初始化',
    connecting: '正在打洞',
    signaling: '正在协商',
    connected: 'P2P 已直连',
    disconnected: '连接中断',
    failed: '直连失败',
    closed: '会话已结束',
    error: '连接错误',
  };
  return labels[state] || state || '等待连接';
}

export default function RemoteDesktopPage() {
  const serverId = useMemo(serverIdFromPath, []);
  const [serverName, setServerName] = useState(serverId);
  const [state, setState] = useState('initializing');
  const [error, setError] = useState('');
  const [videoReady, setVideoReady] = useState(false);
  const [fillMode, setFillMode] = useState('contain');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenToolbarOpen, setFullscreenToolbarOpen] = useState(false);
  const [virtualCursor, setVirtualCursor] = useState({ x: 0.5, y: 0.5, visible: false });
  const [controlEnabled, setControlEnabled] = useState(true);
  const [controlAcknowledged, setControlAcknowledged] = useState(false);
  const [stats, setStats] = useState({
    rtt: 0,
    local: '',
    remote: '',
    fps: 0,
    receivedFps: 0,
    droppedFps: 0,
    loss: 0,
    bufferMs: 0,
    bitrate: 0,
  });

  const desktopAreaRef = useRef(null);
  const surfaceRef = useRef(null);
  const videoRef = useRef(null);
  const peerRef = useRef(null);
  const channelRef = useRef(null);
  const pointerChannelRef = useRef(null);
  const sessionRef = useRef('');
  const stoppedRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const lastSignalRef = useRef(0);
  const pendingLocalIceRef = useRef([]);
  const pendingRemoteIceRef = useRef([]);
  const previousVideoStatsRef = useRef(null);
  const streamProfileRef = useRef({ fps: 60, bitrate: 12_000_000 });
  const healthyIntervalsRef = useRef(0);
  const pointerFrameRef = useRef(0);
  const cursorPositionRef = useRef({ x: 0.5, y: 0.5 });
  const touchGestureRef = useRef(null);
  const remoteInputRef = useRef(null);
  const remoteInputValueRef = useRef('');

  const sendControl = useCallback((payload) => {
    const highFrequency = payload.type === 'pointer' || payload.type === 'wheel';
    const fastChannel = pointerChannelRef.current;
    const channel = highFrequency && fastChannel?.readyState === 'open' ? fastChannel : channelRef.current;
    if (!controlEnabled || channel?.readyState !== 'open') return;
    if (highFrequency && channel.bufferedAmount > 16 * 1024) return;
    channel.send(JSON.stringify(payload));
  }, [controlEnabled]);

  const postSignal = useCallback(async (signal, peer, generation) => {
    if (peer !== peerRef.current || generation !== connectionGenerationRef.current || stoppedRef.current) return;
    const sessionId = sessionRef.current;
    if (!sessionId) {
      pendingLocalIceRef.current.push(signal);
      return;
    }
    await apiRequest(`/api/server/remote-desktop/sessions/${encodeURIComponent(sessionId)}/signals`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ signal }),
    });
  }, []);

  const bindChannel = useCallback((channel, peer, generation) => {
    channelRef.current = channel;
    channel.onopen = () => {
      if (peer !== peerRef.current || generation !== connectionGenerationRef.current) return;
      setState('connected');
      setError('');
      surfaceRef.current?.focus();
    };
    channel.onclose = () => {
      if (peer === peerRef.current && generation === connectionGenerationRef.current) setState('closed');
    };
    channel.onerror = () => {
      if (peer !== peerRef.current || generation !== connectionGenerationRef.current) return;
      setState('failed');
      setError('P2P 数据通道异常。当前网络可能存在对称 NAT、CGNAT 或 UDP 防火墙。');
    };
  }, []);

  const applyRemoteSignal = useCallback(async (signal, sessionId, generation) => {
    if (sessionRef.current !== sessionId || generation !== connectionGenerationRef.current) return;
    const peer = peerRef.current;
    if (!peer || !signal) return;
    if (signal.kind === 'answer') {
      await peer.setRemoteDescription(signal.sdp);
      for (const candidate of pendingRemoteIceRef.current.splice(0)) {
        await peer.addIceCandidate(candidate).catch(() => {});
      }
    } else if (signal.kind === 'ice' && signal.candidate) {
      if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate).catch(() => {});
      else pendingRemoteIceRef.current.push(signal.candidate);
    } else if (signal.kind === 'error') {
      setState('error');
      setError(signal.message || 'Windows Agent 启动远程桌面失败');
    }
  }, []);

  const pollSignals = useCallback(async (sessionId, generation, longPoll = false) => {
    if (!sessionId || stoppedRef.current || sessionRef.current !== sessionId || generation !== connectionGenerationRef.current) return;
    try {
      const data = await apiRequest(`/api/server/remote-desktop/sessions/${encodeURIComponent(sessionId)}/signals?since=${lastSignalRef.current}&wait=${longPoll ? 15000 : 0}`, {
        headers: authHeaders(),
        cache: 'no-store',
      });
      if (sessionRef.current !== sessionId || generation !== connectionGenerationRef.current) return;
      if (data.state) setState(data.state);
      for (const item of data.signals || []) {
        if (sessionRef.current !== sessionId || generation !== connectionGenerationRef.current) return;
        lastSignalRef.current = Math.max(lastSignalRef.current, Number(item.id) || 0);
        await applyRemoteSignal(item.payload, sessionId, generation);
      }
    } catch (err) {
      if (!stoppedRef.current && sessionRef.current === sessionId && generation === connectionGenerationRef.current) {
        setError(err.message || '信令同步失败');
      }
    }
  }, [applyRemoteSignal]);

  const closeSession = useCallback(async () => {
    connectionGenerationRef.current += 1;
    stoppedRef.current = true;
    const sessionId = sessionRef.current;
    sessionRef.current = '';
    channelRef.current?.close?.();
    pointerChannelRef.current?.close?.();
    peerRef.current?.close?.();
    channelRef.current = null;
    pointerChannelRef.current = null;
    peerRef.current = null;
    previousVideoStatsRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setVideoReady(false);
    if (sessionId) {
      await fetch(`/api/server/remote-desktop/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: authHeaders(),
        keepalive: true,
      }).catch(() => {});
    }
  }, []);

  const connect = useCallback(async () => {
    await closeSession();
    const generation = connectionGenerationRef.current;
    stoppedRef.current = false;
    setState('initializing');
    setError('');
    setControlAcknowledged(false);
    lastSignalRef.current = 0;
    pendingLocalIceRef.current = [];
    pendingRemoteIceRef.current = [];
    try {
      const server = await apiRequest(`/api/server/s/${encodeURIComponent(serverId)}`, { headers: authHeaders(), cache: 'no-store' });
      if (generation !== connectionGenerationRef.current) return;
      setServerName(server.name || server.hostname || serverId);
      const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 });
      peerRef.current = peer;
      peer.onconnectionstatechange = () => {
        if (peer !== peerRef.current || generation !== connectionGenerationRef.current) return;
        const next = peer.connectionState;
        if (next === 'connected') setState('connected');
        else if (['failed', 'disconnected', 'closed'].includes(next)) setState(next);
      };
      peer.onicecandidate = (event) => {
        if (event.candidate) postSignal({ kind: 'ice', candidate: event.candidate.toJSON() }, peer, generation).catch(() => {});
      };
      peer.ontrack = (event) => {
        if (peer !== peerRef.current || generation !== connectionGenerationRef.current || event.track.kind !== 'video') return;
        const receiver = event.receiver;
        try {
          if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
          if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
        } catch {
          // Some mobile browsers expose these experimental hints as read-only.
        }
        const stream = event.streams[0] || new MediaStream([event.track]);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      };
      peer.addTransceiver('video', { direction: 'recvonly' });
      const channel = peer.createDataChannel('remote-desktop', { ordered: true });
      bindChannel(channel, peer, generation);
      pointerChannelRef.current = peer.createDataChannel('remote-pointer', { ordered: false, maxRetransmits: 0 });
      channel.onmessage = (event) => {
        if (peer !== peerRef.current || generation !== connectionGenerationRef.current) return;
        if (typeof event.data === 'string') {
          try {
            const meta = JSON.parse(event.data);
            if (meta.type === 'input-ack') setControlAcknowledged(true);
          } catch {
            // Ignore unknown control messages.
          }
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      setState('connecting');
      const created = await apiRequest('/api/server/remote-desktop/sessions', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ serverId, offer: peer.localDescription }),
      });
      if (generation !== connectionGenerationRef.current || peer !== peerRef.current) {
        await fetch(`/api/server/remote-desktop/sessions/${encodeURIComponent(created.sessionId)}`, {
          method: 'DELETE', headers: authHeaders(), keepalive: true,
        }).catch(() => {});
        return;
      }
      sessionRef.current = created.sessionId;
      for (const signal of pendingLocalIceRef.current.splice(0)) await postSignal(signal, peer, generation);
      await pollSignals(created.sessionId, generation);
    } catch (err) {
      if (generation === connectionGenerationRef.current) {
        setState('error');
        setError(err.message || '远程桌面初始化失败');
      }
    }
  }, [bindChannel, closeSession, pollSignals, postSignal, serverId]);

  useEffect(() => {
    connect();
    let signalLoopCancelled = false;
    const runSignalLoop = async () => {
      while (!signalLoopCancelled) {
        const sessionId = sessionRef.current;
        const generation = connectionGenerationRef.current;
        if (!sessionId) {
          await new Promise(resolve => window.setTimeout(resolve, SIGNAL_POLL_MS));
          continue;
        }
        await pollSignals(sessionId, generation, true);
      }
    };
    runSignalLoop();
    const statsTimer = window.setInterval(async () => {
      const peer = peerRef.current;
      if (!peer) return;
      const reports = await peer.getStats().catch(() => null);
      if (!reports) return;
      let pair;
      let localCandidate;
      let remoteCandidate;
      let video;
      reports.forEach((report) => {
        if (report.type === 'candidate-pair' && (report.selected || report.nominated) && report.state === 'succeeded') pair = report;
        if (report.type === 'inbound-rtp' && report.kind === 'video' && !report.isRemote) video = report;
      });
      if (pair) {
        localCandidate = reports.get(pair.localCandidateId);
        remoteCandidate = reports.get(pair.remoteCandidateId);
      }
      const now = performance.now();
      const previous = previousVideoStatsRef.current;
      const elapsedSeconds = previous ? Math.max(0.001, (now - previous.at) / 1000) : 0;
      const framesReceivedDelta = previous ? Math.max(0, Number(video?.framesReceived || 0) - previous.framesReceived) : 0;
      const decodedDelta = previous ? Math.max(0, Number(video?.framesDecoded || 0) - previous.framesDecoded) : 0;
      const droppedDelta = previous ? Math.max(0, Number(video?.framesDropped || 0) - previous.framesDropped) : 0;
      const bytesDelta = previous ? Math.max(0, Number(video?.bytesReceived || 0) - previous.bytesReceived) : 0;
      const receivedDelta = previous ? Math.max(0, Number(video?.packetsReceived || 0) - previous.packetsReceived) : 0;
      const lostDelta = previous ? Math.max(0, Number(video?.packetsLost || 0) - previous.packetsLost) : 0;
      const jitterCountDelta = previous ? Math.max(0, Number(video?.jitterBufferEmittedCount || 0) - previous.jitterCount) : 0;
      const jitterDelayDelta = previous ? Math.max(0, Number(video?.jitterBufferDelay || 0) - previous.jitterDelay) : 0;
      previousVideoStatsRef.current = video ? {
        at: now,
        framesReceived: Number(video.framesReceived || 0),
        framesDecoded: Number(video.framesDecoded || 0),
        framesDropped: Number(video.framesDropped || 0),
        bytesReceived: Number(video.bytesReceived || 0),
        packetsReceived: Number(video.packetsReceived || 0),
        packetsLost: Number(video.packetsLost || 0),
        jitterCount: Number(video.jitterBufferEmittedCount || 0),
        jitterDelay: Number(video.jitterBufferDelay || 0),
      } : null;
      const measuredFps = Number(video?.framesPerSecond || (elapsedSeconds ? decodedDelta / elapsedSeconds : 0));
      const measuredReceivedFps = elapsedSeconds ? framesReceivedDelta / elapsedSeconds : 0;
      const measuredDroppedFps = elapsedSeconds ? droppedDelta / elapsedSeconds : 0;
      const measuredLoss = receivedDelta + lostDelta ? (lostDelta / (receivedDelta + lostDelta)) * 100 : 0;
      const measuredBufferMs = jitterCountDelta ? (jitterDelayDelta / jitterCountDelta) * 1000 : 0;
      const measuredRtt = Math.round(Number(pair?.currentRoundTripTime || 0) * 1000);
      const videoPixels = (videoRef.current?.videoWidth || 1920) * (videoRef.current?.videoHeight || 1080);
      const nativeBitrate = videoPixels > 3_686_400 ? 28_000_000 : videoPixels > 2_073_600 ? 18_000_000 : 12_000_000;
      let nextProfile = streamProfileRef.current;
      if (measuredLoss > 5 || measuredRtt > 120) {
        healthyIntervalsRef.current = 0;
        nextProfile = { fps: 30, bitrate: Math.min(8_000_000, nativeBitrate) };
      } else if (measuredLoss > 2 || measuredRtt > 70 || measuredBufferMs > 55) {
        healthyIntervalsRef.current = 0;
        // A large jitter buffer can be caused by media-clock or decoder
        // pressure. Reducing frame cadence feeds that failure mode; preserve
        // interactive 60 FPS and reduce only the encoded size per second.
        nextProfile = { fps: 60, bitrate: Math.min(8_000_000, nativeBitrate) };
      } else {
        healthyIntervalsRef.current += 1;
        if (healthyIntervalsRef.current >= 4) nextProfile = { fps: 60, bitrate: nativeBitrate };
      }
      const currentProfile = streamProfileRef.current;
      if (nextProfile.fps !== currentProfile.fps || nextProfile.bitrate !== currentProfile.bitrate) {
        streamProfileRef.current = nextProfile;
        const controlChannel = channelRef.current;
        if (controlChannel?.readyState === 'open') {
          controlChannel.send(JSON.stringify({ type: 'video-config', ...nextProfile }));
        }
      }
      setStats({
        rtt: measuredRtt,
        local: localCandidate ? `${localCandidate.candidateType || 'host'} · ${localCandidate.protocol || 'udp'}` : '',
        remote: remoteCandidate ? `${remoteCandidate.candidateType || 'host'} · ${remoteCandidate.protocol || 'udp'}` : '',
        fps: measuredFps,
        receivedFps: measuredReceivedFps,
        droppedFps: measuredDroppedFps,
        loss: measuredLoss,
        bufferMs: measuredBufferMs,
        bitrate: elapsedSeconds ? (bytesDelta * 8) / elapsedSeconds : 0,
      });
    }, 2000);
    return () => {
      signalLoopCancelled = true;
      window.clearInterval(statsTimer);
      closeSession();
    };
  }, [closeSession, connect, pollSignals]);

  useEffect(() => {
    const syncFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === desktopAreaRef.current);
      setFullscreenToolbarOpen(false);
    };
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  useEffect(() => {
    const handleKey = (event, action) => {
      if (!controlEnabled || document.activeElement !== surfaceRef.current) return;
      event.preventDefault();
      sendControl({ type: 'key', key: event.key, code: event.code, action });
    };
    const keyDown = (event) => handleKey(event, 'down');
    const keyUp = (event) => handleKey(event, 'up');
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    return () => {
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
    };
  }, [controlEnabled, sendControl]);

  const pointerPosition = (event) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const video = videoRef.current;
    const videoWidth = video?.videoWidth || rect.width;
    const videoHeight = video?.videoHeight || rect.height;
    const scale = fillMode === 'cover'
      ? Math.max(rect.width / videoWidth, rect.height / videoHeight)
      : Math.min(rect.width / videoWidth, rect.height / videoHeight);
    const renderedWidth = videoWidth * scale;
    const renderedHeight = videoHeight * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left - offsetX) / Math.max(1, renderedWidth))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top - offsetY) / Math.max(1, renderedHeight))),
    };
  };

  const handlePointerMove = (event) => {
    const position = pointerPosition(event);
    if (!position || pointerFrameRef.current) return;
    cursorPositionRef.current = position;
    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = 0;
      sendControl({ type: 'pointer', ...position });
    });
  };

  const handleMouse = (event, action) => {
    event.preventDefault();
    surfaceRef.current?.focus();
    const position = pointerPosition(event);
    if (position) sendControl({ type: 'pointer', ...position });
    sendControl({ type: 'mouse', button: event.button, action });
  };

  const moveRelativePointer = (deltaX, deltaY) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = cursorPositionRef.current;
    const next = {
      x: Math.max(0, Math.min(1, current.x + (deltaX / Math.max(1, rect.width)) * 1.35)),
      y: Math.max(0, Math.min(1, current.y + (deltaY / Math.max(1, rect.height)) * 1.35)),
    };
    cursorPositionRef.current = next;
    if (pointerFrameRef.current) return;
    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = 0;
      const latest = cursorPositionRef.current;
      setVirtualCursor({ ...latest, visible: true });
      sendControl({ type: 'pointer', ...latest });
    });
  };

  const touchCenter = (touches) => ({
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  });

  const touchDistance = (touches) => Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );

  const handleTouchStart = (event) => {
    const { touches } = event;
    if (touches.length === 1) {
      setVirtualCursor(cursor => ({ ...cursor, visible: true }));
      touchGestureRef.current = {
        kind: 'pointer', lastX: touches[0].clientX, lastY: touches[0].clientY, moved: false, startedAt: performance.now(),
      };
    } else if (touches.length === 2) {
      touchGestureRef.current = {
        kind: 'two-finger', center: touchCenter(touches), distance: touchDistance(touches), mode: '', moved: false, startedAt: performance.now(),
      };
    }
  };

  const handleTouchMove = (event) => {
    const gesture = touchGestureRef.current;
    const { touches } = event;
    if (!gesture) return;
    if (gesture.kind === 'pointer' && touches.length === 1) {
      const deltaX = touches[0].clientX - gesture.lastX;
      const deltaY = touches[0].clientY - gesture.lastY;
      gesture.lastX = touches[0].clientX;
      gesture.lastY = touches[0].clientY;
      gesture.moved ||= Math.hypot(deltaX, deltaY) > 3;
      if (gesture.moved) {
        event.preventDefault();
        moveRelativePointer(deltaX, deltaY);
      }
      return;
    }
    if (gesture.kind === 'two-finger' && touches.length === 2) {
      const center = touchCenter(touches);
      const distance = touchDistance(touches);
      const deltaX = center.x - gesture.center.x;
      const deltaY = center.y - gesture.center.y;
      if (!gesture.mode && Math.abs(distance - gesture.distance) > 12) {
        gesture.mode = 'zoom';
        gesture.moved = true;
      }
      if (gesture.mode !== 'zoom' && Math.hypot(deltaX, deltaY) > 2) {
        gesture.mode = 'scroll';
        gesture.moved = true;
        event.preventDefault();
        sendControl({ type: 'wheel', deltaX: -deltaX * 14, deltaY: -deltaY * 14 });
      }
      gesture.center = center;
      gesture.distance = distance;
    }
  };

  const handleTouchEnd = (event) => {
    const gesture = touchGestureRef.current;
    if (gesture?.kind === 'pointer' && !gesture.moved && event.touches.length === 0) {
      sendControl({ type: 'mouse', button: 0, action: 'click' });
    }
    if (gesture?.kind === 'two-finger' && !gesture.moved && event.touches.length === 0 && performance.now() - gesture.startedAt < 400) {
      event.preventDefault();
      sendControl({ type: 'mouse', button: 2, action: 'click' });
    }
    if (event.touches.length === 0) touchGestureRef.current = null;
  };

  const openSystemKeyboard = () => {
    remoteInputRef.current?.focus({ preventScroll: true });
  };

  const handleRemoteTextInput = (event) => {
    const nextValue = event.target.value;
    const previousValue = remoteInputValueRef.current;
    if (nextValue.startsWith(previousValue)) {
      const inserted = nextValue.slice(previousValue.length);
      if (inserted) sendControl({ type: 'text', text: inserted });
    } else if (previousValue.startsWith(nextValue)) {
      for (let index = 0; index < previousValue.length - nextValue.length; index += 1) {
        sendControl({ type: 'key', key: 'Backspace', code: 'Backspace', action: 'click' });
      }
    }
    remoteInputValueRef.current = nextValue;
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else desktopAreaRef.current?.requestFullscreen?.();
  };

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-kumo-recessed text-kumo-default">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <DesktopDisplay className="h-5 w-5 text-kumo-brand" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-kumo-strong">{serverName || 'Windows 远程桌面'}</div>
          </div>
          <Badge variant={state === 'connected' ? 'success' : state === 'error' || state === 'failed' ? 'error' : 'neutral'} appearance="dot">
            {stateLabel(state)}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-kumo-subtle md:inline">
            {stats.rtt ? `${stats.rtt} ms · ` : ''}{stats.fps ? `解码 ${stats.fps.toFixed(0)} FPS · ` : ''}
            {stats.receivedFps ? `接收 ${stats.receivedFps.toFixed(0)} FPS · ` : ''}
            {stats.droppedFps ? `丢帧 ${stats.droppedFps.toFixed(1)}/s · ` : ''}
            {stats.bitrate ? `${(stats.bitrate / 1_000_000).toFixed(1)} Mbps · ` : ''}
            {stats.bufferMs ? `缓冲 ${stats.bufferMs.toFixed(0)} ms · ` : ''}
            {stats.loss ? `丢包 ${stats.loss.toFixed(1)}% · ` : ''}
            {stats.local && stats.remote ? `${stats.local} ↔ ${stats.remote}` : 'ICE 协商中'}
          </span>
          <Button size="sm" variant={controlEnabled ? 'primary' : 'secondary'} onClick={() => setControlEnabled(value => !value)}>
            {controlEnabled ? (controlAcknowledged ? '控制通道正常' : '控制已开启') : '仅观看'}
          </Button>
          <Button size="sm" variant="secondary" onClick={openSystemKeyboard}>键盘</Button>
          <Button size="sm" variant="secondary" onClick={() => setFillMode(mode => mode === 'cover' ? 'contain' : 'cover')}>
            {fillMode === 'cover' ? '填满' : '适应'}
          </Button>
          <Button size="sm" shape="square" variant="secondary" icon={<RefreshCw className="h-4 w-4" />} aria-label="重新连接" onClick={connect} />
          <Button size="sm" shape="square" variant="secondary" icon={<Maximize2 className="h-4 w-4" />} aria-label="全屏" onClick={toggleFullscreen} />
          <Button size="sm" shape="square" variant="secondary" icon={<X className="h-4 w-4" />} aria-label="关闭" onClick={() => window.close()} />
        </div>
      </header>

      <main ref={desktopAreaRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-kumo-strong">
        <div
          ref={surfaceRef}
          tabIndex={0}
          className="relative flex h-full w-full items-center justify-center overflow-hidden outline-none focus:ring-2 focus:ring-kumo-brand"
          onMouseMove={handlePointerMove}
          onMouseDown={(event) => handleMouse(event, 'down')}
          onMouseUp={(event) => handleMouse(event, 'up')}
          onContextMenu={(event) => event.preventDefault()}
          onWheel={(event) => { event.preventDefault(); sendControl({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY }); }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={() => { touchGestureRef.current = null; }}
          style={{ touchAction: 'pinch-zoom' }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            aria-label={`${serverName} 远程桌面`}
            onLoadedData={() => setVideoReady(true)}
            className={`h-full w-full select-none ${fillMode === 'cover' ? 'object-cover' : 'object-contain'} ${videoReady ? 'block' : 'hidden'}`}
          />
          {!videoReady && (
            <div className="flex flex-col items-center gap-3 text-center text-kumo-inverse/70">
              <DesktopDisplay className="h-12 w-12" />
              <div className="text-sm">{stateLabel(state)}</div>
              <div className="max-w-lg text-xs text-kumo-inverse/45">正在通过 STUN 交换公网候选地址并尝试 UDP 打洞。严格直连模式不会使用 fly.io 转发桌面数据。</div>
            </div>
          )}
          {virtualCursor.visible && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${virtualCursor.x * 100}%`, top: `${virtualCursor.y * 100}%` }}
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-kumo-inverse bg-kumo-brand/70">
                <div className="h-1.5 w-1.5 rounded-full bg-kumo-inverse" />
              </div>
            </div>
          )}
        </div>
        {isFullscreen && (
          <div className="absolute left-3 right-3 top-3 z-30 flex justify-end">
            {!fullscreenToolbarOpen ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<Menu className="h-4 w-4" />}
                aria-label="展开全屏控制栏"
                aria-expanded="false"
                onClick={() => setFullscreenToolbarOpen(true)}
              >
                控制
              </Button>
            ) : (
              <div
                role="toolbar"
                aria-label="全屏远程桌面控制栏"
                className="flex max-w-full flex-wrap items-center justify-end gap-2 rounded-md border border-kumo-line bg-kumo-base/95 p-2"
              >
                <Badge variant={state === 'connected' ? 'success' : state === 'error' || state === 'failed' ? 'error' : 'neutral'} appearance="dot">
                  {stateLabel(state)}
                </Badge>
                <span className="text-[11px] text-kumo-subtle">
                  {stats.rtt ? `${stats.rtt} ms · ` : ''}{stats.fps ? `${stats.fps.toFixed(0)} FPS` : '等待视频'}
                  {stats.bufferMs ? ` · 缓冲 ${stats.bufferMs.toFixed(0)} ms` : ''}
                </span>
                <Button size="sm" variant={controlEnabled ? 'primary' : 'secondary'} onClick={() => setControlEnabled(value => !value)}>
                  {controlEnabled ? '控制开启' : '仅观看'}
                </Button>
                <Button size="sm" variant="secondary" onClick={openSystemKeyboard}>键盘</Button>
                <Button size="sm" variant="secondary" onClick={() => setFillMode(mode => mode === 'cover' ? 'contain' : 'cover')}>
                  {fillMode === 'cover' ? '填满' : '适应'}
                </Button>
                <Button size="sm" shape="square" variant="secondary" icon={<RefreshCw className="h-4 w-4" />} aria-label="重新连接" onClick={connect} />
                <Button size="sm" shape="square" variant="secondary" icon={<Maximize2 className="h-4 w-4" />} aria-label="退出全屏" onClick={toggleFullscreen} />
                <Button
                  size="sm"
                  shape="square"
                  variant="secondary"
                  icon={<ChevronUp className="h-4 w-4" />}
                  aria-label="收起全屏控制栏"
                  onClick={() => setFullscreenToolbarOpen(false)}
                />
              </div>
            )}
          </div>
        )}
        {virtualCursor.visible && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-kumo-line bg-kumo-base/80 px-2 py-1 text-[11px] text-kumo-subtle">
            单指移动/轻点左键 · 双指轻点右键 · 双指拖动滚动 · 双指张合缩放
          </div>
        )}
        {error && (
          <div className="absolute bottom-4 left-1/2 max-w-2xl -translate-x-1/2 rounded-md border border-kumo-danger/40 bg-kumo-danger/90 px-4 py-2 text-sm font-semibold text-kumo-inverse">
            {error}
          </div>
        )}
      </main>
      <textarea
        data-ui-exception="remote-system-keyboard-input"
        ref={remoteInputRef}
        aria-label="远程键盘输入"
        inputMode="text"
        autoCapitalize="off"
        autoCorrect="off"
        value={remoteInputValueRef.current}
        onChange={handleRemoteTextInput}
        className="remote-system-keyboard-input fixed -left-[9999px] top-0 h-px w-px opacity-0"
      />
    </div>
  );
}
