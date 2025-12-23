/**
 * SSH 终端管理模块
 * 负责 SSH 会话管理、终端初始化、分屏布局、主题切换等
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { toast } from './toast.js';

/**
 * SSH 终端方法集合
 */
export const sshMethods = {
    /**
     * 打开 SSH 终端(切换到 IDE 视图)
     */
    openSSHTerminal(server) {
        if (!server) return;

        // 检查是否已经打开了该主机的终端
        const existingSession = this.sshSessions.find(s => s.server.id === server.id);
        if (existingSession) {
            this.switchToSSHTab(existingSession.id);
            return;
        }

        const sessionId = 'session_' + Date.now();
        const session = {
            id: sessionId,
            server: server,
            terminal: null,
            fit: null,
            ws: null,
            connected: false
        };

        this.sshSessions.push(session);
        this.activeSSHSessionId = sessionId;
        this.serverCurrentTab = 'terminal';

        this.$nextTick(() => {
            this.initSessionTerminal(sessionId);
            // 延迟同步 DOM 确保 Vue 渲染完成
            setTimeout(() => this.syncTerminalDOM(), 50);
            setTimeout(() => this.syncTerminalDOM(), 200);
        });
    },

    /**
     * 切换当前激活的 SSH 会话
     */
    switchToSSHTab(sessionId) {
        this.serverCurrentTab = 'terminal';
        this.activeSSHSessionId = sessionId;

        // 如果目标会话不在当前分屏中，自动退出分屏返回单屏模式
        if (this.sshViewLayout !== 'single' && !this.visibleSessionIds.includes(sessionId)) {
            this.resetToSingleLayout();
        }

        this.$nextTick(() => {
            this.syncTerminalDOM(); // 同步 DOM 节点位置
            this.fitAllVisibleSessions();
            const session = this.getSessionById(sessionId);
            if (session && session.terminal) session.terminal.focus();
        });
    },

    /**
     * 关闭SSH会话
     */
    closeSSHSession(sessionId) {
        const index = this.sshSessions.findIndex(s => s.id === sessionId);
        if (index === -1) return;

        const session = this.sshSessions[index];

        // 清除心跳定时器
        if (session.heartbeatInterval) {
            clearInterval(session.heartbeatInterval);
            session.heartbeatInterval = null;
        }

        // 关闭 WebSocket 连接
        if (session.ws) {
            if (session.ws.readyState === WebSocket.OPEN) {
                session.ws.send(JSON.stringify({ type: 'disconnect' }));
            }
            session.ws.close();
        }

        // 移除 resize 监听器
        if (session.resizeHandler) {
            window.removeEventListener('resize', session.resizeHandler);
        }

        // 清理 ResizeObserver
        if (session.resizeObserver) {
            session.resizeObserver.disconnect();
        }

        // 销毁终端实例
        if (session.terminal) {
            session.terminal.dispose();
        }

        // 核心修复：从全局仓库中彻底删除该节点的 DOM 元素
        const terminalEl = document.getElementById('ssh-terminal-' + sessionId);
        if (terminalEl) {
            terminalEl.remove();
        }

        // 从数组中移除
        this.sshSessions.splice(index, 1);

        // 如果关闭的是当前激活的会话，切换到其他会话
        if (this.activeSSHSessionId === sessionId) {
            if (this.sshSessions.length > 0) {
                // 切换到下一个可用的会话（优先选择列表中的最后一个）
                const nextSession = this.sshSessions[this.sshSessions.length - 1];
                this.switchToSSHTab(nextSession.id);
            } else {
                // 如果没有会话了，清空激活ID并返回主机列表
                this.activeSSHSessionId = null;
                this.serverCurrentTab = 'list';
            }
        }
    },

    /**
     * 重新连接SSH会话
     */
    reconnectSSHSession(sessionId) {
        const session = this.sshSessions.find(s => s.id === sessionId);
        if (!session) return;

        console.log(`[SSH ${sessionId}] 开始重新连接...`);

        // 清除心跳定时器
        if (session.heartbeatInterval) {
            clearInterval(session.heartbeatInterval);
            session.heartbeatInterval = null;
        }

        // 如果已连接，先断开
        if (session.ws) {
            if (session.ws.readyState === WebSocket.OPEN) {
                session.ws.send(JSON.stringify({ type: 'disconnect' }));
            }
            session.ws.close();
            session.ws = null;
        }

        // 清空终端并显示重连信息
        if (session.terminal) {
            session.terminal.clear();
            session.terminal.writeln(`\x1b[1;33m正在重新连接到 ${session.server.name} (${this.formatHost(session.server.host)})...\x1b[0m`);
        }

        // 建立新的 WebSocket 连接
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/ssh`);
        session.ws = ws;

        ws.onopen = () => {
            console.log(`[SSH ${sessionId}] WebSocket 已重新连接`);
            ws.send(JSON.stringify({
                type: 'connect',
                serverId: session.server.id,
                cols: session.terminal.cols,
                rows: session.terminal.rows
            }));

            // 启动心跳保活
            session.heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                switch (msg.type) {
                    case 'connected':
                        session.connected = true;
                        session.terminal.writeln(`\x1b[1;32m${msg.message}\x1b[0m`);
                        session.terminal.writeln('');
                        break;
                    case 'output':
                        session.terminal.write(msg.data);
                        break;
                    case 'error':
                        session.terminal.writeln(`\x1b[1;31m错误: ${msg.message}\x1b[0m`);
                        break;
                    case 'disconnected':
                        session.connected = false;
                        session.terminal.writeln('');
                        session.terminal.writeln(`\x1b[1;33m${msg.message}\x1b[0m`);
                        break;
                }
            } catch (e) {
                console.error('解析消息失败:', e);
            }
        };

        ws.onerror = () => {
            session.terminal.writeln(`\x1b[1;31mWebSocket 连接错误\x1b[0m`);
        };

        ws.onclose = () => {
            console.log(`[SSH ${sessionId}] WebSocket 已关闭`);

            // 清除心跳定时器
            if (session.heartbeatInterval) {
                clearInterval(session.heartbeatInterval);
                session.heartbeatInterval = null;
            }

            if (session.connected) {
                session.terminal.writeln('');
                session.terminal.writeln(`\x1b[1;33m连接已断开。点击"重新连接"按钮恢复连接。\x1b[0m`);
            }
            session.connected = false;
        };
    },

    // ==================== SSH 分屏拖拽逻辑 ====================

    handleTabDragStart(sessionId) {
        this.draggedSessionId = sessionId;
        this.dropHint = '';
        this.dropTargetId = null;

        // 增强某些浏览器的兼容性
        if (event && event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', sessionId);
        }
    },

    handleTabDragEnd() {
        this.draggedSessionId = null;
        this.dropHint = '';
        this.dropTargetId = null;
    },

    setDropHint(pos, targetId = null) {
        this.dropHint = pos;
        this.dropTargetId = targetId;
    },

    clearDropHint() {
        this.dropHint = '';
        this.dropTargetId = null;
    },

    handleTerminalDragOver(e) {
        e.preventDefault();
    },

    handleTerminalDrop(targetId = null, position = 'center') {
        const effectivePosition = position || this.dropHint || 'center';
        if (!this.draggedSessionId) {
            this.handleTabDragEnd();
            return;
        }

        const draggedId = this.draggedSessionId;
        const isAlreadyVisible = this.visibleSessionIds.includes(draggedId);

        // --- 1. 重复性检查 (仅针对从标签栏新拖入的情况) ---
        if (!isAlreadyVisible) {
            const draggedSession = this.getSessionById(draggedId);
            if (draggedSession) {
                // 检查该服务器是否已经有其他会话在显示了
                const isServerShown = this.visibleSessionIds.some(id => {
                    if (id === targetId && effectivePosition === 'center') return false; // 允许替换
                    const s = this.getSessionById(id);
                    return s && s.server.id === draggedSession.server.id;
                });

                // 如果是单屏模式切分屏，检查 active 会话
                const activeSession = this.getSessionById(this.activeSSHSessionId);
                const isActiveSameServer = this.sshViewLayout === 'single' &&
                    activeSession &&
                    activeSession.server.id === draggedSession.server.id;

                if (isServerShown || (isActiveSameServer && effectivePosition !== 'center')) {
                    toast.info('该服务器已在分屏显示中');
                    this.handleTabDragEnd();
                    return;
                }
            }
        }

        // --- 2. 布局逻辑处理 ---
        if (this.sshViewLayout === 'single') {
            if (effectivePosition === 'center') {
                this.activeSSHSessionId = draggedId;
            } else {
                // 单屏切分屏
                this.visibleSessionIds = (effectivePosition === 'left' || effectivePosition === 'top')
                    ? [draggedId, this.activeSSHSessionId]
                    : [this.activeSSHSessionId, draggedId];
                this.sshViewLayout = (effectivePosition === 'left' || effectivePosition === 'right') ? 'split-h' : 'split-v';
                this.activeSSHSessionId = draggedId;
            }
        } else {
            // 分屏模式下的 移动/替换/交换
            const draggedIndex = this.visibleSessionIds.indexOf(draggedId);
            const targetIndex = this.visibleSessionIds.indexOf(targetId);

            if (effectivePosition === 'center') {
                // 替换或交换
                if (targetIndex !== -1) {
                    if (isAlreadyVisible && draggedIndex !== -1) {
                        // 交换位置 (Swap)
                        const newVisibleIds = [...this.visibleSessionIds];
                        [newVisibleIds[draggedIndex], newVisibleIds[targetIndex]] = [newVisibleIds[targetIndex], newVisibleIds[draggedIndex]];
                        this.visibleSessionIds = newVisibleIds;
                    } else {
                        // 外部替换
                        this.visibleSessionIds.splice(targetIndex, 1, draggedId);
                    }
                }
            } else {
                // 拆分或重新排序 (Rearrange)
                let newVisibleIds = this.visibleSessionIds.filter(id => id !== draggedId);
                let targetIdx = newVisibleIds.indexOf(targetId);

                if (targetIdx !== -1) {
                    let insertAt = targetIdx;

                    // 核心修复：针对 2 列 Grid 布局计算索引
                    // 在 Grid 中，索引 0|1 是第一行，2|3 是第二行
                    if (effectivePosition === 'right' || effectivePosition === 'bottom') {
                        insertAt = targetIdx + 1;
                    }

                    // 特殊处理：如果当前是 2 屏左右(H) 且 向下拆分左侧窗口(0)
                    // 我们希望结果是：[0, 1] 变成 [0, 1, new]，在网格中 new 就会出现在 0 的下方
                    if (this.sshViewLayout === 'split-h' && effectivePosition === 'bottom' && targetIdx === 0) {
                        insertAt = 2;
                    }

                    newVisibleIds.splice(insertAt, 0, draggedId);
                } else {
                    // 边缘放置
                    newVisibleIds.push(draggedId);
                }

                this.visibleSessionIds = newVisibleIds;

                // 智能布局切换
                if (this.visibleSessionIds.length === 2) {
                    if (effectivePosition === 'left' || effectivePosition === 'right') {
                        this.sshViewLayout = 'split-h';
                    } else {
                        this.sshViewLayout = 'split-v';
                    }
                } else if (this.visibleSessionIds.length === 3) {
                    // 核心修复：根据当前布局趋势决定 3 屏方向
                    // 如果已经在左右分屏，向下拆分应保持左右结构 (Master-Stack)
                    if (this.sshViewLayout === 'split-h') {
                        this.sshViewLayout = 'grid';
                    } else if (this.sshViewLayout === 'split-v') {
                        this.sshViewLayout = 'grid-v';
                    } else {
                        // 兜底逻辑
                        this.sshViewLayout = (effectivePosition === 'top' || effectivePosition === 'bottom') ? 'grid-v' : 'grid';
                    }
                } else if (this.visibleSessionIds.length > 3) {
                    this.sshViewLayout = 'grid';
                }
            }
            this.activeSSHSessionId = draggedId;
        }

        this.handleTabDragEnd();

        // --- 4. 同步与适配 ---
        this.$nextTick(() => {
            this.syncTerminalDOM();

            // 针对复杂的 3 屏/4 屏布局，二次同步确保万无一失
            setTimeout(() => this.syncTerminalDOM(), 100);

            this.fitAllVisibleSessions();
        });
    },

    closeSplitView(sessionId) {
        this.visibleSessionIds = this.visibleSessionIds.filter(id => id !== sessionId);

        // 自适应：如果只剩一个会话，或没有会话了，自动恢复到 single 模式
        if (this.visibleSessionIds.length <= 1) {
            this.resetToSingleLayout();
        } else {
            // 如果还剩多个，更新网格计数变量并重新 Fit
            this.$nextTick(() => {
                this.syncTerminalDOM(); // 同步 DOM 节点位置
                this.fitAllVisibleSessions();
            });
        }
    },

    getSessionById(id) {
        return this.sshSessions.find(s => s.id === id);
    },

    resetToSingleLayout() {
        // 1. [核心修复] 在销毁分屏 Slot 之前，抢先将所有终端节点撤回全局仓库保护
        this.saveTerminalsToWarehouse();

        this.sshViewLayout = 'single';
        this.visibleSessionIds = [];

        this.$nextTick(() => {
            this.syncTerminalDOM(); // 2. 重新挂载到单屏 Slot
            this.fitAllVisibleSessions();

            // 3. 二次补偿同步
            setTimeout(() => {
                this.syncTerminalDOM();
                this.fitAllVisibleSessions();
            }, 150);
        });
    },

    /**
     * 同步终端 DOM 节点，将其实际挂载点移动到当前布局的槽位中
     */
    syncTerminalDOM() {
        const isTerminalTab = this.serverCurrentTab === 'terminal';
        const idsToShow = (this.mainActiveTab === 'server' && isTerminalTab)
            ? (this.sshViewLayout === 'single' ? (this.activeSSHSessionId ? [this.activeSSHSessionId] : []) : this.visibleSessionIds)
            : [];

        idsToShow.forEach(id => {
            if (!id) return;
            const slot = document.getElementById('ssh-slot-' + id);
            const terminalEl = document.getElementById('ssh-terminal-' + id);
            const session = this.getSessionById(id);

            if (slot && terminalEl && session && session.terminal) {
                if (terminalEl.parentElement !== slot) {
                    // 将终端节点移动到可见的槽位中
                    slot.appendChild(terminalEl);

                    this.$nextTick(() => {
                        this.safeTerminalFit(session);
                        if (id === this.activeSSHSessionId) {
                            setTimeout(() => session.terminal.focus(), 50);
                        }
                    });
                }
            }
        });

        // 将其余终端放回仓库保活
        const warehouse = document.getElementById('ssh-terminal-warehouse');
        if (warehouse) {
            this.sshSessions.forEach(session => {
                if (!idsToShow.includes(session.id)) {
                    const terminalEl = document.getElementById('ssh-terminal-' + session.id);
                    if (terminalEl && terminalEl.parentElement !== warehouse) {
                        warehouse.appendChild(terminalEl);
                    }
                }
            });
        }
    },

    /**
     * 强制将所有终端节点撤回仓库保活
     */
    saveTerminalsToWarehouse() {
        const warehouse = document.getElementById('ssh-terminal-warehouse');
        if (!warehouse) return;
        this.sshSessions.forEach(session => {
            const el = document.getElementById('ssh-terminal-' + session.id);
            if (el && el.parentElement !== warehouse) {
                warehouse.appendChild(el);
            }
        });
    },

    /**
     * 初始化监听器，自动发现新 Slot 并挂载终端
     */
    initSshMountObserver() {
        if (this.sshMountObserver) this.sshMountObserver.disconnect();

        const observer = new MutationObserver((mutations) => {
            // 只有当有子节点变化时才尝试同步
            const hasRelevantChange = mutations.some(m => m.type === 'childList');
            if (hasRelevantChange && this.mainActiveTab === 'server' && this.serverCurrentTab === 'terminal') {
                this.syncTerminalDOM();
            }
        });

        // 缩小监听范围到具体的主机管理容器，而不是 body
        const container = document.getElementById('server-list-container');
        if (container) {
            observer.observe(container, { childList: true, subtree: true });
        } else {
            // Fallback
            observer.observe(document.body, { childList: true, subtree: true });
        }
        this.sshMountObserver = observer;
    },

    /**
     * 对所有当前可见的终端执行 Fit 序列，解决布局切换时的尺寸计算错位
     */
    fitAllVisibleSessions() {
        const ids = this.sshViewLayout === 'single'
            ? (this.activeSSHSessionId ? [this.activeSSHSessionId] : [])
            : this.visibleSessionIds;

        const runFit = () => {
            ids.forEach(id => {
                const session = this.getSessionById(id);
                if (session) this.safeTerminalFit(session);
            });
        };

        // 仅执行少量必要序列，配合 safeTerminalFit 内部的 rAF
        runFit();
        setTimeout(runFit, 150);
    },

    /**
     * 重新调整当前终端尺寸
     */
    fitCurrentSSHSession() {
        const session = this.sshSessions.find(s => s.id === this.activeSSHSessionId);
        if (session) {
            this.safeTerminalFit(session);
        }
    },

    /**
     * 切换 SSH 终端全屏模式 (使用浏览器原生全屏 API)
     */
    async toggleSSHTerminalFullscreen() {
        const sshLayout = document.querySelector('.ssh-ide-layout');
        if (!sshLayout) return;

        try {
            if (!document.fullscreenElement) {
                if (sshLayout.requestFullscreen) {
                    await sshLayout.requestFullscreen();
                } else if (sshLayout.webkitRequestFullscreen) {
                    await sshLayout.webkitRequestFullscreen();
                } else if (sshLayout.msRequestFullscreen) {
                    await sshLayout.msRequestFullscreen();
                }
            } else {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    await document.webkitExitFullscreen();
                } else if (document.msExitFullscreen) {
                    await document.msExitFullscreen();
                }
            }
        } catch (err) {
            console.error('全屏操作失败:', err);
            // 容错处理：即使 API 失败也尝试切换样式类
            this.sshIdeFullscreen = !this.sshIdeFullscreen;
            setTimeout(() => this.fitCurrentSSHSession(), 300);
        }

        // 统一监听全屏状态变化，不仅处理本方法触发的，也处理 Esc 键退出的情况
        if (!window._sshFullscreenListenerBound) {
            const onFullscreenChange = () => {
                this.sshIdeFullscreen = !!document.fullscreenElement;
                // 连续触发多次 Fit，应对不同浏览器动画时长差异，彻底解决错位 bug
                const fitSequence = [50, 150, 300, 600, 1000];
                fitSequence.forEach(delay => {
                    setTimeout(() => this.fitCurrentSSHSession(), delay);
                });
            };
            document.addEventListener('fullscreenchange', onFullscreenChange);
            document.addEventListener('webkitfullscreenchange', onFullscreenChange);
            window._sshFullscreenListenerBound = true;
        }
    },

    /**
     * 切换 SSH 窗口全屏模式 (使用浏览器 Fullscreen API)
     */
    async toggleSSHWindowFullscreen() {
        const sshLayout = document.querySelector('.ssh-ide-layout');
        if (!sshLayout) return;

        try {
            if (!document.fullscreenElement) {
                await sshLayout.requestFullscreen();
                this.sshWindowFullscreen = true;
            } else {
                await document.exitFullscreen();
                this.sshWindowFullscreen = false;
            }
        } catch (err) {
            console.error('窗口全屏切换失败:', err);
        }

        // 监听全屏变化事件
        document.addEventListener('fullscreenchange', () => {
            this.sshWindowFullscreen = !!document.fullscreenElement;
            setTimeout(() => this.fitCurrentSSHSession(), 100);
            setTimeout(() => this.fitCurrentSSHSession(), 300);
            setTimeout(() => this.fitCurrentSSHSession(), 500);
        }, { once: true });
    },

    /**
     * 切换 SSH 屏幕全屏模式 (使用浏览器原生全屏 API)
     */
    async toggleSSHScreenFullscreen() {
        const sshLayout = document.querySelector('.ssh-ide-layout');
        if (!sshLayout) return;

        try {
            if (!document.fullscreenElement) {
                await sshLayout.requestFullscreen();
                this.sshIdeFullscreen = true;
            } else {
                await document.exitFullscreen();
                this.sshIdeFullscreen = false;
            }
        } catch (err) {
            console.error('全屏切换失败:', err);
        }

        // 监听全屏变化事件
        document.addEventListener('fullscreenchange', () => {
            this.sshIdeFullscreen = !!document.fullscreenElement;
            setTimeout(() => this.fitCurrentSSHSession(), 100);
            setTimeout(() => this.fitCurrentSSHSession(), 300);
            setTimeout(() => this.fitCurrentSSHSession(), 500);
        }, { once: true });
    },

    /**
     * 更新所有终端的主题并强制重新渲染
     */
    updateAllTerminalThemes() {
        // 获取当前最新的主题配置
        const theme = this.getTerminalTheme();

        this.sshSessions.forEach(session => {
            if (session.terminal) {
                try {
                    // 核心修复：显式创建新对象，触发 xterm.js 的 options 监听器
                    session.terminal.options.theme = { ...theme };

                    // 确保渲染器重绘
                    if (session.terminal.buffer && session.terminal.buffer.active) {
                        session.terminal.refresh(0, session.terminal.rows - 1);
                    }
                } catch (err) {
                    console.error('更新终端主题失败:', err);
                }
            }
        });
    },

    /**
     * 获取终端主题配置 - 支持深色/浅色模式自动切换
     */
    getTerminalTheme() {
        // 1. 获取 Body 上的实时计算样式
        const computedStyle = getComputedStyle(document.body);
        let bg = computedStyle.getPropertyValue('--bg-primary').trim();
        let fg = computedStyle.getPropertyValue('--text-primary').trim();

        // 2. 转换颜色为规范的 RGB 格式以便计算亮度
        const parseToRGB = (colorStr) => {
            if (!colorStr) return [255, 255, 255];
            if (colorStr.startsWith('rgb')) {
                return colorStr.match(/\d+/g).map(Number);
            }
            if (colorStr.startsWith('#')) {
                let hex = colorStr.substring(1);
                if (hex.length === 3) hex = hex.split('').map(s => s + s).join('');
                return [
                    parseInt(hex.substring(0, 2), 16),
                    parseInt(hex.substring(2, 4), 16),
                    parseInt(hex.substring(4, 6), 16)
                ];
            }
            return [255, 255, 255];
        };

        const rgb = parseToRGB(bg);
        // 精确亮度计算 (W3C 标准)
        const brightness = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
        const isDark = brightness < 128;

        if (isDark) {
            // 深色模式 - 高对比度调优
            return {
                background: bg || '#0d1117',
                foreground: '#ffffff',
                cursor: '#ffffff',
                selection: 'rgba(56, 139, 253, 0.5)',
                selectionBackground: 'rgba(56, 139, 253, 0.5)',
                black: '#000000',
                red: '#ff6b6b',
                green: '#4ade80',
                yellow: '#fbbf24',
                blue: '#60a5fa',
                magenta: '#e879f9',
                cyan: '#22d3ee',
                white: '#ffffff',
                brightBlack: '#94a3b8',
                brightRed: '#f87171',
                brightGreen: '#4ade80',
                brightYellow: '#fbbf24',
                brightBlue: '#60a5fa',
                brightMagenta: '#e879f9',
                brightCyan: '#22d3ee',
                brightWhite: '#ffffff'
            };
        } else {
            // 浅色模式 - 极致对比度 (针对白底黑字优化)
            return {
                background: bg || '#ffffff',
                foreground: '#000000',
                cursor: '#000000',
                selection: 'rgba(99, 102, 241, 0.3)',
                selectionBackground: 'rgba(99, 102, 241, 0.3)',
                black: '#000000',
                red: '#b91c1c',
                green: '#166534',
                yellow: '#92400e',
                blue: '#1e40af',
                magenta: '#701a75',
                cyan: '#155e75',
                white: '#1f2937',
                brightBlack: '#4b5563',
                brightRed: '#dc2626',
                brightGreen: '#15803d',
                brightYellow: '#b45309',
                brightBlue: '#2563eb',
                brightMagenta: '#9333ea',
                brightCyan: '#0891b2',
                brightWhite: '#6b7280'
            };
        }
    },

    /**
     * 设置主题观察器
     */
    setupThemeObserver() {
        // 1. 监听系统主题变化 (prefers-color-scheme)
        const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handleThemeChange = () => {
            if (this.themeUpdateTimer) clearTimeout(this.themeUpdateTimer);
            this.themeUpdateTimer = setTimeout(() => {
                this.updateAllTerminalThemes();
            }, 150);
        };

        if (darkModeQuery.addEventListener) {
            darkModeQuery.addEventListener('change', handleThemeChange);
        } else if (darkModeQuery.addListener) {
            darkModeQuery.addListener(handleThemeChange);
        }

        // 2. 核心增强：监听 body 和 html 的属性变化 (类名、style 等)
        const attrObserver = new MutationObserver(handleThemeChange);
        attrObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        attrObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

        // 3. 监听自定义 CSS 样式表的变化
        const observer = new MutationObserver(handleThemeChange);
        const customCssElement = document.getElementById('custom-css');
        if (customCssElement) {
            observer.observe(customCssElement, { childList: true, characterData: true, subtree: true });
        }

        // 4. 兜底方案：周期性校准主题 (每1秒检查一次)
        // 解决某些主题切换仅修改 CSS 变量而不触发 DOM 事件的问题
        let lastBg = '';
        this.themePollingInterval = setInterval(() => {
            const currentBg = getComputedStyle(document.body).getPropertyValue('--bg-primary').trim();
            if (currentBg && currentBg !== lastBg) {
                lastBg = currentBg;
                this.updateAllTerminalThemes();
                // 额外的 500ms 延迟刷新，确保 CSS 变量完全生效
                setTimeout(() => this.updateAllTerminalThemes(), 500);
            }
        }, 1000);

        // 保存观察器
        this.themeObserver = observer;
        this.attrObserver = attrObserver;
    },

    /**
     * 初始化会话终端 (WebSocket 版本)
     */
    initSessionTerminal(sessionId) {
        const session = this.sshSessions.find(s => s.id === sessionId);
        if (!session) return;

        // 核心修复：如果全局仓库中不存在该节点的挂载点，则手动创建一个
        let terminalContainer = document.getElementById('ssh-terminal-' + sessionId);
        if (!terminalContainer) {
            const warehouse = document.getElementById('ssh-terminal-warehouse');
            if (!warehouse) {
                console.error('全局仓库 #ssh-terminal-warehouse 不存在！');
                return;
            }
            terminalContainer = document.createElement('div');
            terminalContainer.id = 'ssh-terminal-' + sessionId;
            warehouse.appendChild(terminalContainer);
        }

        // 清空容器
        terminalContainer.innerHTML = '';

        // 获取终端主题
        const theme = this.getTerminalTheme();

        // 创建 fit addon（必须在 Terminal 之前创建）
        const fit = new FitAddon();

        // 创建 xterm 实例 - 不指定固定的 cols/rows，让 FitAddon 计算
        const terminal = new Terminal({
            cursorBlink: true,
            cursorStyle: 'bar',
            fontSize: 14,
            fontFamily: 'Consolas, "Courier New", monospace',
            lineHeight: 1.2,
            theme: theme,
            scrollback: 5000,
            allowProposedApi: true // 允许使用新 API
        });

        // 加载插件
        terminal.loadAddon(fit);
        terminal.loadAddon(new WebLinksAddon());

        // 打开终端到容器
        terminal.open(terminalContainer);

        // 保存到会话
        session.terminal = terminal;
        session.fit = fit;

        // 打印容器尺寸用于调试
        console.log(`[SSH] 容器尺寸: ${terminalContainer.offsetWidth}x${terminalContainer.offsetHeight}`);

        // 安全的 fit 函数
        const doFit = () => {
            try {
                fit.fit();
                console.log(`[SSH] Fit 成功: ${terminal.cols}x${terminal.rows}`);
                return true;
            } catch (e) {
                console.log('[SSH] Fit 失败:', e.message);
                return false;
            }
        };

        // 延迟执行 fit - 给渲染器足够时间初始化
        setTimeout(doFit, 100);
        setTimeout(doFit, 300);
        setTimeout(doFit, 500);
        setTimeout(doFit, 1000);

        // 使用 ResizeObserver 监听容器大小变化
        const resizeObserver = new ResizeObserver(() => {
            if (session.fitTimeout) clearTimeout(session.fitTimeout);
            session.fitTimeout = setTimeout(() => {
                this.safeTerminalFit(session);
            }, 150);
        });
        resizeObserver.observe(terminalContainer);
        session.resizeObserver = resizeObserver;

        // 显示连接中信息
        terminal.writeln(`\x1b[1;33m正在连接到 ${session.server.name} (${this.formatHost(session.server.host)})...\x1b[0m`);

        // 建立 WebSocket 连接
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/ssh`);
        session.ws = ws;

        ws.onopen = () => {
            console.log(`[SSH ${sessionId}] WebSocket 已连接`);
            // 发送连接请求
            ws.send(JSON.stringify({
                type: 'connect',
                serverId: session.server.id,
                cols: terminal.cols,
                rows: terminal.rows
            }));

            // 启动心跳保活
            session.heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000); // 每30秒发送一次心跳
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);

                switch (msg.type) {
                    case 'connected':
                        session.connected = true;
                        // 连接成功后清屏，提供完全干净的界面
                        terminal.clear();
                        // 连接成功后再次 fit 确保终端填满容器
                        setTimeout(() => this.safeTerminalFit(session), 100);
                        break;

                    case 'output':
                        terminal.write(msg.data);
                        break;

                    case 'error':
                        terminal.writeln(`\x1b[1;31m错误: ${msg.message}\x1b[0m`);
                        break;

                    case 'disconnected':
                        session.connected = false;
                        terminal.writeln('');
                        terminal.writeln(`\x1b[1;33m${msg.message}\x1b[0m`);
                        break;
                }
            } catch (e) {
                console.error('解析消息失败:', e);
            }
        };

        ws.onerror = (error) => {
            terminal.writeln(`\x1b[1;31mWebSocket 连接错误\x1b[0m`);
            console.error('WebSocket error:', error);
        };

        ws.onclose = () => {
            console.log(`[SSH ${sessionId}] WebSocket 已关闭`);

            // 清除心跳定时器
            if (session.heartbeatInterval) {
                clearInterval(session.heartbeatInterval);
                session.heartbeatInterval = null;
            }

            if (session.connected) {
                terminal.writeln('');
                terminal.writeln(`\x1b[1;33m连接已断开。点击"重新连接"按钮恢复连接。\x1b[0m`);
            }
            session.connected = false;
        };

        // 监听终端输入，发送到 WebSocket (包含多屏同步逻辑)
        terminal.onData(data => {
            // 1. 发送到当前会话
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'input',
                    data: data
                }));
            }

            // 2. 多屏同步：如果开启了同步且当前会话在可见分屏中，则广播输入
            if (this.sshSyncEnabled && this.sshViewLayout !== 'single' && this.visibleSessionIds.includes(sessionId)) {
                this.visibleSessionIds.forEach(targetId => {
                    if (targetId === sessionId) return; // 避免重复发送给原始会话

                    const targetSession = this.getSessionById(targetId);
                    if (targetSession && targetSession.ws && targetSession.ws.readyState === WebSocket.OPEN) {
                        targetSession.ws.send(JSON.stringify({
                            type: 'input',
                            data: data
                        }));
                    }
                });
            }
        });

        // 监听窗口大小变化
        const resizeHandler = () => {
            this.safeTerminalFit(session);
        };
        window.addEventListener('resize', resizeHandler);
        session.resizeHandler = resizeHandler;
    },

    /**
     * 为指定主机添加新会话（作为子标签页）
     */
    addSessionForServer(server) {
        this.showAddSessionSelectModal = false;

        // 检查是否已存在该主机的会话
        const existingSession = this.sshSessions.find(s => s.server.id === server.id);
        if (existingSession) {
            // 如果已存在，直接切换到该标签页
            this.switchToSSHTab(existingSession.id);
            return;
        }

        const sessionId = 'session_' + Date.now();
        const session = {
            id: sessionId,
            server: server,
            terminal: null,
            fit: null,
            ws: null,
            connected: false
        };

        this.sshSessions.push(session);
        this.activeSSHSessionId = sessionId;

        // 切换到新的SSH标签页
        this.serverCurrentTab = 'terminal';

        this.$nextTick(() => {
            this.initSessionTerminal(sessionId);
            // 初始化后强制同步一次 DOM，将其从仓库移动到 Slot (如果它当前被激活)
            this.syncTerminalDOM();
        });
    },

    /**
     * 显示新建会话选择框
     */
    showAddSessionModal() {
        this.loadServerList();
        this.showAddSessionSelectModal = true;
    },

    /**
     * 全部打开主机列表中的所有 SSH 会话
     */
    async openAllServersInSSH() {
        if (this.serverList.length === 0) return;

        const count = this.serverList.length;
        this.showGlobalToast(`正在批量建立 ${count} 个连接...`, 'info');

        // 切换到终端标签页
        this.serverCurrentTab = 'terminal';
        this.showSSHQuickMenu = false;

        // 准备批量会话
        let newSessionIds = [];

        for (const server of this.serverList) {
            // 检查是否已经打开
            let session = this.sshSessions.find(s => s.server.id === server.id);
            if (!session) {
                const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                session = {
                    id: sessionId,
                    server: server,
                    terminal: null,
                    fit: null,
                    ws: null,
                    connected: false
                };
                this.sshSessions.push(session);
            }
            newSessionIds.push(session.id);
        }

        // 设置布局模式：如果多于 1 个，使用 grid
        if (newSessionIds.length > 1) {
            this.sshViewLayout = 'grid';
            this.visibleSessionIds = [...newSessionIds];
        } else {
            this.sshViewLayout = 'single';
            this.activeSSHSessionId = newSessionIds[0];
        }

        // 初始化所有新终端
        this.$nextTick(() => {
            newSessionIds.forEach(id => {
                const session = this.getSessionById(id);
                if (session && !session.terminal) {
                    this.initSessionTerminal(id);
                }
            });

            // 统一同步 DOM 并适配
            setTimeout(() => {
                this.syncTerminalDOM();
                this.fitAllVisibleSessions();
            }, 300);
        });
    },

    /**
     * 关闭所有 SSH 会话并返回列表
     */
    async closeAllSSHSessions() {
        if (this.sshSessions.length === 0) return;

        const confirmed = await this.showConfirm({
            title: '关闭所有会话',
            message: `确定要断开并关闭所有 ${this.sshSessions.length} 个 SSH 会话吗？`,
            icon: 'fa-power-off',
            confirmText: '全部关闭',
            confirmClass: 'btn-danger'
        });

        if (!confirmed) return;

        // 循环关闭所有，不带参数调用 closeSSHTerminal 即可
        this.closeSSHTerminal();
        this.showGlobalToast('所有 SSH 会话已关闭', 'info');
    },

    /**
     * 关闭 SSH 终端（关闭所有会话）
     */
    closeSSHTerminal() {
        // 逆序遍历并逐个关闭，以确保数组删除过程安全
        for (let i = this.sshSessions.length - 1; i >= 0; i--) {
            this.closeSSHSession(this.sshSessions[i].id);
        }
        // 最终确认状态
        this.activeSSHSessionId = null;
        this.serverCurrentTab = 'list';
    }
};
