/**
 * Dashboard Module - 系统状态概览
 * 优化版：支持缓存预加载、并行请求、后台静默刷新
 */
import { store } from '../store.js';

// 缓存 key
const CACHE_KEY = 'dashboard_stats_cache';
const CACHE_EXPIRY = 5 * 60 * 1000; // 5 分钟缓存有效期

/**
 * 从 localStorage 加载缓存
 */
function loadFromCache() {
    try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
            const { data, timestamp } = JSON.parse(cached);
            // 缓存有效期内直接使用
            if (Date.now() - timestamp < CACHE_EXPIRY) {
                return data;
            }
        }
    } catch (e) {
        console.warn('[Dashboard] Cache load failed:', e);
    }
    return null;
}

/**
 * 保存到 localStorage 缓存
 */
function saveToCache(data) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            data,
            timestamp: Date.now()
        }));
    } catch (e) {
        console.warn('[Dashboard] Cache save failed:', e);
    }
}

export const dashboardMethods = {
    /**
     * 初始化仪表盘数据
     * 优化：先从缓存加载实现瞬时显示，再后台刷新
     */
    async initDashboard() {
        console.log('[Dashboard] Initializing...');

        // 1. 优先从缓存加载（实现瞬时展示）
        const cached = loadFromCache();
        if (cached) {
            console.log('[Dashboard] Loaded from cache');
            Object.assign(store.dashboardStats, cached);
            store.dashboardLastUpdate = '缓存';

            // 后台静默刷新（不显示 loading 状态）
            this.refreshDashboardDataSilent();
        } else {
            // 无缓存时正常加载
            await this.refreshDashboardData();
        }

        // 音乐收藏异步加载（不阻塞仪表盘）
        if (this.musicAutoLoadFavorites) {
            setTimeout(() => this.musicAutoLoadFavorites(), 100);
        }
    },

    /**
     * 刷新仪表盘所有数据（显示 loading 状态）
     */
    async refreshDashboardData() {
        if (store.dashboardLoading) return;
        store.dashboardLoading = true;

        try {
            await this._fetchAllData();
        } catch (error) {
            console.error('[Dashboard] Refresh error:', error);
        } finally {
            store.dashboardLoading = false;
            store.dashboardLastUpdate = new Date().toLocaleTimeString();
        }
    },

    /**
     * 静默刷新（不显示 loading 状态，用于后台更新）
     */
    async refreshDashboardDataSilent() {
        try {
            await this._fetchAllData();
            store.dashboardLastUpdate = new Date().toLocaleTimeString();
        } catch (error) {
            console.error('[Dashboard] Silent refresh error:', error);
        }
    },

    /**
     * 内部方法：并行获取所有数据
     */
    async _fetchAllData() {
        // 使用 Promise.allSettled 确保部分失败不影响整体
        // 所有请求完全并行，不串行等待
        await Promise.allSettled([
            this.fetchServerSummary(),
            this.fetchApiSummary(),
            this.fetchPaaSSummary(),
            this.fetchDnsSummary(),
            this.loadTotpAccounts ? this.loadTotpAccounts() : Promise.resolve()
        ]);

        // 保存到缓存
        saveToCache({
            servers: store.dashboardStats.servers,
            antigravity: store.dashboardStats.antigravity,
            geminiCli: store.dashboardStats.geminiCli,
            paas: store.dashboardStats.paas,
            dns: store.dashboardStats.dns
        });
    },

    /**
     * 获取主机状态摘要
     */
    async fetchServerSummary() {
        try {
            const response = await fetch('/api/server/accounts', { headers: store.getAuthHeaders() });
            const data = await response.json();
            if (data.success) {
                const servers = data.data || [];
                store.dashboardStats.servers = {
                    total: servers.length,
                    online: servers.filter(s => s.status === 'online').length,
                    offline: servers.filter(s => s.status === 'offline').length,
                    error: servers.filter(s => s.status === 'error').length
                };
            }
        } catch (e) {
            console.error('[Dashboard] Fetch server summary failed:', e);
        }
    },

    /**
     * 获取 API 网关摘要 (Antigravity & Gemini CLI)
     * 优化：两个请求并行执行
     */
    async fetchApiSummary() {
        try {
            // 并行请求两个 API
            const [agRes, gRes] = await Promise.all([
                fetch('/api/antigravity/stats', { headers: store.getAuthHeaders() }),
                fetch('/api/gemini-cli/stats', { headers: store.getAuthHeaders() })
            ]);

            if (agRes.ok) {
                const agData = await agRes.json();
                store.dashboardStats.antigravity = agData.data || agData;
            }

            if (gRes.ok) {
                const gData = await gRes.json();
                store.dashboardStats.geminiCli = gData.data || gData;
            }
        } catch (e) {
            console.error('[Dashboard] Fetch API summary failed:', e);
        }
    },

    /**
     * 获取 PaaS 摘要 (Zeabur, Koyeb, Fly.io)
     * 优化：三个平台的请求完全并行
     */
    async fetchPaaSSummary() {
        try {
            // 并行请求所有 PaaS 平台
            const [zRes, kRes, fRes] = await Promise.all([
                fetch('/api/zeabur/projects', { headers: store.getAuthHeaders() }),
                fetch('/api/koyeb/data', { headers: store.getAuthHeaders() }),
                fetch('/api/fly/proxy/apps', { headers: store.getAuthHeaders() })
            ]);

            // Zeabur
            if (zRes.ok) {
                const zData = await zRes.json();
                let appCount = 0;
                let runningCount = 0;
                if (Array.isArray(zData)) {
                    zData.forEach(acc => {
                        if (acc.projects) {
                            acc.projects.forEach(p => {
                                if (p.services) {
                                    appCount += p.services.length;
                                    runningCount += p.services.filter(s => s.status === 'RUNNING').length;
                                }
                            });
                        }
                    });
                }
                store.dashboardStats.paas.zeabur = { total: appCount, running: runningCount };
            }

            // Koyeb
            if (kRes.ok) {
                const kData = await kRes.json();
                let appCount = 0;
                let runningCount = 0;
                if (kData.success && kData.accounts) {
                    kData.accounts.forEach(acc => {
                        if (acc.projects) {
                            acc.projects.forEach(p => {
                                if (p.services) {
                                    p.services.forEach(s => {
                                        appCount++;
                                        if (s.status === 'HEALTHY' || s.status === 'RUNNING') {
                                            runningCount++;
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
                store.dashboardStats.paas.koyeb = { total: appCount, running: runningCount };
            }

            // Fly.io
            if (fRes.ok) {
                const fData = await fRes.json();
                let appCount = 0;
                let runningCount = 0;
                if (fData.success && fData.data) {
                    fData.data.forEach(acc => {
                        if (acc.apps) {
                            acc.apps.forEach(app => {
                                appCount++;
                                if (app.status === 'deployed' || app.status === 'running') {
                                    runningCount++;
                                }
                            });
                        }
                    });
                }
                store.dashboardStats.paas.fly = { total: appCount, running: runningCount };
            }
        } catch (e) {
            console.error('[Dashboard] Fetch PaaS summary failed:', e);
        }
    },

    /**
     * 获取 DNS 摘要
     */
    async fetchDnsSummary() {
        try {
            const res = await fetch('/api/cf-dns/zones', { headers: store.getAuthHeaders() });
            if (res.ok) {
                const data = await res.json();
                if (data.success && Array.isArray(data.data)) {
                    store.dashboardStats.dns.zones = data.data.length;
                } else if (typeof data.zones === 'number') {
                    store.dashboardStats.dns.zones = data.zones;
                }
            }
        } catch (e) {
            console.error('[Dashboard] Fetch DNS summary failed:', e);
        }
    }
};

// 在 store 中初始化相关状态
Object.assign(store, {
    dashboardLoading: false,
    dashboardLastUpdate: '',
    dashboardStats: {
        servers: { total: 0, online: 0, offline: 0, error: 0 },
        antigravity: { total_calls: 0, success_calls: 0, fail_calls: 0 },
        geminiCli: { total_calls: 0, success_calls: 0, fail_calls: 0 },
        paas: {
            zeabur: { total: 0, running: 0 },
            koyeb: { total: 0, running: 0 },
            fly: { total: 0, running: 0 }
        },
        dns: { zones: 0 }
    }
});
