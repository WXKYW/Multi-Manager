import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { ShikiProvider, useShikiHighlighter } from '@cloudflare/kumo/code';
import { AppTable, DataTableFrame, PageStack, PageToolbar, SectionCard } from '../components/ui/AppPrimitives.jsx';
import { MODULE_TABS_PROPS, TOOL_TABS_PROPS } from '../modules/kumoTabs.js';
import { getOSIconClass, getServerPlatformLabel } from '../modules/osPlatform.js';
import useStore from '../store.js';
import { dialog } from '../modules/dialog.js';
import { toast } from '../modules/toast.js';
import CountryFlag from '../components/CountryFlag.jsx';
import { Copy, Download, Edit, Plus, RefreshCw, Save, Star, Trash, X } from '../components/Icons.jsx';

const API = '/api/subscription';
const INTERNAL_API = '/api/server/agent/proxy/nodes';
const LOAD_TIMEOUT_MS = 8000;
const INITIAL_SKELETON_MS = 900;

const emptyInternalNodeForm = { server_id: '', name: '', protocol: 'vless-reality', public_host: '', server_name: 'www.cloudflare.com', certificate_pem: '', private_key_pem: '', enabled: true };

const getInstanceCountryCode = (server) => {
  const direct = String(server?.country_code || server?.countryCode || server?.resolved_country || '').trim();
  if (/^[a-z]{2}$/i.test(direct)) return direct.toUpperCase();
  const location = String(server?.location || '').trim();
  if (/^[a-z]{2}$/i.test(location)) return location.toUpperCase();
  const known = { singapore: 'SG', japan: 'JP', germany: 'DE', france: 'FR', 'hong kong': 'HK', london: 'GB' };
  return known[location.toLowerCase()] || '';
};

const getInstanceLocationLabel = (server) => getInstanceCountryCode(server) || String(server?.location || '—');

const countryFlagEmoji = (countryCode) => {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...code.split('').map((letter) => 127397 + letter.charCodeAt(0)));
};

const formatInstanceUptime = (value) => {
  const text = String(value || '').trim();
  if (!text) return '-';
  const dayMatch = text.match(/(\d+)\s*(?:d|天)/i);
  if (dayMatch) return `${dayMatch[1]}天`;
  return /(?:h|m|s|时|分|秒)/i.test(text) ? '0天' : text;
};

const emptySubscriptionForm = {
  profile_id: '',
  plan_id: '',
  name: '',
  remark: '',
  enabled: true,
  template_id: 'builtin_mihomo_default',
  traffic_source: 'panel',
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
  include_internal_nodes: true,
  include_external_nodes: false,
};

const emptyPlanForm = {
  name: '', remark: '', enabled: true, total_bytes: 0, cycle_type: 'monthly', cycle_day: 1,
  rate_limit_enabled: true, rate_limit_per_minute: 30, node_ids: [], include_internal_nodes: true, include_external_nodes: false,
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
  ownership: 'external',
  management: 'unmanaged',
  traffic_reporting: 'unavailable',
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
    <div className="flex min-w-0 flex-col items-start gap-1 text-left">
      <span
        className={`inline-flex max-w-full items-center rounded-[3px] border px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${hostName ? 'border-kumo-info/25 bg-kumo-info/10 text-kumo-info' : 'border-kumo-line bg-kumo-recessed/45 text-kumo-subtle'}`}
        title={hostName || '未绑定主机'}
      >
        <span className="truncate">{hostName || '未绑定'}</span>
      </span>
      <div className="flex max-w-full flex-wrap justify-start gap-1">
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

const templateLanguage = (format) => (format === 'clash' ? 'yaml' : 'bash');

function TemplateCodeEditorInner({ label, value, format, onChange }) {
  const highlightRef = useRef(null);
  const { highlight, isReady } = useShikiHighlighter();
  const language = templateLanguage(format);
  const highlightedHtml = useMemo(() => {
    if (!isReady) return null;
    return highlight(String(value || ''), language);
  }, [highlight, isReady, language, value]);

  const handleScroll = (event) => {
    if (!highlightRef.current) return;
    highlightRef.current.scrollTop = event.currentTarget.scrollTop;
    highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="text-xs font-semibold text-kumo-subtle">{label}</Label>
      <div className="app-code-editor-shell min-h-64 lg:min-h-80">
        <div
          ref={highlightRef}
          aria-hidden="true"
          className="app-code-editor-highlight"
        >
          {highlightedHtml ? (
            <div
              className="app-code-editor-shiki"
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <pre className="app-code-editor-plain">{String(value || '')}</pre>
          )}
        </div>
        <textarea
          aria-label={label}
          className="app-code-editor-input"
          value={value}
          onChange={onChange}
          onScroll={handleScroll}
          spellCheck={false}
          wrap="off"
        />
      </div>
    </div>
  );
}

function TemplateCodeEditor(props) {
  return (
    <ShikiProvider engine="javascript" languages={['yaml', 'bash']}>
      <TemplateCodeEditorInner {...props} />
    </ShikiProvider>
  );
}

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
  const [activeTab, setActiveTab] = useState('instances');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [plans, setPlans] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [internalNodes, setInternalNodes] = useState([]);
	const [selectedInternalHosts, setSelectedInternalHosts] = useState(new Set());
	const [internalNodeModalOpen, setInternalNodeModalOpen] = useState(false);
	const [internalNodeForm, setInternalNodeForm] = useState(emptyInternalNodeForm);
	const [editingInternalNodeId, setEditingInternalNodeId] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [logs, setLogs] = useState([]);
  const [servers, setServers] = useState([]);
  const [settings, setSettings] = useState(null);

  const [subscriptionModalOpen, setSubscriptionModalOpen] = useState(false);
  const [subscriptionForm, setSubscriptionForm] = useState(emptySubscriptionForm);
  const [editingSubscriptionId, setEditingSubscriptionId] = useState(null);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [planForm, setPlanForm] = useState(emptyPlanForm);
  const [editingPlanId, setEditingPlanId] = useState(null);
  const [planNodeTypeFilter, setPlanNodeTypeFilter] = useState('all');
  const [planNodeSourceFilter, setPlanNodeSourceFilter] = useState('all');
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
  const loadGenerationRef = useRef(0);

  const publicBase = useMemo(
    () => normalizePublicBase(publicApiUrl, typeof window === 'undefined' ? '' : window.location.origin),
    [publicApiUrl]
  );

  const loadAll = async () => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    const loadJSON = async (url) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
      try {
        const response = await fetch(url, { headers: getAuthHeaders(), signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return await response.json();
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const resources = [
      [`${API}/profiles`, setProfiles, []],
      [`${API}/plans`, setPlans, []],
      [`${API}/subscriptions`, setSubscriptions, []],
      [`${API}/nodes`, setNodes, []],
      [INTERNAL_API, setInternalNodes, []],
      [`${API}/templates`, setTemplates, []],
      [`${API}/logs?limit=200`, setLogs, []],
      [`${API}/servers`, setServers, []],
      [`${API}/settings`, setSettings, {}],
    ];
    const requests = resources.map(([url, setter, fallback]) => loadJSON(url)
      .then((payload) => {
        if (loadGenerationRef.current === generation) setter(payload.data ?? fallback);
        return true;
      })
      .catch((error) => {
        console.warn(`Subscription resource unavailable: ${url}`, error);
        return false;
      }));

    // A slow optional resource must never own the whole page's loading state.
    await Promise.race([
      Promise.allSettled([requests[4], requests[7]]),
      new Promise((resolve) => window.setTimeout(resolve, INITIAL_SKELETON_MS)),
    ]);
    if (loadGenerationRef.current === generation) setLoading(false);

    const results = await Promise.all(requests);
    if (loadGenerationRef.current === generation && results.some((success) => !success)) {
      toast.warning(`${results.filter((success) => !success).length} 项数据暂时无法载入，其余内容已显示`);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const createInternalNode = async () => {
    const selectedIDs = [...selectedInternalHosts];
    const targetServerIDs = selectedIDs.length > 0 ? selectedIDs : [internalNodeForm.server_id].filter(Boolean);
    if (targetServerIDs.length === 0) {
      toast.warning('请选择目标实例');
      return;
    }
    setSaving(true);
    try {
      const results = await Promise.all(targetServerIDs.map(async (serverID) => {
        const server = servers.find((item) => item.id === serverID);
        const customName = internalNodeForm.name.trim();
        const protocolLabel = internalNodeForm.protocol === 'hysteria2' ? 'HY2' : 'VLESS';
        const flag = countryFlagEmoji(getInstanceCountryCode(server));
        const generatedName = `${flag ? `${flag} ` : ''}${server?.name || serverID} ${protocolLabel}`;
        const namedNode = customName
          ? `${flag && !customName.startsWith(flag) ? `${flag} ` : ''}${targetServerIDs.length > 1 ? `${customName}-${server?.name || serverID}` : customName}`
          : generatedName;
        const payload = {
          ...internalNodeForm,
          server_id: serverID,
          name: namedNode,
          public_host: server?.host || '',
        };
        const res = await fetch(INTERNAL_API, { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok || data.success === false) throw new Error(`${servers.find((server) => server.id === serverID)?.name || serverID}: ${data.error || data.message || '部署失败'}`);
        return data;
      }));
      toast.success(`已向 ${results.length} 台主机下发部署`);
      setInternalNodeModalOpen(false);
      setInternalNodeForm(emptyInternalNodeForm);
      setSelectedInternalHosts(new Set());
      await loadAll();
    } catch (error) { toast.error(error.message); } finally { setSaving(false); }
  };

  const reconcileInternalNode = async (node) => {
    const res = await fetch(`${INTERNAL_API}/${node.id}/reconcile`, { method: 'POST', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || data.success === false) return toast.error(data.error || data.message || '重新部署失败');
    toast.success('节点状态已同步'); await loadAll();
  };

  const deleteInternalNode = async (node) => {
    if (!(await dialog.deleteResource({ resourceType: '内部节点', resourceName: node.name }))) return;
    const res = await fetch(`${INTERNAL_API}/${node.id}`, { method: 'DELETE', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || data.success === false) return toast.error(data.error || data.message || '卸载失败');
    toast.success('内部节点已卸载'); await loadAll();
  };

  const reconcileInternalNodes = async (managed) => {
    setSaving(true);
    try {
      const results = await Promise.all(managed.map(async (node) => {
        const res = await fetch(`${INTERNAL_API}/${node.id}/reconcile`, { method: 'POST', headers: getAuthHeaders() });
        const data = await res.json();
        if (!res.ok || data.success === false) throw new Error(data.error || data.message || `${node.name} 重新部署失败`);
        return data;
      }));
      toast.success(`已重新部署 ${results.length} 个节点`);
      await loadAll();
    } catch (error) {
      toast.error(error.message || '重新部署失败');
    } finally {
      setSaving(false);
    }
  };

  const uninstallInternalNodes = async (server, managed) => {
    if (!(await dialog.deleteResource({ resourceType: '实例代理服务', resourceName: `${server.name}（${managed.length} 个节点）` }))) return;
    setSaving(true);
    try {
      await Promise.all(managed.map(async (node) => {
        const res = await fetch(`${INTERNAL_API}/${node.id}`, { method: 'DELETE', headers: getAuthHeaders() });
        const data = await res.json();
        if (!res.ok || data.success === false) throw new Error(data.error || data.message || `${node.name} 卸载失败`);
      }));
      toast.success(`已卸载 ${managed.length} 个节点`);
      await loadAll();
    } catch (error) {
      toast.error(error.message || '卸载失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleInternalNodeEnabled = async (node, enabled) => {
    try {
      const res = await fetch(`${INTERNAL_API}/${node.id}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || data.message || '更新失败');
      toast.success(enabled ? '内部节点已启用' : '内部节点已停用');
      await loadAll();
    } catch (error) {
      toast.error(error.message || '更新失败');
    }
  };

  const toggleInternalHost = (serverID, checked) => setSelectedInternalHosts((previous) => {
    const next = new Set(previous); if (checked) next.add(serverID); else next.delete(serverID); return next;
  });

  const startInternalDeployment = (serverID = '') => {
    setEditingInternalNodeId(null);
    const nextSelection = serverID ? new Set([serverID]) : new Set(selectedInternalHosts);
    if (serverID) setSelectedInternalHosts(nextSelection);
    const selected = serverID || [...nextSelection][0] || '';
    setInternalNodeForm((prev) => ({ ...emptyInternalNodeForm, server_id: selected, protocol: prev.protocol || 'vless-reality', public_host: servers.find((server) => server.id === selected)?.host || '' }));
    setInternalNodeModalOpen(true);
  };

  const openEditInternalNode = (node) => {
    setEditingInternalNodeId(node.id);
    setSelectedInternalHosts(new Set([node.server_id]));
    setInternalNodeForm({ ...emptyInternalNodeForm, ...node, server_name: node.server_name || 'www.cloudflare.com' });
    setInternalNodeModalOpen(true);
  };

  const saveInternalNode = async () => {
    if (!internalNodeForm.name.trim()) return toast.warning('请输入节点名称');
    setSaving(true);
    try {
      const res = await fetch(`${INTERNAL_API}/${editingInternalNodeId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name: internalNodeForm.name.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || data.message || '保存失败');
      setInternalNodeModalOpen(false);
      setEditingInternalNodeId(null);
      toast.success('节点名称已更新');
      await loadAll();
    } catch (error) {
      toast.error(error.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const templateItems = useMemo(() => templates.map((item) => ({ value: item.id, label: item.name })), [templates]);
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
  const planItems = useMemo(() => plans.filter((item) => item.enabled).map((item) => ({ value: item.id, label: item.name })), [plans]);
  const planCandidateNodes = useMemo(() => [
    ...internalNodes.map((node) => ({ ...node, source_group: 'internal', display_type: node.protocol === 'vless-reality' ? 'vless' : node.protocol })),
    ...nodes.map((node) => ({ ...node, source_group: 'external', display_type: String(node.type || 'unknown').toLowerCase() })),
  ], [internalNodes, nodes]);
  const planNodeTypeItems = useMemo(() => [{ value: 'all', label: '全部类型' }, ...Array.from(new Set(planCandidateNodes.map((node) => node.display_type))).sort().map((value) => ({ value, label: value.toUpperCase() }))], [planCandidateNodes]);
  const visiblePlanNodes = useMemo(() => planCandidateNodes.filter((node) => (
    (planNodeTypeFilter === 'all' || node.display_type === planNodeTypeFilter)
    && (planNodeSourceFilter === 'all' || node.source_group === planNodeSourceFilter)
  )), [planCandidateNodes, planNodeSourceFilter, planNodeTypeFilter]);
  const visiblePlanNodeIDs = useMemo(() => visiblePlanNodes.map((node) => node.id), [visiblePlanNodes]);
  const allVisiblePlanNodesSelected = visiblePlanNodeIDs.length > 0 && visiblePlanNodeIDs.every((id) => planForm.node_ids.includes(id));
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
    () => nodes,
    [nodes]
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
    const external = subscriptionForm.include_external_nodes && profileID
      ? nodes.filter((item) => profileKeyOf(item) === profileID).map((item) => ({ ...item, source_group: 'external' }))
      : [];
    const managed = subscriptionForm.include_internal_nodes
      ? internalNodes.filter((item) => item.enabled && item.publishable && item.apply_status === 'running').map((item) => ({
          ...item,
          type: item.protocol === 'vless-reality' ? 'vless' : item.protocol,
          server: item.public_host,
          port: item.assigned_port,
          ownership: 'self',
          management: 'agent',
          source_group: 'internal',
        }))
      : [];
    return [...managed, ...external];
  }, [nodes, internalNodes, selectedNodeLibrary, subscriptionForm.profile_id, subscriptionForm.include_external_nodes, subscriptionForm.include_internal_nodes]);
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
      plan_id: planItems[0]?.value || '',
      name: `${library?.name || '节点库'} 订阅 ${linkIndex}`,
      template_id: settings?.default_template_id || 'builtin_mihomo_default',
      rate_limit_enabled: settings?.default_rate_limit_enabled ?? true,
      rate_limit_per_minute: settings?.default_rate_limit_per_minute || 30,
      node_filter_ids: [],
      include_internal_nodes: true,
      include_external_nodes: false,
    });
    setSubscriptionModalOpen(true);
  };

  const openCreatePlan = () => {
    setEditingPlanId(null);
    setPlanForm({ ...emptyPlanForm, node_ids: [] });
    setPlanNodeTypeFilter('all'); setPlanNodeSourceFilter('all');
    setPlanModalOpen(true);
  };

  const openEditPlan = (plan) => {
    setEditingPlanId(plan.id);
    setPlanForm({ ...emptyPlanForm, ...plan, node_ids: Array.isArray(plan.node_ids) ? plan.node_ids : [] });
    setPlanNodeTypeFilter('all'); setPlanNodeSourceFilter('all');
    setPlanModalOpen(true);
  };

  const savePlan = async () => {
    if (!planForm.name.trim()) return toast.warning('请输入套餐名称');
    setSaving(true);
    try {
      const res = await fetch(editingPlanId ? `${API}/plans/${editingPlanId}` : `${API}/plans`, { method: editingPlanId ? 'PUT' : 'POST', headers: getAuthHeaders(), body: JSON.stringify(planForm) });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || '保存失败');
      setPlanModalOpen(false); await loadAll(); toast.success('套餐已保存');
    } catch (error) { toast.error(error.message); } finally { setSaving(false); }
  };

  const deletePlan = async (plan) => {
    if (!(await dialog.deleteResource({ resourceType: '套餐', resourceName: plan.name }))) return;
    const res = await fetch(`${API}/plans/${plan.id}`, { method: 'DELETE', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || data.success === false) return toast.error(data.error || '删除失败');
    await loadAll(); toast.success('套餐已删除');
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
          traffic_source: 'panel',
          traffic_server_id: '',
          manual_upload_bytes: 0,
          manual_download_bytes: 0,
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
    const targetId = subId || nodeSubscriptionId || nodeLibraryItems[0]?.value || '';
    if (!targetId) {
      toast.warning('外部节点导入空间尚未初始化');
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
      toast.warning('请选择导入目标');
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
      className="h-full min-h-0"
      bodyPadding="none"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      actions={<Button size="sm" variant="primary" onClick={openCreateProfile}><Plus className="h-3.5 w-3.5" />新建节点库</Button>}
    >
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <AppTable layout="fixed" widths={[260, 360, 120, 120, 100, 132]}>
          <Table.Header sticky variant="compact">
            <Table.Row>
              <Table.Head>节点库</Table.Head>
              <Table.Head>节点来源</Table.Head>
              <Table.Head className="text-center">节点</Table.Head>
              <Table.Head className="text-center">对外订阅</Table.Head>
              <Table.Head className="text-center">状态</Table.Head>
              <Table.Head className="text-center">操作</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {nodeLibraries.map((profile) => (
              <Table.Row key={profile.id} onDoubleClick={() => openEditProfile(profile)} className="cursor-pointer">
                <Table.Cell>
                  <div className="truncate text-sm font-semibold text-kumo-strong">{profile.name}</div>
                </Table.Cell>
                <Table.Cell>
                  <div className="truncate font-mono text-xs text-kumo-subtle" title={profile.upstream_url || '手动导入 / 粘贴内容'}>
                    {profile.upstream_url || '手动导入 / 粘贴内容'}
                  </div>
                </Table.Cell>
                <Table.Cell className="text-center">
                  <span className="text-xs font-semibold text-kumo-strong">{profile.node_count || profile.nodeCount || 0} 个节点</span>
                </Table.Cell>
                <Table.Cell className="text-center">
                  <span className="text-xs font-semibold text-kumo-strong">{profile.subscription_count || profile.subscriptionCount || 0} 个链接</span>
                </Table.Cell>
                <Table.Cell className="text-center">
                  <Badge variant={profile.enabled !== false ? 'success' : 'secondary'} appearance="dot">{profile.enabled !== false ? '启用' : '停用'}</Badge>
                </Table.Cell>
                <Table.Cell className="text-center">
                  <div className="inline-flex items-center justify-center gap-2">
                    <Button size="sm" shape="square" variant="secondary" aria-label="编辑节点库" title="编辑节点库" onClick={() => openEditProfile(profile)} icon={<Edit className="h-3.5 w-3.5" />} />
                    <Button size="sm" shape="square" variant="secondary-destructive" aria-label="删除节点库" title="删除节点库" onClick={() => deleteProfile(profile)} icon={<Trash className="h-3.5 w-3.5" />} />
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
            {nodeLibraries.length === 0 && (
              <Table.Row><Table.Cell colSpan={6} className="p-8 text-center text-kumo-subtle">暂无节点库。先创建节点库，再导入节点。</Table.Cell></Table.Row>
            )}
          </Table.Body>
        </AppTable>
      </div>
    </SectionCard>
  );

  const renderSubscriptions = () => {
    const currentSubscriptions = exportSubscriptions;
    return (
      <SectionCard
        title={`订阅管理 (${currentSubscriptions.length})`}
        className="h-full min-h-0"
        bodyPadding="none"
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
        actions={(
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <span className="rounded border border-kumo-info/20 bg-kumo-info/10 px-1.5 py-0.5 text-[11px] font-semibold text-kumo-info">{visibleNodes.length} 个节点</span>
            <span className="rounded border border-kumo-badge-purple/20 bg-kumo-badge-purple/10 px-1.5 py-0.5 text-[11px] font-semibold text-kumo-badge-purple">{currentSubscriptions.length} 个订阅</span>
            <Button size="sm" variant="primary" onClick={() => openCreateSubscription()} disabled={plans.length === 0}><Plus className="h-3.5 w-3.5" />生成订阅</Button>
          </div>
        )}
      >
        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
          <AppTable layout="fixed" widths={[320, 130, 240, 130, 180]}>
            <Table.Header sticky variant="compact">
              <Table.Row>
                <Table.Head>订阅链接</Table.Head>
                <Table.Head className="text-center">状态</Table.Head>
                <Table.Head>流量</Table.Head>
                <Table.Head>访问</Table.Head>
                <Table.Head className="text-center">操作</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {currentSubscriptions.map((sub) => {
                const [label, variant] = statusLabel(sub);
                const used = (sub.traffic?.upload || 0) + (sub.traffic?.download || 0);
                const link = subscriptionURL(publicBase, sub);
                return (
                  <Table.Row key={sub.id} onDoubleClick={() => openEditSubscription(sub)} className="cursor-pointer">
                    <Table.Cell>
                      <div className="truncate text-sm font-semibold text-kumo-strong">{sub.name}</div>
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                        <span className="rounded border border-kumo-info/20 bg-kumo-info/10 px-1.5 py-0.5 text-[10px] font-semibold text-kumo-info">{sub.node_count || 0} 个节点</span>
                        <Badge variant="secondary">{plans.find((plan) => plan.id === sub.plan_id)?.name || '未绑定套餐'}</Badge>
                        <span className="truncate font-mono text-[10px] text-kumo-subtle" title={sub.id}>{sub.id}</span>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="text-center">
                      <Badge variant={variant} appearance="dot">{label}</Badge>
                      <div className="mt-1 text-[11px] text-kumo-subtle">{sub.expire_at ? `过期 ${sub.expire_at}` : '不过期'}</div>
                    </Table.Cell>
                    <Table.Cell>
                      <Meter
                        label="流量"
                        value={Math.min(100, sub.traffic?.percent || 0)}
                        customValue={`${formatBytes(used)} / ${sub.traffic?.total ? formatBytes(sub.traffic.total) : '无限制'}`}
                      />
                    </Table.Cell>
                    <Table.Cell>
                      <div className="text-xs font-semibold text-kumo-strong">{sub.access_count_today || 0} 次</div>
                      <div className="mt-1 text-[11px] text-kumo-subtle">{formatTime(sub.last_access_at)}</div>
                    </Table.Cell>
                    <Table.Cell className="text-center">
                      <div className="inline-flex items-center justify-center gap-2">
                        <Button size="sm" shape="square" variant="secondary" aria-label="复制订阅链接" title="复制订阅链接" onClick={() => copyText(link, '订阅链接已复制')} icon={<Copy className="h-3.5 w-3.5" />} />
                        <Button size="sm" shape="square" variant="secondary" aria-label="编辑订阅链接" title="编辑订阅链接" onClick={() => openEditSubscription(sub)} icon={<Edit className="h-3.5 w-3.5" />} />
                        <Button size="sm" shape="square" variant="secondary" aria-label="重置链接" title="重置链接" onClick={() => resetToken(sub)} icon={<RefreshCw className="h-3.5 w-3.5" />} />
                        <Button size="sm" shape="square" variant="secondary-destructive" aria-label="删除订阅链接" title="删除订阅链接" onClick={() => deleteSubscription(sub)} icon={<Trash className="h-3.5 w-3.5" />} />
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
              {currentSubscriptions.length === 0 && (
                <Table.Row><Table.Cell colSpan={5} className="p-8 text-center text-kumo-subtle">暂无订阅。请先创建套餐，再生成订阅。</Table.Cell></Table.Row>
              )}
            </Table.Body>
          </AppTable>
        </div>
      </SectionCard>
    );
  };

  const renderPlans = () => (
    <SectionCard title={`套餐管理 (${plans.length})`} className="h-full min-h-0" bodyPadding="none" bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden" actions={<Button size="sm" variant="primary" onClick={openCreatePlan}><Plus className="h-3.5 w-3.5" />新建套餐</Button>}>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <AppTable layout="fixed" widths={[260, 180, 160, 180, 120, 132]}>
          <Table.Header sticky variant="compact"><Table.Row><Table.Head>套餐</Table.Head><Table.Head>总额度</Table.Head><Table.Head className="text-center">重置</Table.Head><Table.Head>节点范围</Table.Head><Table.Head className="text-center">订阅</Table.Head><Table.Head className="text-center">操作</Table.Head></Table.Row></Table.Header>
          <Table.Body>
            {plans.map((plan) => <Table.Row key={plan.id} onDoubleClick={() => openEditPlan(plan)} className="cursor-pointer">
              <Table.Cell><div className="font-semibold text-kumo-strong">{plan.name}</div><div className="mt-1 truncate text-[11px] text-kumo-subtle">{plan.remark || plan.id}</div></Table.Cell>
              <Table.Cell>{plan.total_bytes > 0 ? formatBytes(plan.total_bytes) : '不限'}</Table.Cell>
              <Table.Cell className="text-center">{plan.cycle_type === 'monthly' ? `每月 ${plan.cycle_day} 日` : plan.cycle_type === 'custom' ? '自定义' : '不重置'}</Table.Cell>
              <Table.Cell><div className="flex flex-wrap gap-1"><Badge variant="info">内部 {plan.node_ids?.filter((id) => internalNodes.some((node) => node.id === id)).length || (plan.include_internal_nodes ? internalNodes.length : 0)}</Badge>{plan.include_external_nodes && <Badge variant="secondary">外部节点不计量</Badge>}</div></Table.Cell>
              <Table.Cell className="text-center">{plan.subscription_count || 0}</Table.Cell>
              <Table.Cell className="text-center"><div className="inline-flex justify-center gap-2"><Button size="sm" shape="square" variant="secondary" onClick={() => openEditPlan(plan)} icon={<Edit className="h-3.5 w-3.5" />} aria-label="编辑套餐" /><Button size="sm" shape="square" variant="secondary-destructive" onClick={() => deletePlan(plan)} icon={<Trash className="h-3.5 w-3.5" />} aria-label="删除套餐" /></div></Table.Cell>
            </Table.Row>)}
            {plans.length === 0 && <Table.Row><Table.Cell colSpan={6} className="p-8 text-center text-kumo-subtle">暂无套餐。套餐统一定义节点范围、额度和重置规则。</Table.Cell></Table.Row>}
          </Table.Body>
        </AppTable>
      </div>
    </SectionCard>
  );

  const renderNodes = () => (
    <div className="grid min-h-0 gap-3 lg:grid-rows-[auto_minmax(0,1fr)]">
    <SectionCard
      title={`本机节点 (${internalNodes.length})`}
      className="min-h-0 max-h-[22rem]"
      bodyPadding="none"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      actions={<Button size="sm" variant="primary" disabled={servers.length === 0} onClick={() => startInternalDeployment()}><Plus className="h-3.5 w-3.5" />部署节点</Button>}
    >
      <DataTableFrame variant="embedded" className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <AppTable layout="fixed" widths={[92, 248, 104, 280, 172, 144]}>
          <Table.Header sticky variant="compact"><Table.Row><Table.Head className="text-center">状态</Table.Head><Table.Head>节点名称</Table.Head><Table.Head className="text-center">类型</Table.Head><Table.Head>连接</Table.Head><Table.Head>主机 / 延迟</Table.Head><Table.Head className="text-center">操作</Table.Head></Table.Row></Table.Header>
          <Table.Body>
            {internalNodes.map((node) => {
              const server = servers.find((item) => item.id === node.server_id);
              const protocol = node.protocol === 'vless-reality' ? 'vless' : node.protocol;
              const connectionTags = [node.transport, node.protocol === 'vless-reality' ? 'reality' : 'tls', node.runtime].filter(Boolean);
              return <Table.Row key={node.id} onDoubleClick={() => openEditInternalNode(node)} className="cursor-pointer">
                <Table.Cell className="text-center"><Switch size="sm" aria-label={node.enabled ? '停用内部节点' : '启用内部节点'} checked={!!node.enabled} onCheckedChange={(checked) => toggleInternalNodeEnabled(node, checked)} /></Table.Cell>
                <Table.Cell><div className="truncate text-sm font-bold text-kumo-strong">{node.name}</div><div className="mt-1 flex flex-wrap gap-1"><Badge variant="success">自有</Badge><Badge variant="info">Agent 托管</Badge><Badge variant={node.publishable ? 'success' : node.apply_status === 'failed' ? 'destructive' : 'warning'}>{node.publishable ? '可发布' : node.apply_status === 'failed' ? '部署失败' : '同步中'}</Badge></div></Table.Cell>
                <Table.Cell className="text-center"><Badge variant={nodeTypeBadgeVariant(protocol)} className="uppercase">{node.protocol === 'vless-reality' ? 'VLESS' : 'HYSTERIA2'}</Badge></Table.Cell>
                <Table.Cell><div className="truncate font-mono text-xs text-kumo-strong">{node.public_host || '-'}:{node.assigned_port || '-'}</div><div className="mt-1 flex min-w-0 flex-wrap gap-1">{connectionTags.map((tag) => <span key={tag} className={`inline-flex rounded-[3px] border px-1.5 py-0.5 font-mono text-[10px] leading-4 ${nodeNetworkTagClass({ key: tag === 'tls' ? 'tls' : 'network', tone: tag })}`}>{tag}</span>)}</div></Table.Cell>
                <Table.Cell><div className="flex min-w-0 flex-col items-start gap-1"><span className="inline-flex max-w-full rounded-[3px] border border-kumo-info/25 bg-kumo-info/10 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-kumo-info"><span className="truncate">{server?.name || node.server_name || node.server_id}</span></span><span className={`inline-flex rounded-[3px] border px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${latencyChipClass(0)}`}>{server?.status === 'online' ? '等待节点延迟' : '主机离线'}</span></div></Table.Cell>
                <Table.Cell className="text-center"><div className="inline-flex items-center justify-center gap-2"><Button size="sm" shape="square" variant="secondary" aria-label={`编辑 ${node.name}`} title={`编辑 ${node.name}`} onClick={() => openEditInternalNode(node)} icon={<Edit className="h-3.5 w-3.5" />} /><Button size="sm" shape="square" variant="secondary" aria-label={`同步 ${node.name}`} title={`同步 ${node.name}`} onClick={() => reconcileInternalNode(node)} icon={<RefreshCw className="h-3.5 w-3.5" />} /><Button size="sm" shape="square" variant="secondary-destructive" aria-label={`卸载 ${node.name}`} title={`卸载 ${node.name}`} onDoubleClick={() => deleteInternalNode(node)} icon={<Trash className="h-3.5 w-3.5" />} /></div></Table.Cell>
              </Table.Row>;
            })}
            {internalNodes.length === 0 && <Table.Row><Table.Cell colSpan={6} className="p-6 text-center text-kumo-subtle">暂无本机节点。请先选择 Linux 主机部署节点。</Table.Cell></Table.Row>}
          </Table.Body>
        </AppTable>
      </DataTableFrame>
    </SectionCard>
    <SectionCard
      title={`节点列表 (${filteredNodes.length})`}
      className="h-full min-h-0"
      headerClassName="flex-wrap items-center gap-y-2 [&>div:last-child]:ml-0 [&>div:last-child]:w-full [&>div:last-child]:justify-start sm:[&>div:last-child]:ml-auto sm:[&>div:last-child]:w-auto sm:[&>div:last-child]:justify-end"
      bodyPadding="none"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      actions={(
        <div className="flex w-full min-w-0 flex-wrap items-center justify-start gap-2 sm:justify-end">
          <Tabs
            {...TOOL_TABS_PROPS}
            value={protocolFilter}
            onValueChange={(value) => setProtocolFilter(String(value))}
            tabs={protocolItems}
            className="min-w-0 w-full sm:w-auto sm:max-w-full sm:flex-1 md:flex-none"
            listClassName="max-w-full"
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
          <Button size="sm" variant="secondary" onClick={() => selectedNodeLibrary && refreshProfileUpstream(selectedNodeLibrary)} disabled={!selectedNodeLibrary?.upstream_url}>
            <RefreshCw className="h-3.5 w-3.5" />
            拉取来源
          </Button>
          <Button size="sm" variant="primary" onClick={() => openImportModal()} disabled={nodeLibraryItems.length === 0} aria-label="导入外部节点" title="导入外部节点"><Download className="h-3.5 w-3.5" />导入外部节点</Button>
        </div>
      )}
    >
      <DataTableFrame variant="embedded" className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <AppTable layout="fixed" widths={[92, 248, 104, 280, 172, 144]}>
          <Table.Header sticky variant="compact">
            <Table.Row>
              <Table.Head className="text-center">状态</Table.Head>
              <Table.Head>节点名称</Table.Head>
              <Table.Head className="text-center">类型</Table.Head>
              <Table.Head>连接</Table.Head>
              <Table.Head>主机 / 延迟</Table.Head>
              <Table.Head className="text-center">操作</Table.Head>
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
                  <Table.Cell>
                    <div className="flex min-w-0 items-center gap-2">
                      <NodeFlag node={node} />
                      {node.stable && <Star className="h-3.5 w-3.5 text-kumo-warning" />}
                      <span className="truncate text-sm font-bold text-kumo-strong">{node.name}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant={node.ownership === 'self' ? 'success' : 'secondary'}>{node.ownership === 'self' ? '自有' : '外部'}</Badge>
                      <Badge variant={node.management === 'agent' ? 'info' : 'secondary'}>{node.management === 'agent' ? 'Agent 托管' : '未托管'}</Badge>
                    </div>
                  </Table.Cell>
                  <Table.Cell className="text-center">
                    <div className="flex flex-wrap items-center justify-center gap-1">
                      <Badge variant={nodeTypeBadgeVariant(node.type)} className="uppercase">{node.type || '-'}</Badge>
                      {node.stable && <Badge variant="success">稳定</Badge>}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="truncate font-mono text-xs text-kumo-strong">{nodeEndpoint(node)}</div>
                    <div className="mt-1 flex min-w-0 flex-wrap gap-1">
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
                  <Table.Cell>
                    <NodeHostQuality node={node} serverNameById={serverNameById} />
                  </Table.Cell>
                  <Table.Cell className="text-center">
                    <div className="inline-flex items-center justify-center gap-2">
                      <Button size="sm" shape="square" variant="secondary" aria-label="编辑节点" title="编辑节点" onClick={() => openEditNode(node)} icon={<Edit className="h-3.5 w-3.5" />} />
                      <Button
                        size="sm"
                        shape="square"
                        variant="secondary-destructive"
                        aria-label="双击删除节点"
                        title="双击删除节点"
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          deleteNode(node);
                        }}
                        icon={<Trash className="h-3.5 w-3.5" />}
                      />
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
    </SectionCard></div>
  );

  const renderInstanceManagement = () => (
    <SectionCard
      title={`Linux 主机 (${servers.length})`}
      className="min-h-0"
      bodyPadding="none"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      actions={<Button size="sm" variant="primary" disabled={selectedInternalHosts.size === 0} onClick={() => startInternalDeployment()}><Plus className="h-3.5 w-3.5" />批量部署 ({selectedInternalHosts.size})</Button>}
    >
      <DataTableFrame variant="embedded" className="max-h-[calc(100dvh-15rem)] min-h-0 overflow-auto scrollbar-thin">
        <AppTable layout="fixed" widths={[48, 104, 220, 120, 90, 140, 200, 150, 120]} className="text-xs [&_td]:border-kumo-interact/45 [&_th]:border-kumo-interact/50">
          <Table.Header sticky variant="compact">
            <Table.Row>
              <Table.CheckHead checked={servers.length > 0 && selectedInternalHosts.size === servers.length} indeterminate={selectedInternalHosts.size > 0 && selectedInternalHosts.size < servers.length} onCheckedChange={(checked) => setSelectedInternalHosts(checked ? new Set(servers.map((server) => server.id)) : new Set())} />
              <Table.Head className="text-center">状态</Table.Head>
              <Table.Head className="text-left">名称</Table.Head>
              <Table.Head className="text-center">位置</Table.Head>
              <Table.Head className="text-center">在线</Table.Head>
              <Table.Head className="text-center">Agent 版本</Table.Head>
              <Table.Head className="text-center">代理服务</Table.Head>
              <Table.Head className="text-center">节点类型</Table.Head>
              <Table.Head className="text-center">操作</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {servers.map((server) => {
              const managed = internalNodes.filter((node) => node.server_id === server.id);
              const running = managed.filter((node) => node.publishable && node.apply_status === 'running');
              const countryCode = getInstanceCountryCode(server);
              const locationLabel = getInstanceLocationLabel(server);
              return (
                <Table.Row key={server.id}>
                  <Table.CheckCell checked={selectedInternalHosts.has(server.id)} onCheckedChange={(checked) => toggleInternalHost(server.id, checked)} />
                  <Table.Cell className="text-center"><Badge variant={server.status === 'online' ? 'success' : server.status === 'offline' ? 'destructive' : 'secondary'} appearance="dot">{server.status === 'online' ? '在线' : server.status === 'offline' ? '离线' : '未知'}</Badge></Table.Cell>
                  <Table.Cell><div className="flex min-w-0 items-center gap-2"><i className={getOSIconClass(getServerPlatformLabel(server), { offline: server.status !== 'online' })} title={getServerPlatformLabel(server) || 'Linux'} /><span className={`truncate font-bold ${server.status === 'online' ? 'text-kumo-strong' : 'text-kumo-subtle'}`} title={server.name}>{server.name}</span></div></Table.Cell>
                  <Table.Cell className="text-center"><div className="mx-auto flex w-[64px] items-center justify-center gap-1.5">{countryCode && <CountryFlag preferSvg countryCode={countryCode} className="h-3.5 w-5 shrink-0 !rounded-[2px] text-sm" />}<span className="truncate font-semibold uppercase text-kumo-strong" title={server.location || locationLabel}>{locationLabel}</span></div></Table.Cell>
                  <Table.Cell className="text-center"><span className="font-semibold tabular-nums text-kumo-strong">{formatInstanceUptime(server.uptime)}</span></Table.Cell>
                  <Table.Cell className="text-center"><span className="font-mono text-xs">{server.agent_version && server.agent_version !== '<nil>' ? server.agent_version : '未报告'}</span></Table.Cell>
                  <Table.Cell className="text-center">{managed.length > 0 ? <div className="inline-flex flex-col items-center gap-1"><Badge variant={running.length > 0 ? 'success' : 'warning'}>{running.length > 0 ? 'sing-box 1.13.14' : managed.some((node) => node.apply_status === 'failed') ? '部署失败' : '部署中'}</Badge>{managed.find((node) => node.apply_status === 'failed')?.last_error && <span className="max-w-40 truncate text-[10px] text-kumo-danger" title={managed.find((node) => node.apply_status === 'failed')?.last_error}>查看错误后重新部署</span>}</div> : <Badge variant="secondary">未部署</Badge>}</Table.Cell>
                  <Table.Cell className="text-center"><div className="flex flex-wrap justify-center gap-1">{managed.map((node) => <Badge key={node.id} variant={node.protocol === 'hysteria2' ? 'orange' : 'blue'}>{node.protocol === 'hysteria2' ? 'HY2' : 'VLESS'}</Badge>)}{managed.length === 0 && <span className="text-xs text-kumo-subtle">—</span>}</div></Table.Cell>
                  <Table.Cell className="text-center"><div className="inline-flex items-center justify-center gap-2">{managed.length === 0 ? <Button size="sm" variant="secondary" onClick={() => startInternalDeployment(server.id)} disabled={server.status !== 'online'}>部署节点</Button> : <><Button size="sm" variant="secondary" onClick={() => reconcileInternalNodes(managed)} disabled={server.status !== 'online' || saving}>重新部署</Button><Button size="sm" variant="secondary-destructive" onClick={() => uninstallInternalNodes(server, managed)} disabled={saving}>卸载</Button></>}</div></Table.Cell>
                </Table.Row>
              );
            })}
            {servers.length === 0 && <Table.Row><Table.Cell colSpan={9} className="p-6 text-center text-kumo-subtle">没有可管理的 Linux 主机。请先在主机实例中部署 Agent。</Table.Cell></Table.Row>}
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
              <Table.Head className="text-center">状态 / 操作</Table.Head>
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
                <Button size="sm" shape="square" variant="secondary" onClick={() => openEditTemplate(tpl)} aria-label="编辑模板" title="编辑模板" icon={<Edit className="h-3.5 w-3.5" />} />
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
    <PageStack>
      <PageToolbar>
        <Tabs
          {...MODULE_TABS_PROPS}
          value={activeTab}
          onValueChange={(value) => setActiveTab(String(value))}
          tabs={[
            { value: 'instances', label: '实例管理' },
            { value: 'nodes', label: '节点管理' },
            { value: 'plans', label: '套餐管理' },
            { value: 'subscriptions', label: '订阅管理' },
          ]}
        />
      </PageToolbar>

      <div className="min-w-0">
        {loading && nodeLibraries.length === 0 ? renderNodesSkeleton() : (
          <div className="min-w-0">
            {activeTab === 'nodes' && renderNodes()}
            {activeTab === 'instances' && renderInstanceManagement()}
            {activeTab === 'plans' && renderPlans()}
            {activeTab === 'subscriptions' && renderSubscriptions()}
          </div>
        )}
      </div>

      <Dialog.Root open={planModalOpen} onOpenChange={setPlanModalOpen}>
        <Dialog size="lg" className="flex max-h-[min(calc(100dvh-2rem),48rem)] w-[calc(100vw-1rem)] max-w-[min(76rem,calc(100vw-2rem))] flex-col overflow-hidden p-0">
          <div className="border-b border-kumo-line px-5 py-4"><Dialog.Title>{editingPlanId ? '编辑套餐' : '新建套餐'}</Dialog.Title><Dialog.Description>统一定义订阅额度、重置规则和可使用节点。</Dialog.Description></div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 scrollbar-thin">
            <div className="grid gap-3 sm:grid-cols-2"><Input size="sm" label="套餐名称" value={planForm.name} onChange={(e) => setPlanForm((prev) => ({ ...prev, name: e.target.value }))} /><Input size="sm" label="备注" value={planForm.remark} onChange={(e) => setPlanForm((prev) => ({ ...prev, remark: e.target.value }))} /></div>
            <div className="grid items-end gap-3 md:grid-cols-[minmax(16rem,1.2fr)_minmax(12rem,.8fr)_minmax(10rem,.7fr)]"><TrafficSizeInput label="订阅总额度（0 为不限）" value={planForm.total_bytes} onChange={(value) => setPlanForm((prev) => ({ ...prev, total_bytes: value }))} /><Select size="sm" label="重置周期" value={planForm.cycle_type} onValueChange={(value) => setPlanForm((prev) => ({ ...prev, cycle_type: String(value) }))} items={[{ value: 'monthly', label: '每月重置' }, { value: 'none', label: '不重置' }]} /><Input size="sm" label="每月重置日" type="number" min="1" max="31" value={planForm.cycle_day} disabled={planForm.cycle_type !== 'monthly'} onChange={(e) => setPlanForm((prev) => ({ ...prev, cycle_day: Number(e.target.value) || 1 }))} /></div>
            <div className="grid items-end gap-3 md:grid-cols-[minmax(18rem,1fr)_auto]"><Input size="sm" label="订阅请求限制（次/分钟）" type="number" min="1" value={planForm.rate_limit_per_minute} onChange={(e) => setPlanForm((prev) => ({ ...prev, rate_limit_per_minute: Number(e.target.value) || 30 }))} /><div className="flex min-h-8 flex-wrap items-center gap-x-6 gap-y-2"><Switch size="sm" label="启用套餐" checked={planForm.enabled} onCheckedChange={(checked) => setPlanForm((prev) => ({ ...prev, enabled: checked }))} /><Switch size="sm" label="启用请求限制" checked={planForm.rate_limit_enabled} onCheckedChange={(checked) => setPlanForm((prev) => ({ ...prev, rate_limit_enabled: checked }))} /></div></div>
            <div className="border-t border-kumo-line pt-4">
              <div className="mb-2 flex flex-wrap items-end justify-between gap-2"><div className="flex flex-wrap items-end gap-2"><div><Label className="text-xs font-semibold text-kumo-subtle">套餐节点</Label><div className="mt-1 text-[11px] text-kumo-subtle">类型与来源筛选同时生效</div></div><Select size="sm" aria-label="节点类型筛选" value={planNodeTypeFilter} onValueChange={(value) => setPlanNodeTypeFilter(String(value))} items={planNodeTypeItems} className="w-36" /><Select size="sm" aria-label="节点来源筛选" value={planNodeSourceFilter} onValueChange={(value) => setPlanNodeSourceFilter(String(value))} items={[{ value: 'all', label: '全部来源' }, { value: 'internal', label: 'Agent 节点' }, { value: 'external', label: '外部节点' }]} className="w-36" /></div><div className="flex items-center gap-2"><Badge variant="secondary">已选 {planForm.node_ids.length}</Badge><Button size="sm" variant="secondary" disabled={visiblePlanNodeIDs.length === 0} onClick={() => setPlanForm((prev) => ({ ...prev, node_ids: allVisiblePlanNodesSelected ? prev.node_ids.filter((id) => !visiblePlanNodeIDs.includes(id)) : [...new Set([...prev.node_ids, ...visiblePlanNodeIDs])], include_internal_nodes: !allVisiblePlanNodesSelected && visiblePlanNodes.some((node) => node.source_group === 'internal') ? true : prev.include_internal_nodes, include_external_nodes: !allVisiblePlanNodesSelected && visiblePlanNodes.some((node) => node.source_group === 'external') ? true : prev.include_external_nodes }))}>{allVisiblePlanNodesSelected ? '取消当前全部' : '全选当前结果'}</Button></div></div>
              <div className="max-h-72 overflow-auto rounded-md border border-kumo-line p-2 scrollbar-thin"><div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">{visiblePlanNodes.map((node) => <label key={`${node.source_group}-${node.id}`} className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 hover:bg-kumo-recessed"><Checkbox checked={planForm.node_ids.includes(node.id)} onCheckedChange={(checked) => setPlanForm((prev) => ({ ...prev, node_ids: checked ? [...new Set([...prev.node_ids, node.id])] : prev.node_ids.filter((id) => id !== node.id), include_internal_nodes: checked && node.source_group === 'internal' ? true : prev.include_internal_nodes, include_external_nodes: checked && node.source_group === 'external' ? true : prev.include_external_nodes }))} /><span className="min-w-0 flex-1 truncate text-xs font-semibold">{node.name}</span><Badge variant={node.source_group === 'internal' ? 'info' : 'secondary'}>{node.source_group === 'internal' ? 'Agent' : '外部'}</Badge><Badge variant={nodeTypeBadgeVariant(node.display_type)}>{node.display_type || '-'}</Badge></label>)}{visiblePlanNodes.length === 0 && <div className="p-5 text-center text-xs text-kumo-subtle sm:col-span-2 lg:col-span-3">没有符合类型与来源条件的节点</div>}</div></div><div className="mt-2 text-[11px] text-kumo-subtle">内部节点纳入 Agent 计量；外部节点仅参与分发，不统计流量或执行额度限制。</div>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3"><Dialog.Close render={(props) => <Button size="sm" variant="secondary" {...props}>取消</Button>} /><Button size="sm" variant="primary" loading={saving} onClick={savePlan}><Save className="h-3.5 w-3.5" />保存套餐</Button></div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={internalNodeModalOpen} onOpenChange={setInternalNodeModalOpen}>
        <Dialog size="lg" className="w-[calc(100vw-1rem)] max-w-3xl p-0">
          <div className="border-b border-kumo-line px-5 py-4"><Dialog.Title>{editingInternalNodeId ? '编辑内部节点' : '部署内部节点'}</Dialog.Title><Dialog.Description>{editingInternalNodeId ? '节点名称可以独立修改，实例、协议和连接参数仍由 Agent 自动管理。' : '面板通过已安装的主机 Agent 自动安装 sing-box、分配端口并发布订阅连接。'}</Dialog.Description></div>
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            {!editingInternalNodeId && <div className="sm:col-span-2">
              <div className="flex items-center justify-between gap-2"><Label className="text-xs font-semibold text-kumo-subtle">目标实例</Label><Badge variant="secondary">已选 {selectedInternalHosts.size} / {servers.length}</Badge></div>
              <div className="mt-1.5 max-h-44 overflow-auto rounded-md border border-kumo-line bg-kumo-recessed/20 p-1.5 scrollbar-thin">
                <div className="grid gap-1 sm:grid-cols-2">
                  {servers.map((server) => {
                    const checked = selectedInternalHosts.has(server.id);
                    return <label key={server.id} className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 hover:bg-kumo-base/60"><Checkbox checked={checked} disabled={server.status !== 'online'} onCheckedChange={(value) => { const next = new Set(selectedInternalHosts); if (value) next.add(server.id); else next.delete(server.id); setSelectedInternalHosts(next); const first = [...next][0] || ''; setInternalNodeForm((prev) => ({ ...prev, server_id: first, public_host: servers.find((item) => item.id === first)?.host || '' })); }} aria-label={`选择 ${server.name}`} /><span className="min-w-0 flex-1 truncate text-xs font-semibold text-kumo-strong">{server.name}</span><Badge variant={server.status === 'online' ? 'success' : 'secondary'} appearance="dot">{server.status === 'online' ? '在线' : '离线'}</Badge></label>;
                  })}
                  {servers.length === 0 && <div className="p-3 text-center text-xs text-kumo-subtle sm:col-span-2">暂无 Linux 实例</div>}
                </div>
              </div>
            </div>}
            <Select size="sm" label="节点协议" disabled={!!editingInternalNodeId} value={internalNodeForm.protocol} onValueChange={(value) => setInternalNodeForm((prev) => ({ ...prev, protocol: String(value) }))} items={[{ value: 'vless-reality', label: 'VLESS REALITY' }, { value: 'hysteria2', label: 'Hysteria2' }]} />
            <Input size="sm" label={editingInternalNodeId ? '节点名称' : selectedInternalHosts.size > 1 ? '节点名称前缀（可选）' : '节点名称（可选）'} placeholder="留空则自动添加国家图标并按实例名称生成" value={internalNodeForm.name} onChange={(event) => setInternalNodeForm((prev) => ({ ...prev, name: event.target.value }))} />
            {!editingInternalNodeId && internalNodeForm.protocol === 'vless-reality' && <Input size="sm" label="REALITY 握手站点（可选）" placeholder="默认 www.cloudflare.com" value={internalNodeForm.server_name} onChange={(event) => setInternalNodeForm((prev) => ({ ...prev, server_name: event.target.value }))} />}
            {!editingInternalNodeId && internalNodeForm.protocol === 'hysteria2' && <div className="flex min-h-8 items-center rounded-md border border-kumo-line bg-kumo-recessed/25 px-3 text-xs text-kumo-subtle">TLS 证书、私钥、SNI 和端口将自动生成并配置。</div>}
          </div>
          <div className="flex justify-end gap-2 border-t border-kumo-line px-5 py-4"><Button size="sm" variant="secondary" onClick={() => setInternalNodeModalOpen(false)}>取消</Button><Button size="sm" variant="primary" loading={saving} onClick={editingInternalNodeId ? saveInternalNode : createInternalNode}>{editingInternalNodeId ? '保存' : '部署节点'}</Button></div>
        </Dialog>
      </Dialog.Root>

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

            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3 sm:justify-end">
              <Dialog.Close render={(props) => <Button size="sm" variant="secondary" {...props}>取消</Button>} />
              <Button size="sm" variant="primary" loading={saving} onClick={saveProfile}><Save className="h-3.5 w-3.5" />保存节点库</Button>
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
                <Dialog.Description className="mt-0.5 truncate text-xs text-kumo-subtle">配置订阅包含的节点、额度与访问策略。</Dialog.Description>
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
                    <div className="min-w-0"><Select size="sm" label="套餐" value={subscriptionForm.plan_id || ''} onValueChange={(value) => setSubscriptionForm((prev) => ({ ...prev, plan_id: String(value) }))} items={planItems} className="w-full min-w-0" /></div>
                  </div>
                </section>

                <section className="space-y-3 border-t border-kumo-line pt-4">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">周期与限制</div>
                  <div className="grid min-w-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(12rem,100%),1fr))]">
                    <div className="min-w-0">
                      <Input size="sm" label="过期日期" type="date" value={subscriptionForm.expire_at || ''} onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, expire_at: e.target.value }))} className="w-full min-w-0" />
                    </div>
                    <div className="flex items-end text-xs text-kumo-subtle">额度、节点范围、重置周期及请求限制均由套餐统一管理。</div>
                  </div>
                </section>

                <section className="space-y-3 border-t border-kumo-line pt-4">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    <Switch size="sm" label="启用链接" controlFirst={false} checked={!!subscriptionForm.enabled} onCheckedChange={(checked) => setSubscriptionForm((prev) => ({ ...prev, enabled: checked }))} />
                  </div>
                </section>
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3 sm:justify-end">
              <Dialog.Close render={(props) => <Button size="sm" variant="secondary" {...props}>取消</Button>} />
              <Button size="sm" variant="primary" loading={saving} onClick={saveSubscription}><Save className="h-3.5 w-3.5" />保存</Button>
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
                  <div className="text-[11px] font-bold uppercase tracking-wide text-kumo-subtle">外部节点属性</div>
                  <div className="grid min-w-0 items-end gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr))]">
                    <div className="rounded-md border border-kumo-line bg-kumo-recessed/25 px-3 py-2 text-xs text-kumo-subtle">外部导入 · 未托管 · 不参与可信流量统计</div>
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

            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3 sm:justify-end">
              <Dialog.Close render={(props) => <Button size="sm" variant="secondary" {...props}>取消</Button>} />
              <Button size="sm" variant="primary" loading={saving} onClick={saveNode}><Save className="h-3.5 w-3.5" />保存节点</Button>
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
                  <div className="rounded-md border border-kumo-line bg-kumo-recessed/25 px-3 py-2 text-xs text-kumo-subtle">外部节点导入后直接进入节点管理，不统计流量或应用额度限制。</div>
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

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3 sm:justify-end">
              <Button size="sm" variant="secondary" onClick={previewImport}>预览</Button>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => commitImport(true)}>
                  <Download className="h-3.5 w-3.5" />
                  覆盖导入
                </Button>
                <Button size="sm" variant="primary" onClick={() => commitImport(false)}>
                  <Download className="h-3.5 w-3.5" />
                  追加导入
                </Button>
              </div>
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
                <TemplateCodeEditor label="模板内容" value={templateForm.content} format={templateForm.format} onChange={(e) => setTemplateForm((prev) => ({ ...prev, content: e.target.value }))} />
                <Input size="sm" label="描述" value={templateForm.description} onChange={(e) => setTemplateForm((prev) => ({ ...prev, description: e.target.value }))} />
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3 sm:justify-end">
              <Dialog.Close render={(props) => <Button size="sm" variant="secondary" {...props}>取消</Button>} />
              <Button size="sm" variant="primary" loading={saving} onClick={saveTemplate}><Save className="h-3.5 w-3.5" />保存模板</Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </PageStack>
  );
}

export default SubscriptionPage;
