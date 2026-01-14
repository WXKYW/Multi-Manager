/**
 * 密码安全工具模块
 * 使用 bcrypt 进行密码哈希和验证
 */

const bcrypt = require('bcryptjs');
const { createLogger } = require('./logger');

const logger = createLogger('Password');

// bcrypt cost factor (2^12 = 4096 次迭代)
const SALT_ROUNDS = 12;

// bcrypt 哈希格式的正则表达式
const BCRYPT_HASH_REGEX = /^\$2[aby]?\$\d{1,2}\$[./A-Za-z0-9]{53}$/;

/**
 * 哈希密码
 * @param {string} plaintext - 明文密码
 * @returns {Promise<string>} 哈希后的密码
 */
async function hashPassword(plaintext) {
    if (!plaintext) {
        throw new Error('密码不能为空');
    }

    try {
        const hash = await bcrypt.hash(plaintext, SALT_ROUNDS);
        logger.debug('密码哈希成功');
        return hash;
    } catch (error) {
        logger.error('密码哈希失败:', error);
        throw new Error('密码哈希失败');
    }
}

/**
 * 同步版本的密码哈希（用于初始化场景）
 * @param {string} plaintext - 明文密码
 * @returns {string} 哈希后的密码
 */
function hashPasswordSync(plaintext) {
    if (!plaintext) {
        throw new Error('密码不能为空');
    }

    try {
        const hash = bcrypt.hashSync(plaintext, SALT_ROUNDS);
        logger.debug('密码哈希成功(sync)');
        return hash;
    } catch (error) {
        logger.error('密码哈希失败:', error);
        throw new Error('密码哈希失败');
    }
}

/**
 * 验证密码
 * @param {string} plaintext - 明文密码
 * @param {string} hash - 哈希后的密码
 * @returns {Promise<boolean>} 密码是否匹配
 */
async function verifyPassword(plaintext, hash) {
    if (!plaintext || !hash) {
        return false;
    }

    try {
        // 如果存储的是明文密码（兼容旧数据），直接比对
        if (!isHashed(hash)) {
            logger.warn('检测到明文密码，建议迁移到哈希格式');
            return plaintext === hash;
        }

        const match = await bcrypt.compare(plaintext, hash);
        return match;
    } catch (error) {
        logger.error('密码验证失败:', error);
        return false;
    }
}

/**
 * 同步版本的密码验证
 * @param {string} plaintext - 明文密码
 * @param {string} hash - 哈希后的密码
 * @returns {boolean} 密码是否匹配
 */
function verifyPasswordSync(plaintext, hash) {
    if (!plaintext || !hash) {
        return false;
    }

    try {
        // 如果存储的是明文密码（兼容旧数据），直接比对
        if (!isHashed(hash)) {
            logger.warn('检测到明文密码，建议迁移到哈希格式');
            return plaintext === hash;
        }

        return bcrypt.compareSync(plaintext, hash);
    } catch (error) {
        logger.error('密码验证失败:', error);
        return false;
    }
}

/**
 * 检查密码是否已经是哈希格式
 * @param {string} password - 密码字符串
 * @returns {boolean} 是否为哈希格式
 */
function isHashed(password) {
    if (!password || typeof password !== 'string') {
        return false;
    }
    return BCRYPT_HASH_REGEX.test(password);
}

module.exports = {
    hashPassword,
    hashPasswordSync,
    verifyPassword,
    verifyPasswordSync,
    isHashed,
    SALT_ROUNDS,
};
