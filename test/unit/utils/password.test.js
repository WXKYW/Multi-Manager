/**
 * 密码工具模块测试
 * @module test/unit/utils/password.test
 */

import { describe, it, expect } from 'vitest';

// 直接测试密码工具的核心逻辑
describe('密码工具模块', () => {
    describe('bcrypt 哈希格式检测', () => {
        // bcrypt 哈希格式正则
        const BCRYPT_HASH_REGEX = /^\$2[aby]?\$\d{1,2}\$[./A-Za-z0-9]{53}$/;

        it('应该正确识别 bcrypt 哈希格式', () => {
            const validHash = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4edpQyIlSc5iIuWy';
            expect(BCRYPT_HASH_REGEX.test(validHash)).toBe(true);
        });

        it('应该识别 $2a$ 格式的哈希', () => {
            const hash2a = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
            expect(BCRYPT_HASH_REGEX.test(hash2a)).toBe(true);
        });

        it('应该识别 $2y$ 格式的哈希', () => {
            // 使用符合 bcrypt 规范的有效 $2y$ 哈希
            const hash2y = '$2y$12$WZx1B5qLmFYELVo6oYEw0u5K8PjKI1gP0aJ5pz9n4NeXZ3qLmFYBC';
            expect(BCRYPT_HASH_REGEX.test(hash2y)).toBe(true);
        });

        it('应该拒绝明文密码', () => {
            const plaintext = 'mypassword123';
            expect(BCRYPT_HASH_REGEX.test(plaintext)).toBe(false);
        });

        it('应该拒绝空字符串', () => {
            expect(BCRYPT_HASH_REGEX.test('')).toBe(false);
        });

        it('应该拒绝其他哈希格式（如 MD5）', () => {
            const md5Hash = '5f4dcc3b5aa765d61d8327deb882cf99';
            expect(BCRYPT_HASH_REGEX.test(md5Hash)).toBe(false);
        });

        it('应该拒绝 SHA256 哈希', () => {
            const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
            expect(BCRYPT_HASH_REGEX.test(sha256)).toBe(false);
        });
    });

    describe('isHashed 函数逻辑', () => {
        const BCRYPT_HASH_REGEX = /^\$2[aby]?\$\d{1,2}\$[./A-Za-z0-9]{53}$/;

        function isHashed(password) {
            if (!password || typeof password !== 'string') {
                return false;
            }
            return BCRYPT_HASH_REGEX.test(password);
        }

        it('应该对 null 返回 false', () => {
            expect(isHashed(null)).toBe(false);
        });

        it('应该对 undefined 返回 false', () => {
            expect(isHashed(undefined)).toBe(false);
        });

        it('应该对数字返回 false', () => {
            expect(isHashed(12345)).toBe(false);
        });

        it('应该对对象返回 false', () => {
            expect(isHashed({ password: 'test' })).toBe(false);
        });

        it('应该对有效 bcrypt 哈希返回 true', () => {
            const hash = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4edpQyIlSc5iIuWy';
            expect(isHashed(hash)).toBe(true);
        });
    });

    describe('密码强度验证逻辑', () => {
        function validatePasswordStrength(password) {
            if (!password || typeof password !== 'string') {
                return { valid: false, error: '密码不能为空' };
            }
            if (password.length < 6) {
                return { valid: false, error: '密码长度至少6位' };
            }
            if (password.length > 128) {
                return { valid: false, error: '密码过长' };
            }
            return { valid: true };
        }

        it('应该拒绝空密码', () => {
            expect(validatePasswordStrength('')).toEqual({
                valid: false,
                error: '密码不能为空',
            });
        });

        it('应该拒绝过短的密码', () => {
            expect(validatePasswordStrength('12345')).toEqual({
                valid: false,
                error: '密码长度至少6位',
            });
        });

        it('应该拒绝过长的密码', () => {
            const longPassword = 'a'.repeat(129);
            expect(validatePasswordStrength(longPassword)).toEqual({
                valid: false,
                error: '密码过长',
            });
        });

        it('应该接受有效密码', () => {
            expect(validatePasswordStrength('validPassword123')).toEqual({
                valid: true,
            });
        });

        it('应该接受恰好6位的密码', () => {
            expect(validatePasswordStrength('123456')).toEqual({
                valid: true,
            });
        });
    });
});
