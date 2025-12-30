
    /**
     * 换一批（随机播放推荐/热门歌单中的歌曲）
     */
    async musicSwapBatch() {
    if (!store.musicHotPlaylists || store.musicHotPlaylists.length === 0) {
        await this.musicLoadHotPlaylists();
    }

    if (store.musicHotPlaylists.length > 0) {
        // 随机选一个歌单
        const randomPlaylist = store.musicHotPlaylists[Math.floor(Math.random() * store.musicHotPlaylists.length)];
        toast.info(`正在加载推荐歌单：${randomPlaylist.name}`);

        // 加载该歌单并播放
        this.musicLoadPlaylist(randomPlaylist.id, true); // true = autoPlay
    } else {
        toast.warning('暂无推荐歌单可供切换');
    }
},
