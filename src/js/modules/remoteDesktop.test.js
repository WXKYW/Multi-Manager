import { describe, expect, it } from 'vitest';
import { canOpenRemoteDesktop, remoteDesktopPath } from './remoteDesktop.js';

describe('remote desktop capability', () => {
  it('only enables online Windows agents that advertise the feature', () => {
    expect(canOpenRemoteDesktop({ status: 'online', platform: 'windows', agent_capabilities: { remote_desktop_v1: true } })).toBe(true);
    expect(canOpenRemoteDesktop({ status: 'online', platform: 'win32', agent_capabilities: { remote_desktop_video_v2: true } })).toBe(true);
    expect(canOpenRemoteDesktop({ status: 'online', platform: 'linux', agent_capabilities: { remote_desktop_v1: true } })).toBe(false);
    expect(canOpenRemoteDesktop({ status: 'offline', platform: 'Windows', agent_capabilities: { remote_desktop_v1: true } })).toBe(false);
    expect(canOpenRemoteDesktop({ status: 'online', platform: 'Windows' })).toBe(false);
  });

  it('builds an encoded new-tab route', () => {
    expect(remoteDesktopPath('server/a')).toBe('/remote-desktop/server%2Fa');
  });
});
