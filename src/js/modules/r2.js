/**
 * R2 存储管理业务逻辑
 */
import { store } from '../store.js';
import { toast } from './toast.js';
import { formatFileSize, formatDateTime } from './utils.js';

export const r2Methods = {
    /**
     * 加载当前账号的所有存储桶
     */
    async loadBuckets() {
        if (!store.dnsSelectedAccountId) return;

        store.r2LoadingBuckets = true;
        try {
            const response = await fetch(`/api/cf-dns/accounts/${store.dnsSelectedAccountId}/r2/buckets`, {
                headers: store.getAuthHeaders()
            });

            const data = await response.json();
            if (data.success) {
                store.r2Buckets = data.buckets;
                console.log('[R2] 存储桶列表已加载:', data.buckets);
            } else {
                toast.error('获取 R2 存储桶失败: ' + (data.error || '未知错误'));
            }
        } catch (error) {
            console.error('[R2] 获取存储桶异常:', error);
            toast.error('网络请求失败，请检查连接');
        } finally {
            store.r2LoadingBuckets = false;
        }
    },

    /**
     * 选择一个存储桶并进入浏览
     */
    async selectBucket(bucketName) {
        store.r2SelectedBucketName = bucketName;
        store.r2CurrentPrefix = '';
        store.r2PrefixStack = [];
        store.r2SearchText = '';
        await this.loadObjects();
    },

    /**
     * 加载对象列表
     */
    async loadObjects() {
        if (!store.dnsSelectedAccountId || !store.r2SelectedBucketName) return;

        store.r2LoadingObjects = true;
        try {
            // 使用 delimiter='/' 来实现文件夹模拟
            let url = `/api/cf-dns/accounts/${store.dnsSelectedAccountId}/r2/buckets/${store.r2SelectedBucketName}/objects?delimiter=/`;
            if (store.r2CurrentPrefix) {
                url += `&prefix=${encodeURIComponent(store.r2CurrentPrefix)}`;
            }

            const response = await fetch(url, {
                headers: store.getAuthHeaders()
            });

            const data = await response.json();
            if (data.success) {
                // 整合公共前缀(文件夹)和具体对象(文件)
                const folders = (data.delimitedPrefixes || []).map(p => ({
                    key: p,
                    isFolder: true,
                    name: p.slice(store.r2CurrentPrefix.length, -1)
                }));

                const files = (data.objects || []).map(o => ({
                    ...o,
                    isFolder: false,
                    name: o.key.slice(store.r2CurrentPrefix.length)
                })).filter(f => f.name !== ''); // 排除当前目录本身

                store.r2Objects = [...folders, ...files];
                console.log(`[R2] 对象列表加载完成 (${store.r2SelectedBucketName}):`, store.r2Objects);
            } else {
                toast.error('获取对象列表失败: ' + (data.error || '未知错误'));
            }
        } catch (error) {
            console.error('[R2] 获取对象集合异常:', error);
        } finally {
            store.r2LoadingObjects = false;
        }
    },

    /**
     * 进入子文件夹
     */
    async enterFolder(prefix) {
        store.r2PrefixStack.push(store.r2CurrentPrefix);
        store.r2CurrentPrefix = prefix;
        await this.loadObjects();
    },

    /**
     * 返回上一级文件夹
     */
    async navigateBack() {
        if (store.r2PrefixStack.length > 0) {
            store.r2CurrentPrefix = store.r2PrefixStack.pop();
            await this.loadObjects();
        } else {
            // 如果已在顶层，重置
            store.r2CurrentPrefix = '';
            await this.loadObjects();
        }
    },

    /**
     * 点击面包屑导航
     */
    async navigateTo(index) {
        if (index === -1) {
            store.r2CurrentPrefix = '';
            store.r2PrefixStack = [];
        } else {
            // 截取栈
            const newStack = store.r2PrefixStack.slice(0, index + 1);
            const newPrefix = newStack[newStack.length - 1]; // 这其实不完全对，面包屑应该基于完整路径分割
            // 为了简单起见，我们重新根据路径构建
            const parts = store.r2CurrentPrefix.split('/').filter(Boolean);
            const targetParts = parts.slice(0, index + 1);
            store.r2CurrentPrefix = targetParts.join('/') + '/';
            store.r2PrefixStack = []; // 简单重置，后面 load 会重建或这种逻辑需要优化
        }
        await this.loadObjects();
    },

    /**
     * 创建存储桶
     */
    async createBucket(name) {
        if (!name) return;
        try {
            const response = await fetch(`/api/cf-dns/accounts/${store.dnsSelectedAccountId}/r2/buckets`, {
                method: 'POST',
                headers: {
                    ...store.getAuthHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name })
            });

            const data = await response.json();
            if (data.success) {
                toast.success('存储桶创建成功');
                await this.loadBuckets();
                return true;
            } else {
                toast.error('创建失败: ' + (data.error || '未知错误'));
                return false;
            }
        } catch (error) {
            toast.error('操作异常');
            return false;
        }
    },

    /**
     * 删除存储桶
     */
    async deleteBucket(bucketName) {
        if (!confirm(`确定要删除存储桶 "${bucketName}" 吗？此操作不可逆，且桶必须为空。`)) return;

        try {
            const response = await fetch(`/api/cf-dns/accounts/${store.dnsSelectedAccountId}/r2/buckets/${bucketName}`, {
                method: 'DELETE',
                headers: store.getAuthHeaders()
            });

            const data = await response.json();
            if (data.success) {
                toast.success('存储桶已删除');
                if (store.r2SelectedBucketName === bucketName) {
                    store.r2SelectedBucketName = null;
                }
                await this.loadBuckets();
            } else {
                toast.error('删除失败: ' + (data.error || '未知错误'));
            }
        } catch (error) {
            toast.error('删除过程发生错误');
        }
    },

    /**
     * 获取文件图标
     */
    getFileIcon(obj) {
        if (obj.isFolder) return 'fas fa-folder r2-icon-folder';

        const ext = obj.name.split('.').pop().toLowerCase();
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'];
        const codeExts = ['js', 'ts', 'html', 'css', 'json', 'py', 'go', 'rs', 'php', 'sh', 'sql'];
        const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz'];

        if (imageExts.includes(ext)) return 'fas fa-file-image r2-icon-image';
        if (codeExts.includes(ext)) return 'fas fa-file-code r2-icon-code';
        if (archiveExts.includes(ext)) return 'fas fa-file-archive r2-icon-archive';

        return 'fas fa-file r2-icon-file';
    },

    // 格式化辅助
    formatSize: formatFileSize,
    formatDate: formatDateTime
};
