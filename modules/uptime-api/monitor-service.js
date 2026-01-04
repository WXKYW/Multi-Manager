/**
 * Uptime Monitor Service
 * Handles the actual checking logic and scheduling.
 */

const axios = require('axios');
const net = require('net');
const https = require('https');
const storage = require('./storage');
const { createLogger } = require('../../src/utils/logger');

const logger = createLogger('UptimeService');

// Global intervals map: monitorId -> IntervalID
const intervals = {};
let io = null;

class UptimeService {
    /**
     * Initialize with Server instance to get Socket.IO
     */
    init(server) {
        // If Socket.IO is already attached to server in server.js, we might need a way to pass it.
        // In server.js structure, IO is usually initialized. 
        // We will assume `monitor-service` is required in router or server.js and we can pass IO.

        // For now, restarting all monitors
        this.restartAllMonitors();
        logger.info('Uptime Monitor Service Initialized');
    }

    setIO(socketIO) {
        io = socketIO;
    }

    /**
     * Restart all active monitors (e.g. on boot)
     */
    restartAllMonitors() {
        this.stopAll();
        const monitors = storage.getActive();
        monitors.forEach(m => this.startMonitor(m));
        logger.info(`Started ${Object.keys(intervals).length} monitors`);
    }

    stopAll() {
        Object.values(intervals).forEach(clearInterval);
        for (const key in intervals) delete intervals[key];
    }

    /**
     * Start a single monitor
     */
    startMonitor(monitor) {
        if (intervals[monitor.id]) clearInterval(intervals[monitor.id]);
        if (!monitor.active) return;

        // Default interval 60s
        const seconds = monitor.interval && monitor.interval > 5 ? monitor.interval : 60;

        // Initial check immediately (with small delay to avoid boot storm)
        setTimeout(() => this.check(monitor), 2000 + Math.random() * 2000);

        intervals[monitor.id] = setInterval(() => {
            this.check(monitor);
        }, seconds * 1000);
    }

    stopMonitor(monitorId) {
        if (intervals[monitorId]) {
            clearInterval(intervals[monitorId]);
            delete intervals[monitorId];
        }
    }

    /**
     * Perform Check
     */
    async check(monitor) {
        const startTime = Date.now();
        let status = 0; // 0: Down, 1: Up
        let msg = '';
        let ping = 0;

        try {
            if (monitor.type === 'http') {
                await this.checkHttp(monitor);
                status = 1;
                msg = 'OK';
            } else if (monitor.type === 'tcp') {
                await this.checkTcp(monitor);
                status = 1;
                msg = 'OK';
            } else if (monitor.type === 'ping') {
                // Fallback to TCP ping if no generic ping lib
                if (monitor.hostname) {
                    // Basic workaround: Try to connect to port 80 or 443 if not specified, 
                    // but 'ping' implies ICMP. Since we want no deps issues, implementing basic TCP connect to 80/443 for "ping" type if user enters hostname.
                    // Real ICMP requires privileged execution usually.
                    await this.checkPingLike(monitor);
                    status = 1;
                    msg = 'OK';
                } else {
                    throw new Error('Host required');
                }
            } else {
                throw new Error('Unknown Type');
            }
        } catch (error) {
            status = 0;
            msg = error.message;
            // logger.debug(`Check failed for ${monitor.name}: ${error.message}`);
        }

        if (status === 1) {
            ping = Date.now() - startTime;
        } else {
            ping = 0;
        }

        const beat = {
            id: Date.now(),
            status,
            msg,
            ping,
            time: new Date().toISOString()
        };

        // Save
        storage.saveHeartbeat(monitor.id, beat);

        // Emit via Socket.IO
        if (io) {
            io.emit('uptime:heartbeat', { monitorId: monitor.id, beat });
        }
    }

    // --- Check Logic ---

    async checkHttp(monitor) {
        const agent = new https.Agent({
            rejectUnauthorized: !monitor.ignoreTls
        });

        const config = {
            url: monitor.url,
            method: monitor.method || 'GET',
            timeout: (monitor.timeout || 30) * 1000,
            headers: monitor.headers ? JSON.parse(monitor.headers) : {},
            httpsAgent: agent,
            validateStatus: function (status) {
                // Parse accepted codes e.g. "200-299"
                // Simple impl: return true, we check result later or let axios throw if outside 2xx? 
                // Axios throws for <200 || >=300 by default.
                return status >= 200 && status < 300;
            }
        };

        // If user specified codes, we need custom validator
        if (monitor.accepted_status_codes) {
            config.validateStatus = (status) => {
                // "200-299" -> 200..299
                // "200, 201"
                // TODO: Robust parsing. For now assuming default range behavior or simple match.
                return true; // We will check manually below if needed, or just let it pass if it returns
            };
        }

        const res = await axios(config);

        // Check Status Code explicitly if needed logic here
        if (monitor.accepted_status_codes) {
            // Simplest: 200-299 default
            // If fail, throw error
        }
        return res;
    }

    checkTcp(monitor) {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            socket.setTimeout((monitor.timeout || 10) * 1000);

            socket.on('connect', () => {
                socket.destroy();
                resolve();
            });

            socket.on('timeout', () => {
                socket.destroy();
                reject(new Error('Connection Timeout'));
            });

            socket.on('error', (err) => {
                socket.destroy();
                reject(err);
            });

            socket.connect(monitor.port, monitor.hostname);
        });
    }

    async checkPingLike(monitor) {
        // Use TCP connect to 80, 443, or 53 as a "Ping" proxy if just hostname
        // This is a naive approximation.
        const ports = [80, 443, 53];
        for (const p of ports) {
            try {
                await this.checkTcp({ hostname: monitor.hostname, port: p, timeout: 2 });
                return; // Success one is enough
            } catch (e) { }
        }
        throw new Error('Ping(Tcp) Failed');
    }
}

module.exports = new UptimeService();
