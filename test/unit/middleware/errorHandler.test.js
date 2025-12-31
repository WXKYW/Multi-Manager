/**
 * 错误处理中间件测试
 * @module test/unit/middleware/errorHandler.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../../src/utils/logger', () => ({
    createLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    })),
}));

// 导入模块
import {
    AppError,
    NotFoundError,
    BadRequestError,
    UnauthorizedError,
    ForbiddenError,
    ValidationError,
    RateLimitError,
    errorHandler,
    asyncHandler,
    successResponse,
    paginatedResponse,
} from '../../../src/middleware/errorHandler.js';

// 创建模拟的 req/res/next
function createMockReq(overrides = {}) {
    return {
        method: 'GET',
        path: '/api/test',
        body: {},
        ...overrides,
    };
}

function createMockRes() {
    const res = {
        statusCode: 200,
        _json: null,
        headersSent: false,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this._json = data;
            return this;
        },
    };
    return res;
}

describe('错误类型', () => {
    describe('AppError', () => {
        it('应该创建带有正确属性的错误', () => {
            const error = new AppError('测试错误', 500, 'TEST_ERROR');

            expect(error.message).toBe('测试错误');
            expect(error.statusCode).toBe(500);
            expect(error.code).toBe('TEST_ERROR');
            expect(error.isOperational).toBe(true);
        });

        it('应该有默认值', () => {
            const error = new AppError('测试');

            expect(error.statusCode).toBe(500);
            expect(error.code).toBe('INTERNAL_ERROR');
        });
    });

    describe('NotFoundError', () => {
        it('应该有正确的状态码', () => {
            const error = new NotFoundError();

            expect(error.statusCode).toBe(404);
            expect(error.code).toBe('NOT_FOUND');
        });
    });

    describe('BadRequestError', () => {
        it('应该有正确的状态码', () => {
            const error = new BadRequestError('参数错误');

            expect(error.statusCode).toBe(400);
            expect(error.code).toBe('BAD_REQUEST');
            expect(error.message).toBe('参数错误');
        });
    });

    describe('UnauthorizedError', () => {
        it('应该有正确的状态码', () => {
            const error = new UnauthorizedError();

            expect(error.statusCode).toBe(401);
            expect(error.code).toBe('UNAUTHORIZED');
        });
    });

    describe('ForbiddenError', () => {
        it('应该有正确的状态码', () => {
            const error = new ForbiddenError();

            expect(error.statusCode).toBe(403);
            expect(error.code).toBe('FORBIDDEN');
        });
    });

    describe('ValidationError', () => {
        it('应该包含验证错误详情', () => {
            const errors = [{ field: 'email', message: '邮箱格式不正确' }];
            const error = new ValidationError('验证失败', errors);

            expect(error.statusCode).toBe(422);
            expect(error.code).toBe('VALIDATION_ERROR');
            expect(error.errors).toEqual(errors);
        });
    });

    describe('RateLimitError', () => {
        it('应该有正确的状态码', () => {
            const error = new RateLimitError();

            expect(error.statusCode).toBe(429);
            expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
        });
    });
});

describe('errorHandler 中间件', () => {
    let req, res, next;

    beforeEach(() => {
        req = createMockReq();
        res = createMockRes();
        next = vi.fn();
        process.env.NODE_ENV = 'development';
    });

    it('应该处理 AppError', () => {
        const error = new NotFoundError('资源未找到');

        errorHandler(error, req, res, next);

        expect(res.statusCode).toBe(404);
        expect(res._json.success).toBe(false);
        expect(res._json.error.code).toBe('NOT_FOUND');
    });

    it('应该处理普通 Error', () => {
        const error = new Error('普通错误');

        errorHandler(error, req, res, next);

        expect(res.statusCode).toBe(500);
        expect(res._json.success).toBe(false);
    });

    it('应该处理 JSON 解析错误', () => {
        const error = new SyntaxError('Unexpected token');
        error.status = 400;

        errorHandler(error, req, res, next);

        expect(res.statusCode).toBe(400);
        expect(res._json.error.code).toBe('INVALID_JSON');
    });

    it('开发环境应该包含堆栈信息', () => {
        process.env.NODE_ENV = 'development';
        const error = new Error('测试错误');

        errorHandler(error, req, res, next);

        expect(res._json.error.stack).toBeDefined();
    });

    it('生产环境不应该暴露内部错误详情', () => {
        process.env.NODE_ENV = 'production';
        const error = new Error('敏感信息');

        errorHandler(error, req, res, next);

        expect(res._json.error.message).toBe('服务器内部错误');
        expect(res._json.error.stack).toBeUndefined();
    });

    it('响应已发送时应该调用 next', () => {
        res.headersSent = true;
        const error = new Error('测试');

        errorHandler(error, req, res, next);

        expect(next).toHaveBeenCalledWith(error);
    });
});

describe('asyncHandler', () => {
    it('应该正常执行成功的异步函数', async () => {
        const handler = asyncHandler(async (req, res) => {
            res.json({ success: true });
        });

        const req = createMockReq();
        const res = createMockRes();
        const next = vi.fn();

        await handler(req, res, next);

        expect(res._json.success).toBe(true);
        expect(next).not.toHaveBeenCalled();
    });

    it('应该捕获异步错误并传递给 next', async () => {
        const error = new Error('异步错误');
        const handler = asyncHandler(async () => {
            throw error;
        });

        const req = createMockReq();
        const res = createMockRes();
        const next = vi.fn();

        await handler(req, res, next);

        expect(next).toHaveBeenCalledWith(error);
    });
});

describe('successResponse', () => {
    it('应该返回标准成功响应', () => {
        const res = createMockRes();
        successResponse(res, { id: 1 }, '创建成功', 201);

        expect(res.statusCode).toBe(201);
        expect(res._json.success).toBe(true);
        expect(res._json.message).toBe('创建成功');
        expect(res._json.data).toEqual({ id: 1 });
    });

    it('没有数据时不包含 data 字段', () => {
        const res = createMockRes();
        successResponse(res, null, '操作成功');

        expect(res._json.data).toBeUndefined();
    });
});

describe('paginatedResponse', () => {
    it('应该返回带分页信息的响应', () => {
        const res = createMockRes();
        const data = [{ id: 1 }, { id: 2 }];
        const pagination = { page: 1, pageSize: 10, total: 25 };

        paginatedResponse(res, data, pagination);

        expect(res._json.success).toBe(true);
        expect(res._json.data).toEqual(data);
        expect(res._json.pagination.page).toBe(1);
        expect(res._json.pagination.pageSize).toBe(10);
        expect(res._json.pagination.total).toBe(25);
        expect(res._json.pagination.totalPages).toBe(3);
    });
});
