const express = require('express');
const router = express.Router();
const storage = require('./storage');
const axios = require('axios');

// 获取所有账号
router.get('/manage-accounts', (req, res) => {
    try {
        const accounts = storage.getAllAccounts();
        res.json({ success: true, data: accounts });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 添加账号
router.post('/manage-accounts', (req, res) => {
    try {
        const id = storage.addAccount(req.body);
        res.json({ success: true, data: { id } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 删除账号
router.delete('/manage-accounts/:id', (req, res) => {
    try {
        storage.deleteAccount(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 账号连通性测试 (探活)
router.post('/manage-accounts/:id/test', async (req, res) => {
    try {
        const account = storage.getAccountById(req.params.id);
        if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

        const response = await axios.get(`${account.api_url}/api/public/settings`, {
            headers: { 'Authorization': account.api_token },
            timeout: 5000
        });

        const status = response.status === 200 ? 'online' : 'error';
        const version = response.data?.data?.version || 'unknown';
        
        storage.updateStatus(account.id, status, version);
        res.json({ success: true, data: { status, version } });
    } catch (error) {
        storage.updateStatus(req.params.id, 'offline', null);
        res.json({ success: true, data: { status: 'offline', error: error.message } });
    }
});

// 通用 API 转发 (用于前端直接调用 OpenList 接口)
router.all('/proxy/:id/*', async (req, res) => {
    const { id } = req.params;
    const subPath = req.params[0];
    const account = storage.getAccountById(id);

    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

    try {
        const url = `${account.api_url}/api/${subPath}`;
        const response = await axios({
            method: req.method,
            url: url,
            headers: { 
                'Authorization': account.api_token,
                'Content-Type': 'application/json'
            },
            params: req.query,
            data: req.body,
            timeout: 10000
        });
        res.json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).json(error.response?.data || { success: false, error: error.message });
    }
});

module.exports = router;
