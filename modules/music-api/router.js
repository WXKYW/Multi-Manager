/**
 * Music API 模块 - 网易云音乐代理
 * 使用 @neteasecloudmusicapienhanced/api 和 @unblockneteasemusic/server
 * Cookie 存储于数据库
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const { createLogger } = require('../../src/utils/logger');
const dbService = require('../../src/db/database');

const logger = createLogger('Music');

// NCM API 库 (使用 npm 包)
let ncmApi = null;
let storedCookie = '';

/**
 * 加载 NCM API 库
 */
function loadNcmApi() {
    if (ncmApi) return ncmApi;

    try {
        ncmApi = require('@neteasecloudmusicapienhanced/api');
        logger.success('NCM API loaded from npm package');
        return ncmApi;
    } catch (error) {
        logger.error('Failed to load NCM API:', error.message);
        logger.warn('Please install: npm install @neteasecloudmusicapienhanced/api');
        return null;
    }
}

/**
 * 加载存储的 Cookie (从数据库)
 */
function loadStoredCookie() {
    try {
        const db = dbService.getDatabase();
        const row = db.prepare('SELECT value FROM music_settings WHERE key = ?').get('cookie');
        if (row && row.value) {
            storedCookie = row.value;
            logger.info('Loaded stored cookie from database, length:', storedCookie.length);
        } else {
            logger.info('No cookie found in database');
        }
    } catch (error) {
        logger.error('Failed to load cookie from database:', error.message);
    }
    return storedCookie;
}

/**
 * 保存 Cookie 到数据库
 */
function saveCookie(cookieString) {
    try {
        const db = dbService.getDatabase();
        db.prepare(`
            INSERT INTO music_settings (key, value, updated_at) 
            VALUES ('cookie', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(cookieString);
        storedCookie = cookieString;
        logger.success('Cookie saved to database');
    } catch (error) {
        logger.error('Failed to save cookie to database:', error.message);
    }
}

/**
 * 清除存储的 Cookie
 */
function clearCookie() {
    storedCookie = '';
    try {
        const db = dbService.getDatabase();
        db.prepare('DELETE FROM music_settings WHERE key = ?').run('cookie');
        logger.info('Cookie cleared from database');
    } catch (error) {
        logger.warn('Failed to clear cookie from database:', error.message);
    }
}

/**
 * 获取当前有效的 Cookie
 */
function getEffectiveCookie(reqCookieHeader) {
    // 优先使用服务器存储的 Cookie
    if (storedCookie) {
        return storedCookie;
    }
    // 兼容浏览器 Cookie
    return reqCookieHeader || '';
}

// 初始化
loadNcmApi();
loadStoredCookie();

/**
 * 通用请求处理器
 */
async function handleRequest(moduleName, req, res) {
    const api = loadNcmApi();

    if (!api || typeof api[moduleName] !== 'function') {
        return res.status(404).json({
            code: 404,
            message: `API method ${moduleName} not found`
        });
    }

    try {
        const query = {
            ...req.query,
            ...req.body,
            cookie: getEffectiveCookie(req.headers.cookie)
        };

        const result = await api[moduleName](query);

        // 如果返回新的 Cookie，保存到服务器
        if (result.cookie && Array.isArray(result.cookie)) {
            const cookieStr = result.cookie.join('; ');
            if (cookieStr) {
                saveCookie(cookieStr);
            }
        }

        res.status(result.status || 200).json(result.body);
    } catch (error) {
        logger.error(`${moduleName} error:`, error.message || error);

        if (error.status && error.body) {
            return res.status(error.status).json(error.body);
        }

        res.status(500).json({
            code: 500,
            message: error.message || 'Internal server error'
        });
    }
}

// ==================== 搜索 API ====================

router.get('/search', (req, res) => handleRequest('cloudsearch', req, res));
router.get('/search/suggest', (req, res) => handleRequest('search_suggest', req, res));
router.get('/search/hot', (req, res) => handleRequest('search_hot_detail', req, res));

// ==================== 歌曲 API ====================

/**
 * 获取歌曲播放地址 (自动解锁)
 */
router.get('/song/url', async (req, res) => {
    const api = loadNcmApi();
    const { id, level = 'exhigh', unblock = 'true' } = req.query;

    if (!id) {
        return res.status(400).json({ code: 400, message: 'Missing song id' });
    }

    if (!api || typeof api.song_url_v1 !== 'function') {
        return res.status(500).json({ code: 500, message: 'NCM API not available' });
    }

    try {
        const query = {
            id,
            level,
            cookie: getEffectiveCookie(req.headers.cookie)
        };

        const result = await api.song_url_v1(query);
        const song = result.body?.data?.[0];

        const needUnblock = !song?.url ||
            song.freeTrialInfo !== null ||
            [1, 4].includes(song.fee);

        if (needUnblock && unblock !== 'false') {
            logger.info(`Song ${id} needs unblock, trying...`);

            try {
                const match = require('@unblockneteasemusic/server');
                const sources = ['bodian'];
                const unblocked = await match(Number(id), sources);

                if (unblocked && unblocked.url) {
                    logger.success(`Song ${id} unblocked from ${unblocked.source}`);

                    if (song) {
                        song.url = unblocked.url;
                        song.br = unblocked.br || 320000;
                        song.size = unblocked.size || song.size;
                        song.freeTrialInfo = null;
                        song.source = unblocked.source;
                    } else if (result.body?.data) {
                        result.body.data[0] = {
                            id: Number(id),
                            url: unblocked.url,
                            br: unblocked.br || 320000,
                            size: unblocked.size || 0,
                            md5: unblocked.md5 || null,
                            code: 200,
                            type: 'unblock',
                            source: unblocked.source
                        };
                    }
                }
            } catch (unlockErr) {
                logger.warn(`Unblock failed for ${id}:`, unlockErr.message);
            }
        }

        if (result.cookie && Array.isArray(result.cookie)) {
            res.set('Set-Cookie', result.cookie);
        }

        res.status(result.status || 200).json(result.body);
    } catch (error) {
        logger.error('song/url error:', error.message || error);

        if (error.status && error.body) {
            return res.status(error.status).json(error.body);
        }

        res.status(500).json({
            code: 500,
            message: error.message || 'Internal server error'
        });
    }
});

router.get('/song/detail', (req, res) => handleRequest('song_detail', req, res));

/**
 * 使用解锁服务获取歌曲 URL
 */
router.get('/song/url/unblock', async (req, res) => {
    const { id, source } = req.query;

    if (!id) {
        return res.status(400).json({ code: 400, message: 'Missing song id' });
    }

    try {
        const match = require('@unblockneteasemusic/server');
        const sources = source ? source.split(',') : ['bodian'];

        logger.info(`Unblock: trying to match song ${id} with sources:`, sources);

        const result = await match(Number(id), sources);

        if (result && result.url) {
            logger.success(`Unblock: matched song ${id} from ${result.source}`);
            res.json({
                code: 200,
                data: {
                    id: Number(id),
                    url: result.url,
                    br: result.br || 320000,
                    size: result.size || 0,
                    md5: result.md5 || null,
                    source: result.source || 'unknown'
                }
            });
        } else {
            res.status(404).json({
                code: 404,
                message: 'No available source'
            });
        }
    } catch (error) {
        const errMsg = error?.message || (typeof error === 'string' ? error : 'Unblock failed');
        logger.error('Unblock error:', errMsg);
        res.status(500).json({
            code: 500,
            message: errMsg
        });
    }
});

// ==================== 歌词 API ====================

router.get('/lyric', (req, res) => handleRequest('lyric_new', req, res));

// ==================== 歌单 API ====================

router.get('/playlist/detail', (req, res) => handleRequest('playlist_detail', req, res));
router.get('/top/playlist', (req, res) => handleRequest('top_playlist', req, res));
router.get('/top/playlist/highquality', (req, res) => handleRequest('top_playlist_highquality', req, res));
router.get('/playlist/catlist', (req, res) => handleRequest('playlist_catlist', req, res));

// ==================== 推荐 API ====================

router.get('/recommend/songs', (req, res) => handleRequest('recommend_songs', req, res));
router.get('/personalized', (req, res) => handleRequest('personalized', req, res));
router.get('/personalized/newsong', (req, res) => handleRequest('personalized_newsong', req, res));
router.get('/personal/fm', (req, res) => handleRequest('personal_fm', req, res));

// ==================== 排行榜 API ====================

router.get('/toplist', (req, res) => handleRequest('toplist', req, res));
router.get('/toplist/detail', (req, res) => handleRequest('toplist_detail', req, res));

// ==================== 歌手 API ====================

router.get('/artist/detail', (req, res) => handleRequest('artist_detail', req, res));
router.get('/artist/top/song', (req, res) => handleRequest('artist_top_song', req, res));
router.get('/artist/album', (req, res) => handleRequest('artist_album', req, res));

// ==================== 专辑 API ====================

router.get('/album', (req, res) => handleRequest('album', req, res));
router.get('/album/detail', (req, res) => handleRequest('album_detail', req, res));

// ==================== MV API ====================

router.get('/mv/detail', (req, res) => handleRequest('mv_detail', req, res));
router.get('/mv/url', (req, res) => handleRequest('mv_url', req, res));

// ==================== 用户 API ====================

router.get('/user/playlist', (req, res) => handleRequest('user_playlist', req, res));
router.get('/user/record', (req, res) => handleRequest('user_record', req, res));
router.get('/likelist', (req, res) => handleRequest('likelist', req, res));
router.get('/login/status', (req, res) => handleRequest('login_status', req, res));
router.get('/login/qr/key', (req, res) => handleRequest('login_qr_key', req, res));
router.get('/login/qr/create', (req, res) => handleRequest('login_qr_create', req, res));
router.get('/login/qr/check', async (req, res) => {
    const api = loadNcmApi();

    if (!api || typeof api.login_qr_check !== 'function') {
        return res.status(404).json({ code: 404, message: 'API method not found' });
    }

    try {
        const query = {
            ...req.query,
            cookie: getEffectiveCookie(req.headers.cookie)
        };

        const result = await api.login_qr_check(query);

        // 登录成功 (code 803) 时保存 Cookie
        if (result.body?.code === 803) {
            logger.info('[Music] 扫码登录成功，正在提取并持久化 Cookie...');

            let cookieStr = '';

            // 1. 优先从 api 直接返回的 cookie 字段提取 (通常是字符串数组)
            if (result.cookie) {
                const rawCookies = Array.isArray(result.cookie) ? result.cookie : [result.cookie];
                cookieStr = rawCookies.join('; ');
            }

            // 2. 如果第一步没拿到，检查 body 里的 cookie (兼容模式)
            if (!cookieStr && result.body?.cookie) {
                cookieStr = result.body.cookie;
            }

            if (cookieStr) {
                saveCookie(cookieStr);
                logger.success('[Music] 登录态已持久化到服务器数据库');
            } else {
                logger.error('[Music] 登录成功但未提取到有效 Cookie');
            }
        }

        res.status(result.status || 200).json(result.body);
    } catch (error) {
        logger.error('login_qr_check error:', error.message || error);
        res.status(500).json({ code: 500, message: error.message || 'Internal server error' });
    }
});

/**
 * 退出登录 - 清除服务器存储的 Cookie
 */
router.post('/logout', (req, res) => {
    clearCookie();
    res.json({ code: 200, message: 'Logged out successfully' });
});

/**
 * 获取登录状态（包含存储的 Cookie 状态）
 */
router.get('/auth/status', async (req, res) => {
    const api = loadNcmApi();

    // 每次检查时从数据库刷新 Cookie（确保使用最新的）
    loadStoredCookie();

    logger.debug('Auth status check, storedCookie length:', storedCookie ? storedCookie.length : 0);

    if (!storedCookie) {
        return res.json({
            code: 200,
            loggedIn: false,
            hasStoredCookie: false
        });
    }

    try {
        const result = await api.login_status({ cookie: storedCookie });
        const profile = result.body?.data?.profile;

        if (profile) {
            res.json({
                code: 200,
                loggedIn: true,
                hasStoredCookie: true,
                user: {
                    userId: profile.userId,
                    nickname: profile.nickname,
                    avatarUrl: profile.avatarUrl,
                    vipType: profile.vipType || 0
                }
            });
        } else {
            logger.warn('Cookie exists but no profile returned');
            res.json({
                code: 200,
                loggedIn: false,
                hasStoredCookie: true,
                message: 'Cookie expired'
            });
        }
    } catch (error) {
        logger.error('Auth status error:', error.message);
        res.json({
            code: 200,
            loggedIn: false,
            hasStoredCookie: true,
            error: error.message
        });
    }
});

// ==================== 健康检查 ====================

router.get('/health', (req, res) => {
    const api = loadNcmApi();

    res.json({
        status: 'ok',
        modulesLoaded: !!api,
        moduleCount: api ? Object.keys(api).filter(k => typeof api[k] === 'function').length : 0,
        hasStoredCookie: !!storedCookie,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;

