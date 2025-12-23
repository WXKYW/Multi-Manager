/**
 * 自建服务模块 (Self-H) 前端逻辑
 */
import { store } from '../store.js';
import { toast } from './toast.js';

export const selfHMethods = {
    // 加载所有 OpenList 账号
    async loadOpenListAccounts() {
        try {
            const response = await fetch('/api/openlist/manage-accounts');
            const data = await response.json();
            if (data.success) {
                this.openListAccounts = data.data;
                this.openListStats.onlineCount = this.openListAccounts.filter(a => a.status === 'online').length;
                
                // 如果当前没有选中的账号，但有可用账号，则自动选择第一个
                if (!this.currentOpenListAccount && this.openListAccounts.length > 0) {
                    this.selectOpenListAccount(this.openListAccounts[0]);
                }
            }
        } catch (e) {
            console.error('Failed to load OpenList accounts:', e);
        }
    },

    // 切换到账号管理标签
    goToOpenListAccounts() {
        this.openListSubTab = 'accounts';
    },

    // 添加账号
    async doAddOpenListAccount() {
        if (!this.newOpenListAcc.name || !this.newOpenListAcc.api_url || !this.newOpenListAcc.api_token) {
            return toast.error('请填写完整信息');
        }
        try {
            const response = await fetch('/api/openlist/manage-accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.newOpenListAcc)
            });
            const data = await response.json();
            if (data.success) {
                toast.success('账号已添加');
                this.newOpenListAcc = { name: '', api_url: '', api_token: '' };
                this.loadOpenListAccounts();
            }
        } catch (e) {
            toast.error('添加失败: ' + e.message);
        }
    },

    // 删除账号
    async deleteOpenListAccount(id) {
        if (!confirm('确定要删除这个 OpenList 实例配置吗？')) return;
        try {
            const response = await fetch(`/api/openlist/manage-accounts/${id}`, { method: 'DELETE' });
            const data = await response.json();
            if (data.success) {
                toast.success('账号已删除');
                if (this.currentOpenListAccount && this.currentOpenListAccount.id === id) {
                    this.currentOpenListAccount = null;
                }
                this.loadOpenListAccounts();
            }
        } catch (e) {
            toast.error('删除失败');
        }
    },

    // 根据 ID 选择账号
    selectOpenListAccountById(id) {
        const acc = this.openListAccounts.find(a => a.id === id);
        if (acc) this.selectOpenListAccount(acc);
    },

    // 选择账号进入文件管理
    selectOpenListAccount(account) {
        this.currentOpenListAccount = account;
        this.openListSubTab = 'files';
        this.loadOpenListFiles('/');
    },

    // 加载文件列表
    async loadOpenListFiles(path, refresh = false) {
        console.log('[OpenList] Loading path:', path);
        if (!this.currentOpenListAccount) return;
        
        this.openListFilesLoading = true;
        this.openListPath = path;

        try {
            const response = await fetch(`/api/openlist/${this.currentOpenListAccount.id}/fs/list`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, refresh })
            });
            const data = await response.json();
            if (data.code === 200) {
                this.openListFiles = data.data.content || [];
                this.openListReadme = data.data.readme || '';
            } else {
                toast.error('加载失败: ' + data.message);
            }
        } catch (e) {
            console.error('[OpenList] Load error:', e);
            toast.error('请求出错: ' + e.message);
        } finally {
            this.openListFilesLoading = false;
        }
    },

    // 处理文件/目录点击
    handleOpenFile(file) {
        if (this.openListFilesLoading) return; // 防止加载中点击导致路径计算错误

        if (file.is_dir) {
            const newPath = this.openListPath === '/' ? `/${file.name}` : `${this.openListPath}/${file.name}`;
            this.loadOpenListFiles(newPath);
        } else {
            this.showOpenFileDetail(file);
        }
    },

    // 返回上一级
    goUpOpenListDir() {
        if (this.openListFilesLoading) return; // 防止加载中点击
        if (this.openListPath === '/') return;
        const parts = this.openListPath.split('/').filter(p => p);
        parts.pop();
        const newPath = '/' + parts.join('/');
        this.loadOpenListFiles(newPath);
    },

    // 获取文件图标
    getFileIconClass(file) {
        if (file.is_dir) return 'fas fa-folder text-warning';
        const name = file.name.toLowerCase();
        if (/\.(jpg|jpeg|png|gif|webp|svg)$/.test(name)) return 'fas fa-file-image text-success';
        if (/\.(mp4|webm|mkv|avi)$/.test(name)) return 'fas fa-file-video text-danger';
        if (/\.(mp3|wav|flac)$/.test(name)) return 'fas fa-file-audio text-info';
        if (/\.(zip|rar|7z|gz|tar)$/.test(name)) return 'fas fa-file-archive text-warning';
        if (/\.(pdf)$/.test(name)) return 'fas fa-file-pdf text-danger';
        if (/\.(txt|md|sql|js|json|html|css|py)$/.test(name)) return 'fas fa-file-alt text-secondary';
        return 'fas fa-file text-secondary';
    },

    // 下载文件 (直接打开原始链接)
    async downloadOpenListFile(file) {
        const fullPath = this.openListPath === '/' ? `/${file.name}` : `${this.openListPath}/${file.name}`;
        try {
            const response = await fetch(`/api/openlist/${this.currentOpenListAccount.id}/fs/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: fullPath })
            });
            const data = await response.json();
            if (data.code === 200 && data.data.raw_url) {
                window.open(data.data.raw_url, '_blank');
            } else {
                toast.error('获取链接失败');
            }
        } catch (e) {
            toast.error('下载请求失败');
        }
    },

    // 显示文件详情 (复用 toast 或对话框)
    async showOpenFileDetail(file) {
        const fullPath = this.openListPath === '/' ? `/${file.name}` : `${this.openListPath}/${file.name}`;
        try {
            const response = await fetch(`/api/openlist/${this.currentOpenListAccount.id}/fs/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: fullPath })
            });
            const data = await response.json();
            if (data.code === 200) {
                const info = data.data;
                
                // 构建详情列表，过滤掉 undefined 的值
                const detailRows = [
                    { label: '完整路径', value: `<code>${fullPath}</code>` },
                    { label: '文件大小', value: this.formatFileSize(info.size) },
                    { label: '修改日期', value: this.formatDateTime(info.modified) }
                ];

                if (info.created) detailRows.push({ label: '创建日期', value: this.formatDateTime(info.created) });
                if (info.driver) detailRows.push({ label: '存储驱动', value: `<span class="badge bg-light text-dark border">${info.driver}</span>` });
                
                // 处理哈希值
                if (info.hash_info) {
                    if (info.hash_info.sha1) detailRows.push({ label: 'SHA1', value: `<small class="text-break">${info.hash_info.sha1}</small>` });
                    if (info.hash_info.md5) detailRows.push({ label: 'MD5', value: `<small class="text-break">${info.hash_info.md5}</small>` });
                }

                let message = `
                    <div class="text-start" style="font-size: 13px;">
                        <table class="table table-sm table-borderless mb-0">
                            <tbody>
                                ${detailRows.map(row => `
                                    <tr>
                                        <td style="width: 80px; color: var(--text-tertiary); padding-left: 0;">${row.label}</td>
                                        <td style="color: var(--text-primary);">${row.value}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                `;
                
                // 获取图标类名（去掉颜色类，因为 showAlert 可能只接受基础 icon）
                const iconClass = this.getFileIconClass(file).split(' ').filter(c => c.startsWith('fa-')).join(' ');
                this.showAlert(message, info.name, iconClass || 'fa-file', true);
            } else {
                toast.error('获取详情失败: ' + data.message);
            }
        } catch (e) {
            console.error('[OpenList] Detail load error:', e);
            toast.error('获取详情出错');
        }
    },
};

/**
 * 辅助计算属性扩展 (将通过setup中的computed返回)
 */
export const selfHComputed = {
    openListPathParts(state) {
        // console.log('[OpenList] Recalculating breadcrumbs for:', state.openListPath);
        if (!state.openListPath || state.openListPath === '/') return [];
        const parts = state.openListPath.split('/').filter(p => p);
        let current = '';
        return parts.map(p => {
            current += '/' + p;
            return { name: p, path: current };
        });
    }
};