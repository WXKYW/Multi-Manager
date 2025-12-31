/**
 * 通用内存缓存工具 (基于 lru-cache)
 */

const { LRUCache } = require('lru-cache');

// 默认缓存配置
const options = {
    max: 500, // 最大条数
    // 条目最大存活时间 (TTL)，单位毫秒
    ttl: 1000 * 60 * 10, // 默认 10 分钟
    // 是否允许在条目过期后返回 (在静默后台刷新前)
    allowStale: false,
    updateAgeOnGet: false,
    updateAgeOnHas: false,
};

// 全局单例缓存
const cache = new LRUCache(options);

/**
 * 获取或设置缓存 (计算属性缓存模式)
 * @param {string} key - 缓存键
 * @param {Function} fetchFn - 缓存失效时获取数据的异步函数
 * @param {number} ttl - 可选的特定 TTL
 */
async function getOrSet(key, fetchFn, ttl = null) {
    const cached = cache.get(key);
    if (cached !== undefined) {
        return cached;
    }

    const result = await fetchFn();
    if (result !== undefined) {
        cache.set(key, result, ttl ? { ttl } : undefined);
    }
    return result;
}

module.exports = {
    cache,
    getOrSet,
    // 导出不同场景的预设缓存
    apiCache: new LRUCache({ ...options, max: 200, ttl: 1000 * 60 * 5 }), // API 响应缓存 5 分钟
    userCache: new LRUCache({ ...options, max: 100, ttl: 1000 * 60 * 30 }), // 用户数据缓存 30 分钟
};
