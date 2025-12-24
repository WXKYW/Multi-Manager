/**
 * 流媒体播放器 UI 模块
 * 
 * 提供 Vue 组件方法和模板数据
 * 与 stream-player.js 和 transcoder.js 配合使用
 * 
 * @module stream-player-ui
 */

import { store } from '../store.js';
import { toast } from './toast.js';
import { streamPlayer } from './stream-player.js';
import { transcoder } from './transcoder.js';

// ==================== 状态 ====================

// 将播放器状态添加到 store
if (!store.streamPlayer) {
    Object.assign(store, {
        streamPlayer: {
            visible: false,
            loading: false,
            playing: false,
            currentTime: 0,
            duration: 0,
            buffered: 0,
            volume: 1,
            muted: false,
            playbackRate: 1,
            fullscreen: false,
            filename: '',
            url: '',

            // 不支持格式对话框
            showUnsupportedDialog: false,
            unsupportedFormat: '',
            unsupportedUrl: '',
            unsupportedFilename: '',

            // 转码状态
            transcoding: false,
            transcodeProgress: 0,
            transcodeStatus: ''
        }
    });
}

// ==================== 方法 ====================

export const streamPlayerMethods = {

    /**
     * 打开视频播放器
     * @param {string} url - 视频直链
     * @param {string} filename - 文件名
     */
    async openVideoPlayer(url, filename) {
        console.log('[StreamPlayerUI] Opening video:', filename);

        store.streamPlayer.visible = true;
        store.streamPlayer.loading = true;
        store.streamPlayer.filename = filename;
        store.streamPlayer.url = url;
        store.streamPlayer.currentTime = 0;
        store.streamPlayer.duration = 0;

        // 等待 DOM 更新
        await this.$nextTick();

        const videoElement = document.getElementById('stream-player-video');
        if (!videoElement) {
            console.error('[StreamPlayerUI] Video element not found');
            store.streamPlayer.loading = false;
            return;
        }

        // 绑定视频事件
        this._bindVideoEvents(videoElement);

        // 尝试播放
        const result = await streamPlayer.play({
            url,
            filename,
            videoElement,
            onUnsupported: (ext, videoUrl, videoFilename) => {
                this._showUnsupportedDialog(ext, videoUrl, videoFilename);
            }
        });

        store.streamPlayer.loading = false;

        if (!result.success && !result.needsTranscode) {
            if (result.message) {
                toast.warning(result.message);
            }
        }
    },

    /**
     * 绑定视频事件
     * @private
     */
    _bindVideoEvents(video) {
        // 时间更新
        video.ontimeupdate = () => {
            store.streamPlayer.currentTime = video.currentTime;
        };

        // 加载元数据
        video.onloadedmetadata = () => {
            store.streamPlayer.duration = video.duration;
            store.streamPlayer.loading = false;
        };

        // 播放/暂停状态
        video.onplay = () => {
            store.streamPlayer.playing = true;
        };

        video.onpause = () => {
            store.streamPlayer.playing = false;
        };

        // 缓冲进度
        video.onprogress = () => {
            if (video.buffered.length > 0) {
                store.streamPlayer.buffered = video.buffered.end(video.buffered.length - 1);
            }
        };

        // 音量变化
        video.onvolumechange = () => {
            store.streamPlayer.volume = video.volume;
            store.streamPlayer.muted = video.muted;
        };

        // 播放速度变化
        video.onratechange = () => {
            store.streamPlayer.playbackRate = video.playbackRate;
        };

        // 错误处理
        video.onerror = (e) => {
            console.error('[StreamPlayerUI] Video error:', e);
            store.streamPlayer.loading = false;
            toast.error('视频加载失败');
        };

        // 等待中
        video.onwaiting = () => {
            store.streamPlayer.loading = true;
        };

        video.oncanplay = () => {
            store.streamPlayer.loading = false;
        };
    },

    /**
     * 关闭视频播放器
     */
    closeVideoPlayer() {
        streamPlayer.destroyPlayer();
        store.streamPlayer.visible = false;
        store.streamPlayer.showUnsupportedDialog = false;
        store.streamPlayer.transcoding = false;
    },

    /**
     * 切换播放/暂停
     */
    toggleVideoPlay() {
        streamPlayer.togglePlay();
    },

    /**
     * 视频跳转
     * @param {Event} e - 点击事件
     */
    handleProgressClick(e) {
        const progressBar = e.currentTarget;
        const rect = progressBar.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        const time = percent * store.streamPlayer.duration;
        streamPlayer.seek(time);
    },

    /**
     * 设置音量
     * @param {Event} e - 事件
     */
    handleVolumeChange(e) {
        const slider = e.currentTarget;
        const rect = slider.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        streamPlayer.setVolume(Math.max(0, Math.min(1, percent)));
    },

    /**
     * 切换静音
     */
    toggleMute() {
        const video = document.getElementById('stream-player-video');
        if (video) {
            video.muted = !video.muted;
        }
    },

    /**
     * 设置播放速度
     * @param {number} rate - 播放速度
     */
    setVideoPlaybackRate(rate) {
        streamPlayer.setPlaybackRate(rate);
    },

    /**
     * 切换全屏
     */
    toggleVideoFullscreen() {
        const container = document.querySelector('.stream-player-container');
        streamPlayer.toggleFullscreen(container);
    },

    /**
     * 画中画
     */
    toggleVideoPiP() {
        streamPlayer.togglePictureInPicture();
    },

    /**
     * 快进/快退
     * @param {number} seconds - 秒数
     */
    skipVideo(seconds) {
        streamPlayer.skip(seconds);
    },

    /**
     * 格式化时间显示
     * @param {number} seconds - 秒数
     * @returns {string}
     */
    formatVideoTime(seconds) {
        return streamPlayer.formatTime(seconds);
    },

    /**
     * 显示不支持格式对话框
     * @private
     */
    _showUnsupportedDialog(ext, url, filename) {
        store.streamPlayer.showUnsupportedDialog = true;
        store.streamPlayer.unsupportedFormat = ext.toUpperCase();
        store.streamPlayer.unsupportedUrl = url;
        store.streamPlayer.unsupportedFilename = filename;
    },

    /**
     * 关闭不支持格式对话框
     */
    closeUnsupportedDialog() {
        store.streamPlayer.showUnsupportedDialog = false;
    },

    /**
     * 直接下载视频
     */
    downloadVideo() {
        const url = store.streamPlayer.unsupportedUrl || store.streamPlayer.url;
        if (url) {
            window.open(url, '_blank');
        }
        this.closeUnsupportedDialog();
        this.closeVideoPlayer();
    },

    /**
     * 开始转码
     * @param {string} preset - 转码预设 ('fast', 'balanced', 'quality')
     */
    async startTranscode(preset = 'balanced') {
        const url = store.streamPlayer.unsupportedUrl;
        const filename = store.streamPlayer.unsupportedFilename;

        if (!url || !filename) {
            toast.error('缺少文件信息');
            return;
        }

        // 检查支持情况
        const support = transcoder.checkSupport();
        if (!support.supported) {
            toast.error('您的浏览器不支持视频转码');
            return;
        }

        if (support.warnings.length > 0) {
            support.warnings.forEach(w => toast.warning(w));
        }

        // 关闭不支持对话框，显示转码进度
        store.streamPlayer.showUnsupportedDialog = false;
        store.streamPlayer.transcoding = true;
        store.streamPlayer.transcodeProgress = 0;
        store.streamPlayer.transcodeStatus = '准备中...';

        try {
            const result = await transcoder.transcode({
                url,
                filename,
                preset,
                onProgress: (progress, status) => {
                    store.streamPlayer.transcodeProgress = progress;
                    store.streamPlayer.transcodeStatus = status;
                },
                onLog: (log) => {
                    console.log('[Transcoder]', log);
                }
            });

            // 转码成功，播放转码后的视频
            store.streamPlayer.transcoding = false;
            store.streamPlayer.filename = result.filename;

            // 重新播放
            const videoElement = document.getElementById('stream-player-video');
            if (videoElement) {
                videoElement.src = result.url;
                await videoElement.play();
                store.streamPlayer.playing = true;
            }

            toast.success('转码完成，开始播放');

        } catch (error) {
            console.error('[StreamPlayerUI] Transcode error:', error);
            store.streamPlayer.transcoding = false;
            toast.error('转码失败: ' + error.message);
        }
    },

    /**
     * 取消转码
     */
    cancelTranscode() {
        transcoder.cancelTranscode();
        store.streamPlayer.transcoding = false;
        store.streamPlayer.showUnsupportedDialog = true;
    },

    /**
     * 获取音量图标
     * @returns {string} FontAwesome 图标类名
     */
    getVolumeIcon() {
        if (store.streamPlayer.muted || store.streamPlayer.volume === 0) {
            return 'fa-volume-mute';
        } else if (store.streamPlayer.volume < 0.5) {
            return 'fa-volume-down';
        }
        return 'fa-volume-up';
    },

    /**
     * 获取进度百分比
     * @returns {number} 0-100
     */
    getPlayedPercent() {
        if (!store.streamPlayer.duration) return 0;
        return (store.streamPlayer.currentTime / store.streamPlayer.duration) * 100;
    },

    /**
     * 获取缓冲百分比
     * @returns {number} 0-100
     */
    getBufferedPercent() {
        if (!store.streamPlayer.duration) return 0;
        return (store.streamPlayer.buffered / store.streamPlayer.duration) * 100;
    },

    /**
     * 获取转码进度百分比
     * @returns {number} 0-100
     */
    getTranscodePercent() {
        return Math.round(store.streamPlayer.transcodeProgress * 100);
    },

    /**
     * 播放速度选项
     */
    playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],

    /**
     * 转码预设列表
     */
    transcodePresets: transcoder.presets
};

export default streamPlayerMethods;
