/**
 * 测试工具函数和 Mock 数据
 */

/**
 * 创建模拟的 Express 请求对象
 */
export function createMockRequest(options = {}) {
    return {
        body: options.body || {},
        params: options.params || {},
        query: options.query || {},
        headers: options.headers || {},
        cookies: options.cookies || {},
        method: options.method || 'GET',
        path: options.path || '/',
        session: options.session || {},
        get: function (header) {
            return this.headers[header.toLowerCase()];
        },
    };
}

/**
 * 创建模拟的 Express 响应对象
 */
export function createMockResponse() {
    const res = {
        _status: 200,
        _json: null,
        _headers: {},
        _cookies: {},

        status(code) {
            this._status = code;
            return this;
        },
        json(data) {
            this._json = data;
            return this;
        },
        send(data) {
            this._data = data;
            return this;
        },
        setHeader(name, value) {
            this._headers[name] = value;
            return this;
        },
        cookie(name, value, options) {
            this._cookies[name] = { value, options };
            return this;
        },
        clearCookie(name) {
            delete this._cookies[name];
            return this;
        },
    };
    return res;
}

/**
 * 测试用的模拟账号数据
 */
export const mockAccounts = {
    admin: {
        id: 'test-admin-001',
        username: 'admin',
        password: 'test123',
        role: 'admin',
    },
    user: {
        id: 'test-user-001',
        username: 'testuser',
        password: 'user123',
        role: 'user',
    },
};

/**
 * 测试用的模拟服务器数据
 */
export const mockServers = [
    {
        id: 'server-001',
        name: 'Test Server 1',
        host: '192.168.1.100',
        port: 22,
        username: 'root',
        status: 'online',
        tags: ['production'],
    },
    {
        id: 'server-002',
        name: 'Test Server 2',
        host: '192.168.1.101',
        port: 22,
        username: 'admin',
        status: 'offline',
        tags: ['development'],
    },
];

/**
 * 等待指定毫秒数
 */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 生成随机字符串
 */
export function randomString(length = 8) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
