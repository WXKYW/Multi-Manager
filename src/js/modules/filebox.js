import { store } from '../store.js';

export const fileboxData = {
    fileboxRetrieveCode: '',
    fileboxShareType: 'file', // 'file' or 'text'
    fileboxCurrentTab: 'share', // 'share' or 'history'
    fileboxShareText: '',
    fileboxSelectedFile: null,
    fileboxExpiry: '24',
    fileboxBurnAfterReading: false,
    fileboxLoading: false,
    fileboxResult: null, // { code: '...' }
    fileboxHistory: [], // Local history of uploads
    fileboxRetrievedEntry: null, // Populated after retrieve
    isDragging: false,
};

export const fileboxMethods = {
    // Methods
    initFileBox() {
        this.loadFileBoxHistory();
    },

    loadFileBoxHistory() {
        try {
            const saved = localStorage.getItem('filebox_history');
            if (saved) {
                this.fileboxHistory = JSON.parse(saved);
            }
        } catch (e) {
            console.error('Failed to load history', e);
        }
    },

    saveFileBoxHistory(entry) {
        // Add to history
        this.fileboxHistory.unshift(entry);
        // Limit to 20
        if (this.fileboxHistory.length > 20) this.fileboxHistory.length = 20;
        localStorage.setItem('filebox_history', JSON.stringify(this.fileboxHistory));
    },

    handleFileDrop(e) {
        this.isDragging = false;
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            this.fileboxSelectedFile = files[0];
            this.fileboxShareType = 'file';
        }
    },

    handleFileSelect(e) {
        const files = e.target.files;
        if (files.length > 0) {
            this.fileboxSelectedFile = files[0];
        }
    },

    resetFileBoxForm() {
        this.fileboxShareText = '';
        this.fileboxSelectedFile = null;
        this.fileboxExpiry = '24';
        this.fileboxBurnAfterReading = false;
        // Clear file input
        if (this.$refs.fileInput) this.$refs.fileInput.value = '';
    },

    async shareFileBoxEntry() {
        if (this.fileboxShareType === 'text' && !this.fileboxShareText) return;
        if (this.fileboxShareType === 'file' && !this.fileboxSelectedFile) return;

        this.fileboxLoading = true;
        try {
            const formData = new FormData();
            formData.append('type', this.fileboxShareType);
            formData.append('expiry', this.fileboxExpiry);
            formData.append('burn_after_reading', this.fileboxBurnAfterReading);

            if (this.fileboxShareType === 'text') {
                formData.append('text', this.fileboxShareText);
            } else {
                formData.append('file', this.fileboxSelectedFile);
            }

            const res = await axios.post('/api/filebox/share', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });

            if (res.data.success) {
                this.fileboxResult = { code: res.data.code };

                // Save minimal info to history
                this.saveFileBoxHistory({
                    code: res.data.code,
                    type: this.fileboxShareType,
                    originalName: this.fileboxSelectedFile ? this.fileboxSelectedFile.name : null,
                    content: this.fileboxShareText,
                    size: this.fileboxSelectedFile ? this.fileboxSelectedFile.size : 0,
                    createdAt: Date.now()
                });

                this.$toast.success('分享成功！取件码已生成');
            } else {
                this.$toast.error('分享失败: ' + res.data.error);
            }
        } catch (error) {
            this.handleError(error);
        } finally {
            this.fileboxLoading = false;
        }
    },

    async retrieveFileBoxEntry() {
        if (!this.fileboxRetrieveCode || this.fileboxRetrieveCode.length < 5) {
            this.$toast.error('请输入 5 位取件码');
            return;
        }

        this.fileboxLoading = true;
        try {
            // First get metadata
            const res = await axios.get(`/api/filebox/retrieve/${this.fileboxRetrieveCode}`);
            if (res.data.success) {
                this.fileboxRetrievedEntry = res.data.data;
                if (this.fileboxRetrievedEntry.type === 'text') {
                    const contentRes = await axios.get(`/api/filebox/download/${this.fileboxRetrieveCode}`, { responseType: 'text' });
                    this.fileboxRetrievedEntry.content = contentRes.data;
                }
            } else {
                this.$toast.error(res.data.error || '取件失败');
            }
        } catch (error) {
            // 404 handled here
            if (error.response && error.response.status === 404) {
                this.$toast.error('取件码无效或已过期');
            } else {
                this.handleError(error);
            }
        } finally {
            this.fileboxLoading = false;
        }
    },

    downloadFileBoxEntry(code) {
        window.open(`/api/filebox/download/${code}`, '_blank');
    },

    deleteFileBoxEntry(code) {
        // Remove from history
        this.fileboxHistory = this.fileboxHistory.filter(h => h.code !== code);
        localStorage.setItem('filebox_history', JSON.stringify(this.fileboxHistory));
    },

    handleError(error) {
        console.error(error);
        const msg = error.response?.data?.error || error.message;
        this.$toast.error(msg);
    },

    copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                this.$toast.success('已复制到剪贴板');
            }, () => {
                this.$toast.error('复制失败');
            });
        } else {
            // Fallback
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.left = "-9999px";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                document.execCommand('copy');
                this.$toast.success('已复制到剪贴板');
            } catch (err) {
                this.$toast.error('复制失败');
            }
            document.body.removeChild(textArea);
        }
    }
};
