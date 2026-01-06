/**
 * Uptime API 路由
 */

const express = require('express');
const router = express.Router();
const storage = require('./storage');
const monitorService = require('./monitor-service');

// GET /api/uptime/monitors
router.get('/monitors', (req, res) => {
    const monitors = storage.getAll();
    // 如有需要可附加最新状态，或者由前端单独获取历史记录
    // 优化：前端通常需要每个监控项的最新心跳状态。

    const result = monitors.map(m => {
        const history = storage.getHistory(m.id, 1);
        return {
            ...m,
            lastHeartbeat: history[0] || null
        };
    });

    res.json(result);
});

// GET /api/uptime/monitors/:id/history
router.get('/monitors/:id/history', (req, res) => {
    const history = storage.getHistory(req.params.id, 60); // 最近 60 个点
    res.json(history);
});

// POST /api/uptime/monitors
router.post('/monitors', (req, res) => {
    try {
        const data = req.body;
        if (!data.name) return res.status(400).json({ error: 'Name is required' });

        const newMonitor = storage.create(data);
        monitorService.startMonitor(newMonitor);

        res.json(newMonitor);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/uptime/monitors/:id
router.put('/monitors/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const data = req.body;

        const updated = storage.update(id, data);
        if (!updated) return res.status(404).json({ error: 'Not found' });

        // 如果间隔/URL 发生变化，重启监控；或者只是执行标准重启
        monitorService.startMonitor(updated);

        res.json(updated);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/uptime/monitors/:id
router.delete('/monitors/:id', (req, res) => {
    const id = parseInt(req.params.id);
    monitorService.stopMonitor(id);
    const success = storage.delete(id);
    if (success) res.json({ success: true });
    else res.status(404).json({ error: 'Not found' });
});

// POST /api/uptime/monitors/:id/toggle
router.post('/monitors/:id/toggle', (req, res) => {
    const id = parseInt(req.params.id);
    const monitor = storage.getById(id);
    if (!monitor) return res.status(404).json({ error: 'Not found' });

    monitor.active = !monitor.active;
    storage.update(id, { active: monitor.active });

    if (monitor.active) monitorService.startMonitor(monitor);
    else monitorService.stopMonitor(id);

    res.json({ success: true, active: monitor.active });
});

module.exports = router;
