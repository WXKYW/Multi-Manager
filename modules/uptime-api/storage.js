/**
 * Uptime Storage Service
 * Handles persistence of monitors and heartbeat history using JSON files.
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../src/utils/logger');

const logger = createLogger('UptimeStorage');
const DATA_DIR = path.join(__dirname, '../../data');
const HISTORY_DIR = path.join(DATA_DIR, 'uptime-history');

// Ensure data existence
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

class UptimeStorage {
    constructor() {
        this.monitors = [];
        this.loadMonitors();
    }

    loadMonitors() {
        try {
            const { SystemConfig } = require('../../src/db/models');
            const data = SystemConfig.getConfigValue('uptime_monitors_json');
            if (data) {
                this.monitors = JSON.parse(data);
            } else {
                // 尝试从旧文件迁移
                const oldFile = path.join(__dirname, '../../data/uptime-monitors.json');
                if (fs.existsSync(oldFile)) {
                    const fileContent = fs.readFileSync(oldFile, 'utf8');
                    this.monitors = JSON.parse(fileContent);
                    SystemConfig.setConfig('uptime_monitors_json', fileContent);
                    logger.info('Migrated uptime monitors from JSON file to database');
                    try { fs.renameSync(oldFile, oldFile + '.bak'); } catch (e) { }
                } else {
                    this.monitors = [];
                    this.saveMonitors();
                }
            }
        } catch (error) {
            logger.error('Failed to load monitors:', error);
            this.monitors = [];
        }
    }

    saveMonitors() {
        try {
            const { SystemConfig } = require('../../src/db/models');
            SystemConfig.setConfig('uptime_monitors_json', JSON.stringify(this.monitors));
        } catch (error) {
            logger.error('Failed to save monitors:', error);
        }
    }

    /**
     * Get all monitors
     */
    getAll() {
        return this.monitors;
    }

    /**
     * Get active monitors
     */
    getActive() {
        return this.monitors.filter(m => m.active);
    }

    /**
     * Get single monitor
     */
    getById(id) {
        return this.monitors.find(m => m.id == id);
    }

    /**
     * Create monitor
     */
    create(data) {
        const newMonitor = {
            ...data,
            id: Date.now(), // Simple ID
            createdAt: new Date().toISOString()
        };
        this.monitors.push(newMonitor);
        this.saveMonitors();
        return newMonitor;
    }

    /**
     * Update monitor
     */
    update(id, data) {
        const index = this.monitors.findIndex(m => m.id == id);
        if (index !== -1) {
            this.monitors[index] = { ...this.monitors[index], ...data };
            this.saveMonitors();
            return this.monitors[index];
        }
        return null;
    }

    /**
     * Delete monitor
     */
    delete(id) {
        const index = this.monitors.findIndex(m => m.id == id);
        if (index !== -1) {
            this.monitors.splice(index, 1);
            this.saveMonitors();
            // Optionally clean up history file?
            const historyFile = path.join(HISTORY_DIR, `${id}.json`);
            if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile);
            return true;
        }
        return false;
    }

    // ==================== History Handling ====================

    /**
     * Save heartbeat
     */
    saveHeartbeat(monitorId, beat) {
        const file = path.join(HISTORY_DIR, `${monitorId}.json`);
        let history = [];

        try {
            if (fs.existsSync(file)) {
                history = JSON.parse(fs.readFileSync(file, 'utf8'));
            }
        } catch (e) { /* ignore */ }

        // Prepend new beat
        history.unshift(beat);

        // Default Keep last 100 for display (backend can store more if needed, but for json implementation keep it small)
        if (history.length > 200) history = history.slice(0, 200);

        try {
            fs.writeFileSync(file, JSON.stringify(history), 'utf8');
        } catch (e) {
            logger.error(`Failed to save history for ${monitorId}:`, e);
        }

        return history;
    }

    /**
     * Get history
     */
    getHistory(monitorId, limit = 50) {
        const file = path.join(HISTORY_DIR, `${monitorId}.json`);
        try {
            if (fs.existsSync(file)) {
                const history = JSON.parse(fs.readFileSync(file, 'utf8'));
                return history.slice(0, limit);
            }
        } catch (e) { /* ignore */ }
        return [];
    }
}

module.exports = new UptimeStorage();
