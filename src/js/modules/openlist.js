import { createToast } from './toast.js';
import { request } from './utils.js';

class OpenListModule {
    constructor() {
        this.currentAccountId = null;
        this.currentPath = '/';
        this.accounts = [];
        this.viewMode = 'list'; // 'list' or 'grid'
        this.history = []; // 用于前进/后退
        
        this.init();
    }

    async init() {
        this.bindEvents();
        await this.loadAccounts();
    }

    bindEvents() {
        // 账号选择
        $('#openlist-account-select').on('change', (e) => {
            const accountId = $(e.target).val();
            if (accountId) {
                this.switchAccount(accountId);
            }
        });

        // 刷新按钮
        $('#openlist-refresh-btn').on('click', () => {
            if (this.currentAccountId) {
                this.loadDirectory(this.currentPath, true);
                this.loadAccountInfo();
            }
        });

        // 账号管理按钮
        $('#openlist-accounts-btn').on('click', () => {
            this.showAccountsModal();
        });

        // 添加账号表单
        $('#openlist-add-account-form').on('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const data = Object.fromEntries(formData.entries());
            await this.addAccount(data);
            e.target.reset();
        });

        // 搜索
        $('#openlist-search-btn').on('click', () => this.searchFiles());
        $('#openlist-search-input').on('keypress', (e) => {
            if (e.which === 13) this.searchFiles();
        });

        // 视图切换
        $('#view-list-btn').on('click', () => this.setViewMode('list'));
        $('#view-grid-btn').on('click', () => this.setViewMode('grid'));

        // 面包屑点击
        $(document).on('click', '#openlist-breadcrumb .breadcrumb-item[data-path]', (e) => {
            const path = $(e.currentTarget).data('path');
            this.loadDirectory(path);
        });
    }

    async loadAccounts() {
        try {
            const res = await request('/api/modules/openlist-api/manage-accounts');
            if (res.success) {
                this.accounts = res.data;
                this.renderAccountSelect();
            }
        } catch (error) {
            createToast('加载账号失败: ' + error.message, 'danger');
        }
    }

    renderAccountSelect() {
        const $select = $('#openlist-account-select');
        const currentVal = $select.val();
        $select.empty().append('<option value="">选择账号...</option>');
        
        this.accounts.forEach(acc => {
            $select.append(`<option value="${acc.id}" ${currentVal === acc.id ? 'selected' : ''}>${acc.name}</option>`);
        });
    }

    async switchAccount(accountId) {
        this.currentAccountId = accountId;
        this.currentPath = '/';
        
        // 显示加载状态
        $('#openlist-file-container').html('<div class="text-center py-5"><div class="spinner-border text-primary"></div></div>');
        
        await Promise.all([
            this.loadDirectory('/'),
            this.loadAccountInfo()
        ]);
        
        $('#openlist-account-info-card').removeClass('d-none');
    }

    async loadAccountInfo() {
        try {
            const res = await request(`/api/modules/openlist-api/${this.currentAccountId}/me`);
            if (res.code === 200) {
                const user = res.data;
                $('#acc-username').text(user.username);
                $('#acc-role').text(user.role === 2 ? '管理员' : '普通用户');
                $('#acc-base-path').text(user.base_path);
                $('#acc-permission').text(user.permission);

                if (user.role === 2) {
                    this.loadStorages();
                } else {
                    $('#openlist-admin-storages-card').addClass('d-none');
                }
            }
        } catch (error) {
            console.error('获取用户信息失败', error);
        }
    }

    async loadStorages() {
        try {
            const res = await request(`/api/modules/openlist-api/${this.currentAccountId}/admin/storages`);
            if (res.code === 200) {
                const storages = res.data.content;
                const $list = $('#openlist-storages-list');
                $list.empty();
                
                storages.forEach(s => {
                    const statusClass = s.status.includes('work') ? 'status-work' : (s.status.includes('error') ? 'status-error' : 'status-unknown');
                    $list.append(`
                        <div class="list-group-item">
                            <div class="d-flex justify-content-between align-items-center mb-1">
                                <span class="fw-bold">${s.mount_path}</span>
                                <span class="badge bg-light text-dark border">${s.driver}</span>
                            </div>
                            <div class="d-flex align-items-center text-muted" style="font-size: 0.7rem;">
                                <span class="storage-status-dot ${statusClass}"></span>
                                <span>${s.status}</span>
                            </div>
                        </div>
                    `);
                });
                
                $('#openlist-admin-storages-card').removeClass('d-none');
            }
        } catch (error) {
            console.error('获取存储列表失败', error);
        }
    }

    async loadDirectory(path, refresh = false) {
        this.currentPath = path;
        this.renderBreadcrumb(path);
        
        try {
            const res = await request(`/api/modules/openlist-api/${this.currentAccountId}/fs/list`, {
                method: 'POST',
                body: JSON.stringify({ path, refresh })
            });

            if (res.code === 200) {
                this.renderFileList(res.data.content);
                this.renderReadme(res.data.readme);
                $('#openlist-status-info').text(`共 ${res.data.content ? res.data.content.length : 0} 个项目`);
                $('#openlist-current-path-title').text(path === '/' ? '根目录' : path.split('/').pop());
            } else {
                createToast('加载目录失败: ' + res.message, 'warning');
            }
        } catch (error) {
            createToast('请求失败: ' + error.message, 'danger');
        }
    }

    renderFileList(items) {
        const $container = $('#openlist-file-container');
        $container.empty();

        if (!items || items.length === 0) {
            $container.html('<div class="text-center py-5 text-muted">此目录为空</div>');
            return;
        }

        items.forEach(item => {
            const icon = this.getFileIcon(item);
            const size = item.is_dir ? '-' : this.formatSize(item.size);
            const time = new Date(item.modified).toLocaleString();

            const $item = $(`
                <div class="file-item">
                    <div class="file-icon">${icon}</div>
                    <div class="file-info">
                        <div class="file-name">${item.name}</div>
                        <div class="file-meta">${item.is_dir ? '目录' : size} | ${time}</div>
                    </div>
                    <div class="file-actions">
                        <button class="btn btn-link btn-sm text-primary p-0 me-2 btn-detail"><i class="bi bi-info-circle"></i></button>
                        ${!item.is_dir ? `<a href="${item.sign || '#'}" target="_blank" class="btn btn-link btn-sm text-success p-0"><i class="bi bi-download"></i></a>` : ''}
                    </div>
                </div>
            `);

            $item.on('click', (e) => {
                if ($(e.target).closest('.file-actions').length) return;
                if (item.is_dir) {
                    const nextPath = this.currentPath === '/' ? `/${item.name}` : `${this.currentPath}/${item.name}`;
                    this.loadDirectory(nextPath);
                } else {
                    this.showFileDetail(item);
                }
            });

            $item.find('.btn-detail').on('click', () => this.showFileDetail(item));

            $container.append($item);
        });
    }

    renderBreadcrumb(path) {
        const $bc = $('#openlist-breadcrumb');
        $bc.empty();
        $bc.append('<li class="breadcrumb-item" data-path="/">根目录</li>');

        if (path === '/') return;

        const parts = path.split('/').filter(p => p);
        let currentBuildPath = '';
        parts.forEach((part, index) => {
            currentBuildPath += '/' + part;
            const isActive = index === parts.length - 1;
            if (isActive) {
                $bc.append(`<li class="breadcrumb-item active">${part}</li>`);
            } else {
                $bc.append(`<li class="breadcrumb-item" data-path="${currentBuildPath}">${part}</li>`);
            }
        });
    }

    renderReadme(content) {
        const $container = $('#openlist-readme-container');
        if (!content) {
            $container.addClass('d-none');
            return;
        }

        $container.removeClass('d-none');
        // 简单处理 Markdown (实际项目中建议使用 marked 等库)
        $('#openlist-readme-content').html(content.replace(/\n/g, '<br>'));
    }

    async showFileDetail(item) {
        const fullPath = this.currentPath === '/' ? `/${item.name}` : `${this.currentPath}/${item.name}`;
        
        try {
            const res = await request(`/api/modules/openlist-api/${this.currentAccountId}/fs/get`, {
                method: 'POST',
                body: JSON.stringify({ path: fullPath })
            });

            if (res.code === 200) {
                const data = res.data;
                $('#file-modal-title').text(data.name);
                
                const $info = $('#file-info-table');
                $info.empty();
                const details = [
                    ['名称', data.name],
                    ['大小', this.formatSize(data.size)],
                    ['修改时间', new Date(data.modified).toLocaleString()],
                    ['创建时间', new Date(data.created).toLocaleString()],
                    ['驱动', data.driver],
                    ['路径', fullPath]
                ];
                
                details.forEach(([k, v]) => {
                    $info.append(`<tr><th width="30%">${k}</th><td>${v}</td></tr>`);
                });

                // 预览逻辑
                const $preview = $('#file-preview-area');
                $preview.empty();
                if (this.isImage(data.name)) {
                    $preview.html(`<img src="${data.raw_url}" class="img-fluid rounded shadow-sm" style="max-height: 400px;">`);
                } else if (this.isVideo(data.name)) {
                    $preview.html(`<video src="${data.raw_url}" controls class="w-100 rounded"></video>`);
                }

                $('#file-download-link').attr('href', data.raw_url);
                $('#openlist-file-modal').modal('show');
            }
        } catch (error) {
            createToast('获取详情失败: ' + error.message, 'danger');
        }
    }

    async searchFiles() {
        const keywords = $('#openlist-search-input').val();
        if (!keywords) return;

        try {
            const res = await request(`/api/modules/openlist-api/${this.currentAccountId}/fs/search`, {
                method: 'POST',
                body: JSON.stringify({ keywords, parent: this.currentPath })
            });

            if (res.code === 200) {
                this.renderFileList(res.data.content);
                $('#openlist-status-info').text(`搜索结果: ${res.data.content ? res.data.content.length : 0} 个项目`);
            }
        } catch (error) {
            createToast('搜索失败', 'danger');
        }
    }

    // 辅助方法
    getFileIcon(item) {
        if (item.is_dir) return '<i class="bi bi-folder-fill icon-folder"></i>';
        const name = item.name.toLowerCase();
        if (this.isImage(name)) return '<i class="bi bi-file-earmark-image icon-image"></i>';
        if (this.isVideo(name)) return '<i class="bi bi-file-earmark-play icon-video"></i>';
        if (this.isAudio(name)) return '<i class="bi bi-file-earmark-music icon-audio"></i>';
        if (name.endsWith('.zip') || name.endsWith('.rar') || name.endsWith('.7z')) return '<i class="bi bi-file-earmark-zip icon-archive"></i>';
        return '<i class="bi bi-file-earmark icon-file"></i>';
    }

    formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    isImage(name) { return /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(name); }
    isVideo(name) { return /\.(mp4|webm|ogg|mkv|mov|avi)$/i.test(name); }
    isAudio(name) { return /\.(mp3|wav|flac|aac)$/i.test(name); }

    setViewMode(mode) {
        this.viewMode = mode;
        $('#view-list-btn, #view-grid-btn').removeClass('active');
        $(`#view-${mode}-btn`).addClass('active');
        // TODO: 实现网格视图渲染逻辑，目前仅实现列表
    }

    // 账号管理模态框
    showAccountsModal() {
        this.renderAccountsTable();
        $('#openlist-accounts-modal').modal('show');
    }

    async renderAccountsTable() {
        const $tbody = $('#openlist-accounts-table-body');
        $tbody.html('<tr><td colspan="4" class="text-center">加载中...</td></tr>');
        
        await this.loadAccounts();
        $tbody.empty();
        
        this.accounts.forEach(acc => {
            $tbody.append(`
                <tr>
                    <td><strong>${acc.name}</strong></td>
                    <td class="text-muted small">${acc.api_url}</td>
                    <td><span class="badge bg-${acc.status === 'online' ? 'success' : 'danger'}">${acc.status}</span></td>
                    <td class="text-end">
                        <button class="btn btn-sm btn-outline-info me-1 btn-test" data-id="${acc.id}">测试</button>
                        <button class="btn btn-sm btn-outline-danger btn-del" data-id="${acc.id}">删除</button>
                    </td>
                </tr>
            `);
        });

        $('.btn-test').on('click', async (e) => {
            const id = $(e.target).data('id');
            const res = await request(`/api/modules/openlist-api/manage-accounts/${id}/test`, { method: 'POST' });
            if (res.success) {
                createToast(`测试成功: ${res.data.status}`, 'success');
                this.renderAccountsTable();
            }
        });

        $('.btn-del').on('click', async (e) => {
            if (!confirm('确定删除该账号吗？')) return;
            const id = $(e.target).data('id');
            await request(`/api/modules/openlist-api/manage-accounts/${id}`, { method: 'DELETE' });
            this.renderAccountsTable();
            this.renderAccountSelect();
        });
    }

    async addAccount(data) {
        try {
            const res = await request('/api/modules/openlist-api/manage-accounts', {
                method: 'POST',
                body: JSON.stringify(data)
            });
            if (res.success) {
                createToast('添加成功', 'success');
                this.renderAccountsTable();
                this.renderAccountSelect();
            }
        } catch (error) {
            createToast('添加失败: ' + error.message, 'danger');
        }
    }
}

export default new OpenListModule();
