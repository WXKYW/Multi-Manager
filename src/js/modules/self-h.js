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
            }
        } catch (e) {
            console.error('Failed to load OpenList accounts:', e);
        }
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
                this.openListSubTab = 'overview';
                this.loadOpenListAccounts();
            }
        } catch (e) {
            toast.error('添加失败: ' + e.message);
        }
    },

    // 测试连接
    async testOpenListAccount(id) {
        try {
            const response = await fetch(`/api/openlist/accounts/${id}/test`, { method: 'POST' });
            const data = await response.json();
            if (data.success) {
                const isOnline = data.data.status === 'online';
                toast[isOnline ? 'success' : 'error'](isOnline ? '连接成功' : '连接失败: ' + (data.data.error || '未知错误'));
                this.loadOpenListAccounts();
            }
        } catch (e) {
            toast.error('测试请求失败');
        }
    },

    // 选择账号进入文件管理
    selectOpenListAccount(account) {
        this.currentOpenListAccount = account;
        this.openListSubTab = 'files';
    }
};
