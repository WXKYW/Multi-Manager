/**
 * SSH 分屏管理模块 (重构版)
 * 
 * 核心设计原则:
 * 1. 简化状态: 只维护 visibleSessionIds 数组
 * 2. 布局自动计算: 根据 visibleSessionIds.length 自动决定布局
 * 3. DOM 同步可靠: 使用 Vue 响应式 + 延迟同步
 * 4. 拖拽简化: 只支持基本的分屏/替换操作
 */

export const sshSplitMethods = {
    /**
     * 获取指定 ID 的会话
     */
    getSessionById(id) {
        return (this.sshSessions || []).find(s => s.id === id);
    },

    // ==================== 核心分屏 API ====================

    /**
     * 添加会话到分屏视图
     * @param {string} sessionId - 要添加的会话 ID
     * @param {string} position - 添加位置: 'left', 'right', 'top', 'bottom'
     */
    addToSplitView(sessionId, position = 'right') {
        if (!sessionId) return;

        // 防止重复添加
        if (this.visibleSessionIds.includes(sessionId)) {
            this.activeSSHSessionId = sessionId;
            return;
        }

        // 最多支持 4 个窗格
        if (this.visibleSessionIds.length >= 4) {
            this.showGlobalToast('最多支持 4 个分屏窗格', 'warning');
            return;
        }

        // 如果当前是单屏模式，先初始化 visibleSessionIds
        if (this.sshViewLayout === 'single') {
            this.visibleSessionIds = this.activeSSHSessionId
                ? [this.activeSSHSessionId]
                : [];
        }

        // 根据位置插入
        if (position === 'left' || position === 'top') {
            this.visibleSessionIds.unshift(sessionId);
        } else {
            this.visibleSessionIds.push(sessionId);
        }

        // 自动设置布局
        this._updateLayoutMode(position);
        this.activeSSHSessionId = sessionId;

        // 同步 DOM
        this._scheduleSync();
    },

    /**
     * 从分屏视图移除会话
     * @param {string} sessionId - 要移除的会话 ID
     */
    removeFromSplitView(sessionId) {
        const index = this.visibleSessionIds.indexOf(sessionId);
        if (index === -1) return;

        this.visibleSessionIds.splice(index, 1);

        // 如果只剩一个或没有，恢复单屏
        if (this.visibleSessionIds.length <= 1) {
            this._resetToSingle();
        } else {
            this._scheduleSync();
        }

        // 如果关闭的是当前激活的，切换到其他
        if (this.activeSSHSessionId === sessionId && this.visibleSessionIds.length > 0) {
            this.activeSSHSessionId = this.visibleSessionIds[0];
        }
    },

    /**
     * 重置为单屏模式
     */
    _resetToSingle() {
        // 保存终端到仓库
        this._saveToWarehouse();

        this.sshViewLayout = 'single';
        this.visibleSessionIds = [];

        this._scheduleSync();
    },

    /**
     * 根据窗格数量和位置自动更新布局模式
     */
    _updateLayoutMode(position = 'right') {
        const count = this.visibleSessionIds.length;

        if (count <= 1) {
            this.sshViewLayout = 'single';
        } else if (count === 2) {
            // 2 屏根据位置决定横向/纵向
            this.sshViewLayout = (position === 'top' || position === 'bottom')
                ? 'split-v'
                : 'split-h';
        } else {
            // 3-4 屏使用网格
            this.sshViewLayout = 'grid';
        }
    },

    // ==================== 拖拽处理 ====================

    /**
     * 标签拖拽开始
     */
    onTabDragStart(sessionId, event) {
        this.draggedSessionId = sessionId;
        this.dropHint = '';
        this.dropTargetId = null;

        if (event?.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', sessionId);
        }
    },

    /**
     * 标签拖拽结束
     */
    onTabDragEnd() {
        this.draggedSessionId = null;
        this.dropHint = '';
        this.dropTargetId = null;
    },

    /**
     * 设置拖拽提示
     */
    onDropZoneEnter(position, targetId) {
        this.dropHint = position;
        this.dropTargetId = targetId;
    },

    /**
     * 清除拖拽提示
     */
    onDropZoneLeave() {
        this.dropHint = '';
        this.dropTargetId = null;
    },

    /**
     * 处理放置操作
     * @param {string} targetId - 目标窗格的会话 ID (null 表示空区域)
     * @param {string} position - 放置位置
     */
    onDrop(targetId, position) {
        // 使用传入位置或当前悬停提示
        const effectivePosition = position || this.dropHint || 'center';
        const draggedId = this.draggedSessionId;

        console.log(`[SSH Split] Drop: dragged=${draggedId}, target=${targetId}, pos=${effectivePosition}`);

        if (!draggedId) {
            this.onTabDragEnd();
            return;
        }

        const draggedSession = this.getSessionById(draggedId);
        if (!draggedSession) {
            console.warn('[SSH Split] Dragged session not found:', draggedId);
            this.onTabDragEnd();
            return;
        }

        // 检查是否重复添加同一服务器 (分屏中一个服务器通常只显示一个会话)
        if (!this.visibleSessionIds.includes(draggedId)) {
            const isDuplicate = this.visibleSessionIds.some(id => {
                const s = this.getSessionById(id);
                return s && s.server.id === draggedSession.server.id && id !== targetId;
            });
            if (isDuplicate && effectivePosition !== 'center') {
                this.showGlobalToast('该服务器已在分屏显示中', 'info');
                this.onTabDragEnd();
                return;
            }
        }

        // 执行分屏或替换逻辑
        if (effectivePosition === 'center' && targetId) {
            this._replaceInSplit(targetId, draggedId);
        } else if (this.sshViewLayout === 'single') {
            this.addToSplitView(draggedId, effectivePosition);
        } else {
            this._insertInSplit(draggedId, targetId, effectivePosition);
        }

        this.onTabDragEnd();
        this._scheduleSync();
    },

    /**
     * 替换分屏中的会话
     */
    _replaceInSplit(targetId, newId) {
        const index = this.visibleSessionIds.indexOf(targetId);
        if (index !== -1) {
            // 如果新会话已在列表中，先移除再替换（实现交换）
            const newIndex = this.visibleSessionIds.indexOf(newId);
            if (newIndex !== -1) {
                // 交换位置
                this.visibleSessionIds[newIndex] = targetId;
            }
            this.visibleSessionIds[index] = newId;
        }
        this.activeSSHSessionId = newId;
    },

    /**
     * 在分屏中插入会话
     */
    _insertInSplit(sessionId, targetId, position) {
        // 先移除（如果已存在）
        const existingIndex = this.visibleSessionIds.indexOf(sessionId);
        if (existingIndex !== -1) {
            this.visibleSessionIds.splice(existingIndex, 1);
        }

        // 最多 4 个
        if (this.visibleSessionIds.length >= 4) {
            this.showGlobalToast('最多支持 4 个分屏窗格', 'warning');
            return;
        }

        // 计算插入位置
        let insertAt = this.visibleSessionIds.length;
        if (targetId) {
            const targetIndex = this.visibleSessionIds.indexOf(targetId);
            if (targetIndex !== -1) {
                insertAt = (position === 'right' || position === 'bottom')
                    ? targetIndex + 1
                    : targetIndex;
            }
        } else {
            // 无目标时根据位置决定
            insertAt = (position === 'left' || position === 'top') ? 0 : this.visibleSessionIds.length;
        }

        this.visibleSessionIds.splice(insertAt, 0, sessionId);
        this._updateLayoutMode(position);
        this.activeSSHSessionId = sessionId;
    },

    // ==================== DOM 同步 ====================

    /**
     * 调度 DOM 同步（防抖）
     */
    _scheduleSync() {
        if (this._syncTimer) clearTimeout(this._syncTimer);

        this.$nextTick(() => {
            this._syncTerminals();
            // 延迟二次同步确保渲染完成
            this._syncTimer = setTimeout(() => {
                this._syncTerminals();
                this._fitAll();
            }, 100);
        });
    },

    /**
     * 同步终端 DOM 节点到对应槽位
     */
    _syncTerminals() {
        // 确定当前应该显示的会话列表
        const idsToShow = this.sshViewLayout === 'single'
            ? (this.activeSSHSessionId ? [this.activeSSHSessionId] : [])
            : this.visibleSessionIds;

        // 将需要显示的终端移动到对应槽位
        idsToShow.forEach(id => {
            if (!id) return;
            const slot = document.getElementById('ssh-slot-' + id);
            const terminal = document.getElementById('ssh-terminal-' + id);

            if (slot && terminal && terminal.parentElement !== slot) {
                slot.appendChild(terminal);
            }
        });

        // 将不显示的终端移回仓库
        const warehouse = document.getElementById('ssh-terminal-warehouse');
        if (warehouse) {
            this.sshSessions.forEach(session => {
                if (!idsToShow.includes(session.id)) {
                    const terminal = document.getElementById('ssh-terminal-' + session.id);
                    if (terminal && terminal.parentElement !== warehouse) {
                        warehouse.appendChild(terminal);
                    }
                }
            });
        }
    },

    /**
     * 保存所有终端到仓库
     */
    _saveToWarehouse() {
        const warehouse = document.getElementById('ssh-terminal-warehouse');
        if (!warehouse) return;

        this.sshSessions.forEach(session => {
            const terminal = document.getElementById('ssh-terminal-' + session.id);
            if (terminal && terminal.parentElement !== warehouse) {
                warehouse.appendChild(terminal);
            }
        });
    },

    /**
     * 适配所有可见终端尺寸
     */
    _fitAll() {
        const idsToFit = this.sshViewLayout === 'single'
            ? (this.activeSSHSessionId ? [this.activeSSHSessionId] : [])
            : this.visibleSessionIds;

        idsToFit.forEach(id => {
            const session = this.getSessionById(id);
            if (session) {
                this.safeTerminalFit(session);
            }
        });
    },

    // ==================== 兼容旧 API ====================

    // 以下方法是对旧 API 的兼容封装

    handleTabDragStart(sessionId) {
        this.onTabDragStart(sessionId, window.event);
    },

    handleTabDragEnd() {
        this.onTabDragEnd();
    },

    setDropHint(pos, targetId = null) {
        this.onDropZoneEnter(pos, targetId);
    },

    clearDropHint() {
        this.onDropZoneLeave();
    },

    handleTerminalDragOver(e) {
        e.preventDefault();
    },

    handleTerminalDrop(targetId = null, position = 'center') {
        this.onDrop(targetId, position);
    },

    closeSplitView(sessionId) {
        this.removeFromSplitView(sessionId);
    },

    resetToSingleLayout() {
        this._resetToSingle();
    },

    syncTerminalDOM() {
        this._syncTerminals();
    },

    saveTerminalsToWarehouse() {
        this._saveToWarehouse();
    },

    fitAllVisibleSessions() {
        this._fitAll();
    }
};
