/**
 * 流媒体播放器模块 (Stream Player)
 * 
 * 功能:
 * - 支持多种视频格式 (MP4, WebM, MKV, HLS, FLV, DASH)
 * - 按需动态加载解码库 (hls.js, flv.js, dash.js)
 * - FFmpeg.wasm 转码支持 (AVI, WMV, RMVB 等)
 * - 沉浸式全屏播放体验
 * - 快捷键控制
 * 
 * @module stream-player
 */

import { store } from '../store.js';
import { toast } from './toast.js';

// ==================== 配置常量 ====================

/**
 * 播放器配置
 */
const PLAYER_CONFIG = {
    // 可直接播放的格式 (浏览器原生支持)
    NATIVE_FORMATS: ['mp4', 'webm', 'ogg', 'mov'],

    // 需要 hls.js 的格式
    HLS_FORMATS: ['m3u8'],

    // 需要 flv.js 的格式
    FLV_FORMATS: ['flv'],

    // 需要 dash.js 的格式
    DASH_FORMATS: ['mpd'],

    // 可能可以直接播放的格式 (取决于编码)
    MAYBE_NATIVE: ['mkv', 'ts'],

    // 需要转码的格式
    TRANSCODE_FORMATS: ['avi', 'wmv', 'rmvb', 'rm', 'asf', 'vob', '3gp'],

    // CDN 地址 (使用 npmmirror)
    CDN: {
        hlsjs: 'https://registry.npmmirror.com/hls.js/1.5.7/files/dist/hls.min.js',
        flvjs: 'https://registry.npmmirror.com/flv.js/1.6.2/files/dist/flv.min.js',
        dashjs: 'https://registry.npmmirror.com/dashjs/4.7.4/files/dist/dash.all.min.js',
        ffmpeg_core: 'https://registry.npmmirror.com/@ffmpeg/core/0.12.6/files/dist/umd/ffmpeg-core.js',
        ffmpeg_wasm: 'https://registry.npmmirror.com/@ffmpeg/core/0.12.6/files/dist/umd/ffmpeg-core.wasm'
    },

    // 转码预设
    TRANSCODE_PRESETS: {
        fast: {
            name: '快速预览',
            description: '480p, 快速转码',
            args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-vf', 'scale=-2:480', '-c:a', 'aac', '-b:a', '128k']
        },
        balanced: {
            name: '平衡',
            description: '720p, 推荐',
            args: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-vf', 'scale=-2:720', '-c:a', 'aac', '-b:a', '192k']
        },
        quality: {
            name: '高质量',
            description: '原始分辨率',
            args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '256k']
        }
    }
};

// ==================== 状态管理 ====================

/**
 * 播放器状态 (模块内部状态，不放入全局 store)
 */
const playerState = {
    // 当前播放器实例
    videoElement: null,
    hlsInstance: null,
    flvPlayer: null,
    dashPlayer: null,

    // FFmpeg 实例
    ffmpeg: null,
    ffmpegLoaded: false,
    ffmpegLoading: false,

    // 库加载状态
    libsLoaded: {
        hls: false,
        flv: false,
        dash: false
    },

    // 当前播放信息
    currentFile: null,
    currentUrl: null,
    isPlaying: false,
    isFullscreen: false,

    // 转码状态
    transcoding: false,
    transcodeProgress: 0,

    // 用户偏好 (可持久化)
    userPreferences: {
        defaultTranscodeAction: 'ask', // 'ask', 'transcode', 'download'
        transcodePreset: 'balanced',
        volume: 1,
        playbackRate: 1
    }
};

// ==================== 工具函数 ====================

/**
 * 获取文件扩展名
 * @param {string} filename - 文件名
 * @returns {string} 小写扩展名
 */
function getFileExtension(filename) {
    if (!filename) return '';
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

/**
 * 判断格式类型
 * @param {string} ext - 文件扩展名
 * @returns {'native'|'hls'|'flv'|'dash'|'maybe'|'transcode'|'unknown'}
 */
function getFormatType(ext) {
    if (PLAYER_CONFIG.NATIVE_FORMATS.includes(ext)) return 'native';
    if (PLAYER_CONFIG.HLS_FORMATS.includes(ext)) return 'hls';
    if (PLAYER_CONFIG.FLV_FORMATS.includes(ext)) return 'flv';
    if (PLAYER_CONFIG.DASH_FORMATS.includes(ext)) return 'dash';
    if (PLAYER_CONFIG.MAYBE_NATIVE.includes(ext)) return 'maybe';
    if (PLAYER_CONFIG.TRANSCODE_FORMATS.includes(ext)) return 'transcode';
    return 'unknown';
}

/**
 * 动态加载 JS 库
 * @param {string} url - 库的 URL
 * @param {string} globalName - 全局变量名 (用于检测是否已加载)
 * @returns {Promise<void>}
 */
function loadScript(url, globalName) {
    return new Promise((resolve, reject) => {
        // 检查是否已加载
        if (globalName && window[globalName]) {
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load: ${url}`));
        document.head.appendChild(script);
    });
}

/**
 * 格式化时间
 * @param {number} seconds - 秒数
 * @returns {string} 格式化的时间字符串
 */
function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ==================== 库加载器 ====================

/**
 * 加载 HLS.js
 */
async function loadHlsJs() {
    if (playerState.libsLoaded.hls || window.Hls) {
        playerState.libsLoaded.hls = true;
        return;
    }

    await loadScript(PLAYER_CONFIG.CDN.hlsjs, 'Hls');
    playerState.libsLoaded.hls = true;
    console.log('[StreamPlayer] HLS.js loaded');
}

/**
 * 加载 FLV.js
 */
async function loadFlvJs() {
    if (playerState.libsLoaded.flv || window.flvjs) {
        playerState.libsLoaded.flv = true;
        return;
    }

    await loadScript(PLAYER_CONFIG.CDN.flvjs, 'flvjs');
    playerState.libsLoaded.flv = true;
    console.log('[StreamPlayer] flv.js loaded');
}

/**
 * 加载 Dash.js
 */
async function loadDashJs() {
    if (playerState.libsLoaded.dash || window.dashjs) {
        playerState.libsLoaded.dash = true;
        return;
    }

    await loadScript(PLAYER_CONFIG.CDN.dashjs, 'dashjs');
    playerState.libsLoaded.dash = true;
    console.log('[StreamPlayer] dash.js loaded');
}

// ==================== 播放器核心 ====================

/**
 * 销毁当前播放器实例
 */
function destroyPlayer() {
    if (playerState.hlsInstance) {
        playerState.hlsInstance.destroy();
        playerState.hlsInstance = null;
    }

    if (playerState.flvPlayer) {
        playerState.flvPlayer.unload();
        playerState.flvPlayer.detachMediaElement();
        playerState.flvPlayer.destroy();
        playerState.flvPlayer = null;
    }

    if (playerState.dashPlayer) {
        playerState.dashPlayer.reset();
        playerState.dashPlayer = null;
    }

    if (playerState.videoElement) {
        playerState.videoElement.pause();
        playerState.videoElement.src = '';
        playerState.videoElement.load();
    }

    playerState.isPlaying = false;
    playerState.currentFile = null;
    playerState.currentUrl = null;
}

/**
 * 原生播放
 * @param {HTMLVideoElement} video - 视频元素
 * @param {string} url - 视频 URL
 */
async function playNative(video, url) {
    video.src = url;
    await video.play();
    playerState.isPlaying = true;
}

/**
 * HLS 播放
 * @param {HTMLVideoElement} video - 视频元素
 * @param {string} url - m3u8 URL
 */
async function playHls(video, url) {
    await loadHlsJs();

    if (window.Hls.isSupported()) {
        const hls = new window.Hls({
            enableWorker: true,
            lowLatencyMode: false
        });

        hls.loadSource(url);
        hls.attachMedia(video);

        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
            video.play();
            playerState.isPlaying = true;
        });

        hls.on(window.Hls.Events.ERROR, (event, data) => {
            console.error('[StreamPlayer] HLS error:', data);
            if (data.fatal) {
                toast.error('HLS 播放失败: ' + data.type);
            }
        });

        playerState.hlsInstance = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari 原生支持 HLS
        video.src = url;
        await video.play();
        playerState.isPlaying = true;
    } else {
        throw new Error('浏览器不支持 HLS 播放');
    }
}

/**
 * FLV 播放
 * @param {HTMLVideoElement} video - 视频元素
 * @param {string} url - FLV URL
 */
async function playFlv(video, url) {
    await loadFlvJs();

    if (!window.flvjs.isSupported()) {
        throw new Error('浏览器不支持 FLV 播放');
    }

    const flvPlayer = window.flvjs.createPlayer({
        type: 'flv',
        url: url,
        isLive: false,
        hasAudio: true,
        hasVideo: true,
        cors: true
    });

    flvPlayer.attachMediaElement(video);
    flvPlayer.load();
    await flvPlayer.play();

    flvPlayer.on(window.flvjs.Events.ERROR, (errType, errDetail) => {
        console.error('[StreamPlayer] FLV error:', errType, errDetail);
        toast.error('FLV 播放失败: ' + errDetail);
    });

    playerState.flvPlayer = flvPlayer;
    playerState.isPlaying = true;
}

/**
 * DASH 播放
 * @param {HTMLVideoElement} video - 视频元素
 * @param {string} url - MPD URL
 */
async function playDash(video, url) {
    await loadDashJs();

    const player = window.dashjs.MediaPlayer().create();
    player.initialize(video, url, true);

    player.on(window.dashjs.MediaPlayer.events.ERROR, (e) => {
        console.error('[StreamPlayer] DASH error:', e);
        toast.error('DASH 播放失败');
    });

    playerState.dashPlayer = player;
    playerState.isPlaying = true;
}

// ==================== 主播放方法 ====================

/**
 * 播放视频
 * @param {Object} options - 播放选项
 * @param {string} options.url - 视频直链
 * @param {string} options.filename - 文件名
 * @param {HTMLVideoElement} options.videoElement - 视频元素
 * @param {Function} [options.onUnsupported] - 不支持格式时的回调
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function play(options) {
    const { url, filename, videoElement, onUnsupported } = options;

    if (!url || !videoElement) {
        return { success: false, message: '缺少必要参数' };
    }

    // 销毁之前的播放器
    destroyPlayer();

    playerState.videoElement = videoElement;
    playerState.currentUrl = url;
    playerState.currentFile = filename;

    const ext = getFileExtension(filename);
    const formatType = getFormatType(ext);

    console.log(`[StreamPlayer] Playing: ${filename}, format: ${formatType}`);

    try {
        switch (formatType) {
            case 'native':
                await playNative(videoElement, url);
                return { success: true };

            case 'hls':
                await playHls(videoElement, url);
                return { success: true };

            case 'flv':
                await playFlv(videoElement, url);
                return { success: true };

            case 'dash':
                await playDash(videoElement, url);
                return { success: true };

            case 'maybe':
                // 尝试原生播放
                try {
                    await playNative(videoElement, url);
                    return { success: true };
                } catch (e) {
                    console.warn('[StreamPlayer] Native playback failed for', ext, e);
                    if (onUnsupported) {
                        onUnsupported(ext, url, filename);
                    }
                    return { success: false, message: `${ext.toUpperCase()} 格式可能不兼容，尝试直接播放失败` };
                }

            case 'transcode':
                // 触发不支持回调
                if (onUnsupported) {
                    onUnsupported(ext, url, filename);
                }
                return { success: false, message: `${ext.toUpperCase()} 格式需要转码才能播放`, needsTranscode: true };

            default:
                // 未知格式，尝试原生播放
                try {
                    await playNative(videoElement, url);
                    return { success: true };
                } catch (e) {
                    if (onUnsupported) {
                        onUnsupported(ext, url, filename);
                    }
                    return { success: false, message: '未知格式，播放失败' };
                }
        }
    } catch (error) {
        console.error('[StreamPlayer] Play error:', error);
        return { success: false, message: error.message || '播放失败' };
    }
}

// ==================== 播放控制 ====================

/**
 * 暂停/继续播放
 */
function togglePlay() {
    if (!playerState.videoElement) return;

    if (playerState.videoElement.paused) {
        playerState.videoElement.play();
        playerState.isPlaying = true;
    } else {
        playerState.videoElement.pause();
        playerState.isPlaying = false;
    }
}

/**
 * 设置音量
 * @param {number} volume - 0-1
 */
function setVolume(volume) {
    if (!playerState.videoElement) return;
    playerState.videoElement.volume = Math.max(0, Math.min(1, volume));
    playerState.userPreferences.volume = playerState.videoElement.volume;
}

/**
 * 设置播放速度
 * @param {number} rate - 播放速度
 */
function setPlaybackRate(rate) {
    if (!playerState.videoElement) return;
    playerState.videoElement.playbackRate = rate;
    playerState.userPreferences.playbackRate = rate;
}

/**
 * 跳转到指定时间
 * @param {number} time - 秒数
 */
function seek(time) {
    if (!playerState.videoElement) return;
    playerState.videoElement.currentTime = Math.max(0, Math.min(time, playerState.videoElement.duration || 0));
}

/**
 * 快进/快退
 * @param {number} seconds - 秒数 (正数快进，负数快退)
 */
function skip(seconds) {
    if (!playerState.videoElement) return;
    seek(playerState.videoElement.currentTime + seconds);
}

/**
 * 切换全屏
 */
async function toggleFullscreen(container) {
    const elem = container || playerState.videoElement?.parentElement;
    if (!elem) return;

    if (!document.fullscreenElement) {
        await elem.requestFullscreen?.() || elem.webkitRequestFullscreen?.() || elem.msRequestFullscreen?.();
        playerState.isFullscreen = true;
    } else {
        await document.exitFullscreen?.() || document.webkitExitFullscreen?.() || document.msExitFullscreen?.();
        playerState.isFullscreen = false;
    }
}

/**
 * 画中画
 */
async function togglePictureInPicture() {
    if (!playerState.videoElement) return;

    if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
    } else if (playerState.videoElement.requestPictureInPicture) {
        await playerState.videoElement.requestPictureInPicture();
    }
}

// ==================== 快捷键处理 ====================

/**
 * 绑定快捷键
 * @param {HTMLElement} container - 播放器容器
 */
function bindKeyboardShortcuts(container) {
    const handler = (e) => {
        // 忽略输入框中的按键
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key.toLowerCase()) {
            case ' ':
            case 'k':
                e.preventDefault();
                togglePlay();
                break;
            case 'f':
                e.preventDefault();
                toggleFullscreen(container);
                break;
            case 'p':
                if (e.shiftKey) {
                    e.preventDefault();
                    togglePictureInPicture();
                }
                break;
            case 'm':
                e.preventDefault();
                if (playerState.videoElement) {
                    playerState.videoElement.muted = !playerState.videoElement.muted;
                }
                break;
            case 'arrowleft':
                e.preventDefault();
                skip(e.shiftKey ? -30 : -5);
                break;
            case 'arrowright':
                e.preventDefault();
                skip(e.shiftKey ? 30 : 5);
                break;
            case 'arrowup':
                e.preventDefault();
                setVolume((playerState.videoElement?.volume || 0) + 0.1);
                break;
            case 'arrowdown':
                e.preventDefault();
                setVolume((playerState.videoElement?.volume || 0) - 0.1);
                break;
            case 'escape':
                if (playerState.isFullscreen) {
                    toggleFullscreen(container);
                }
                break;
            case ',':
                e.preventDefault();
                setPlaybackRate(Math.max(0.25, (playerState.videoElement?.playbackRate || 1) - 0.25));
                break;
            case '.':
                e.preventDefault();
                setPlaybackRate(Math.min(3, (playerState.videoElement?.playbackRate || 1) + 0.25));
                break;
        }
    };

    container.addEventListener('keydown', handler);

    // 返回解绑函数
    return () => container.removeEventListener('keydown', handler);
}

// ==================== 格式检查工具 ====================

/**
 * 检查格式是否可以直接播放
 * @param {string} filename - 文件名
 * @returns {Object} 检查结果
 */
function checkFormatSupport(filename) {
    const ext = getFileExtension(filename);
    const formatType = getFormatType(ext);

    return {
        extension: ext,
        formatType,
        canPlayNatively: formatType === 'native',
        needsLibrary: ['hls', 'flv', 'dash'].includes(formatType),
        maybePlayable: formatType === 'maybe',
        needsTranscode: formatType === 'transcode',
        libraryName: formatType === 'hls' ? 'hls.js' :
            formatType === 'flv' ? 'flv.js' :
                formatType === 'dash' ? 'dash.js' : null
    };
}

/**
 * 判断文件是否是视频
 * @param {string} filename - 文件名
 * @returns {boolean}
 */
function isVideoFile(filename) {
    const ext = getFileExtension(filename);
    const allFormats = [
        ...PLAYER_CONFIG.NATIVE_FORMATS,
        ...PLAYER_CONFIG.HLS_FORMATS,
        ...PLAYER_CONFIG.FLV_FORMATS,
        ...PLAYER_CONFIG.DASH_FORMATS,
        ...PLAYER_CONFIG.MAYBE_NATIVE,
        ...PLAYER_CONFIG.TRANSCODE_FORMATS
    ];
    return allFormats.includes(ext);
}

// ==================== 导出 ====================

export const streamPlayer = {
    // 配置
    config: PLAYER_CONFIG,

    // 状态 (只读)
    get state() {
        return { ...playerState };
    },

    // 核心方法
    play,
    destroyPlayer,

    // 播放控制
    togglePlay,
    setVolume,
    setPlaybackRate,
    seek,
    skip,
    toggleFullscreen,
    togglePictureInPicture,

    // 工具方法
    checkFormatSupport,
    isVideoFile,
    getFileExtension,
    formatTime,
    bindKeyboardShortcuts,

    // 库加载器 (供外部预加载)
    loadHlsJs,
    loadFlvJs,
    loadDashJs
};

export default streamPlayer;
