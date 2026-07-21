import { io } from 'socket.io-client';
import { createServer } from 'node:net';

const endpoint = process.env.VIRTUAL_AGENT_URL || 'http://127.0.0.1:3000';
const serverId = process.env.VIRTUAL_AGENT_SERVER_ID;
const key = process.env.VIRTUAL_AGENT_KEY;

if (!serverId || !key) {
  throw new Error('VIRTUAL_AGENT_SERVER_ID and VIRTUAL_AGENT_KEY are required');
}

const startedAt = Date.now() - 17 * 24 * 60 * 60 * 1000;
const proxyListeners = new Map();
const socket = io(endpoint, {
  path: '/socket.io',
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

const hostInfo = () => ({
  server_id: serverId,
  hostname: 'edge-sin-virtual-01',
  platform: 'linux',
  platform_version: 'Ubuntu 24.04.2 LTS',
  arch: 'x86_64',
  version: '2.0.0-virtual',
  agent_version: '2.0.0-virtual',
  location: 'Singapore',
  region: 'Singapore',
  country_code: 'sg',
  cpu_cores: 4,
  cpu_threads: 8,
  total_memory: 8 * 1024 ** 3,
  total_disk: 120 * 1024 ** 3,
});

const state = () => ({
  server_id: serverId,
  timestamp_ms: Date.now(),
  platform: 'linux',
  platform_version: 'Ubuntu 24.04.2 LTS',
  agent_version: '2.0.0-virtual',
  location: 'Singapore',
  region: 'Singapore',
  country_code: 'sg',
  uptime: Math.floor((Date.now() - startedAt) / 1000),
  cpu: 18.4,
  memory: 42.7,
  disk_usage: 36.2,
  net_rx: 18432,
  net_tx: 7168,
  network_quality: {
    results: [
      { id: 1, name: '移动', host: 'www.baidu.com', port: 443, success: true, latency_ms: 68 },
      { id: 2, name: '联通', host: 'www.qq.com', port: 443, success: true, latency_ms: 54 },
      { id: 3, name: '电信', host: 'www.aliyun.com', port: 443, success: true, latency_ms: 43 },
    ],
  },
});

socket.on('connect', () => {
  socket.emit('agent:connect', {
    server_id: serverId,
    key,
    hostname: 'edge-sin-virtual-01',
    version: '2.0.0-virtual',
    platform: 'linux',
    arch: 'x86_64',
    capabilities: ['proxy_runtime_v1', 'network_quality_v1'],
  });
});

socket.on('dashboard:auth_ok', () => {
  socket.emit('agent:host_info', hostInfo());
  socket.emit('agent:state', state());
});

socket.on('dashboard:task', (task) => {
  if (Number(task?.type) !== 50) return;
  const desired = JSON.parse(task.data || '{}');
  const assignedPort = Number(desired.requested_port) || 48721;
  const config = JSON.parse(desired.config || '{}');
  if (Array.isArray(config.inbounds) && config.inbounds[0]) config.inbounds[0].listen_port = assignedPort;
  if (desired.remove) {
    proxyListeners.get(desired.node_id)?.close();
    proxyListeners.delete(desired.node_id);
  } else if ((desired.transport || 'tcp') === 'tcp' && !proxyListeners.has(desired.node_id)) {
    const listener = createServer((connection) => connection.end());
    listener.listen(assignedPort, '0.0.0.0');
    proxyListeners.set(desired.node_id, listener);
  }

  setTimeout(() => socket.emit('agent:task_result', {
    id: task.id,
    type: 50,
    successful: true,
    data: JSON.stringify({
      node_id: desired.node_id,
      assigned_port: assignedPort,
      transport: desired.transport || 'tcp',
      config: JSON.stringify(config),
      status: desired.remove ? 'removed' : 'running',
      runtime_version: desired.runtime_version || '1.13.14',
    }),
    delay: 120,
  }), 150);
});

setInterval(() => socket.emit('agent:state', state()), 10_000).unref();

const shutdown = () => {
  proxyListeners.forEach((listener) => listener.close());
  socket.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
