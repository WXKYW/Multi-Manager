/**
 * 监控指标模块
 * 负责实时指标流、轮询、历史记录、图表渲染等
 */

/**
 * 监控指标方法集合
 */
export const metricsMethods = {
    // ==================== 日志与轮询 ====================

    async loadMonitorLogs(page) {
        if (typeof page === 'number') {
            this.logPage = page;
        }

        this.monitorLogsLoading = true;

        try {
            const params = new URLSearchParams({
                page: this.logPage,
                pageSize: this.logPageSize
            });

            if (this.logFilter.serverId) {
                params.append('serverId', this.logFilter.serverId);
            }
            if (this.logFilter.status) {
                params.append('status', this.logFilter.status);
            }

            const response = await fetch(`/api/server/monitor/logs?${params}`, {
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (data.success) {
                this.monitorLogs = data.data;
            } else {
                this.showGlobalToast('加载日志失败: ' + data.error, 'error');
            }
        } catch (error) {
            console.error('加载监控日志失败:', error);
            this.showGlobalToast('加载监控日志失败', 'error');
        } finally {
            this.monitorLogsLoading = false;
        }
    },

    startServerPolling() {
        // 关键决策：若有 WebSocket 实时流，则无需发起任何 HTTP 主动探测
        if (this.metricsWsConnected) {
            if (this.serverPollingTimer) {
                console.warn('🛡️ 实时流已接管，正在休眠后台轮询任务');
                this.stopServerPolling();
            }
            return;
        }

        // 确保只有一个轮询定时器在运行
        if (this.serverPollingTimer) return;

        const interval = Math.max(30000, (this.monitorConfig.interval || 60) * 1000);
        console.log(`📡 实时流不可用，启动后台降级轮询 (${interval / 1000}s)`);

        // 重置倒计时
        this.serverRefreshCountdown = Math.floor(interval / 1000);
        this.serverRefreshProgress = 100;

        // 启动倒计时定时器 (仅在可见时运行)
        this.serverCountdownInterval = setInterval(() => {
            if (document.visibilityState !== 'visible') return;

            if (this.serverRefreshCountdown > 0) {
                this.serverRefreshCountdown--;
                this.serverRefreshProgress = (this.serverRefreshCountdown / (interval / 1000)) * 100;
            }
        }, 1000);

        // 启动主轮询定时器
        this.serverPollingTimer = setInterval(() => {
            // 只要可见且已认证就探测，不再局限于 server 标签页
            if (document.visibilityState === 'visible' && this.isAuthenticated) {
                this.probeAllServers();
                // 重置倒计时
                this.serverRefreshCountdown = Math.floor(interval / 1000);
                this.serverRefreshProgress = 100;
            }
        }, interval);
    },

    stopServerPolling() {
        if (this.serverPollingTimer) {
            clearInterval(this.serverPollingTimer);
            this.serverPollingTimer = null;
        }
        if (this.serverCountdownInterval) {
            clearInterval(this.serverCountdownInterval);
            this.serverCountdownInterval = null;
        }
    },

    // ==================== WebSocket 实时流 ====================

    connectMetricsStream() {
        if (!this.isAuthenticated) {
            console.warn('⚠️ 尝试连接实时流失败: 用户未登录');
            return;
        }

        if (this.metricsWsConnected || this.metricsWsConnecting) {
            console.warn('ℹ️ 实时指标流已在连接中或已连接');
            return;
        }

        this.metricsWsConnecting = true;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/metrics`;

        console.warn('🚀 正在发起实时指标流连接:', wsUrl);
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            this.metricsWsConnected = true;
            this.metricsWsConnecting = false;
            console.warn('✅ 实时指标流握手成功');
        };

        ws.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.type === 'metrics_update') {
                    this.handleMetricsUpdate(payload.data);
                }
            } catch (err) {
                console.error('解析指标数据失败:', err);
            }
        };

        ws.onclose = () => {
            this.metricsWsConnected = false;
            this.metricsWsConnecting = false;
            this.metricsWs = null;
            console.warn('❌ 实时指标流连接已关闭');
        };

        ws.onerror = (err) => {
            console.error('WebSocket 连接错误:', err);
            this.metricsWsConnecting = false;
            this.metricsWsConnected = false;
        };

        this.metricsWs = ws;
    },

    closeMetricsStream() {
        if (this.metricsWs) {
            this.metricsWs.close();
            this.metricsWs = null;
        }
    },

    handleMetricsUpdate(data) {
        if (!data || !Array.isArray(data)) return;

        // 智能更新 serverList 中的数据
        data.forEach(item => {
            const server = this.serverList.find(s => s.id === item.serverId);
            if (server) {
                // 初始化结构（如果为空）
                if (!server.info) {
                    server.info = {
                        cpu: { Load: '', Usage: '0%', Cores: '-' },
                        memory: { Used: '-', Total: '-', Usage: '0%' },
                        disk: [{ device: '/', used: '-', total: '-', usage: '0%' }],
                        system: {},
                        docker: { installed: false, containers: [] }
                    };
                }

                // 1. 更新 CPU 负载
                if (!server.info.cpu) server.info.cpu = {};
                server.info.cpu.Load = item.metrics.load;
                server.info.cpu.Usage = item.metrics.cpu_usage;
                server.info.cpu.Cores = item.metrics.cores || '-';

                // 2. 更新内存数据 (解析 "123/1024MB")
                if (!server.info.memory) server.info.memory = {};
                const memMatch = item.metrics.mem_usage.match(/(\d+)\/(\d+)MB/);
                if (memMatch) {
                    const used = parseInt(memMatch[1]);
                    const total = parseInt(memMatch[2]);
                    server.info.memory.Used = used + ' MB';
                    server.info.memory.Total = total + ' MB';
                    server.info.memory.Usage = Math.round((used / total) * 100) + '%';
                }

                // 3. 更新磁盘数据 (解析 "10G/50G (20%)")
                if (!server.info.disk || !server.info.disk[0]) {
                    server.info.disk = [{ device: '/', used: '-', total: '-', usage: '0%' }];
                }
                const diskMatch = item.metrics.disk_usage.match(/([^\/]+)\/([^\s]+)\s\(([\d%.]+)\)/);
                if (diskMatch) {
                    server.info.disk[0].used = diskMatch[1];
                    server.info.disk[0].total = diskMatch[2];
                    server.info.disk[0].usage = diskMatch[3];
                }

                // 4. 更新 Docker 概要信息
                if (!server.info.docker) server.info.docker = { installed: false, containers: [] };
                server.info.docker.installed = item.metrics.docker.installed;
                server.info.docker.runningCount = item.metrics.docker.running;
                server.info.docker.stoppedCount = item.metrics.docker.stopped;

                server.status = 'online';
                server.error = null;
            }
        });
    },

    // ==================== 主动探测 ====================

    async probeAllServers() {
        this.probeStatus = 'loading';
        try {
            const response = await fetch('/api/server/check-all', { method: 'POST' });
            const data = await response.json();
            if (data.success) {
                this.probeStatus = 'success';
                await this.loadServerList();
            } else {
                this.probeStatus = 'error';
            }
        } catch (error) {
            console.error('探测主机失败:', error);
            this.probeStatus = 'error';
        }
        setTimeout(() => { this.probeStatus = ''; }, 3000);
    },

    // ==================== 历史指标 ====================

    async loadMetricsHistory(page = null) {
        if (page !== null) {
            this.metricsHistoryPagination.page = page;
        }

        this.metricsHistoryLoading = true;

        try {
            // 计算时间范围 (使用 UTC 时间)
            let startTime = null;
            const now = Date.now();

            switch (this.metricsHistoryTimeRange) {
                case '1h':
                    startTime = new Date(now - 60 * 60 * 1000).toISOString();
                    break;
                case '6h':
                    startTime = new Date(now - 6 * 60 * 60 * 1000).toISOString();
                    break;
                case '24h':
                    startTime = new Date(now - 24 * 60 * 60 * 1000).toISOString();
                    break;
                case '7d':
                    startTime = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
                    break;
                case 'all':
                default:
                    startTime = null;
            }

            console.log('[History] 查询时间范围:', this.metricsHistoryTimeRange, '起始时间:', startTime);

            // 移除分页逻辑，一次性加载所有数据
            const params = new URLSearchParams({
                page: 1, // 始终第一页
                pageSize: 10000 // 足够大的页容量以获取该时间段内所有数据
            });

            if (this.metricsHistoryFilter.serverId) {
                params.append('serverId', this.metricsHistoryFilter.serverId);
            }

            if (startTime) {
                params.append('startTime', startTime);
            }

            const response = await fetch(`/api/server/metrics/history?${params}`, {
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (data.success) {
                this.metricsHistoryList = data.data;
                this.metricsHistoryTotal = data.pagination.total;
                this.metricsHistoryPagination = {
                    page: data.pagination.page,
                    pageSize: data.pagination.pageSize,
                    totalPages: data.pagination.totalPages
                };
            } else {
                this.showGlobalToast('加载历史记录失败: ' + data.error, 'error');
            }

            // 同时加载采集器状态
            this.loadCollectorStatus();

            // 渲染图表
            this.$nextTick(() => {
                this.renderMetricsCharts();
            });
        } catch (error) {
            console.error('加载历史指标失败:', error);
            this.showGlobalToast('加载历史指标失败', 'error');
        } finally {
            this.metricsHistoryLoading = false;
        }
    },

    setMetricsTimeRange(range) {
        this.metricsHistoryTimeRange = range;
        this.loadMetricsHistory(1);
    },

    async triggerMetricsCollect() {
        try {
            const response = await fetch('/api/server/metrics/collect', { method: 'POST' });
            const data = await response.json();

            if (data.success) {
                this.showGlobalToast('已触发历史指标采集', 'success');
                setTimeout(() => this.loadMetricsHistory(), 1000);
            } else {
                this.showGlobalToast('触发采集失败: ' + data.error, 'error');
            }
        } catch (error) {
            console.error('触发采集失败:', error);
            this.showGlobalToast('触发采集失败', 'error');
        }
    },

    // ==================== 图表渲染 ====================

    renderMetricsCharts() {
        if (!window.Chart || !this.groupedMetricsHistory) return;

        Object.entries(this.groupedMetricsHistory).forEach(([serverId, records]) => {
            // 渲染历史页面的大图表
            this.renderSingleChart(serverId, records, `metrics-chart-${serverId}`);
            // 同时尝试渲染卡片图表 (如果 DOM 存在)
            this.renderSingleChart(serverId, records, `metrics-chart-card-${serverId}`);
        });
    },

    /**
     * 渲染单个指标图表
     * @param {string} serverId 主机 ID
     * @param {Array} records 历史记录数据
     * @param {string} canvasId Canvas 元素 ID
     */
    renderSingleChart(serverId, records, canvasId) {
        if (!window.Chart || !records || records.length === 0) return;

        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        // 由于记录通常是记录时间倒序排列的，绘图前先克隆并正序排列
        const sortedRecords = [...records].sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));

        // 准备数据
        const labels = sortedRecords.map(r => {
            const d = new Date(r.recorded_at);
            return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
        });
        const cpuData = sortedRecords.map(r => r.cpu_usage || 0);
        const memData = sortedRecords.map(r => r.mem_usage || 0);

        // 销毁已存在的实例
        const existingChart = Chart.getChart(canvas);
        if (existingChart) {
            existingChart.destroy();
        }

        // 创建新图表
        new Chart(canvas, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'CPU (%)',
                        data: cpuData,
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 1,
                        pointHoverRadius: 4
                    },
                    {
                        label: '内存 (%)',
                        data: memData,
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 1,
                        pointHoverRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        padding: 10,
                        backgroundColor: 'rgba(13, 17, 23, 0.9)',
                        titleColor: '#8b949e',
                        bodyColor: '#e6edf3',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1
                    }
                },
                scales: {
                    x: {
                        display: true,
                        grid: { display: false },
                        ticks: {
                            maxRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: 6,
                            font: { size: 11 },
                            color: '#8b949e'
                        }
                    },
                    y: {
                        display: true,
                        min: 0,
                        max: 100,
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: {
                            font: { size: 11 },
                            color: '#8b949e',
                            stepSize: 20
                        }
                    }
                },
                interaction: {
                    mode: 'nearest',
                    axis: 'x',
                    intersect: false
                }
            }
        });
    },

    /**
     * 为特定主机加载指标历史数据（用于卡片展示）
     */
    async loadCardMetrics(serverId) {
        if (!serverId) return;

        try {
            const params = new URLSearchParams({
                serverId: serverId,
                page: 1,
                pageSize: 30 // 获取最近 30 条记录
            });

            const response = await fetch(`/api/server/metrics/history?${params}`, {
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (data.success && data.data.length > 0) {
                // 如果当前已经在 history 列表里了，则合并，否则直接放入
                // 为了简单起见，我们直接看 groupedMetricsHistory 能否拿到
                // 我们把获取到的数据放入一个临时的缓存或直接渲染
                const records = data.data;

                this.$nextTick(() => {
                    this.renderSingleChart(serverId, records, `metrics-chart-card-${serverId}`);
                });
            }
        } catch (error) {
            console.error('加载卡片指标失败:', error);
        }
    },

    // ==================== 采集器管理 ====================

    async loadCollectorStatus() {
        try {
            const response = await fetch('/api/server/metrics/collector/status', {
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (data.success) {
                this.metricsCollectorStatus = data.data;
                if (data.data.interval) {
                    this.metricsCollectInterval = Math.floor(data.data.interval / 60000);
                }
            }
        } catch (error) {
            console.error('加载采集器状态失败:', error);
        }
    },

    getCpuClass(usage) {
        if (!usage && usage !== 0) return '';
        const val = parseFloat(usage);
        if (val >= 90) return 'critical';
        if (val >= 70) return 'warning';
        return 'normal';
    },

    toggleMetricsServerExpand(serverId) {
        const index = this.expandedMetricsServers.indexOf(serverId);
        if (index === -1) {
            this.expandedMetricsServers.push(serverId);
        } else {
            this.expandedMetricsServers.splice(index, 1);
        }
    },

    async updateMetricsCollectInterval() {
        try {
            const intervalMs = this.metricsCollectInterval * 60 * 1000;
            const response = await fetch('/api/server/metrics/collector/interval', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ interval: intervalMs })
            });
            const data = await response.json();

            if (data.success) {
                this.showGlobalToast(`采集间隔已更新为 ${this.metricsCollectInterval} 分钟`, 'success');
                this.loadCollectorStatus();
            } else {
                this.showGlobalToast('更新失败: ' + data.error, 'error');
            }
        } catch (error) {
            console.error('更新采集间隔失败:', error);
            this.showGlobalToast('更新采集间隔失败', 'error');
        }
    },

    /**
     * 加载监控配置
     */
    async loadMonitorConfig() {
        try {
            const response = await fetch('/api/server/monitor/config', {
                headers: this.getAuthHeaders()
            });
            const data = await response.json();
            if (data.success) {
                this.monitorConfig = data.data;
                // 同步更新显示用的采集间隔
                if (data.data.metrics_collect_interval) {
                    this.metricsCollectInterval = Math.floor(data.data.metrics_collect_interval / 60);
                }
                // 加载采集器运行状态
                this.loadCollectorStatus();
            }
        } catch (error) {
            console.error('加载监控配置失败:', error);
        }
    },

    /**
     * 更新监控全局配置
     */
    async updateMonitorConfig() {
        try {
            const response = await fetch('/api/server/monitor/config', {
                method: 'PUT',
                headers: {
                    ...this.getAuthHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(this.monitorConfig)
            });
            const data = await response.json();
            if (data.success) {
                this.showGlobalToast('配置已更新', 'success');
                this.loadCollectorStatus();
                // 重新加载配置以确保同步
                this.loadMonitorConfig();
            }
        } catch (error) {
            this.showGlobalToast('配置更新失败', 'error');
            console.error('更新配置失败:', error);
        }
    }
};
