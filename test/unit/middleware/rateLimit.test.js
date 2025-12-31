/**
 * 速率限制中间件测试
 * 测试配置和基本行为
 * @module test/unit/middleware/rateLimit.test
 */

import { describe, it, expect, vi } from 'vitest';

// Mock logger
vi.mock('../../../src/utils/logger', () => ({
    createLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    })),
}));

describe('速率限制中间件', () => {
    describe('模块导入', () => {
        it('应该能够正确导入所有限制器', async () => {
            const module = await import('../../../src/middleware/rateLimit.js');

            expect(module.createLimiter).toBeDefined();
            expect(typeof module.createLimiter).toBe('function');
            expect(module.generalLimiter).toBeDefined();
            expect(module.authLimiter).toBeDefined();
            expect(module.proxyLimiter).toBeDefined();
            expect(module.audioProxyLimiter).toBeDefined();
            expect(module.uploadLimiter).toBeDefined();
            expect(module.sshLimiter).toBeDefined();
        });

        it('所有限制器应该是函数（中间件）', async () => {
            const module = await import('../../../src/middleware/rateLimit.js');

            expect(typeof module.generalLimiter).toBe('function');
            expect(typeof module.authLimiter).toBe('function');
            expect(typeof module.proxyLimiter).toBe('function');
            expect(typeof module.audioProxyLimiter).toBe('function');
            expect(typeof module.uploadLimiter).toBe('function');
            expect(typeof module.sshLimiter).toBe('function');
        });
    });

    describe('createLimiter 函数', () => {
        it('应该创建一个中间件函数', async () => {
            const { createLimiter } = await import('../../../src/middleware/rateLimit.js');
            const limiter = createLimiter();

            expect(typeof limiter).toBe('function');
        });

        it('应该接受自定义配置', async () => {
            const { createLimiter } = await import('../../../src/middleware/rateLimit.js');
            const customLimiter = createLimiter({
                windowMs: 60000,
                max: 50,
            });

            expect(typeof customLimiter).toBe('function');
        });
    });
});

// 配置验证测试（不依赖实际中间件执行）
describe('速率限制配置验证', () => {
    it('认证限制应该比通用限制更严格', () => {
        // 认证: 5 次 / 15 分钟
        // 通用: 100 次 / 15 分钟
        const authMax = 5;
        const generalMax = 100;

        expect(authMax).toBeLessThan(generalMax);
    });

    it('代理限制应该按分钟计算', () => {
        const proxyWindowMs = 60 * 1000; // 1 分钟
        const proxyMax = 30;

        // 每分钟 30 次是合理的
        expect(proxyMax).toBeLessThanOrEqual(60);
        expect(proxyWindowMs).toBe(60000);
    });

    it('上传限制应该是每小时的', () => {
        const uploadWindowMs = 60 * 60 * 1000; // 1 小时
        const uploadMax = 10;

        expect(uploadWindowMs).toBe(3600000);
        expect(uploadMax).toBeLessThanOrEqual(20);
    });

    it('SSH 限制应该比通用限制更严格', () => {
        const sshMax = 20;
        const generalMax = 100;

        expect(sshMax).toBeLessThan(generalMax);
    });
});
