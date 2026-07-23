import { describe, expect, it } from 'vitest';
import { getOSIconClass, getServerPlatformLabel } from './osPlatform.js';

describe('OS platform presentation', () => {
  it('uses distribution-specific icons', () => {
    expect(getOSIconClass('Ubuntu 24.04')).toContain('si-ubuntu');
    expect(getOSIconClass('Debian GNU/Linux')).toContain('si-debian');
    expect(getOSIconClass('Windows 11')).toContain('fa-windows');
  });

  it('combines platform and version fields from server payloads', () => {
    expect(getServerPlatformLabel({ platform: 'Linux', platform_version: 'Ubuntu 24.04' })).toBe('Linux Ubuntu 24.04');
  });
});
