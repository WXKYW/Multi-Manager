/**
 * 数据库预解析语句缓存 (Prepared Statement Cache)
 * 提高频繁执行的 SQL 语句的性能
 */

const dbService = require('./database');
const { createLogger } = require('../utils/logger');

const logger = createLogger('DbCache');

// 语句缓存 Map
const statementCache = new Map();

/**
 * 获取预解析语句
 * @param {string} sql - SQL 语句
 * @returns {Object} Better-SQLite3 Statement 对象
 */
function getStatement(sql) {
    if (!statementCache.has(sql)) {
        try {
            const db = dbService.getDatabase();
            const stmt = db.prepare(sql);
            statementCache.set(sql, stmt);
            logger.debug(`Cached new statement: ${sql.substring(0, 50)}${sql.length > 50 ? '...' : ''}`);
        } catch (error) {
            logger.error(`Failed to prepare statement: ${sql}`, error.message);
            throw error;
        }
    }
    return statementCache.get(sql);
}

/**
 * 执行查询并返回所有结果 (all)
 * @param {string} sql 
 * @param  {...any} params 
 */
function queryAll(sql, ...params) {
    return getStatement(sql).all(...params);
}

/**
 * 执行查询并返回单个结果 (get)
 * @param {string} sql 
 * @param  {...any} params 
 */
function queryOne(sql, ...params) {
    return getStatement(sql).get(...params);
}

/**
 * 执行更新/插入操作 (run)
 * @param {string} sql 
 * @param  {...any} params 
 */
function execute(sql, ...params) {
    return getStatement(sql).run(...params);
}

/**
 * 清空缓存
 * 在数据库结构变更或重启时调用
 */
function clearCache() {
    statementCache.clear();
    logger.info('Statement cache cleared');
}

module.exports = {
    getStatement,
    queryAll,
    queryOne,
    execute,
    clearCache,
};
