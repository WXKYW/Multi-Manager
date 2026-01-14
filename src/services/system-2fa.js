/**
 * 系统登录双因素认证 (2FA) 服务
 * 使用 TOTP 算法实现
 */

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { SystemConfig } = require('../db/models');
const { encrypt, decrypt } = require('../utils/encryption');
const { createLogger } = require('../utils/logger');

const logger = createLogger('System2FA');

// 应用名称（显示在 Authenticator App 中）
const APP_NAME = 'API-Monitor';

/**
 * 获取 2FA 状态
 * @returns {Object} { enabled: boolean }
 */
function get2FAStatus() {
    try {
        const enabled = SystemConfig.getConfigValue('system_2fa_enabled');
        return {
            enabled: enabled === 'true' || enabled === true,
        };
    } catch (error) {
        logger.error('获取 2FA 状态失败:', error);
        return { enabled: false };
    }
}

/**
 * 生成新的 2FA 密钥和二维码
 * @param {string} label - 用户标识（如邮箱）
 * @returns {Promise<Object>} { secret, qrCodeDataUrl, otpauthUrl }
 */
async function generate2FASecret(label = 'admin') {
    try {
        // 生成密钥
        const secret = speakeasy.generateSecret({
            name: `${APP_NAME}:${label}`,
            issuer: APP_NAME,
            length: 20,
        });

        // 生成二维码 Data URL
        const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);

        logger.info('已生成新的 2FA 密钥');

        return {
            secret: secret.base32,
            qrCodeDataUrl,
            otpauthUrl: secret.otpauth_url,
        };
    } catch (error) {
        logger.error('生成 2FA 密钥失败:', error);
        throw new Error('生成 2FA 密钥失败');
    }
}

/**
 * 验证 TOTP 验证码
 * @param {string} secret - Base32 编码的密钥
 * @param {string} token - 6 位验证码
 * @returns {boolean} 是否验证通过
 */
function verifyToken(secret, token) {
    if (!secret || !token) {
        return false;
    }

    try {
        const verified = speakeasy.totp.verify({
            secret: secret,
            encoding: 'base32',
            token: token.replace(/\s/g, ''), // 移除空格
            window: 1, // 允许前后 30 秒的误差
        });

        return verified;
    } catch (error) {
        logger.error('验证 2FA 失败:', error);
        return false;
    }
}

/**
 * 启用 2FA
 * @param {string} secret - Base32 编码的密钥
 * @param {string} token - 用户输入的验证码（用于确认）
 * @returns {boolean} 是否启用成功
 */
function enable2FA(secret, token) {
    // 先验证一次，确保用户正确设置了 Authenticator
    if (!verifyToken(secret, token)) {
        logger.warn('启用 2FA 失败: 验证码错误');
        return false;
    }

    try {
        // 加密存储密钥
        const encryptedSecret = encrypt(secret);
        SystemConfig.setConfig('system_2fa_secret', encryptedSecret, '系统 2FA 密钥(加密)');
        SystemConfig.setConfig('system_2fa_enabled', 'true', '系统 2FA 启用状态');

        logger.info('系统 2FA 已启用');
        return true;
    } catch (error) {
        logger.error('启用 2FA 失败:', error);
        return false;
    }
}

/**
 * 禁用 2FA
 * @returns {boolean} 是否禁用成功
 */
function disable2FA() {
    try {
        SystemConfig.setConfig('system_2fa_enabled', 'false', '系统 2FA 启用状态');
        SystemConfig.deleteConfig('system_2fa_secret');

        logger.info('系统 2FA 已禁用');
        return true;
    } catch (error) {
        logger.error('禁用 2FA 失败:', error);
        return false;
    }
}

/**
 * 验证登录时的 2FA 验证码
 * @param {string} token - 6 位验证码
 * @returns {boolean} 是否验证通过
 */
function verifyLogin2FA(token) {
    try {
        const encryptedSecret = SystemConfig.getConfigValue('system_2fa_secret');
        if (!encryptedSecret) {
            logger.warn('2FA 密钥不存在');
            return false;
        }

        const secret = decrypt(encryptedSecret);
        return verifyToken(secret, token);
    } catch (error) {
        logger.error('验证登录 2FA 失败:', error);
        return false;
    }
}

/**
 * 检查是否已启用 2FA
 * @returns {boolean}
 */
function is2FAEnabled() {
    return get2FAStatus().enabled;
}

module.exports = {
    get2FAStatus,
    generate2FASecret,
    verifyToken,
    enable2FA,
    disable2FA,
    verifyLogin2FA,
    is2FAEnabled,
};
