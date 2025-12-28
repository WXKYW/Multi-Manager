/**
 * Music Player Module - 网易云音乐播放器
 * 基于 api-enhanced 和 UnblockNeteaseMusic 实现
 */

import { store } from '../store.js';
import { toast } from './toast.js';

// 导入 AMLL 样式
import '@applemusic-like-lyrics/core/style.css';

// 音频播放器实例
let audioPlayer = null;
let audioContext = null;
let analyser = null;

// AMLL 核心组件 (从 npm 包动态导入)
let amllPlayer = null; // AMLL 歌词播放器实例
let amllUpdateFrame = null;

/**
 * 转换 NCM 歌词为 AMLL 格式
 */
function transformToAMLL(lyrics, translations = []) {
    if (!lyrics || !lyrics.length) return [];

    // 如果是逐字歌词 (来自 yrc)
    if (lyrics[0].words && lyrics[0].words.length > 0) {
        return lyrics.map((line, index) => {
            const nextTime = lyrics[index + 1]?.startTime || (line.endTime + 500);

            let trans = '';
            if (translations && translations.length) {
                const match = translations.find(t => Math.abs(t.time - line.startTime) < 500);
                if (match) trans = match.text;
            }

            return {
                startTime: line.startTime,
                endTime: line.endTime,
                words: line.words.map(w => ({
                    startTime: w.startTime,
                    endTime: w.endTime,
                    word: w.word || ''
                })),
                translatedLyric: trans || '',
                romanLyric: '',
                isBG: false,
                isDuet: false
            };
        });
    }

    // 普通 LRC 转换为 AMLL 格式并模拟逐字动画
    return lyrics.map((line, index) => {
        const nextTime = lyrics[index + 1]?.time || (line.time + 5000);

        // 让 endTime 紧贴下一行 startTime，避免 AMLL 识别出间奏（间奏需要 >= 4s 间隔）
        const gap = nextTime - line.time;
        const duration = Math.min(gap - 100, 8000); // 始终留 100ms 间隔
        const endTime = line.time + Math.max(duration, 1000);

        let trans = '';
        if (translations && translations.length) {
            const match = translations.find(t => Math.abs(t.time - line.time) < 100);
            if (match) trans = match.text;
        }

        // 智能拆分字词以模拟逐字效果
        let words = [];
        const text = line.text || '';

        // 判断是否包含中日韩字符 (CJK)
        const isCJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(text);

        if (isCJK) {
            // 如果是中文/日韩文，按字符拆分
            const chars = text.split('');
            const charDuration = duration / Math.max(chars.length, 1);
            words = chars.map((char, i) => ({
                startTime: line.time + (i * charDuration),
                endTime: line.time + ((i + 1) * charDuration),
                word: char
            }));
        } else {
            // 如果是英文等，按单词拆分
            const parts = text.split(/(\s+)/); // 保留空格
            const totalParts = parts.length;
            const partDuration = duration / Math.max(totalParts, 1);
            words = parts.map((part, i) => ({
                startTime: line.time + (i * partDuration),
                endTime: line.time + ((i + 1) * partDuration),
                word: part
            }));
        }

        return {
            startTime: line.time,
            endTime: endTime,
            words: words,
            translatedLyric: trans || '',
            romanLyric: '',
            isBG: false,
            isDuet: false
        };
    });
}



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

    // 如果全屏且 AMLL 存在，也在这里更新一次确保对齐
    if (store.musicShowFullPlayer && amllPlayer) {
        amllPlayer.setCurrentTime(audioPlayer.currentTime * 1000);
    }
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

    // 更新 AMLL 播放器状态 (由 startAmllUpdateLoop 统一管理)
    // if (amllPlayer) {
    //     amllPlayer.setCurrentTime(currentTime);
    // }

    for (let i = store.musicLyrics.length - 1; i >= 0; i--) {
        if (store.musicLyrics[i].time <= currentTime) {
            if (store.musicCurrentLyricIndex !== i) {
                store.musicCurrentLyricIndex = i;

                // 全屏模式下自动滚动 (如果 AMLL 没初始化则使用旧逻辑)
                if (store.musicShowFullPlayer && !amllPlayer) {
                    scrollToCurrentLyric();
                }
            }
            break;
        }
    }
}

/**
 * 启动 AMLL 更新循环
 */
function startAmllUpdateLoop() {
    if (amllUpdateFrame) return;

    let lastTime = performance.now();
    function step(now) {
        if (!store.musicShowFullPlayer) {
            amllUpdateFrame = null;
            return;
        }

        const delta = now - lastTime;
        lastTime = now;

        if (amllPlayer && audioPlayer) {
            // AMLL 需要 setCurrentTime 并在 update 中根据 delta 计算补间
            amllPlayer.setCurrentTime(audioPlayer.currentTime * 1000);
            amllPlayer.update(delta);
        }

        amllUpdateFrame = requestAnimationFrame(step);
    }
    amllUpdateFrame = requestAnimationFrame(step);
}


/**
 * 滚动歌词到中心位置
 */
function scrollToCurrentLyric() {
    // 延迟执行以确保 DOM 已更新
    setTimeout(() => {
        const container = document.querySelector('.full-lyrics-container');
        if (!container) return;

        const activeLine = container.querySelector('.lyric-line.active');
        if (activeLine) {
            const containerHeight = container.offsetHeight;
            const lineOffset = activeLine.offsetTop;
            const lineHeight = activeLine.offsetHeight;

            container.scrollTo({
                top: lineOffset - containerHeight / 2 + lineHeight / 2,
                behavior: 'smooth'
            });
        }
    }, 10);
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
     * 切换播放/暂停
     */
    musicTogglePlay() {
        if (!audioPlayer) return;
        if (store.musicPlaying) {
            audioPlayer.pause();
            store.musicPlaying = false;
            if (amllPlayer) amllPlayer.pause();
            if (amllBgRender) amllBgRender.pause();
        } else {
            audioPlayer.play();
            store.musicPlaying = true;
            if (amllPlayer) amllPlayer.resume();
            if (amllBgRender) amllBgRender.resume();
        }
    },

    /**
     * 上一首
     */
    playPrevious() {
        if (store.musicPlaylist.length === 0) return;
        let newIndex = store.musicCurrentIndex - 1;
        if (newIndex < 0) newIndex = store.musicPlaylist.length - 1;
        this.musicPlay(store.musicPlaylist[newIndex]);
    },

    /**
     * 下一首
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
     * 切换全屏播放器显示/隐藏
     */
    musicToggleFullPlayer() {
        if (store.musicShowFullPlayer) {
            store.musicShowFullPlayer = false;
        } else {
            this.musicOpenFullPlayer();
        }
    },

    /**
     * 打开全屏播放器
     */
    async musicOpenFullPlayer() {
        store.musicShowFullPlayer = true;

        // 延迟初始化 AMLL，确保容器已渲染
        setTimeout(async () => {
            // 初始化歌词播放器 (使用 DomSlimLyricPlayer)
            if (!amllPlayer) {
                try {
                    const amllCore = await import('@applemusic-like-lyrics/core');
                    console.log('[Music] AMLL Core loaded:', Object.keys(amllCore));

                    const { DomSlimLyricPlayer } = amllCore;
                    if (!DomSlimLyricPlayer) {
                        throw new Error('DomSlimLyricPlayer not found');
                    }

                    amllPlayer = new DomSlimLyricPlayer();
                    const el = amllPlayer.getElement();

                    // 先设置样式
                    el.style.width = '100%';
                    el.style.height = '100%';
                    el.classList.add('amll-lyric-player');
                    el.style.fontWeight = '700';
                    el.style.fontFamily = '"SF Pro Display", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

                    // 先添加到 DOM
                    const container = document.querySelector('.full-lyrics-container');
                    if (container) {
                        container.innerHTML = '';
                        container.appendChild(el);
                    }

                    // 添加到 DOM 后再配置 AMLL 参数 (SPlayer 风格)
                    await new Promise(r => setTimeout(r, 50));

                    amllPlayer.setEnableScale(true);      // 缩放效果
                    amllPlayer.setEnableBlur(true);       // 非当前行模糊
                    amllPlayer.setEnableSpring(true);     // 弹簧动画
                    amllPlayer.setAlignPosition(0.15);    // SPlayer 默认：当前行在屏幕 15% 位置
                    amllPlayer.setAlignAnchor('top');     // 以行顶部对齐
                    amllPlayer.setWordFadeWidth(0.8);     // 逐字淡入宽度

                    // 监听点击歌词事件
                    el.addEventListener('click', (e) => {
                        let target = e.target;
                        while (target && target !== el) {
                            const lineObj = amllPlayer.lyricLineElementMap?.get(target);
                            if (lineObj) {
                                const time = lineObj.getLine()?.startTime;
                                if (time !== undefined) {
                                    this.musicSeekToLyric(time);
                                }
                                break;
                            }
                            target = target.parentElement;
                        }
                    });

                    startAmllUpdateLoop();
                    console.log('[Music] AMLL initialized successfully');
                } catch (err) {
                    console.error('[Music] AMLL init failed:', err);
                }
            }

            // 每次打开都确保 AMLL 元素在容器中
            if (amllPlayer) {
                const container = document.querySelector('.full-lyrics-container');
                const el = amllPlayer.getElement();
                if (container && el && !container.contains(el)) {
                    container.innerHTML = '';
                    container.appendChild(el);
                }
            }

            // 设置歌词
            if (amllPlayer && store.musicLyrics) {
                amllPlayer.setLyricLines(transformToAMLL(store.musicLyrics, store.musicLyricsTranslation), audioPlayer.currentTime * 1000);

                if (store.musicPlaying) amllPlayer.resume();
                else amllPlayer.pause();

                // 等待歌词渲染完成后再应用配置
                setTimeout(() => {
                    try {
                        amllPlayer.setEnableScale(true);
                        amllPlayer.setEnableBlur(true);
                        amllPlayer.setEnableSpring(true);
                        amllPlayer.setAlignPosition(0.15);
                        amllPlayer.setAlignAnchor('top');
                        amllPlayer.setWordFadeWidth(0.8);
                        console.log('[Music] AMLL config applied');
                    } catch (e) {
                        console.warn('[Music] AMLL config error:', e);
                    }
                }, 100);
            }
        }, 100);
    },



    /**
     * 播放歌曲
     */
    async musicPlay(song) {
        if (!song) return;

        initAudioPlayer();
        store.musicBuffering = true;
        store.musicCurrentSong = song;
        store.musicCurrentLyricIndex = 0; // 重置歌词索引

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
                if (amllPlayer) amllPlayer.resume();

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
            if (amllPlayer) amllPlayer.pause();
            if (amllBgRender) amllBgRender.pause();
        } else {
            audioPlayer.play();
            store.musicPlaying = true;
            if (amllPlayer) amllPlayer.resume();
            if (amllBgRender) amllBgRender.resume();
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
     * 点击进度条跳转 (原始坐标)
     */
    musicSeekByClick(event) {
        if (!audioPlayer || !store.musicDuration) return;
        const bar = event.currentTarget;
        const rect = bar.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const percent = (x / rect.width) * 100;
        this.musicSeek(percent);
    },

    /**
     * 点击歌词跳转
     */
    musicSeekToLyric(timeMs) {
        if (!audioPlayer) return;
        audioPlayer.currentTime = timeMs / 1000;
        if (!store.musicPlaying) {
            this.musicTogglePlay();
        }
    },

    /**
     * 切换全屏模式
     */
    toggleFullScreen() {
        const elem = document.querySelector('.music-full-player');
        if (!elem) return;

        if (!document.fullscreenElement) {
            elem.requestFullscreen().catch(err => {
                console.error(`[Music] Fullscreen error: ${err.message}`);
            });
        } else {
            document.exitFullscreen();
        }
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
            // 移除不稳定的新接口，统一使用标准接口
            const response = await fetch(`/api/music/lyric?id=${songId}`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();

            const lrcText = data.lrc?.lyric || '';
            const tlyricText = data.tlyric?.lyric || ''; // 翻译歌词

            store.musicLyrics = parseLyrics(lrcText);
            store.musicLyricsTranslation = parseLyrics(tlyricText);
            store.musicCurrentLyricIndex = 0;

            // 同步到底层 AMLL 播放器
            if (amllPlayer) {
                amllPlayer.setLyricLines(transformToAMLL(store.musicLyrics, store.musicLyricsTranslation));
            }
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
                    store.musicCurrentSong.album = detail.al?.name || '';
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

            if (data.data?.dailySongs && data.data.dailySongs.length > 0) {
                const songs = data.data.dailySongs.map(song => ({
                    id: song.id,
                    name: song.name,
                    artists: song.ar?.map(a => a.name).join(' / ') || '未知艺术家',
                    album: song.al?.name || '未知专辑',
                    cover: song.al?.picUrl || '',
                    duration: song.dt || 0
                }));

                store.musicDailyRecommend = songs;

                // 直接播放每日推荐
                store.musicPlaylist = songs;
                store.musicCurrentIndex = 0;
                this.musicPlay(songs[0]);
                toast.success('每日推荐已加载');
            } else {
                toast.warning('需要登录才能获取每日推荐');
            }
        } catch (error) {
            console.error('[Music] Daily recommend error:', error);
            toast.error('加载每日推荐失败');
        } finally {
            store.musicRecommendLoading = false;
        }
    },

    /**
     * 加载私人 FM
     */
    async musicLoadPrivateFM() {
        try {
            const response = await fetch('/api/music/personal/fm', {
                credentials: 'include'
            });
            const data = await response.json();

            if (data.data && data.data.length > 0) {
                const songs = data.data.map(song => ({
                    id: song.id,
                    name: song.name,
                    artists: song.artists?.map(a => a.name).join(' / ') || '未知艺术家',
                    album: song.album?.name || '未知专辑',
                    cover: song.album?.picUrl || '',
                    duration: song.duration || 0
                }));

                // 直接播放 FM 歌曲
                store.musicPlaylist = songs;
                store.musicCurrentIndex = 0;
                this.musicPlay(songs[0]);
                toast.success('私人 FM 已加载');
            } else {
                toast.warning('需要登录才能使用私人 FM');
            }
        } catch (error) {
            console.error('[Music] Private FM error:', error);
            toast.error('加载私人 FM 失败');
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
                // 自动打开详情页
                store.musicShowDetail = true;
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

    // ==================== 登录相关 ====================

    /**
     * 检查登录状态 (使用服务器存储的 Cookie)
     */
    async musicCheckLoginStatus() {
        try {
            const response = await fetch('/api/music/auth/status', { credentials: 'include' });
            const data = await response.json();

            if (data.loggedIn && data.user) {
                store.musicUser = data.user;
                localStorage.setItem('music_user_info', JSON.stringify(data.user));
                console.log('[Music] Logged in as:', data.user.nickname);

                // 登录成功后加载用户歌单
                this.musicLoadUserPlaylists();
                return true;
            } else {
                store.musicUser = null;
                localStorage.removeItem('music_user_info');
                return false;
            }
        } catch (error) {
            console.error('[Music] Check login status error:', error);
            return false;
        }
    },

    /**
     * 加载用户歌单列表
     */
    async musicLoadUserPlaylists() {
        if (!store.musicUser) return;

        try {
            const response = await fetch(`/api/music/user/playlist?uid=${store.musicUser.userId}`, { credentials: 'include' });
            const data = await response.json();

            if (data.playlist) {
                // 分类歌单：创建的 vs 收藏的
                const myPlaylists = [];
                const collectedPlaylists = [];

                data.playlist.forEach(pl => {
                    const item = {
                        id: pl.id,
                        name: pl.name,
                        cover: pl.coverImgUrl || '',
                        trackCount: pl.trackCount || 0,
                        playCount: pl.playCount || 0,
                        creator: pl.creator?.nickname || '',
                        isSpecial: pl.specialType === 5 // 我喜欢的音乐
                    };

                    if (pl.creator?.userId === store.musicUser.userId) {
                        myPlaylists.push(item);
                    } else {
                        collectedPlaylists.push(item);
                    }
                });

                store.musicMyPlaylists = myPlaylists;
                store.musicCollectedPlaylists = collectedPlaylists;
                console.log('[Music] Loaded user playlists:', myPlaylists.length, 'created,', collectedPlaylists.length, 'collected');
            }
        } catch (error) {
            console.error('[Music] Load user playlists error:', error);
        }
    },

    /**
     * 生成登录二维码
     */
    async musicGenerateLoginQr() {
        store.musicLoginLoading = true;
        store.musicQrExpired = false;

        try {
            // 1. 获取二维码 key
            const keyRes = await fetch('/api/music/login/qr/key');
            const keyData = await keyRes.json();

            if (!keyData.data?.unikey) {
                throw new Error('获取二维码 key 失败');
            }

            store.musicQrKey = keyData.data.unikey;

            // 2. 生成二维码图片
            const qrRes = await fetch(`/api/music/login/qr/create?key=${store.musicQrKey}&qrimg=true`);
            const qrData = await qrRes.json();

            if (qrData.data?.qrimg) {
                store.musicQrImg = qrData.data.qrimg;

                // 开始轮询检查扫码状态
                this.musicStartQrCheck();
            } else {
                throw new Error('生成二维码失败');
            }
        } catch (error) {
            console.error('[Music] Generate QR error:', error);
            toast.error('生成登录二维码失败');
        } finally {
            store.musicLoginLoading = false;
        }
    },

    /**
     * 开始检查二维码扫描状态
     */
    musicStartQrCheck() {
        if (store.musicQrChecking) return;
        store.musicQrChecking = true;

        const self = this;

        const checkInterval = setInterval(async () => {
            if (!store.musicQrKey || store.musicQrExpired) {
                clearInterval(checkInterval);
                store.musicQrChecking = false;
                return;
            }

            try {
                const response = await fetch(`/api/music/login/qr/check?key=${store.musicQrKey}`, { credentials: 'include' });
                const data = await response.json();

                // 状态码：800-二维码过期，801-等待扫码，802-待确认，803-授权成功
                switch (data.code) {
                    case 800:
                        // 二维码过期
                        store.musicQrExpired = true;
                        clearInterval(checkInterval);
                        store.musicQrChecking = false;
                        break;
                    case 803:
                        // 登录成功
                        clearInterval(checkInterval);
                        store.musicQrChecking = false;
                        store.musicQrKey = '';
                        store.musicQrImg = '';

                        // 获取用户信息 (使用 self 保持 this 上下文)
                        try {
                            const statusRes = await fetch('/api/music/auth/status', { credentials: 'include' });
                            const statusData = await statusRes.json();

                            if (statusData.loggedIn && statusData.user) {
                                store.musicUser = statusData.user;
                                localStorage.setItem('music_user_info', JSON.stringify(statusData.user));
                                console.log('[Music] Logged in as:', statusData.user.nickname);

                                // 加载用户歌单
                                self.musicLoadUserPlaylists();

                                // 关闭登录弹窗
                                store.musicShowLoginModal = false;
                            }
                        } catch (e) {
                            console.error('[Music] Get user info error:', e);
                        }

                        store.musicLoginStatusText = '登录成功！';
                        toast.success('登录成功');
                        break;
                    case 802:
                        // 待确认，继续等待
                        store.musicLoginStatusText = '扫码成功，请在手机上确认登录';
                        console.log('[Music] QR scanned, waiting for confirm...');
                        break;
                    case 801:
                        // 等待扫码
                        store.musicLoginStatusText = '请使用网易云音乐 App 扫码登录';
                        break;
                }
            } catch (error) {
                console.error('[Music] QR check error:', error);
            }
        }, 2000);

        // 3分钟后自动停止检查
        setTimeout(() => {
            if (store.musicQrChecking) {
                store.musicQrExpired = true;
                clearInterval(checkInterval);
                store.musicQrChecking = false;
            }
        }, 180000);
    },

    /**
     * 退出登录 (清除服务器存储的 Cookie)
     */
    async musicLogout() {
        try {
            await fetch('/api/music/logout', { method: 'POST', credentials: 'include' });
        } catch (error) {
            console.warn('[Music] Logout API error:', error);
        }

        // 清除前端状态
        store.musicUser = null;
        localStorage.removeItem('music_user_info');
        store.musicQrKey = '';
        store.musicQrImg = '';
        store.musicQrExpired = false;
        store.musicMyPlaylists = [];
        store.musicCollectedPlaylists = [];

        toast.success('已退出登录');
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

        // 默认进入首页
        store.musicCurrentTab = 'home';

        // 快速恢复 localStorage 中的用户信息缓存
        const cachedUser = localStorage.getItem('music_user_info');
        if (cachedUser) {
            try {
                store.musicUser = JSON.parse(cachedUser);
            } catch (e) {
                console.warn('[Music] Failed to parse cached user info');
            }
        }

        // 自动加载发现页/首页数据 (热门推荐)
        this.musicLoadHotPlaylists();

        // 检查后端真实登录状态并同步数据
        this.musicCheckLoginStatus().then(() => {
            if (store.musicUser) {
                // 如果已登录，加载用户歌单和每日推荐
                this.musicLoadUserPlaylists();
                this.musicLoadDailyRecommend();
            }
        });
    },
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
