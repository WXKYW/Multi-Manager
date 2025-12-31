/**
 * 加密工具模块测试
 * @module test/unit/utils/encryption.test
 */

import { describe, it, expect, beforeAll } from 'vitest';

// 需要在导入模块前设置环境变量
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-vitest-32b';

// 动态导入以确保环境变量已设置
let encrypt, decrypt;

beforeAll(async () => {
    const encryption = await import('../../../src/utils/encryption.js');
    encrypt = encryption.encrypt;
    decrypt = encryption.decrypt;
});

describe('encryption 模块', () => {
    describe('encrypt 函数', () => {
        it('应该成功加密文本', () => {
            const plainText = 'Hello, World!';
            const encrypted = encrypt(plainText);

            expect(encrypted).toBeDefined();
            expect(encrypted).not.toBe(plainText);
            expect(encrypted.split(':')).toHaveLength(3); // iv:authTag:data
        });

        it('应该对空字符串返回空字符串', () => {
            expect(encrypt('')).toBe('');
            expect(encrypt(null)).toBe('');
            expect(encrypt(undefined)).toBe('');
        });

        it('应该能加密中文文本', () => {
            const chineseText = '这是一段中文测试文本';
            const encrypted = encrypt(chineseText);

            expect(encrypted).toBeDefined();
            expect(encrypted.split(':')).toHaveLength(3);
        });

        it('应该能加密特殊字符', () => {
            const specialChars = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
            const encrypted = encrypt(specialChars);

            expect(encrypted).toBeDefined();
            expect(encrypted.split(':')).toHaveLength(3);
        });

        it('每次加密应该产生不同的结果（随机 IV）', () => {
            const plainText = 'Same text';
            const encrypted1 = encrypt(plainText);
            const encrypted2 = encrypt(plainText);

            expect(encrypted1).not.toBe(encrypted2);
        });
    });

    describe('decrypt 函数', () => {
        it('应该成功解密文本', () => {
            const plainText = 'Hello, World!';
            const encrypted = encrypt(plainText);
            const decrypted = decrypt(encrypted);

            expect(decrypted).toBe(plainText);
        });

        it('应该对空字符串返回空字符串', () => {
            expect(decrypt('')).toBe('');
            expect(decrypt(null)).toBe('');
            expect(decrypt(undefined)).toBe('');
        });

        it('应该能正确解密中文文本', () => {
            const chineseText = '这是一段中文测试文本，包含标点符号！';
            const encrypted = encrypt(chineseText);
            const decrypted = decrypt(encrypted);

            expect(decrypted).toBe(chineseText);
        });

        it('应该能正确解密特殊字符', () => {
            const specialChars = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`\n\t\r';
            const encrypted = encrypt(specialChars);
            const decrypted = decrypt(encrypted);

            expect(decrypted).toBe(specialChars);
        });

        it('应该在格式错误时抛出异常', () => {
            expect(() => decrypt('invalid-format')).toThrow('解密失败');
            expect(() => decrypt('only:two')).toThrow('解密失败');
        });

        it('应该在数据被篡改时抛出异常', () => {
            const plainText = 'Original text';
            const encrypted = encrypt(plainText);
            const parts = encrypted.split(':');

            // 篡改加密数据
            const tamperedData = parts[0] + ':' + parts[1] + ':' + 'tampered' + parts[2];

            expect(() => decrypt(tamperedData)).toThrow();
        });
    });

    describe('加密解密往返测试', () => {
        const testCases = [
            'Simple text',
            '中文文本',
            '混合 Mixed 内容 123',
            'JSON: {"key": "value", "number": 123}',
            'Very long text '.repeat(100),
            'Unicode: 🎉🚀💻',
        ];

        testCases.forEach((testCase, index) => {
            it(`应该能正确处理测试用例 #${index + 1}`, () => {
                const encrypted = encrypt(testCase);
                const decrypted = decrypt(encrypted);
                expect(decrypted).toBe(testCase);
            });
        });
    });
});
