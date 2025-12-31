/**
 * Cookie Helper 单元测试
 */
import { describe, it, expect, beforeAll } from 'vitest';

let cookieHelper;

beforeAll(async () => {
  // 动态导入 CommonJS 模块
  cookieHelper = await import('../../../src/utils/cookie-helper.js');
});

describe('cookie-helper', () => {
  describe('extractCookieParts', () => {
    it('should extract key=value from Set-Cookie array', () => {
      const setCookies = [
        'MUSIC_U=abc123; Path=/; Max-Age=2592000',
        'NMTID=xyz789; Expires=Sun, 01 Jan 2026 00:00:00 GMT',
      ];
      const result = cookieHelper.extractCookieParts(setCookies);
      expect(result).toEqual(['MUSIC_U=abc123', 'NMTID=xyz789']);
    });

    it('should filter out HTTP attributes', () => {
      const setCookies = ['Path=/; HttpOnly; Secure'];
      const result = cookieHelper.extractCookieParts(setCookies);
      expect(result).toEqual([]);
    });

    it('should handle empty array', () => {
      expect(cookieHelper.extractCookieParts([])).toEqual([]);
    });

    it('should handle non-array input', () => {
      expect(cookieHelper.extractCookieParts(null)).toEqual([]);
      expect(cookieHelper.extractCookieParts(undefined)).toEqual([]);
    });
  });

  describe('parseCookieString', () => {
    it('should parse cookie string to object', () => {
      const cookieStr = 'MUSIC_U=abc; NMTID=xyz; __csrf=123';
      const result = cookieHelper.parseCookieString(cookieStr);
      expect(result).toEqual({
        MUSIC_U: 'abc',
        NMTID: 'xyz',
        __csrf: '123',
      });
    });

    it('should handle values with equals sign', () => {
      const cookieStr = 'token=abc=def=ghi';
      const result = cookieHelper.parseCookieString(cookieStr);
      expect(result).toEqual({ token: 'abc=def=ghi' });
    });

    it('should handle empty string', () => {
      expect(cookieHelper.parseCookieString('')).toEqual({});
      expect(cookieHelper.parseCookieString(null)).toEqual({});
    });
  });

  describe('serializeCookies', () => {
    it('should serialize cookie object to string', () => {
      const cookies = { MUSIC_U: 'abc', NMTID: 'xyz' };
      const result = cookieHelper.serializeCookies(cookies);
      expect(result).toContain('MUSIC_U=abc');
      expect(result).toContain('NMTID=xyz');
      expect(result).toContain('; ');
    });

    it('should handle empty object', () => {
      expect(cookieHelper.serializeCookies({})).toBe('');
    });
  });

  describe('mergeCookies', () => {
    it('should merge new cookies when no login exists', () => {
      const existing = 'NMTID=old';
      const newCookies = ['NMTID=new; Path=/', 'OTHER=value; Path=/'];
      const result = cookieHelper.mergeCookies(existing, newCookies);
      expect(result).toContain('NMTID=new');
      expect(result).toContain('OTHER=value');
    });

    it('should only update login cookies when login exists', () => {
      const existing = 'MUSIC_U=login_token; NMTID=old';
      const newCookies = ['NMTID=should_not_update; Path=/', 'MUSIC_U=new_token; Path=/'];
      const result = cookieHelper.mergeCookies(existing, newCookies);
      // MUSIC_U should be updated (login cookie)
      expect(result).toContain('MUSIC_U=new_token');
      // NMTID should NOT be updated (not a login cookie)
      expect(result).toContain('NMTID=old');
    });

    it('should return existing cookie if no new cookies', () => {
      const existing = 'MUSIC_U=abc';
      expect(cookieHelper.mergeCookies(existing, [])).toBe(existing);
    });
  });

  describe('hasValidLoginCookie', () => {
    it('should return true for cookie with MUSIC_U', () => {
      expect(cookieHelper.hasValidLoginCookie('MUSIC_U=abc; NMTID=xyz')).toBe(true);
    });

    it('should return false for cookie without MUSIC_U', () => {
      expect(cookieHelper.hasValidLoginCookie('NMTID=xyz; OTHER=abc')).toBe(false);
    });

    it('should return false for empty/null', () => {
      expect(cookieHelper.hasValidLoginCookie('')).toBe(false);
      expect(cookieHelper.hasValidLoginCookie(null)).toBe(false);
    });
  });
});
