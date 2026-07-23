const WINDOWS_PATTERN = /windows|win32|win64/i;

export function remoteDesktopPlatform(server = {}) {
  return String(server.platform || server.info?.platform || server.metadata?.platform || '').trim();
}

export function hasRemoteDesktopCapability(server = {}) {
  return server.agent_capabilities?.remote_desktop_video_v2 === true
    || server.capabilities?.remote_desktop_video_v2 === true
    || server.agent_capabilities?.remote_desktop_v1 === true
    || server.capabilities?.remote_desktop_v1 === true;
}

export function canOpenRemoteDesktop(server = {}) {
  const online = server.is_online === true || server.agent_online === true || server.status === 'online';
  return online && WINDOWS_PATTERN.test(remoteDesktopPlatform(server)) && hasRemoteDesktopCapability(server);
}

export function remoteDesktopPath(serverId) {
  return `/remote-desktop/${encodeURIComponent(String(serverId || '').trim())}`;
}
