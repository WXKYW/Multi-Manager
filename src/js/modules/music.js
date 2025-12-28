/**
 * Music Player Module - 网易云音乐播放器
 * 基于 api-enhanced 和 UnblockNeteaseMusic 实现
 */

import { store } from '../store.js';
import { toast } from './toast.js';

// 音频播放器实例
let audioPlayer = null;
let audioContext = null;
let analyser = null;

/**
 * 初始化音频播放器
 */
function initAudioPlayer() {
    if (audioPlayer) return audioPlayer;

    audioPlayer = new Audio();
    // 注意：不设置 crossOrigin，因为第三方音源（如酷我、酷狗）不支持 CORS
    // 这意味着 Web Audio API 可视化功能将不可用
    audioPlayer.preload = 'auto';

    // 绑定事件
    audioPlayer.addEventListener('timeupdate', handleTimeUpdate);
    audioPlayer.addEventListener('ended', handleTrackEnd);
    audioPlayer.addEventListener('error', handlePlayError);
    audioPlayer.addEventListener('loadedmetadata', handleMetadataLoaded);
    audioPlayer.addEventListener('canplay', handleCanPlay);
    audioPlayer.addEventListener('waiting', () => store.musicBuffering = true);
    audioPlayer.addEventListener('playing', () => store.musicBuffering = false);

    // Web Audio API 可视化在无 CORS 时不可用
    // 如果需要可视化，需要通过后端代理音频流

    return audioPlayer;
}

/**
 * 播放时间更新
 */
function handleTimeUpdate() {
    if (!audioPlayer) return;
    store.musicCurrentTime = audioPlayer.currentTime;
    store.musicProgress = (audioPlayer.currentTime / audioPlayer.duration) * 100 || 0;

    // 更新当前歌词行
    updateCurrentLyricLine();
}

/**
 * 歌曲播放结束
 */
function handleTrackEnd() {
    console.log('[Music] Track ended, repeat mode:', store.musicRepeatMode);

    if (store.musicRepeatMode === 'one') {
        // 单曲循环
        audioPlayer.currentTime = 0;
        audioPlayer.play();
    } else if (store.musicRepeatMode === 'all' || store.musicPlaylist.length > 1) {
        // 列表循环或有下一首
        playNext();
    } else {
        // 停止播放
        store.musicPlaying = false;
    }
}

/**
 * 播放错误处理
 */
function handlePlayError(e) {
    console.error('[Music] Play error:', e);
    store.musicBuffering = false;
    toast.error('播放失败，尝试切换音源...');

    // 尝试使用解锁服务重新获取
    if (store.musicCurrentSong) {
        retryWithUnblock(store.musicCurrentSong.id);
    }
}

/**
 * 元数据加载完成
 */
function handleMetadataLoaded() {
    store.musicDuration = audioPlayer.duration;
}

/**
 * 可以播放
 */
function handleCanPlay() {
    store.musicBuffering = false;
}

/**
 * 使用解锁服务重试
 */
async function retryWithUnblock(songId) {
    try {
        console.log('[Music] Trying to unblock song:', songId);
        const response = await fetch(`/api/music/song/url/unblock?id=${songId}`);
        const data = await response.json();

        // 后端返回格式: { code: 200, data: { url, source, ... } }
        const urlData = data.data || data;

        if (urlData?.url) {
            audioPlayer.src = urlData.url;
            await audioPlayer.play();
            store.musicPlaying = true;
            store.musicBuffering = false;
            toast.success(`已切换音源: ${urlData.source || '解锁'}`);
        } else {
            toast.error('暂无可用音源');
            store.musicBuffering = false;
        }
    } catch (error) {
        console.error('[Music] Unblock retry failed:', error);
        toast.error('获取音源失败');
        store.musicBuffering = false;
    }
}

/**
 * 更新当前歌词行
 */
function updateCurrentLyricLine() {
    if (!store.musicLyrics.length) return;

    const currentTime = store.musicCurrentTime * 1000; // 转换为毫秒

    for (let i = store.musicLyrics.length - 1; i >= 0; i--) {
        if (store.musicLyrics[i].time <= currentTime) {
            if (store.musicCurrentLyricIndex !== i) {
                store.musicCurrentLyricIndex = i;
            }
            break;
        }
    }
}

/**
 * 解析 LRC 歌词
 */
function parseLyrics(lrcText) {
    if (!lrcText) return [];

    const lines = lrcText.split('\n');
    const lyrics = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;

    for (const line of lines) {
        const matches = [...line.matchAll(timeRegex)];
        const text = line.replace(timeRegex, '').trim();

        if (!text) continue;

        for (const match of matches) {
            const minutes = parseInt(match[1]);
            const seconds = parseInt(match[2]);
            const ms = parseInt(match[3].padEnd(3, '0'));
            const time = minutes * 60 * 1000 + seconds * 1000 + ms;

            lyrics.push({ time, text });
        }
    }

    return lyrics.sort((a, b) => a.time - b.time);
}

/**
 * 音乐模块方法
 */
export const musicMethods = {
    /**
     * 搜索歌曲
     */
    async musicSearch() {
        if (!store.musicSearchKeyword.trim()) return;

        store.musicSearchLoading = true;
        try {
            const response = await fetch(`/api/music/search?keywords=${encodeURIComponent(store.musicSearchKeyword)}&limit=30`);
            const data = await response.json();

            if (data.result?.songs) {
                store.musicSearchResults = data.result.songs.map(song => ({
                    id: song.id,
                    name: song.name,
                    artists: song.ar?.map(a => a.name).join(' / ') || '未知艺术家',
                    album: song.al?.name || '未知专辑',
                    cover: song.al?.picUrl || '',
                    duration: song.dt || 0
                }));
            } else {
                store.musicSearchResults = [];
            }
        } catch (error) {
            console.error('[Music] Search error:', error);
            toast.error('搜索失败');
        } finally {
            store.musicSearchLoading = false;
        }
    },

    /**
     * 播放歌曲
     */
    async musicPlay(song) {
        if (!song) return;

        initAudioPlayer();
        store.musicBuffering = true;
        store.musicCurrentSong = song;

        // 添加到播放列表（如果不存在）
        if (!store.musicPlaylist.find(s => s.id === song.id)) {
            store.musicPlaylist.push(song);
        }
        store.musicCurrentIndex = store.musicPlaylist.findIndex(s => s.id === song.id);

        try {
            // 获取播放地址
            console.log('[Music] Fetching URL for song:', song.id);
            const response = await fetch(`/api/music/song/url?id=${song.id}&level=exhigh`);
            const data = await response.json();

            const songData = data.data?.[0];
            console.log('[Music] URL response:', songData?.url ? 'Got URL' : 'No URL', 'source:', songData?.source || 'official');

            if (songData?.url) {
                audioPlayer.src = songData.url;
                await audioPlayer.play();
                store.musicPlaying = true;
                store.musicBuffering = false;

                // 获取歌词
                this.musicLoadLyrics(song.id);

                // 更新封面（如果没有）
                if (!song.cover) {
                    this.musicLoadSongDetail(song.id);
                }
            } else {
                // 尝试解锁
                console.log('[Music] No URL from official API, trying unblock...');
                await retryWithUnblock(song.id);
            }
        } catch (error) {
            console.error('[Music] Play error:', error);
            toast.error('播放失败');
            store.musicBuffering = false;
        }
    },

    /**
     * 暂停/继续播放
     */
    musicTogglePlay() {
        if (!audioPlayer) return;

        if (store.musicPlaying) {
            audioPlayer.pause();
            store.musicPlaying = false;
        } else {
            audioPlayer.play();
            store.musicPlaying = true;
        }
    },

    /**
     * 播放上一首
     */
    playPrevious() {
        if (store.musicPlaylist.length === 0) return;

        let newIndex;
        if (store.musicShuffleEnabled) {
            newIndex = Math.floor(Math.random() * store.musicPlaylist.length);
        } else {
            newIndex = store.musicCurrentIndex - 1;
            if (newIndex < 0) newIndex = store.musicPlaylist.length - 1;
        }

        this.musicPlay(store.musicPlaylist[newIndex]);
    },

    /**
     * 播放下一首
     */
    playNext() {
        if (store.musicPlaylist.length === 0) return;

        let newIndex;
        if (store.musicShuffleEnabled) {
            newIndex = Math.floor(Math.random() * store.musicPlaylist.length);
        } else {
            newIndex = store.musicCurrentIndex + 1;
            if (newIndex >= store.musicPlaylist.length) newIndex = 0;
        }

        this.musicPlay(store.musicPlaylist[newIndex]);
    },

    /**
     * 跳转到指定时间
     */
    musicSeek(percent) {
        if (!audioPlayer || !store.musicDuration) return;
        audioPlayer.currentTime = (percent / 100) * store.musicDuration;
    },

    /**
     * 设置音量
     */
    musicSetVolume(volume) {
        store.musicVolume = volume;
        if (audioPlayer) {
            audioPlayer.volume = volume / 100;
        }
    },

    /**
     * 切换循环模式
     */
    musicToggleRepeat() {
        const modes = ['none', 'all', 'one'];
        const currentIndex = modes.indexOf(store.musicRepeatMode);
        store.musicRepeatMode = modes[(currentIndex + 1) % modes.length];

        const modeNames = { none: '顺序播放', all: '列表循环', one: '单曲循环' };
        toast.info(modeNames[store.musicRepeatMode]);
    },

    /**
     * 切换随机播放
     */
    musicToggleShuffle() {
        store.musicShuffleEnabled = !store.musicShuffleEnabled;
        toast.info(store.musicShuffleEnabled ? '随机播放已开启' : '随机播放已关闭');
    },

    /**
     * 加载歌词
     */
    async musicLoadLyrics(songId) {
        try {
            const response = await fetch(`/api/music/lyric?id=${songId}`);
            const data = await response.json();

            const lrcText = data.lrc?.lyric || '';
            const tlyricText = data.tlyric?.lyric || ''; // 翻译歌词

            store.musicLyrics = parseLyrics(lrcText);
            store.musicLyricsTranslation = parseLyrics(tlyricText);
            store.musicCurrentLyricIndex = 0;
        } catch (error) {
            console.error('[Music] Load lyrics error:', error);
            store.musicLyrics = [];
        }
    },

    /**
     * 加载歌曲详情（封面等）
     */
    async musicLoadSongDetail(songId) {
        try {
            const response = await fetch(`/api/music/song/detail?ids=${songId}`);
            const data = await response.json();

            if (data.songs?.[0]) {
                const detail = data.songs[0];
                if (store.musicCurrentSong?.id === songId) {
                    store.musicCurrentSong.cover = detail.al?.picUrl || '';
                }
            }
        } catch (error) {
            console.error('[Music] Load song detail error:', error);
        }
    },

    /**
     * 获取每日推荐
     */
    async musicLoadDailyRecommend() {
        store.musicRecommendLoading = true;
        try {
            const response = await fetch('/api/music/recommend/songs', {
                credentials: 'include'
            });
            const data = await response.json();

            if (data.data?.dailySongs) {
                store.musicDailyRecommend = data.data.dailySongs.map(song => ({
                    id: song.id,
                    name: song.name,
                    artists: song.ar?.map(a => a.name).join(' / ') || '未知艺术家',
                    album: song.al?.name || '未知专辑',
                    cover: song.al?.picUrl || '',
                    duration: song.dt || 0
                }));
            }
        } catch (error) {
            console.error('[Music] Daily recommend error:', error);
        } finally {
            store.musicRecommendLoading = false;
        }
    },

    /**
     * 获取热门歌单
     */
    async musicLoadHotPlaylists() {
        store.musicPlaylistsLoading = true;
        try {
            const response = await fetch('/api/music/top/playlist?limit=20');
            const data = await response.json();

            if (data.playlists) {
                store.musicHotPlaylists = data.playlists.map(pl => ({
                    id: pl.id,
                    name: pl.name,
                    cover: pl.coverImgUrl || '',
                    playCount: pl.playCount || 0,
                    creator: pl.creator?.nickname || '未知'
                }));
            }
        } catch (error) {
            console.error('[Music] Hot playlists error:', error);
        } finally {
            store.musicPlaylistsLoading = false;
        }
    },

    /**
     * 获取歌单详情
     */
    async musicLoadPlaylistDetail(id) {
        store.musicPlaylistDetailLoading = true;
        try {
            const response = await fetch(`/api/music/playlist/detail?id=${id}`);
            const data = await response.json();

            if (data.playlist) {
                const pl = data.playlist;
                store.musicCurrentPlaylistDetail = {
                    id: pl.id,
                    name: pl.name,
                    cover: pl.coverImgUrl || '',
                    description: pl.description || '',
                    creator: pl.creator?.nickname || '未知',
                    trackCount: pl.trackCount || 0,
                    playCount: pl.playCount || 0,
                    tracks: (pl.tracks || []).map(song => ({
                        id: song.id,
                        name: song.name,
                        artists: song.ar?.map(a => a.name).join(' / ') || '未知艺术家',
                        album: song.al?.name || '未知专辑',
                        cover: song.al?.picUrl || '',
                        duration: song.dt || 0
                    }))
                };
            }
        } catch (error) {
            console.error('[Music] Playlist detail error:', error);
        } finally {
            store.musicPlaylistDetailLoading = false;
        }
    },

    /**
     * 播放整个歌单
     */
    musicPlayPlaylist(tracks) {
        if (!tracks?.length) return;
        store.musicPlaylist = [...tracks];
        store.musicCurrentIndex = 0;
        this.musicPlay(tracks[0]);
    },

    /**
     * 从播放列表移除
     */
    musicRemoveFromPlaylist(index) {
        if (index < 0 || index >= store.musicPlaylist.length) return;

        // 如果移除的是当前播放的歌曲
        if (index === store.musicCurrentIndex) {
            if (store.musicPlaylist.length > 1) {
                this.playNext();
            } else {
                audioPlayer?.pause();
                store.musicPlaying = false;
                store.musicCurrentSong = null;
            }
        }

        store.musicPlaylist.splice(index, 1);

        // 更新当前索引
        if (index < store.musicCurrentIndex) {
            store.musicCurrentIndex--;
        }
    },

    /**
     * 清空播放列表
     */
    musicClearPlaylist() {
        audioPlayer?.pause();
        store.musicPlaying = false;
        store.musicCurrentSong = null;
        store.musicPlaylist = [];
        store.musicCurrentIndex = -1;
    },

    /**
     * 格式化时间
     */
    formatMusicTime(ms) {
        if (!ms || isNaN(ms)) return '0:00';
        const seconds = Math.floor(ms / 1000);
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    },

    /**
     * 格式化时间（秒）
     */
    formatMusicSeconds(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    },

    /**
     * 点击进度条跳转
     */
    musicSeekByClick(event) {
        const bar = event.currentTarget;
        const rect = bar.getBoundingClientRect();
        const percent = ((event.clientX - rect.left) / rect.width) * 100;
        this.musicSeek(Math.max(0, Math.min(100, percent)));
    },

    /**
     * 初始化音乐模块
     */
    initMusicModule() {
        console.log('[Music] Module initialized');
        // 恢复上次的音量设置
        if (audioPlayer) {
            audioPlayer.volume = store.musicVolume / 100;
        }
    }
};

// 导出便捷函数
export function playNext() {
    if (store.musicPlaylist.length === 0) return;

    let newIndex;
    if (store.musicShuffleEnabled) {
        newIndex = Math.floor(Math.random() * store.musicPlaylist.length);
    } else {
        newIndex = store.musicCurrentIndex + 1;
        if (newIndex >= store.musicPlaylist.length) newIndex = 0;
    }

    const song = store.musicPlaylist[newIndex];
    if (song && window.vueApp) {
        window.vueApp.musicPlay(song);
    }
}
