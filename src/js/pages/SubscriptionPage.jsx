import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Checkbox } from '@cloudflare/kumo/components/checkbox';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input, InputArea } from '@cloudflare/kumo/components/input';
import { Label } from '@cloudflare/kumo/components/label';
import { Select } from '@cloudflare/kumo/components/select';
import { Switch } from '@cloudflare/kumo/components/switch';
import { Table } from '@cloudflare/kumo/components/table';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import { Badge, ClipboardText, Code, LayerCard, Meter, Tabs } from '@cloudflare/kumo';
import { AppTable, DataTableFrame, PageStack, PageToolbar, SectionCard } from '../components/ui/AppPrimitives.jsx';
import { MODULE_TABS_PROPS, TOOL_TABS_PROPS } from '../modules/kumoTabs.js';
import useStore from '../store.js';
import { dialog } from '../modules/dialog.js';
import { toast } from '../modules/toast.js';
import CountryFlag from '../components/CountryFlag.jsx';
import { Copy, Download, Edit, Plus, RefreshCw, Save, Star, Trash, X } from '../components/Icons.jsx';

const API = '/api/subscription';

const emptySubscriptionForm = {
  profile_id: '',
  name: '',
  remark: '',
  enabled: true,
  template_id: 'builtin_mihomo_default',
  traffic_source: 'manual',
  traffic_server_id: '',
  upstream_url: '',
  upstream_enabled: false,
  upstream_refresh_hours: 24,
  total_bytes: 0,
  manual_upload_bytes: 0,
  manual_download_bytes: 0,
  expire_at: '',
  cycle_type: 'none',
  cycle_day: 1,
  rate_limit_enabled: true,
  rate_limit_per_minute: 30,
  node_filter_ids: [],
};

const emptyProfileForm = {
  name: '',
  remark: '',
  enabled: true,
  template_id: 'builtin_mihomo_default',
  traffic_source: 'manual',
  traffic_server_id: '',
  upstream_url: '',
  upstream_enabled: false,
  upstream_refresh_hours: 24,
  total_bytes: 0,
  manual_upload_bytes: 0,
  manual_download_bytes: 0,
  expire_at: '',
  cycle_type: 'none',
  cycle_day: 1,
  rate_limit_enabled: true,
  rate_limit_per_minute: 30,
};

const emptyTemplateForm = {
  name: '',
  format: 'clash',
  content: '',
  description: '',
};

const emptyNodeForm = {
  name: '',
  type: '',
  server: '',
  port: 0,
  country_code: '',
  location: '',
  tags: '',
  traffic_server_id: '',
  enabled: true,
  stable: false,
  sort_order: 0,
  raw: '',
  config_json: '',
};

const safeBtoa = (str) => {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch (e) {
    return btoa(str);
  }
};

const safeAtob = (str) => {
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch (e) {
    return atob(str);
  }
};

const parseNodeUrlToConfig = (urlStr) => {
  try {
    const raw = String(urlStr).trim();
    if (!raw) return null;

    if (raw.toLowerCase().startsWith('vmess://')) {
      const b64Part = raw.substring(8).trim();
      try {
        const decoded = safeAtob(b64Part);
        const obj = JSON.parse(decoded);
        const name = obj.ps || 'vmess-node';
        const server = obj.add || '';
        const port = Number(obj.port) || 0;
        const type = 'vmess';
        
        const config = {
          name,
          type,
          server,
          port,
          uuid: obj.id,
          alterId: Number(obj.aid) || 0,
          cipher: obj.scy || 'auto',
        };
        if (obj.net) config.network = obj.net;
        if (obj.tls === 'tls') {
          config.tls = true;
          if (obj.sni) {
            config.sni = obj.sni;
            config.servername = obj.sni;
          }
        }
        if (obj.net === 'ws') {
          config['ws-opts'] = {
            path: obj.path || '/',
          };
          if (obj.host) {
            config['ws-opts'].headers = { Host: obj.host };
          }
        }
        return { name, type, server, port, config };
      } catch (e) {}
    }

    const match = raw.match(/^([^:]+):\/\/([^@]+@)?([^:\/?#]+)(?::(\d+))?([^#]*)(?:#(.*))?$/);
    if (!match) return null;

    let type = match[1].toLowerCase();
    if (type === 'hy2') type = 'hysteria2';

    const userInfo = match[2] ? match[2].slice(0, -1) : '';
    const server = match[3];
    const port = match[4] ? Number(match[4]) : 0;
    const rest = match[5] || '';
    const hash = match[6] ? decodeURIComponent(match[6]) : '';
    const name = hash || `${type}-node`;

    const config = {
      name,
      type,
      server,
      port,
    };

    const query = {};
    if (rest.startsWith('?')) {
      const parts = rest.substring(1).split('&');
      for (const part of parts) {
        const [k, v] = part.split('=');
        if (k) {
          query[decodeURIComponent(k)] = decodeURIComponent(v || '');
        }
      }
    }

    if (type === 'vless') {
      config.uuid = userInfo;
      if (query.encryption && query.encryption !== 'none') {
        config.encryption = query.encryption;
      }
      const network = query.type || query.network;
      if (network && network !== 'tcp') {
        config.network = network;
      }
      if (query.security === 'tls') {
        config.tls = true;
      }
      const sni = query.sni || query.servername;
      if (sni) {
        config.servername = sni;
        config.sni = sni;
      }
      if (query.fp) {
        config['client-fingerprint'] = query.fp;
      }
      if (query.allowInsecure === '1' || query.allowInsecure === 'true' || query.insecure === '1' || query.insecure === 'true' || query['skip-cert-verify'] === 'true') {
        config['skip-cert-verify'] = true;
      }
      if (network === 'ws') {
        config['ws-opts'] = {};
        if (query.path) config['ws-opts'].path = query.path;
        const host = query.host || query.Host || sni;
        if (host) {
          config['ws-opts'].headers = { Host: host };
        }
        if (Object.keys(config['ws-opts']).length === 0) delete config['ws-opts'];
      }
    } else if (type === 'trojan') {
      config.password = userInfo;
      config.tls = true;
      const sni = query.sni || query.peer || query.servername;
      if (sni) {
        config.sni = sni;
      }
      if (query.allowInsecure === '1' || query.allowInsecure === 'true' || query.insecure === '1' || query.insecure === 'true' || query['skip-cert-verify'] === 'true') {
        config['skip-cert-verify'] = true;
      }
      if (query.alpn) {
        config.alpn = query.alpn.split(',');
      }
      const network = query.type || query.network;
      if (network) {
        config.network = network;
      }
      if (query.fp) {
        config['client-fingerprint'] = query.fp;
      }
    } else if (type === 'hysteria2') {
      config.password = userInfo;
      const sni = query.sni || query.peer || query.servername;
      if (sni) {
        config.sni = sni;
      }
      if (query.insecure === '1' || query.insecure === 'true' || query.allowInsecure === '1' || query.allowInsecure === 'true' || query['skip-cert-verify'] === 'true') {
        config['skip-cert-verify'] = true;
      }
      if (query.alpn) {
        config.alpn = query.alpn.split(',');
      }
    } else if (type === 'ss') {
      if (userInfo) {
        try {
          const decoded = safeAtob(userInfo);
          const parts = decoded.split(':');
          if (parts.length === 2) {
            config.cipher = parts[0];
            config.password = parts[1];
          }
        } catch (e) {
          const parts = userInfo.split(':');
          if (parts.length === 2) {
            config.cipher = parts[0];
            config.password = parts[1];
          }
        }
      }
    }

    return { name, type, server, port, config };
  } catch (err) {
    return null;
  }
};

const buildNodeUrl = (config) => {
  try {
    if (!config || !config.type || !config.server || !config.port) return '';
    const type = config.type.toLowerCase();
    const server = config.server;
    const port = config.port;
    const name = config.name || '';

    if (type === 'vmess') {
      const obj = {
        v: '2',
        ps: name,
        add: server,
        port: String(port),
        id: config.uuid || '',
        aid: String(config.alterId || 0),
        net: config.network || 'tcp',
        type: 'none',
        host: config['ws-opts']?.headers?.Host || '',
        path: config['ws-opts']?.path || '',
        tls: config.tls ? 'tls' : '',
        sni: config.sni || config.servername || '',
      };
      return 'vmess://' + safeBtoa(JSON.stringify(obj));
    }

    let userInfo = '';
    const query = [];

    if (type === 'vless') {
      userInfo = config.uuid || '';
      if (config.encryption) query.push(`encryption=${encodeURIComponent(config.encryption)}`);
      if (config.network) query.push(`type=${encodeURIComponent(config.network)}`);
      if (config.tls) query.push(`security=tls`);
      const sni = config.sni || config.servername;
      if (sni) query.push(`sni=${encodeURIComponent(sni)}`);
      if (config['client-fingerprint']) query.push(`fp=${encodeURIComponent(config['client-fingerprint'])}`);
      if (config['skip-cert-verify']) query.push(`skip-cert-verify=true`);
      if (config.network === 'ws' && config['ws-opts']?.path) {
        query.push(`path=${encodeURIComponent(config['ws-opts'].path)}`);
      }
    } else if (type === 'trojan') {
      userInfo = config.password || '';
      const sni = config.sni;
      if (sni) query.push(`sni=${encodeURIComponent(sni)}`);
      if (config['skip-cert-verify']) query.push(`skip-cert-verify=true`);
      if (config.alpn) query.push(`alpn=${encodeURIComponent(config.alpn.join(','))}`);
      if (config.network) query.push(`type=${encodeURIComponent(config.network)}`);
      if (config['client-fingerprint']) query.push(`fp=${encodeURIComponent(config['client-fingerprint'])}`);
    } else if (type === 'hysteria2') {
      userInfo = config.password || '';
      const sni = config.sni;
      if (sni) query.push(`sni=${encodeURIComponent(sni)}`);
      if (config['skip-cert-verify']) query.push(`skip-cert-verify=true`);
      if (config.alpn) query.push(`alpn=${encodeURIComponent(config.alpn.join(','))}`);
    } else if (type === 'ss') {
      if (config.cipher && config.password) {
        userInfo = safeBtoa(`${config.cipher}:${config.password}`);
      }
    }

    const userPart = userInfo ? `${userInfo}@` : '';
    const queryPart = query.length > 0 ? `?${query.join('&')}` : '';
    const hashPart = name ? `#${name}` : '';

    return `${type}://${userPart}${server}:${port}${queryPart}${hashPart}`;
  } catch (e) {
    return '';
  }
};

const syncNodeForm = (prev, changedField, value) => {
  const next = { ...prev, [changedField]: value };

  if (['name', 'type', 'server', 'port'].includes(changedField)) {
    if (changedField === 'type') {
      next.type = value.toLowerCase();
    }

    let parsedConfig = null;
    try {
      parsedConfig = JSON.parse(prev.config_json || '{}');
    } catch (e) {}

    if (!parsedConfig || typeof parsedConfig !== 'object') {
      parsedConfig = {};
    }

    parsedConfig.name = next.name;
    parsedConfig.type = next.type;
    parsedConfig.server = next.server;
    parsedConfig.port = next.port ? Number(next.port) : 0;

    next.config_json = JSON.stringify(parsedConfig);

    if (next.raw) {
      try {
        const match = next.raw.match(/^([^:]+):\/\/([^@]+@)?([^:\/?#]+)(?::(\d+))?([^#]*)(?:#(.*))?$/);
        if (match) {
          const proto = changedField === 'type' ? value.toLowerCase() : match[1];
          const userInfo = match[2] || '';
          const host = changedField === 'server' ? value : match[3];
          const port = changedField === 'port' ? (value ? `:${value}` : '') : (match[4] ? `:${match[4]}` : '');
          const rest = match[5] || '';
          const hash = changedField === 'name' ? `#${value}` : (match[6] ? `#${match[6]}` : '');
          next.raw = `${proto}://${userInfo}${host}${port}${rest}${hash}`;
        }
      } catch (e) {}
    } else {
      next.raw = buildNodeUrl(parsedConfig);
    }
  }

  if (changedField === 'config_json') {
    try {
      const parsedConfig = JSON.parse(value);
      if (parsedConfig && typeof parsedConfig === 'object') {
        if (parsedConfig.name !== undefined) next.name = String(parsedConfig.name);
        if (parsedConfig.type !== undefined) next.type = String(parsedConfig.type).toLowerCase();
        if (parsedConfig.server !== undefined) next.server = String(parsedConfig.server);
        if (parsedConfig.port !== undefined) next.port = Number(parsedConfig.port) || 0;

        next.raw = buildNodeUrl(parsedConfig);
      }
    } catch (e) {}
  }

  if (changedField === 'raw') {
    const parsed = parseNodeUrlToConfig(value);
    if (parsed) {
      next.name = parsed.name;
      next.type = parsed.type;
      next.server = parsed.server;
      next.port = parsed.port;
      next.config_json = JSON.stringify(parsed.config);
    }
  }

  return next;
};

const getAuthHeaders = () => ({
  'Content-Type': 'application/json',
  'x-admin-password': localStorage.getItem('admin_password') || '',
});

const formatBytes = (bytes = 0) => {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let current = value / 1024;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(current >= 100 ? 0 : 1)} ${units[index]}`;
};

const TRAFFIC_UNITS = [
  { value: 'GB', label: 'GB', bytes: 1024 ** 3 },
  { value: 'TB', label: 'TB', bytes: 1024 ** 4 },
];

const trafficUnitBytes = (unit) => TRAFFIC_UNITS.find((item) => item.value === unit)?.bytes || TRAFFIC_UNITS[0].bytes;

const preferredTrafficUnit = (bytes) => {
  const value = Number(bytes) || 0;
  const tbBytes = trafficUnitBytes('TB');
  if (value >= tbBytes) return 'TB';
  return 'GB';
};

const trafficDisplayValue = (bytes, unit) => {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0';
  const converted = value / trafficUnitBytes(unit);
  return Number.isInteger(converted) ? String(converted) : String(Number(converted.toFixed(3)));
};

const formatTime = (value) => {
  if (!value) return '-';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const statusLabel = (sub) => {
  if (!sub.enabled) return ['停用', 'secondary'];
  if (sub.traffic?.status === 'expired') return ['已过期', 'error'];
  if (sub.traffic?.status === 'exhausted') return ['流量用尽', 'warning'];
  return ['运行中', 'success'];
};

const profileKeyOf = (item) => item?.profile_id || item?.subscription_id || item?.id || '';

const parseNodeConfig = (node) => {
  if (!node?.config_json) return {};
  try {
    return JSON.parse(node.config_json);
  } catch {
    return {};
  }
};

const nodeEndpoint = (node) => {
  const host = node.server || '-';
  return `${host}:${node.port || '-'}`;
};

const nodeNetworkTags = (node) => {
  const cfg = parseNodeConfig(node);
  const wsPath = cfg['ws-opts']?.path;
  const sni = cfg.sni || cfg.servername;
  return [
    cfg.network ? { key: 'network', label: cfg.network, tone: String(cfg.network).toLowerCase() } : null,
    cfg.tls ? { key: 'tls', label: 'tls' } : null,
    sni ? { key: 'sni', label: `sni ${sni}` } : null,
    wsPath ? { key: 'path', label: `path ${wsPath}` } : null,
    cfg['client-fingerprint'] ? { key: 'fingerprint', label: `fp ${cfg['client-fingerprint']}` } : null,
    cfg['skip-cert-verify'] ? { key: 'insecure', label: 'insecure' } : null,
    Array.isArray(cfg.alpn) && cfg.alpn.length > 0 ? { key: 'alpn', label: `alpn ${cfg.alpn.join(',')}` } : null,
  ].filter(Boolean);
};

const nodeNetworkTagClass = (tag) => {
  if (tag.key === 'tls') return 'border-kumo-success/20 bg-kumo-success/10 text-kumo-success';
  if (tag.key === 'sni') return 'border-kumo-warning/25 bg-kumo-warning/10 text-kumo-warning';
  if (tag.key === 'path') return 'border-kumo-info/20 bg-kumo-info/10 text-kumo-info';
  if (tag.key === 'fingerprint') return 'border-kumo-badge-purple/20 bg-kumo-badge-purple/10 text-kumo-badge-purple';
  if (tag.key === 'alpn') return 'border-kumo-badge-purple/20 bg-kumo-badge-purple/10 text-kumo-badge-purple';
  if (tag.key === 'insecure') return 'border-kumo-danger/20 bg-kumo-danger/10 text-kumo-danger';
  if (tag.tone === 'ws') return 'border-kumo-info/20 bg-kumo-info/10 text-kumo-info';
  if (tag.tone === 'grpc') return 'border-kumo-badge-purple/20 bg-kumo-badge-purple/10 text-kumo-badge-purple';
  if (tag.tone === 'h2' || tag.tone === 'http') return 'border-kumo-badge-purple/20 bg-kumo-badge-purple/10 text-kumo-badge-purple';
  if (tag.tone === 'tcp') return 'border-kumo-badge-orange/20 bg-kumo-badge-orange/10 text-kumo-badge-orange';
  return 'border-kumo-line bg-kumo-recessed/35 text-kumo-subtle';
};

const nodeCountryCode = (node) => {
  const direct = String(node?.country_code || '').trim();
  if (/^[a-z]{2}$/i.test(direct)) return direct.toUpperCase();
  const name = String(node?.name || '').trim();
  const runes = Array.from(name);
  if (runes.length >= 2) {
    const first = runes[0].codePointAt(0);
    const second = runes[1].codePointAt(0);
    if (first >= 0x1F1E6 && first <= 0x1F1FF && second >= 0x1F1E6 && second <= 0x1F1FF) {
      return String.fromCharCode(65 + first - 0x1F1E6, 65 + second - 0x1F1E6);
    }
  }
  const namePrefix = name.match(/^([A-Za-z]{2})(?=$|[\s_-]|[\u4e00-\u9fa5])/);
  if (namePrefix) return namePrefix[1].toUpperCase();
  const location = String(node?.location || '').trim();
  const locationPrefix = location.match(/^([A-Za-z]{2})(?=$|[\s_-]|[\u4e00-\u9fa5])/);
  return locationPrefix ? locationPrefix[1].toUpperCase() : '';
};

function NodeFlag({ node }) {
  const code = nodeCountryCode(node);
  if (!code) return null;
  return <CountryFlag preferSvg countryCode={code} className="h-3.5 w-5 shrink-0 !rounded-[2px] text-sm" />;
}

const latencyChipClass = (latency) => {
  const value = Number(latency) || 0;
  if (value <= 0) return 'border-kumo-line bg-kumo-recessed/50 text-kumo-subtle';
  if (value <= 120) return 'border-kumo-success/25 bg-kumo-success/10 text-kumo-success';
  if (value <= 260) return 'border-kumo-warning/30 bg-kumo-warning/10 text-kumo-warning';
  return 'border-kumo-danger/25 bg-kumo-danger/10 text-kumo-danger';
};

function NodeHostQuality({ node, serverNameById }) {
  const hostName = node.traffic_server_id ? serverNameById.get(String(node.traffic_server_id)) || node.traffic_server_id : '';
  const orderMap = { '移动': 1, '联通': 2, '电信': 3 };
  const samples = Array.isArray(node?.quality)
    ? [...node.quality].sort((a, b) => {
        const orderA = orderMap[a.name] ?? 99;
        const orderB = orderMap[b.name] ?? 99;
        return orderA - orderB;
      }).slice(0, 3)
    : [];
  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      <span
        className={`inline-flex max-w-full items-center rounded-[3px] border px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${hostName ? 'border-kumo-info/25 bg-kumo-info/10 text-kumo-info' : 'border-kumo-line bg-kumo-recessed/45 text-kumo-subtle'}`}
        title={hostName || '未绑定主机'}
      >
        <span className="truncate">{hostName || '未绑定'}</span>
      </span>
      <div className="flex max-w-full flex-wrap justify-center gap-1">
        {samples.length > 0 ? samples.map((item) => {
          const latency = Math.round(Number(item.avg_latency_ms ?? item.latency_ms) || 0);
          return (
            <span
              key={`${item.name}-${item.sampled_at || latency}`}
              className={`inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 text-[10px] font-semibold leading-4 tabular-nums ${latencyChipClass(latency)}`}
              title={`${item.name || '线路'} 24h 平均 ${latency > 0 ? `${latency}ms` : '暂无延迟'}`}
            >
              <span className="max-w-8 truncate">{item.name || '-'}</span>
              <span>{latency > 0 ? `${latency}ms` : '-'}</span>
            </span>
          );
        }) : (
          <span className="inline-flex rounded-[3px] border border-kumo-line bg-kumo-recessed/45 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-kumo-subtle">
            暂无延迟
          </span>
        )}
      </div>
    </div>
  );
}

const nodeTypeBadgeVariant = (type) => {
  switch (String(type || '').toLowerCase()) {
    case 'vless':
      return 'blue';
    case 'vmess':
      return 'purple';
    case 'trojan':
      return 'red';
    case 'ss':
    case 'shadowsocks':
      return 'teal';
    case 'hysteria2':
    case 'hy2':
    case 'hysteria':
      return 'orange';
    case 'tuic':
      return 'green';
    case 'socks':
    case 'socks5':
      return 'neutral';
    case 'http':
      return 'info';
    default:
      return 'secondary';
  }
};

const subscriptionURL = (base, sub, format = '') => {
  if (!sub?.public_token) return '';
  const suffix = format ? `?format=${format}` : '';
  return `${base}/sub/${sub.public_token}${suffix}`;
};

const normalizePublicBase = (configured, fallback = '') => {
  const value = String(configured || '').trim().replace(/\/+$/g, '');
  if (value) return value.replace(/\/api$/i, '');
  if (!fallback) return '';
  try {
    const url = new URL(fallback);
    if (/^517\d$/.test(url.port)) {
      url.port = '3000';
      return url.origin;
    }
    return url.origin;
  } catch {
    return String(fallback || '').replace(/\/+$/g, '');
  }
};

const copyText = async (text, message = '已复制') => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(message);
  } catch {
    toast.error('复制失败');
  }
};

function LinkCopyButton({ label, text, onCopy, variant = 'secondary' }) {
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={!text}
      onClick={() => onCopy(text, `${label} 链接已复制`)}
      className="gap-1.5"
    >
      <Copy className="h-3.5 w-3.5" />
      <span>{label}</span>
    </Button>
  );
}

function TrafficSizeInput({ label, value, onChange }) {
  const [unit, setUnit] = useState(() => preferredTrafficUnit(value));

  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="text-xs font-semibold text-kumo-subtle">{label}</Label>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_4.75rem] gap-2">
        <Input
          size="sm"
          aria-label={label}
          type="number"
          min="0"
          step="0.001"
          value={trafficDisplayValue(value, unit)}
          onChange={(event) => onChange(Math.round((Number(event.target.value) || 0) * trafficUnitBytes(unit)))}
          className="w-full min-w-0"
        />
        <Select
          size="sm"
          aria-label={`${label}单位`}
          value={unit}
          onValueChange={(nextUnit) => setUnit(String(nextUnit))}
          items={TRAFFIC_UNITS.map(({ value: itemValue, label: itemLabel }) => ({ value: itemValue, label: itemLabel }))}
          className="w-full min-w-0"
        />
      </div>
    </div>
  );
}

function SubscriptionPage() {
  const publicApiUrl = useStore((state) => state.publicApiUrl);
  const [activeTab, setActiveTab] = useState('profiles');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [logs, setLogs] = useState([]);
  const [servers, setServers] = useState([]);
  const [settings, setSettings] = useState(null);

  const [subscriptionModalOpen, setSubscriptionModalOpen] = useState(false);
  const [subscriptionForm, setSubscriptionForm] = useState(emptySubscriptionForm);
  const [editingSubscriptionId, setEditingSubscriptionId] = useState(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileForm, setProfileForm] = useState(emptyProfileForm);
  const [editingProfileId, setEditingProfileId] = useState(null);

  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importSourceURL, setImportSourceURL] = useState('');
  const [importSubscriptionId, setImportSubscriptionId] = useState('');
  const [importPreview, setImportPreview] = useState([]);
  const [nodeSubscriptionId, setNodeSubscriptionId] = useState('');
  const [nodeModalOpen, setNodeModalOpen] = useState(false);
  const [nodeForm, setNodeForm] = useState(emptyNodeForm);
  const [editingNodeId, setEditingNodeId] = useState(null);
  const [protocolFilter, setProtocolFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');

  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateForm, setTemplateForm] = useState(emptyTemplateForm);
  const [editingTemplateId, setEditingTemplateId] = useState(null);
  const [templateSubscriptionId, setTemplateSubscriptionId] = useState('');
  const [templateBindingId, setTemplateBindingId] = useState('');

  const publicBase = useMemo(
    () => normalizePublicBase(publicApiUrl, typeof window === 'undefined' ? '' : window.location.origin),
    [publicApiUrl]
  );

  const loadAll = async () => {
    setLoading(true);
    try {
      const [profilesRes, subsRes, nodesRes, templatesRes, logsRes, serversRes, settingsRes] = await Promise.all([
        fetch(`${API}/profiles`, { headers: getAuthHeaders() }),
        fetch(`${API}/subscriptions`, { headers: getAuthHeaders() }),
        fetch(`${API}/nodes`, { headers: getAuthHeaders() }),
        fetch(`${API}/templates`, { headers: getAuthHeaders() }),
        fetch(`${API}/logs?limit=200`, { headers: getAuthHeaders() }),
        fetch(`${API}/servers`, { headers: getAuthHeaders() }),
        fetch(`${API}/settings`, { headers: getAuthHeaders() }),
      ]);
      const [profilesData, subsData, nodesData, templatesData, logsData, serversData, settingsData] = await Promise.all([
        profilesRes.json(),
        subsRes.json(), nodesRes.json(), templatesRes.json(), logsRes.json(), serversRes.json(), settingsRes.json(),
      ]);
      setProfiles(profilesData.data || []);
      setSubscriptions(subsData.data || []);
      setNodes(nodesData.data || []);
      setTemplates(templatesData.data || []);
      setLogs(logsData.data || []);
      setServers(serversData.data || []);
      setSettings(settingsData.data || {});
    } catch (error) {
      console.error(error);
      toast.error('载入节点数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const templateItems = useMemo(() => templates.map((item) => ({ value: item.id, label: item.name })), [templates]);
  const serverItems = useMemo(() => [
    { value: '', label: '不绑定主机' },
    ...servers.map((item) => ({ value: item.id, label: `${item.name} (${item.host})` })),
  ], [servers]);
  const serverNameById = useMemo(() => {
    const map = new Map();
    servers.forEach((item) => map.set(String(item.id), item.name || item.host || item.id));
    return map;
  }, [servers]);
  const nodeLibraries = useMemo(() => {
    if (profiles.length > 0) {
      return profiles
        .map((item) => ({
          ...item,
          nodeCount: item.node_count || 0,
          subscriptionCount: item.subscription_count || 0,
          subscription: item,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    const map = new Map();
    nodes.forEach((node) => {
      const profileID = profileKeyOf(node);
      if (!profileID) return;
      const current = map.get(profileID) || { id: profileID, name: profileID, nodeCount: 0, subscription: null };
      current.nodeCount += 1;
      map.set(profileID, current);
    });
    subscriptions.forEach((item) => {
      const profileID = profileKeyOf(item);
      if (!profileID) return;
      const current = map.get(profileID) || { id: profileID, name: item.name || profileID, nodeCount: item.node_count || 0, subscription: null };
      const isAnchor = item.id === profileID;
      if (isAnchor || !current.subscription) {
        current.subscription = item;
      }
      if (isAnchor || current.name === profileID) {
        current.name = item.name || profileID;
      }
      current.nodeCount = Math.max(current.nodeCount, item.node_count || 0);
      map.set(profileID, current);
    });
    return Array.from(map.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [nodes, profiles, subscriptions]);
  const exportSubscriptions = useMemo(
    () => subscriptions.filter((item) => item.id !== profileKeyOf(item)),
    [subscriptions]
  );
  const subscriptionItems = useMemo(() => exportSubscriptions.map((item) => ({ value: item.id, label: item.name })), [exportSubscriptions]);
  const profileItems = useMemo(() => nodeLibraries.map((item) => ({ value: item.id, label: `${item.name} (${item.nodeCount})` })), [nodeLibraries]);
  const nodeLibraryItems = profileItems;
  const selectedNodeLibrary = useMemo(
    () => nodeLibraries.find((item) => item.id === nodeSubscriptionId) || null,
    [nodeLibraries, nodeSubscriptionId]
  );
  const selectedTemplateSubscription = useMemo(
    () => exportSubscriptions.find((item) => item.id === templateSubscriptionId) || null,
    [exportSubscriptions, templateSubscriptionId]
  );
  useEffect(() => {
    if (nodeLibraryItems.length > 0 && !nodeLibraryItems.some((item) => item.value === nodeSubscriptionId)) {
      setNodeSubscriptionId(nodeLibraryItems[0].value);
    }
  }, [nodeLibraryItems, nodeSubscriptionId]);
  useEffect(() => {
    if (exportSubscriptions.length > 0 && !exportSubscriptions.some((item) => item.id === templateSubscriptionId)) {
      setTemplateSubscriptionId(exportSubscriptions[0].id);
    }
  }, [exportSubscriptions, templateSubscriptionId]);
  const visibleNodes = useMemo(
    () => {
      if (!selectedNodeLibrary) return nodes;
      const profileID = selectedNodeLibrary.id;
      return nodes.filter((item) => {
        const nodeProfileID = profileKeyOf(item);
        return nodeProfileID === profileID;
      });
    },
    [nodes, selectedNodeLibrary]
  );
  const protocolItems = useMemo(() => {
    const counts = new Map();
    visibleNodes.forEach((node) => {
      const key = String(node.type || 'unknown').toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [
      { value: 'all', label: `全部 (${visibleNodes.length})` },
      ...Array.from(counts.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, count]) => ({ value, label: `${value.toUpperCase()} (${count})` })),
    ];
  }, [visibleNodes]);
  const tagItems = useMemo(() => {
    const counts = new Map();
    visibleNodes.forEach((node) => {
      const tags = String(node.tags || '').split(',').map((item) => item.trim()).filter(Boolean);
      if (tags.length === 0) return;
      tags.forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1));
    });
    return [
      { value: 'all', label: `全部 (${visibleNodes.length})` },
      ...Array.from(counts.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, count]) => ({ value, label: `${value} (${count})` })),
    ];
  }, [visibleNodes]);
  const filteredNodes = useMemo(() => (
    visibleNodes.filter((node) => {
      const protocolOK = protocolFilter === 'all' || String(node.type || 'unknown').toLowerCase() === protocolFilter;
      const tagOK = tagFilter === 'all' || String(node.tags || '').split(',').map((item) => item.trim()).includes(tagFilter);
      return protocolOK && tagOK;
    })
  ), [protocolFilter, tagFilter, visibleNodes]);
  const selectedLibrarySubscriptions = useMemo(() => {
    const profileID = selectedNodeLibrary?.id || '';
    if (!profileID) return [];
    return exportSubscriptions.filter((item) => profileKeyOf(item) === profileID);
  }, [exportSubscriptions, selectedNodeLibrary]);
  const subscriptionSourceNodes = useMemo(() => {
    const profileID = subscriptionForm.profile_id || selectedNodeLibrary?.id || '';
    if (!profileID) return [];
    return nodes.filter((item) => profileKeyOf(item) === profileID);
  }, [nodes, selectedNodeLibrary, subscriptionForm.profile_id]);
  const subscriptionSelectedNodeIDs = useMemo(
    () => new Set(Array.isArray(subscriptionForm.node_filter_ids) ? subscriptionForm.node_filter_ids : []),
    [subscriptionForm.node_filter_ids]
  );

  useEffect(() => {
    if (!protocolItems.some((item) => item.value === protocolFilter)) {
      setProtocolFilter('all');
    }
  }, [protocolFilter, protocolItems]);

  useEffect(() => {
    if (!tagItems.some((item) => item.value === tagFilter)) {
      setTagFilter('all');
    }
  }, [tagFilter, tagItems]);

  useEffect(() => {
    setTemplateBindingId(selectedTemplateSubscription?.template_id || settings?.default_template_id || 'builtin_mihomo_default');
  }, [selectedTemplateSubscription, settings]);

  const openCreateSubscription = (profileIDOverride = '') => {
    const profileID = profileIDOverride || selectedNodeLibrary?.id || '';
    const library = nodeLibraries.find((item) => item.id === profileID) || selectedNodeLibrary;
    const linkIndex = exportSubscriptions.filter((item) => profileKeyOf(item) === profileID).length + 1;
    setEditingSubscriptionId(null);
    setSubscriptionForm({
      ...emptySubscriptionForm,
      profile_id: profileID,
      name: `${library?.name || '节点库'} 订阅 ${linkIndex}`,
      template_id: settings?.default_template_id || 'builtin_mihomo_default',
      rate_limit_enabled: settings?.default_rate_limit_enabled ?? true,
      rate_limit_per_minute: settings?.default_rate_limit_per_minute || 30,
      node_filter_ids: [],
    });
    setSubscriptionModalOpen(true);
  };

  const openEditSubscription = (sub) => {
    setEditingSubscriptionId(sub.id);
    setSubscriptionForm({
      ...emptySubscriptionForm,
      ...sub,
      node_filter_ids: Array.isArray(sub.node_filter_ids) ? sub.node_filter_ids : [],
      expire_at: sub.expire_at ? String(sub.expire_at).slice(0, 10) : '',
    });
    setSubscriptionModalOpen(true);
  };

  const setSubscriptionNodeFilter = (nodeID, checked) => {
    setSubscriptionForm((prev) => {
      const rawIDs = Array.isArray(prev.node_filter_ids) ? prev.node_filter_ids : [];
      const current = new Set(rawIDs.length === 0 && !checked ? subscriptionSourceNodes.map((node) => node.id) : rawIDs);
      if (checked) {
        current.add(nodeID);
      } else {
        current.delete(nodeID);
      }
      return { ...prev, node_filter_ids: Array.from(current) };
    });
  };

  const selectAllSubscriptionNodes = () => {
    setSubscriptionForm((prev) => ({ ...prev, node_filter_ids: subscriptionSourceNodes.map((node) => node.id) }));
  };

  const clearSubscriptionNodes = () => {
    setSubscriptionForm((prev) => ({ ...prev, node_filter_ids: [] }));
  };

  const saveSubscription = async () => {
    if (!subscriptionForm.name.trim()) {
      toast.warning('请输入名称');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(editingSubscriptionId ? `${API}/subscriptions/${editingSubscriptionId}` : `${API}/subscriptions`, {
        method: editingSubscriptionId ? 'PUT' : 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...subscriptionForm,
          traffic_source: subscriptionForm.traffic_source || 'manual',
          traffic_server_id: subscriptionForm.traffic_source === 'server' ? subscriptionForm.traffic_server_id || '' : '',
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || '保存失败');
      if (!editingSubscriptionId && data.data?.public_token) {
        await copyText(subscriptionURL(publicBase, data.data), '订阅链接已创建并复制');
      } else {
        toast.success(editingSubscriptionId ? '订阅链接已更新' : '订阅链接已创建');
      }
      setSubscriptionModalOpen(false);
      loadAll();
    } catch (error) {
      toast.error(error.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const deleteSubscription = async (sub) => {
    if (!(await dialog.deleteResource({ resourceType: '订阅链接', resourceName: sub.name }))) return;
    const res = await fetch(`${API}/subscriptions/${sub.id}`, { method: 'DELETE', headers: getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      toast.error(data.error || '删除失败');
      return;
    }
    toast.success('订阅链接已删除');
    loadAll();
  };

  const resetToken = async (sub) => {
    const confirmed = await dialog.confirm({
      title: '重置订阅链接',
      message: `确定要重置「${sub.name}」的订阅链接吗？重置后旧链接会立即失效，需要重新复制新链接给使用者。`,
      confirmText: '重置链接',
      confirmClass: 'text-kumo-warning',
    });
    if (!confirmed) return;
    const res = await fetch(`${API}/subscriptions/${sub.id}/reset-token`, { method: 'POST', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      toast.error(data.error || '重置失败');
      return;
    }
    toast.success('订阅链接已重置');
    loadAll();
  };

  const openCreateProfile = () => {
    setEditingProfileId(null);
    setProfileForm({
      ...emptyProfileForm,
      template_id: settings?.default_template_id || 'builtin_mihomo_default',
      rate_limit_enabled: settings?.default_rate_limit_enabled ?? true,
      rate_limit_per_minute: settings?.default_rate_limit_per_minute || 30,
      upstream_refresh_hours: settings?.default_refresh_hours || 24,
    });
    setProfileModalOpen(true);
  };

  const openEditProfile = (profile) => {
    setEditingProfileId(profile.id);
    setProfileForm({
      ...emptyProfileForm,
      ...profile,
      expire_at: profile.expire_at ? String(profile.expire_at).slice(0, 10) : '',
    });
    setProfileModalOpen(true);
  };

  const saveProfile = async () => {
    if (!profileForm.name.trim()) {
      toast.warning('请输入节点库名称');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(editingProfileId ? `${API}/profiles/${editingProfileId}` : `${API}/profiles`, {
        method: editingProfileId ? 'PUT' : 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...profileForm,
          upstream_refresh_hours: Number(profileForm.upstream_refresh_hours) || 24,
          total_bytes: Number(profileForm.total_bytes) || 0,
          manual_upload_bytes: Number(profileForm.manual_upload_bytes) || 0,
          manual_download_bytes: Number(profileForm.manual_download_bytes) || 0,
          cycle_day: Number(profileForm.cycle_day) || 1,
          rate_limit_per_minute: Number(profileForm.rate_limit_per_minute) || 30,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || '保存失败');
      toast.success(editingProfileId ? '节点库已更新' : '节点库已创建');
      setProfileModalOpen(false);
      if (data.data?.id) setNodeSubscriptionId(data.data.id);
      loadAll();
    } catch (error) {
      toast.error(error.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const deleteProfile = async (profile) => {
    if (!(await dialog.deleteResource({ resourceType: '节点库', resourceName: profile.name }))) return;
    const res = await fetch(`${API}/profiles/${profile.id}`, { method: 'DELETE', headers: getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      const confirmed = await dialog.confirm({
        title: '强制删除节点库',
        message: `节点库「${profile.name}」仍包含节点或对外订阅。强制删除会同时删除该节点库下的节点、订阅链接和访问日志，此操作不可恢复。`,
        confirmText: '强制删除',
        cancelText: '取消',
        variant: 'destructive',
      });
      if (!confirmed) return;
      const forceRes = await fetch(`${API}/profiles/${profile.id}?force=1`, { method: 'DELETE', headers: getAuthHeaders() });
      const forceData = await forceRes.json().catch(() => ({}));
      if (!forceRes.ok || forceData.success === false) {
        toast.error(forceData.error || '强制删除失败');
        return;
      }
      toast.success('节点库已强制删除');
      loadAll();
      return;
    }
    if (!res.ok || data.success === false) {
      toast.error(data.error || '删除失败');
      return;
    }
    toast.success('节点库已删除');
    loadAll();
  };

  const refreshProfileUpstream = async (profile) => {
    const res = await fetch(`${API}/profiles/${profile.id}/refresh-upstream`, { method: 'POST', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      toast.error(data.error || '刷新失败');
      return;
    }
    toast.success('节点来源已刷新');
    loadAll();
  };

  const openImportModal = (subId = '') => {
    const targetId = subId || nodeSubscriptionId || '';
    if (!targetId) {
      toast.warning('请先选择节点库');
      return;
    }
    setImportSubscriptionId(targetId);
    setImportText('');
    setImportSourceURL('');
    setImportPreview([]);
    setImportModalOpen(true);
  };

  const previewImport = async () => {
    if (!importSourceURL.trim() && !importText.trim()) {
      toast.warning('请填写原订阅 URL 或粘贴订阅内容');
      return;
    }
    const res = await fetch(`${API}/import/preview`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ text: importText, source_url: importSourceURL }),
    });
    const data = await res.json();
    setImportPreview(data.data || []);
  };

  const commitImport = async (replace = false) => {
    if (!importSubscriptionId) {
      toast.warning('请选择节点库');
      return;
    }
    if (!importSourceURL.trim() && !importText.trim()) {
      toast.warning('请填写原订阅 URL 或粘贴订阅内容');
      return;
    }
    const res = await fetch(`${API}/import/commit`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ subscription_id: importSubscriptionId, text: importText, source_url: importSourceURL, replace }),
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      toast.error(data.error || '导入失败');
      return;
    }
    toast.success(`已接管 ${data.data?.imported || 0} 个节点`);
    setImportModalOpen(false);
    setNodeSubscriptionId(importSubscriptionId);
    loadAll();
  };

  const openEditNode = (node) => {
    setEditingNodeId(node.id);
    setNodeForm({
      ...emptyNodeForm,
      ...node,
      port: node.port || 0,
      sort_order: node.sort_order || 0,
    });
    setNodeModalOpen(true);
  };

  const saveNode = async () => {
    if (!editingNodeId) return;
    if (!nodeForm.name.trim()) {
      toast.warning('请输入节点名称');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API}/nodes/${editingNodeId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...nodeForm,
          port: Number(nodeForm.port) || 0,
          sort_order: Number(nodeForm.sort_order) || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || '保存失败');
      toast.success('节点已更新');
      setNodeModalOpen(false);
      loadAll();
    } catch (error) {
      toast.error(error.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleNodeEnabled = async (node, enabled) => {
    try {
      const res = await fetch(`${API}/nodes/${node.id}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...node,
          enabled,
          port: Number(node.port) || 0,
          sort_order: Number(node.sort_order) || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || '更新失败');
      toast.success(enabled ? '节点已启用' : '节点已停用');
      loadAll();
    } catch (error) {
      toast.error(error.message || '更新失败');
    }
  };

  const deleteNode = async (node) => {
    const res = await fetch(`${API}/nodes/${node.id}`, { method: 'DELETE', headers: getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      toast.error(data.error || '删除失败');
      return;
    }
    toast.success('节点已删除');
    loadAll();
  };

  const openCreateTemplate = () => {
    setEditingTemplateId(null);
    setTemplateForm(emptyTemplateForm);
    setTemplateModalOpen(true);
  };

  const openEditTemplate = (tpl) => {
    setEditingTemplateId(tpl.id);
    setTemplateForm({ name: tpl.name, format: tpl.format, content: tpl.content, description: tpl.description || '' });
    setTemplateModalOpen(true);
  };

  const saveTemplate = async () => {
    setSaving(true);
    try {
      const res = await fetch(editingTemplateId ? `${API}/templates/${editingTemplateId}` : `${API}/templates`, {
        method: editingTemplateId ? 'PUT' : 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(templateForm),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || '保存失败');
      toast.success('模板已保存');
      setTemplateModalOpen(false);
      loadAll();
    } catch (error) {
      toast.error(error.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const setDefaultTemplate = async (tpl) => {
    const res = await fetch(`${API}/templates/${tpl.id}/default`, { method: 'POST', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      toast.error(data.error || '设置失败');
      return;
    }
    toast.success('默认模板已更新');
    loadAll();
  };

  const deleteTemplate = async (tpl) => {
    if (tpl.builtin) {
      toast.warning('内置模板不能删除');
      return;
    }
    if (!(await dialog.deleteResource({ resourceType: '模板', resourceName: tpl.name }))) return;
    const res = await fetch(`${API}/templates/${tpl.id}`, { method: 'DELETE', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      toast.error(data.error || '删除失败');
      return;
    }
    toast.success('模板已删除');
    loadAll();
  };

  const saveTemplateBinding = async () => {
    if (!selectedTemplateSubscription) {
      toast.warning('请选择对外订阅');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API}/subscriptions/${selectedTemplateSubscription.id}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...selectedTemplateSubscription,
          template_id: templateBindingId || settings?.default_template_id || 'builtin_mihomo_default',
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || '保存失败');
      toast.success('转换模板已更新');
      loadAll();
    } catch (error) {
      toast.error(error.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async () => {
    const res = await fetch(`${API}/settings`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(settings),
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      toast.error(data.error || '保存失败');
      return;
    }
    toast.success('设置已保存');
    loadAll();
  };

  const exportBackup = () => {
    fetch(`${API}/export`, { headers: getAuthHeaders() })
      .then((res) => res.json())
      .then((payload) => {
        if (!payload.success) throw new Error(payload.error || '导出失败');
        const blob = new Blob([JSON.stringify(payload.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `subscriptions_export_${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(url);
      })
      .catch((error) => toast.error(error.message || '导出失败'));
  };

  const renderProfiles = () => (
    <SectionCard
      title={`节点库 (${nodeLibraries.length})`}
      description="节点库负责接管原始节点来源；订阅链接从节点库生成。"
      className="h-full min-h-0"
      bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
      actions={<Button size="sm" variant="primary" onClick={openCreateProfile}><Plus className="h-3.5 w-3.5" />新建节点库</Button>}
    >
      <DataTableFrame className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <AppTable layout="fixed" widths={[220, 250, 120, 140, 100, 110]}>
          <Table.Header sticky variant="compact">
            <Table.Row>
              <Table.Head className="w-[24%] text-center">节点库</Table.Head>
              <Table.Head className="w-[26%] text-center">节点来源</Table.Head>
              <Table.Head className="w-[13%] text-center">节点</Table.Head>
              <Table.Head className="w-[15%] text-center">对外订阅</Table.Head>
              <Table.Head className="w-[10%] text-center">状态</Table.Head>
              <Table.Head className="w-[12%] text-center">操作</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {nodeLibraries.map((profile) => (
              <Table.Row key={profile.id} onDoubleClick={() => openEditProfile(profile)} className="cursor-pointer">
                <Table.Cell className="text-center">
                  <div className="truncate text-sm font-bold text-kumo-strong">{profile.name}</div>
                </Table.Cell>
                <Table.Cell className="text-center">
                  <div className="truncate font-mono text-xs text-kumo-strong">{profile.upstream_url || '手动导入 / 粘贴内容'}</div>
                </Table.Cell>
                <Table.Cell className="text-center">
                  <div className="text-xs font-semibold text-kumo-strong">{profile.node_count || profile.nodeCount || 0} 个节点</div>
                </Table.Cell>
                <Table.Cell className="text-center">
                  <div className="text-xs font-semibold text-kumo-strong">{profile.subscription_count || profile.subscriptionCount || 0} 个链接</div>
                </Table.Cell>
                <Table.Cell className="text-center">
                  <Badge variant={profile.enabled !== false ? 'success' : 'secondary'} appearance="dot">{profile.enabled !== false ? '启用' : '停用'}</Badge>
                </Table.Cell>
                <Table.Cell className="text-center">
                  <div className="flex justify-center gap-1">
                    <Button size="sm" variant="ghost" shape="square" aria-label="编辑节点库" title="编辑节点库" className="text-kumo-subtle hover:text-kumo-brand" onClick={() => openEditProfile(profile)}><Edit className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" shape="square" aria-label="删除节点库" title="删除节点库" className="text-kumo-subtle hover:text-kumo-danger" onClick={() => deleteProfile(profile)}><Trash className="h-3.5 w-3.5" /></Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
            {nodeLibraries.length === 0 && (
              <Table.Row><Table.Cell colSpan={6} className="p-8 text-center text-kumo-subtle">暂无节点库。先创建节点库，再导入节点。</Table.Cell></Table.Row>
            )}
          </Table.Body>
        </AppTable>
      </DataTableFrame>
    </SectionCard>
  );

  const renderSubscriptions = () => {
    const currentSubscriptions = selectedNodeLibrary ? selectedLibrarySubscriptions : [];
    return (
      <SectionCard
        title={`订阅管理 (${currentSubscriptions.length})`}
        description="选择一个节点库，然后生成和管理它对外提供的订阅链接。"
        className="h-full min-h-0"
        bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
        actions={(
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <span className="rounded border border-kumo-info/20 bg-kumo-info/10 px-1.5 py-0.5 text-[11px] font-semibold text-kumo-info">{visibleNodes.length} 个节点</span>
            <span className="rounded border border-kumo-badge-purple/20 bg-kumo-badge-purple/10 px-1.5 py-0.5 text-[11px] font-semibold text-kumo-badge-purple">{currentSubscriptions.length} 个订阅</span>
            <Select
              size="sm"
              aria-label="节点库"
              value={nodeSubscriptionId}
              onValueChange={(value) => setNodeSubscriptionId(String(value))}
              items={nodeLibraryItems}
              className="w-56 min-w-0"
            />
            <Button size="sm" variant="primary" onClick={() => openCreateSubscription()} disabled={!selectedNodeLibrary || visibleNodes.length === 0}><Plus className="h-3.5 w-3.5" />生成订阅</Button>
          </div>
        )}
      >
        <DataTableFrame className="min-h-0 flex-1 overflow-auto scrollbar-thin">
          <AppTable layout="fixed" widths={[260, 120, 210, 120, 160]}>
            <Table.Header sticky variant="compact">
              <Table.Row>
                <Table.Head className="w-[30%] text-center">订阅链接</Table.Head>
                <Table.Head className="w-[13%] text-center">状态</Table.Head>
                <Table.Head className="w-[24%] text-center">流量</Table.Head>
                <Table.Head className="w-[16%] text-center">访问</Table.Head>
                <Table.Head className="w-[17%] text-center">操作</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {currentSubscriptions.map((sub) => {
                const [label, variant] = statusLabel(sub);
                const used = (sub.traffic?.upload || 0) + (sub.traffic?.download || 0);
                const link = subscriptionURL(publicBase, sub);
                return (
                  <Table.Row key={sub.id} onDoubleClick={() => openEditSubscription(sub)} className="cursor-pointer">
                    <Table.Cell className="text-center">
                      <div className="truncate text-sm font-bold text-kumo-strong">{sub.name}</div>
                      <div className="mt-1 flex min-w-0 flex-wrap items-center justify-center gap-1">
                        <span className="rounded border border-kumo-info/20 bg-kumo-info/10 px-1.5 py-0.5 text-[10px] font-semibold text-kumo-info">{sub.node_count || visibleNodes.length || 0} 个节点</span>
                        <span className="truncate font-mono text-[10px] text-kumo-subtle">{sub.id}</span>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-center">
                      <Badge variant={variant} appearance="dot">{label}</Badge>
                      <div className="mt-1 text-[11px] text-kumo-subtle">{sub.expire_at ? `过期 ${sub.expire_at}` : '不过期'}</div>
                    </Table.Cell>
                    <Table.Cell className="text-center">
                      <Meter
                        label="流量"
                        value={Math.min(100, sub.traffic?.percent || 0)}
                        customValue={`${formatBytes(used)} / ${sub.traffic?.total ? formatBytes(sub.traffic.total) : '无限制'}`}
                      />
                    </Table.Cell>
                    <Table.Cell className="text-center">
                      <div className="text-xs text-kumo-strong">{sub.access_count_today || 0} 次</div>
                      <div className="mt-1 text-[11px] text-kumo-subtle">{formatTime(sub.last_access_at)}</div>
                    </Table.Cell>
                    <Table.Cell className="text-center">
                      <div className="flex justify-center gap-1">
                        <Button size="sm" variant="ghost" shape="square" aria-label="复制订阅链接" title="复制订阅链接" className="text-kumo-subtle hover:text-kumo-brand" onClick={() => copyText(link, '订阅链接已复制')}><Copy className="h-3.5 w-3.5" /></Button>
                        <Button size="sm" variant="ghost" shape="square" aria-label="编辑订阅链接" title="编辑订阅链接" className="text-kumo-subtle hover:text-kumo-brand" onClick={() => openEditSubscription(sub)}><Edit className="h-3.5 w-3.5" /></Button>
                        <Button size="sm" variant="ghost" shape="square" aria-label="重置链接" title="重置链接" className="text-kumo-subtle hover:text-kumo-warning" onClick={() => resetToken(sub)}><RefreshCw className="h-3.5 w-3.5" /></Button>
                        <Button size="sm" variant="ghost" shape="square" aria-label="删除订阅链接" title="删除订阅链接" className="text-kumo-subtle hover:text-kumo-danger" onClick={() => deleteSubscription(sub)}><Trash className="h-3.5 w-3.5" /></Button>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
              {currentSubscriptions.length === 0 && (
                <Table.Row><Table.Cell colSpan={5} className="p-8 text-center text-kumo-subtle">当前节点库还没有订阅链接。选择有节点的节点库后点击生成订阅。</Table.Cell></Table.Row>
              )}
            </Table.Body>
          </AppTable>
        </DataTableFrame>
      </SectionCard>
    );
  };

  const renderNodes = () => (
    <SectionCard
      title={`节点列表 (${filteredNodes.length})`}
      description={visibleNodes.length === filteredNodes.length ? '先导入节点并维护节点库，订阅链接会从这里选择节点源。' : `已从 ${visibleNodes.length} 个节点中过滤。`}
      className="h-full min-h-0"
      bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
      actions={(
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Select
            size="sm"
            aria-label="节点库"
            value={nodeSubscriptionId}
            onValueChange={(value) => setNodeSubscriptionId(String(value))}
            items={nodeLibraryItems}
            className="w-56 min-w-0"
          />
          <Button size="sm" variant="secondary" onClick={() => selectedNodeLibrary && refreshProfileUpstream(selectedNodeLibrary)} disabled={!selectedNodeLibrary || !selectedNodeLibrary.upstream_url}>
            <RefreshCw className="h-3.5 w-3.5" />
            拉取来源
          </Button>
          <Button size="sm" variant="primary" onClick={() => openImportModal()} disabled={!selectedNodeLibrary}>
            <Download className="h-3.5 w-3.5" />
            导入节点
          </Button>
        </div>
      )}
    >
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
        <Tabs
          {...TOOL_TABS_PROPS}
          value={protocolFilter}
          onValueChange={(value) => setProtocolFilter(String(value))}
          tabs={protocolItems}
          className="min-w-0 max-w-full flex-1 sm:flex-none"
          listClassName="max-w-full overflow-x-auto"
        />
        {tagItems.length > 1 && (
          <Select
            size="sm"
            aria-label="标签筛选"
            value={tagFilter}
            onValueChange={(value) => setTagFilter(String(value))}
            items={tagItems}
            className="w-full sm:w-36"
          />
        )}
      </div>

      <DataTableFrame className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <AppTable layout="fixed" widths={[90, 210, 100, 280, 190, 110]}>
          <Table.Header sticky variant="compact">
            <Table.Row>
              <Table.Head className="w-[9%] text-center">状态</Table.Head>
              <Table.Head className="w-[22%] text-center">节点名称</Table.Head>
              <Table.Head className="w-[10%] text-center">类型</Table.Head>
              <Table.Head className="w-[29%] text-center">连接</Table.Head>
              <Table.Head className="w-[18%] text-center">主机 / 延迟</Table.Head>
              <Table.Head className="w-[12%] text-center">操作</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {filteredNodes.map((node) => {
              const networkTags = nodeNetworkTags(node);
              return (
                <Table.Row key={node.id} onDoubleClick={() => openEditNode(node)} className="cursor-pointer">
                  <Table.Cell className="text-center">
                    <Switch
                      size="sm"
                      aria-label={node.enabled ? '停用节点' : '启用节点'}
                      checked={!!node.enabled}
                      onCheckedChange={(checked) => toggleNodeEnabled(node, checked)}
                    />
                  </Table.Cell>
                  <Table.Cell className="text-center">
                    <div className="flex min-w-0 items-center justify-center gap-2">
                      <NodeFlag node={node} />
                      {node.stable && <Star className="h-3.5 w-3.5 text-kumo-warning" />}
                      <span className="truncate text-sm font-bold text-kumo-strong">{node.name}</span>
                    </div>
                  </Table.Cell>
                  <Table.Cell className="text-center">
                    <div className="flex flex-wrap items-center justify-center gap-1">
                      <Badge variant={nodeTypeBadgeVariant(node.type)} className="uppercase">{node.type || '-'}</Badge>
                      {node.stable && <Badge variant="success">稳定</Badge>}
                    </div>
                  </Table.Cell>
                  <Table.Cell className="text-center">
                    <div className="truncate font-mono text-xs text-kumo-strong">{nodeEndpoint(node)}</div>
                    <div className="mt-1 flex min-w-0 flex-wrap justify-center gap-1">
                      {networkTags.map((tag) => (
                        <span
                          key={tag.key}
                          className={`inline-flex min-w-0 max-w-full truncate rounded-[3px] border px-1.5 py-0.5 font-mono text-[10px] leading-4 ${nodeNetworkTagClass(tag)}`}
                          title={tag.label}
                        >
                          {tag.label}
                        </span>
                      ))}
                      {networkTags.length === 0 && <span className="font-mono text-[11px] text-kumo-subtle">-</span>}
                    </div>
                  </Table.Cell>
                  <Table.Cell className="text-center">
                    <NodeHostQuality node={node} serverNameById={serverNameById} />
                  </Table.Cell>
                  <Table.Cell className="text-center">
                    <div className="flex justify-center gap-1">
                      <Button size="sm" variant="ghost" shape="square" aria-label="编辑节点" title="编辑节点" className="text-kumo-subtle hover:text-kumo-brand" onClick={() => openEditNode(node)}><Edit className="h-3.5 w-3.5" /></Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        shape="square"
                        aria-label="双击删除节点"
                        title="双击删除节点"
                        className="text-kumo-subtle hover:text-kumo-danger"
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          deleteNode(node);
                        }}
                      >
                        <Trash className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              );
            })}
            {filteredNodes.length === 0 && (
              <Table.Row><Table.Cell colSpan={6} className="p-8 text-center text-kumo-subtle">{visibleNodes.length === 0 ? '暂无节点。' : '没有符合筛选条件的节点。'}</Table.Cell></Table.Row>
            )}
          </Table.Body>
        </AppTable>
      </DataTableFrame>
    </SectionCard>
  );

  const renderNodesSkeleton = () => (
    <div className="grid gap-3" aria-busy="true" aria-label="正在加载节点">
      <LayerCard className="flex flex-col overflow-hidden p-0 shadow-none">
        <LayerCard.Secondary className="flex min-h-[56px] items-center justify-between gap-3 border-b border-kumo-line bg-kumo-recessed/20 px-4 py-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <SkeletonLine className="h-4 w-20" />
            <SkeletonLine className="h-3 w-72 max-w-[42vw]" />
          </div>
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <SkeletonLine className="h-8 w-24" />
            <SkeletonLine className="h-8 w-24" />
            <SkeletonLine className="h-8 w-28" />
          </div>
        </LayerCard.Secondary>
        <LayerCard.Primary className="p-4">
          <div className="grid gap-4 lg:grid-cols-4">
            <div className="space-y-2">
              <SkeletonLine className="h-3 w-12" />
              <SkeletonLine className="h-8 w-full" />
            </div>
            <div className="space-y-2 lg:col-span-2">
              <SkeletonLine className="h-3 w-20" />
              <SkeletonLine className="h-8 w-full" />
            </div>
            <div className="space-y-2">
              <SkeletonLine className="h-3 w-24" />
              <SkeletonLine className="h-8 w-full" />
            </div>
            <SkeletonLine className="h-8 w-32" />
          </div>
        </LayerCard.Primary>
      </LayerCard>

      <DataTableFrame>
        <Table layout="fixed" className="min-w-[920px]">
          <Table.Header>
            <Table.Row>
              <Table.Head>节点名称</Table.Head>
              <Table.Head>类型</Table.Head>
              <Table.Head>连接</Table.Head>
              <Table.Head>主机 / 延迟</Table.Head>
              <Table.Head>状态 / 操作</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {Array.from({ length: 6 }).map((_, index) => (
              <Table.Row key={index}>
                <Table.Cell>
                  <SkeletonLine className="h-4 w-32" />
                </Table.Cell>
                <Table.Cell><SkeletonLine className="h-5 w-16" /></Table.Cell>
                <Table.Cell><SkeletonLine className="h-3 w-44" /></Table.Cell>
                <Table.Cell><SkeletonLine className="h-3 w-16" /></Table.Cell>
                <Table.Cell>
                  <div className="flex gap-1">
                    <SkeletonLine className="h-8 w-8" />
                    <SkeletonLine className="h-8 w-8" />
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </DataTableFrame>
    </div>
  );

  const renderTemplates = () => (
    <div className="grid gap-3">
      <SectionCard
        title="模板转换"
        description="为对外订阅指定输出模板；Mihomo/Clash、Raw URI、Base64 订阅都从这里选择。"
        actions={<Button size="sm" variant="primary" onClick={saveTemplateBinding} loading={saving} disabled={!selectedTemplateSubscription}><Save className="h-3.5 w-3.5" />保存转换</Button>}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Select size="sm" label="对外订阅" value={templateSubscriptionId} onValueChange={(value) => setTemplateSubscriptionId(String(value))} items={subscriptionItems} />
          <Select size="sm" label="输出模板" value={templateBindingId} onValueChange={(value) => setTemplateBindingId(String(value))} items={templateItems} disabled={!selectedTemplateSubscription} />
        </div>
        {selectedTemplateSubscription && (
          <div className="mt-4 grid gap-2 border-t border-kumo-line pt-4 sm:grid-cols-3">
            <ClipboardText size="sm" text={subscriptionURL(publicBase, selectedTemplateSubscription)} tooltip={{ text: '复制默认格式', copiedText: '默认格式已复制' }} labels={{ copyAction: '复制默认格式' }} />
            <ClipboardText size="sm" text={subscriptionURL(publicBase, selectedTemplateSubscription, 'raw')} tooltip={{ text: '复制 Raw 链接', copiedText: 'Raw 链接已复制' }} labels={{ copyAction: '复制 Raw 链接' }} />
            <ClipboardText size="sm" text={subscriptionURL(publicBase, selectedTemplateSubscription, 'base64')} tooltip={{ text: '复制 Base64 链接', copiedText: 'Base64 链接已复制' }} labels={{ copyAction: '复制 Base64 链接' }} />
          </div>
        )}
      </SectionCard>

      <div className="grid items-start gap-3 lg:grid-cols-2">
        {templates.map((tpl) => (
          <LayerCard key={tpl.id} className="overflow-hidden">
            <LayerCard.Secondary className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-bold text-kumo-strong">{tpl.name}</span>
                  {tpl.is_default && <Badge variant="success">默认</Badge>}
                  {tpl.builtin && <Badge variant="secondary">内置</Badge>}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="secondary" onClick={() => setDefaultTemplate(tpl)}>默认</Button>
                <Button size="sm" variant="secondary" onClick={() => openEditTemplate(tpl)} disabled={tpl.builtin}><Edit className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="secondary-destructive" onClick={() => deleteTemplate(tpl)} disabled={tpl.builtin}><Trash className="h-3.5 w-3.5" /></Button>
              </div>
            </LayerCard.Secondary>
            <LayerCard.Primary>
              <div className="mb-3 text-xs text-kumo-subtle">{tpl.description || tpl.format}</div>
              <div className="max-h-44 overflow-auto">
                <Code lang={tpl.format === 'clash' ? 'yaml' : 'text'} code={tpl.content} />
              </div>
            </LayerCard.Primary>
          </LayerCard>
        ))}
      </div>
    </div>
  );

  const renderLogs = () => (
    <DataTableFrame>
      <Table layout="fixed" className="min-w-[960px]">
          <Table.Header>
            <Table.Row>
              <Table.Head>时间</Table.Head>
              <Table.Head>对外订阅</Table.Head>
              <Table.Head>客户端</Table.Head>
              <Table.Head>格式</Table.Head>
              <Table.Head>结果</Table.Head>
              <Table.Head>节点</Table.Head>
              <Table.Head>流量快照</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {logs.map((log) => (
              <Table.Row key={log.id}>
                <Table.Cell className="text-xs">{formatTime(log.created_at)}</Table.Cell>
                <Table.Cell className="text-xs">{subscriptions.find((item) => item.id === log.subscription_id)?.name || log.subscription_id || '-'}</Table.Cell>
                <Table.Cell><div className="truncate font-mono text-[11px]">{log.ip_address}</div><div className="truncate text-[10px] text-kumo-subtle">{log.user_agent}</div></Table.Cell>
                <Table.Cell className="text-xs">{log.format || '-'}</Table.Cell>
                <Table.Cell><Badge variant={log.success ? 'success' : 'error'} appearance="dot">{log.success ? '成功' : log.error_message || log.status_code}</Badge></Table.Cell>
                <Table.Cell className="text-xs">{log.node_count}</Table.Cell>
                <Table.Cell className="text-xs">{formatBytes((log.upload_bytes || 0) + (log.download_bytes || 0))} / {formatBytes(log.total_bytes || 0)}</Table.Cell>
              </Table.Row>
            ))}
            {logs.length === 0 && (
              <Table.Row><Table.Cell colSpan={7} className="p-8 text-center text-kumo-subtle">暂无访问日志。</Table.Cell></Table.Row>
            )}
          </Table.Body>
      </Table>
    </DataTableFrame>
  );

  const renderSettings = () => settings && (
    <SectionCard title="默认策略" className="max-w-3xl">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select size="sm" label="默认模板" value={settings.default_template_id} onValueChange={(value) => setSettings((prev) => ({ ...prev, default_template_id: String(value) }))} items={templateItems} />
          <Input size="sm" label="默认上游刷新间隔（小时）" type="number" value={settings.default_refresh_hours || 24} onChange={(e) => setSettings((prev) => ({ ...prev, default_refresh_hours: Number(e.target.value) || 24 }))} />
          <Input size="sm" label="默认限流阈值（次/分钟）" type="number" value={settings.default_rate_limit_per_minute || 30} onChange={(e) => setSettings((prev) => ({ ...prev, default_rate_limit_per_minute: Number(e.target.value) || 30 }))} />
          <Switch
            size="sm"
            label="默认启用限流"
            controlFirst={false}
            checked={!!settings.default_rate_limit_enabled}
            onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, default_rate_limit_enabled: checked }))}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="primary" onClick={saveSettings}><Save className="h-3.5 w-3.5" />保存设置</Button>
        </div>
    </SectionCard>
  );

  return (
    <PageStack className="min-h-0 flex-1 overflow-hidden">
      <PageToolbar className="shrink-0">
        <div className="min-w-0 max-w-full overflow-x-auto scrollbar-thin">
          <Tabs
            {...MODULE_TABS_PROPS}
            value={activeTab}
            onValueChange={(value) => setActiveTab(String(value))}
            tabs={[
              { value: 'profiles', label: '节点库' },
              { value: 'nodes', label: '节点' },
              { value: 'subscriptions', label: '订阅管理' },
            ]}
          />
        </div>
      </PageToolbar>

      <div className="min-h-0 flex-1 overflow-hidden p-px">
        {loading && nodeLibraries.length === 0 ? renderNodesSkeleton() : (
          <div className="h-full min-h-0">
            {activeTab === 'profiles' && renderProfiles()}
            {activeTab === 'nodes' && renderNodes()}
            {activeTab === 'subscriptions' && renderSubscriptions()}
          </div>
        )}
      </div>

      <Dialog.Root open={profileModalOpen} onOpenChange={setProfileModalOpen}>
        <Dialog size="lg" className="flex max-h-[min(calc(100dvh-2rem),42rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:w-[min(calc(100vw-3rem),64rem)]">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-kumo-line bg-kumo-recessed/20 px-5 py-3.5">
              <div className="min-w-0">
                <Dialog.Title className="min-w-0 truncate text-base font-semibold text-kumo-strong">
                  {editingProfileId ? '编辑节点库' : '新建节点库'}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 truncate text-xs text-kumo-subtle">
                  管理节点来源和节点库状态。
                </Dialog.Description>
              </div>
              <Dialog.Close
                aria-label="关闭"
                render={(props) => (
                  <Button
                    {...props}
                    type="button"
                    variant="secondary"
                    shape="square"
                    size="sm"
                    icon={<X className="h-3.5 w-3.5" />}
                    aria-label="关闭"
                    className="shrink-0"
                  />
                )}
              />
            </div>

            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 text-xs scrollbar-thin">
              <div className="space-y-4">
                <section className="space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">基础信息</div>
                  <div className="grid min-w-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]">
                    <Input size="sm" label="节点库名称" value={profileForm.name} onChange={(e) => setProfileForm((prev) => ({ ...prev, name: e.target.value }))} className="w-full min-w-0" />
                    <Input size="sm" label="备注" value={profileForm.remark || ''} onChange={(e) => setProfileForm((prev) => ({ ...prev, remark: e.target.value }))} className="w-full min-w-0" />
                  </div>
                </section>

                <section className="space-y-3 border-t border-kumo-line pt-4">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">节点来源</div>
                  <div className="grid min-w-0 items-end gap-3 md:grid-cols-[1fr_1fr_10rem]">
                    <Input size="sm" label="原始订阅 URL" placeholder="https://example.com/sub.yaml" value={profileForm.upstream_url || ''} onChange={(e) => setProfileForm((prev) => ({ ...prev, upstream_url: e.target.value }))} className="w-full min-w-0" />
                    <Input size="sm" label="刷新间隔（小时）" type="number" min="1" value={profileForm.upstream_refresh_hours || 24} onChange={(e) => setProfileForm((prev) => ({ ...prev, upstream_refresh_hours: Number(e.target.value) || 24 }))} className="w-full min-w-0" />
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="text-sm font-medium text-kumo-strong">定时拉取</div>
                      <div className="flex h-8 items-center">
                        <Switch size="sm" aria-label="定时拉取" checked={!!profileForm.upstream_enabled} onCheckedChange={(checked) => setProfileForm((prev) => ({ ...prev, upstream_enabled: checked }))} />
                      </div>
                    </div>
                  </div>
                </section>

                <section className="space-y-3 border-t border-kumo-line pt-4">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    <Switch size="sm" label="启用节点库" controlFirst={false} checked={!!profileForm.enabled} onCheckedChange={(checked) => setProfileForm((prev) => ({ ...prev, enabled: checked }))} />
                  </div>
                </section>
              </div>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3 sm:flex-row sm:justify-end">
              <Dialog.Close render={(props) => <Button size="sm" variant="secondary" className="w-full sm:w-auto" {...props}>取消</Button>} />
              <Button size="sm" variant="primary" loading={saving} onClick={saveProfile} className="w-full sm:w-auto"><Save className="h-3.5 w-3.5" />保存节点库</Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={subscriptionModalOpen} onOpenChange={setSubscriptionModalOpen}>
        <Dialog size="lg" className="flex max-h-[min(calc(100dvh-2rem),42rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:w-[min(calc(100vw-3rem),64rem)]">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-kumo-line bg-kumo-recessed/20 px-5 py-3.5">
              <div className="min-w-0">
                <Dialog.Title className="min-w-0 truncate text-base font-semibold text-kumo-strong">
                  {editingSubscriptionId ? '编辑对外订阅' : '创建对外订阅'}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 truncate text-xs text-kumo-subtle">
                  选择节点库作为来源，并设置对外订阅的流量额度和周期限制。
                </Dialog.Description>
              </div>
              <Dialog.Close
                aria-label="关闭"
                render={(props) => (
                  <Button
                    {...props}
                    type="button"
                    variant="secondary"
                    shape="square"
                    size="sm"
                    icon={<X className="h-3.5 w-3.5" />}
                    aria-label="关闭"
                    className="shrink-0"
                  />
                )}
              />
            </div>

            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 text-xs scrollbar-thin">
              <div className="space-y-4">
                <section className="space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">基础信息</div>
                  <div className="grid min-w-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]">
                    <div className="min-w-0">
                      <Input size="sm" label="名称" value={subscriptionForm.name} onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, name: e.target.value }))} className="w-full min-w-0" />
                    </div>
                    <div className="min-w-0">
                      <Select size="sm" label="节点来源" value={subscriptionForm.profile_id || selectedNodeLibrary?.id || ''} onValueChange={(value) => setSubscriptionForm((prev) => ({ ...prev, profile_id: String(value), node_filter_ids: [] }))} items={profileItems} className="w-full min-w-0" />
                    </div>
                  </div>
                </section>

                <section className="space-y-3 border-t border-kumo-line pt-4">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">使用节点</div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{subscriptionSelectedNodeIDs.size || subscriptionSourceNodes.length} / {subscriptionSourceNodes.length}</Badge>
                      <Button size="sm" variant="secondary" onClick={selectAllSubscriptionNodes} disabled={subscriptionSourceNodes.length === 0}>全选</Button>
                      <Button size="sm" variant="secondary" onClick={clearSubscriptionNodes} disabled={subscriptionSelectedNodeIDs.size === 0}>全部节点</Button>
                    </div>
                  </div>
                  <div className="max-h-56 overflow-auto rounded-md border border-kumo-line bg-kumo-recessed/20 p-2 scrollbar-thin">
                    <div className="grid min-w-0 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                      {subscriptionSourceNodes.map((node) => {
                        const useAll = subscriptionSelectedNodeIDs.size === 0;
                        const checked = useAll || subscriptionSelectedNodeIDs.has(node.id);
                        return (
                          <label key={node.id} className="flex min-w-0 items-center gap-2 rounded border border-transparent px-2 py-1.5 hover:border-kumo-line hover:bg-kumo-base/60">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(value) => setSubscriptionNodeFilter(node.id, !!value)}
                              aria-label={`选择 ${node.name}`}
                            />
                            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-kumo-strong">{node.name}</span>
                            <Badge variant={nodeTypeBadgeVariant(node.type)} className="uppercase">{node.type || '-'}</Badge>
                          </label>
                        );
                      })}
                      {subscriptionSourceNodes.length === 0 && (
                        <div className="px-2 py-4 text-center text-xs text-kumo-subtle sm:col-span-2 lg:col-span-3">暂无节点</div>
                      )}
                    </div>
                  </div>
                </section>

                <section className="space-y-3 border-t border-kumo-line pt-4">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">流量额度</div>
                  <div className="grid min-w-0 items-end gap-3 lg:grid-cols-[minmax(15rem,0.9fr)_minmax(0,3fr)]">
                    <div className="min-w-0">
                      <Select
                        size="sm"
                        label="流量来源"
                        value={subscriptionForm.traffic_source || 'manual'}
                        onValueChange={(value) => setSubscriptionForm((prev) => ({
                          ...prev,
                          traffic_source: String(value),
                          traffic_server_id: String(value) === 'server' ? prev.traffic_server_id : '',
                        }))}
                        items={[
                          { value: 'manual', label: '手动记录' },
                          { value: 'node_servers', label: '节点绑定主机' },
                          { value: 'server', label: '指定主机' },
                          { value: 'upstream', label: '上游订阅' },
                        ]}
                        className="w-full min-w-0"
                      />
                    </div>
                    <div className="grid min-w-0 items-end gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(13.5rem,100%),1fr))]">
                    {subscriptionForm.traffic_source === 'server' && (
                      <Select size="sm" label="统计主机" value={subscriptionForm.traffic_server_id || ''} onValueChange={(value) => setSubscriptionForm((prev) => ({ ...prev, traffic_server_id: String(value) }))} items={serverItems} className="w-full min-w-0" />
                    )}
                    {subscriptionForm.traffic_source !== 'upstream' && (
                      <TrafficSizeInput label="总流量" value={subscriptionForm.total_bytes || 0} onChange={(bytes) => setSubscriptionForm((prev) => ({ ...prev, total_bytes: bytes }))} />
                    )}
                    {(subscriptionForm.traffic_source || 'manual') === 'manual' && (
                      <>
                        <TrafficSizeInput label="手动上传" value={subscriptionForm.manual_upload_bytes || 0} onChange={(bytes) => setSubscriptionForm((prev) => ({ ...prev, manual_upload_bytes: bytes }))} />
                        <TrafficSizeInput label="手动下载" value={subscriptionForm.manual_download_bytes || 0} onChange={(bytes) => setSubscriptionForm((prev) => ({ ...prev, manual_download_bytes: bytes }))} />
                      </>
                    )}
                    </div>
                  </div>
                </section>

                <section className="space-y-3 border-t border-kumo-line pt-4">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">周期与限制</div>
                  <div className="grid min-w-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(12rem,100%),1fr))]">
                    <div className="min-w-0">
                      <Input size="sm" label="过期日期" type="date" value={subscriptionForm.expire_at || ''} onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, expire_at: e.target.value }))} className="w-full min-w-0" />
                    </div>
                    <div className="min-w-0">
                      <Select size="sm" label="周期" value={subscriptionForm.cycle_type || 'none'} onValueChange={(value) => setSubscriptionForm((prev) => ({ ...prev, cycle_type: String(value) }))} items={[{ value: 'none', label: '不重置' }, { value: 'monthly', label: '每月重置' }, { value: 'custom', label: '自定义周期' }]} className="w-full min-w-0" />
                    </div>
                    <div className="min-w-0">
                      <Input size="sm" label="每月重置日" type="number" min="1" max="31" value={subscriptionForm.cycle_day || 1} onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, cycle_day: Number(e.target.value) || 1 }))} className="w-full min-w-0" />
                    </div>
                    <div className="min-w-0">
                      <Input size="sm" label="限流（次/分钟）" type="number" value={subscriptionForm.rate_limit_per_minute || 30} onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, rate_limit_per_minute: Number(e.target.value) || 30 }))} className="w-full min-w-0" />
                    </div>
                  </div>
                </section>

                <section className="space-y-3 border-t border-kumo-line pt-4">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    <Switch size="sm" label="启用链接" controlFirst={false} checked={!!subscriptionForm.enabled} onCheckedChange={(checked) => setSubscriptionForm((prev) => ({ ...prev, enabled: checked }))} />
                    <Switch size="sm" label="启用限流" controlFirst={false} checked={!!subscriptionForm.rate_limit_enabled} onCheckedChange={(checked) => setSubscriptionForm((prev) => ({ ...prev, rate_limit_enabled: checked }))} />
                  </div>
                </section>
              </div>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3 sm:flex-row sm:justify-end">
              <Dialog.Close render={(props) => <Button size="sm" variant="secondary" className="w-full sm:w-auto" {...props}>取消</Button>} />
              <Button size="sm" variant="primary" loading={saving} onClick={saveSubscription} className="w-full sm:w-auto"><Save className="h-3.5 w-3.5" />保存</Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={nodeModalOpen} onOpenChange={setNodeModalOpen}>
        <Dialog size="lg" className="flex max-h-[min(calc(100dvh-2rem),44rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:w-[min(calc(100vw-3rem),72rem)]">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-kumo-line bg-kumo-recessed/20 px-5 py-3.5">
              <div className="min-w-0">
                <Dialog.Title className="min-w-0 truncate text-base font-semibold text-kumo-strong">编辑节点</Dialog.Title>
                <Dialog.Description className="mt-0.5 truncate text-xs text-kumo-subtle">
                  调整代理节点的连接信息、归属主机和原始配置。
                </Dialog.Description>
              </div>
              <Dialog.Close
                aria-label="关闭"
                render={(props) => (
                  <Button
                    {...props}
                    type="button"
                    variant="secondary"
                    shape="square"
                    size="sm"
                    icon={<X className="h-3.5 w-3.5" />}
                    aria-label="关闭"
                    className="shrink-0"
                  />
                )}
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 scrollbar-thin">
              <div className="space-y-4">
                <section className="min-w-0 space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">连接信息</div>
                  <div className="grid min-w-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr))]">
                    <Input size="sm" label="节点名称" value={nodeForm.name} onChange={(e) => setNodeForm((prev) => syncNodeForm(prev, 'name', e.target.value))} className="w-full min-w-0" />
                    <Input size="sm" label="协议类型" value={nodeForm.type} onChange={(e) => setNodeForm((prev) => syncNodeForm(prev, 'type', e.target.value))} className="w-full min-w-0" />
                    <Input size="sm" label="服务器地址" value={nodeForm.server} onChange={(e) => setNodeForm((prev) => syncNodeForm(prev, 'server', e.target.value))} className="w-full min-w-0" />
                    <Input size="sm" label="端口" type="number" value={nodeForm.port || 0} onChange={(e) => setNodeForm((prev) => syncNodeForm(prev, 'port', Number(e.target.value) || 0))} className="w-full min-w-0" />
                    <Input size="sm" label="国家 / 地区代码" value={nodeForm.country_code || ''} onChange={(e) => setNodeForm((prev) => ({ ...prev, country_code: e.target.value }))} className="w-full min-w-0" />
                    <Input size="sm" label="位置" value={nodeForm.location || ''} onChange={(e) => setNodeForm((prev) => ({ ...prev, location: e.target.value }))} className="w-full min-w-0" />
                    <Input size="sm" label="标签" value={nodeForm.tags || ''} onChange={(e) => setNodeForm((prev) => ({ ...prev, tags: e.target.value }))} className="w-full min-w-0" />
                  </div>
                </section>

                <section className="min-w-0 space-y-3 border-t border-kumo-line pt-4">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">管理属性</div>
                  <div className="grid min-w-0 items-end gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr))]">
                    <Select size="sm" label="绑定主机" value={nodeForm.traffic_server_id || ''} onValueChange={(value) => setNodeForm((prev) => ({ ...prev, traffic_server_id: String(value) }))} items={serverItems} className="w-full min-w-0" />
                    <Input size="sm" label="排序" type="number" value={nodeForm.sort_order || 0} onChange={(e) => setNodeForm((prev) => ({ ...prev, sort_order: Number(e.target.value) || 0 }))} className="w-full min-w-0" />
                    <div className="grid min-h-8 min-w-0 gap-3 rounded-md border border-kumo-line bg-kumo-recessed/25 px-3 py-2 sm:grid-cols-2">
                      <Switch size="sm" label="启用节点" controlFirst={false} checked={!!nodeForm.enabled} onCheckedChange={(checked) => setNodeForm((prev) => ({ ...prev, enabled: checked }))} />
                      <Switch size="sm" label="稳定节点" controlFirst={false} checked={!!nodeForm.stable} onCheckedChange={(checked) => setNodeForm((prev) => ({ ...prev, stable: checked }))} />
                    </div>
                  </div>
                </section>

                <section className="min-w-0 space-y-3 border-t border-kumo-line pt-4">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">原始配置</div>
                  <div className="grid min-w-0 gap-3">
                    <InputArea label="原始节点链接" className="min-h-36 w-full min-w-0 font-mono text-xs" value={nodeForm.raw || ''} onChange={(e) => setNodeForm((prev) => syncNodeForm(prev, 'raw', e.target.value))} />
                    <InputArea label="节点配置 JSON" className="min-h-36 w-full min-w-0 font-mono text-xs" value={nodeForm.config_json || ''} onChange={(e) => setNodeForm((prev) => syncNodeForm(prev, 'config_json', e.target.value))} />
                  </div>
                </section>
              </div>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3 sm:flex-row sm:justify-end">
              <Dialog.Close render={(props) => <Button size="sm" variant="secondary" className="w-full sm:w-auto" {...props}>取消</Button>} />
              <Button size="sm" variant="primary" loading={saving} onClick={saveNode} className="w-full sm:w-auto"><Save className="h-3.5 w-3.5" />保存节点</Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={importModalOpen} onOpenChange={setImportModalOpen}>
        <Dialog size="lg" className="flex max-h-[min(calc(100dvh-2rem),42rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:w-[min(calc(100vw-3rem),72rem)]">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-kumo-line bg-kumo-recessed/20 px-5 py-3.5">
              <div className="min-w-0">
                <Dialog.Title className="min-w-0 truncate text-base font-semibold text-kumo-strong">导入节点</Dialog.Title>
                <Dialog.Description className="mt-0.5 truncate text-xs text-kumo-subtle">
                  解析订阅地址、节点链接或 YAML 内容并导入节点库。
                </Dialog.Description>
              </div>
              <Dialog.Close
                aria-label="关闭"
                render={(props) => (
                  <Button
                    {...props}
                    type="button"
                    variant="secondary"
                    shape="square"
                    size="sm"
                    icon={<X className="h-3.5 w-3.5" />}
                    aria-label="关闭"
                    className="shrink-0"
                  />
                )}
              />
            </div>

            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 scrollbar-thin">
              <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.6fr)] lg:items-stretch">
                <div className="space-y-3">
                  <Select size="sm" label="导入到节点库" value={importSubscriptionId} onValueChange={(value) => setImportSubscriptionId(String(value))} items={nodeLibraryItems} />
                  <Input size="sm" label="原始订阅 URL" placeholder="https://example.com/sub.yaml" value={importSourceURL} onChange={(e) => setImportSourceURL(e.target.value)} />
                  <InputArea label="节点链接 / YAML / Base64 内容" className="min-h-56 w-full font-mono text-xs lg:min-h-72" placeholder="可粘贴 vmess/vless/trojan/ss/hysteria2 链接、Base64 订阅内容，或 Clash/Mihomo YAML 的 proxies 内容。" value={importText} onChange={(e) => setImportText(e.target.value)} />
                </div>
                <LayerCard className="flex min-h-72 flex-col overflow-hidden border border-kumo-line bg-kumo-elevated p-0 shadow-none">
                  <LayerCard.Secondary className="flex min-h-11 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-recessed/20 px-4 py-2.5">
                    <div className="min-w-0 truncate text-sm font-bold text-kumo-strong">解析预览</div>
                    <Badge variant="secondary">{importPreview.length} 个节点</Badge>
                  </LayerCard.Secondary>
                  <LayerCard.Primary className="min-h-0 flex-1 overflow-y-auto p-0 scrollbar-thin">
                    <div className="flex min-h-full flex-col divide-y divide-kumo-line">
                      {importPreview.map((node, index) => (
                        <div key={`${node.name}-${index}`} className="grid min-h-14 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-xs">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <NodeFlag node={node} />
                              <span className="truncate font-semibold text-kumo-strong">{node.name || '未命名节点'}</span>
                            </div>
                            <div className="mt-1 truncate font-mono text-[11px] text-kumo-subtle">{node.server || '-'}:{node.port || '-'}</div>
                          </div>
                          <Badge variant={nodeTypeBadgeVariant(node.type)} className="shrink-0 uppercase">{node.type || '-'}</Badge>
                        </div>
                      ))}
                      {importPreview.length === 0 && (
                        <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-xs text-kumo-subtle">预览后显示解析出的节点。</div>
                      )}
                    </div>
                  </LayerCard.Primary>
                </LayerCard>
              </div>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3 sm:flex-row sm:justify-end">
              <Button size="sm" variant="secondary" onClick={previewImport} className="w-full sm:w-auto">预览</Button>
              <Button size="sm" variant="secondary" onClick={() => commitImport(true)} className="w-full sm:w-auto"><Download className="h-3.5 w-3.5" />覆盖导入</Button>
              <Button size="sm" variant="primary" onClick={() => commitImport(false)} className="w-full sm:w-auto"><Download className="h-3.5 w-3.5" />追加导入</Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={templateModalOpen} onOpenChange={setTemplateModalOpen}>
        <Dialog size="lg" className="flex max-h-[min(calc(100dvh-2rem),42rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:w-[min(calc(100vw-3rem),64rem)]">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-kumo-line bg-kumo-recessed/20 px-5 py-3.5">
              <div className="min-w-0">
                <Dialog.Title className="min-w-0 truncate text-base font-semibold text-kumo-strong">
                  {editingTemplateId ? '编辑模板' : '创建模板'}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 truncate text-xs text-kumo-subtle">
                  维护分发模板内容和输出格式。
                </Dialog.Description>
              </div>
              <Dialog.Close
                aria-label="关闭"
                render={(props) => (
                  <Button
                    {...props}
                    type="button"
                    variant="secondary"
                    shape="square"
                    size="sm"
                    icon={<X className="h-3.5 w-3.5" />}
                    aria-label="关闭"
                    className="shrink-0"
                  />
                )}
              />
            </div>

            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 scrollbar-thin">
              <div className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input size="sm" label="名称" value={templateForm.name} onChange={(e) => setTemplateForm((prev) => ({ ...prev, name: e.target.value }))} />
                  <Select size="sm" label="格式" value={templateForm.format} onValueChange={(value) => setTemplateForm((prev) => ({ ...prev, format: String(value) }))} items={[{ value: 'clash', label: 'Mihomo/Clash YAML' }, { value: 'raw', label: 'Raw URI List' }, { value: 'base64', label: 'Base64 URI List' }]} />
                </div>
                <InputArea label="模板内容" className="min-h-64 w-full font-mono text-xs lg:min-h-80" value={templateForm.content} onChange={(e) => setTemplateForm((prev) => ({ ...prev, content: e.target.value }))} />
                <Input size="sm" label="描述" value={templateForm.description} onChange={(e) => setTemplateForm((prev) => ({ ...prev, description: e.target.value }))} />
              </div>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3 sm:flex-row sm:justify-end">
              <Dialog.Close render={(props) => <Button size="sm" variant="secondary" className="w-full sm:w-auto" {...props}>取消</Button>} />
              <Button size="sm" variant="primary" loading={saving} onClick={saveTemplate} className="w-full sm:w-auto"><Save className="h-3.5 w-3.5" />保存模板</Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </PageStack>
  );
}

export default SubscriptionPage;
