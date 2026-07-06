import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Switch } from '@cloudflare/kumo/components/switch';
import { toast } from '../modules/toast.js';
import { Download, FileText, RefreshCw, Search } from '../components/Icons.jsx';
import { SectionCard } from '../components/ui/AppPrimitives.jsx';

const LEVELS = [
  { value: 'all', label: '全部' },
  { value: 'INFO', label: 'INFO' },
  { value: 'WARN', label: 'WARN' },
  { value: 'ERROR', label: 'ERROR' },
  { value: 'DEBUG', label: 'DEBUG' },
];

function authHeaders() {
  return { 'x-admin-password': localStorage.getItem('admin_password') || '' };
}

function levelClass(level) {
  if (level === 'ERROR' || level === 'FATAL') return 'text-red-400';
  if (level === 'WARN') return 'text-amber-300';
  if (level === 'DEBUG') return 'text-cyan-300';
  if (level === 'INFO') return 'text-emerald-300';
  return 'text-zinc-300';
}

function formatLogTime(value) {
  if (!value) return '--:--:--';
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }
  const match = String(value).match(/T?(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : String(value).slice(0, 8);
}

function parseRawLog(line) {
  const raw = line.raw || '';
  const match = raw.match(/^(\[[^\]]+\])\s+(\S+)\s+\[([A-Z]+)\]\s+\[([^\]]+)\]\s*(.*)$/);
  const message = line.message || raw;
  if (!match) {
    return {
      source: raw.match(/^(\[[^\]]+\])/)?.[1] || '[backend]',
      time: formatLogTime(line.time),
      level: line.level || 'RAW',
      module: line.module || '-',
      message: formatDisplayMessage(message),
    };
  }
  return {
    source: match[1],
    time: match[2],
    level: match[3],
    module: match[4],
    message: formatDisplayMessage(match[5]),
  };
}

function formatDisplayMessage(message) {
  return String(message || '')
    .replace(/\s+status=(\d{3})\s+duration=(\d+ms)\b/g, ' - $1 ($2)')
    .replace(/\s+duration=(\d+ms)\b/g, ' ($1)')
    .replace(/\s+status=(\d{3})\b/g, ' - $1');
}

function durationTone(value) {
  const duration = Number(String(value).match(/\d+/)?.[0]);
  if (!Number.isFinite(duration)) return 'text-zinc-200';
  if (duration >= 3000) return 'text-red-400';
  if (duration >= 1000) return 'text-amber-300';
  return 'text-emerald-300';
}

function statusTone(value) {
  const status = Number(String(value).match(/\d{3}/)?.[0]);
  if (!Number.isFinite(status)) return 'text-zinc-200';
  if (status >= 500) return 'text-red-400';
  if (status >= 400) return 'text-amber-300';
  if (status >= 300) return 'text-cyan-300';
  return 'text-emerald-300';
}

function renderMessageParts(message) {
  const text = String(message || '');
  const tokenPattern = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|status=\d{3}|\b\d{3}\b|duration=\d+ms|\(\d+ms\)|\bsession_id=[^\s]+|\bserver_id=[^\s]+/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    let className = 'text-zinc-100';
    if (/^(GET|HEAD|OPTIONS)$/.test(token)) className = 'text-sky-300 font-semibold';
    else if (/^(POST|PUT|PATCH)$/.test(token)) className = 'text-emerald-300 font-semibold';
    else if (/^DELETE$/.test(token)) className = 'text-rose-400 font-semibold';
    else if (/^(status=)?\d{3}$/.test(token)) className = `${statusTone(token)} font-semibold`;
    else if (/^(duration=|\()\d+ms\)?$/.test(token)) className = `${durationTone(token)} font-semibold`;
    else if (/^(session_id|server_id)=/.test(token)) className = 'text-zinc-400';

    parts.push(
      <span key={`${token}-${match.index}`} className={className}>
        {token}
      </span>
    );
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export default function SystemLogsPage() {
  const [level, setLevel] = useState('all');
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState([]);
  const [logPath, setLogPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const logViewportRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '500' });
      if (level !== 'all') params.set('level', level);
      if (query.trim()) params.set('q', query.trim());
      const res = await fetch(`/api/system/logs/stream?${params}`, { headers: authHeaders() });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '载入日志失败');
      setLines(data.data?.lines || []);
      setLogPath(data.data?.path || '');
    } catch (error) {
      toast.error(error.message || '载入日志失败');
    } finally {
      setLoading(false);
    }
  };

  const download = async () => {
    try {
      const res = await fetch('/api/system/logs/download', { headers: authHeaders() });
      if (!res.ok) throw new Error('下载日志失败');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'app.log';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error.message || '下载日志失败');
    }
  };

  useEffect(() => { load(); }, [level]);
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, level, query]);

  const renderedLines = useMemo(() => lines.map(parseRawLog), [lines]);

  useEffect(() => {
    if (!autoScroll || !logViewportRef.current) return;
    logViewportRef.current.scrollTop = logViewportRef.current.scrollHeight;
  }, [autoScroll, renderedLines]);

  return (
    <div className="flex w-full min-w-0 flex-col gap-3 sm:gap-4">
      <SectionCard
        title="系统日志"
        description={logPath || '查看、筛选并下载 Go 后端应用日志。'}
        icon={<FileText className="h-4 w-4 text-kumo-brand" />}
        actions={(
          <>
            <Badge variant="secondary">{lines.length} 条</Badge>
            <label className="flex h-8 items-center gap-2 rounded-md border border-kumo-line bg-kumo-recessed px-2 text-xs text-kumo-subtle">
              <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
              自动刷新
            </label>
            <label className="flex h-8 items-center gap-2 rounded-md border border-kumo-line bg-kumo-recessed px-2 text-xs text-kumo-subtle">
              <Switch checked={autoScroll} onCheckedChange={setAutoScroll} />
              跟随底部
            </label>
            <Button size="sm" variant="secondary" onClick={download} icon={<Download className="h-3.5 w-3.5" />}>下载</Button>
            <Button size="sm" variant="primary" onClick={load} loading={loading} icon={<RefreshCw className="h-3.5 w-3.5" />}>刷新</Button>
          </>
        )}
      >
        <div className="grid gap-3 md:grid-cols-[11rem_minmax(0,1fr)_auto] md:items-end">
          <Select size="sm" label="级别" className="w-full" value={level} onValueChange={setLevel} items={LEVELS} />
          <Input size="sm" label="关键字 / 正则" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && load()} placeholder="输入关键字或正则后回车" />
          <Button size="sm" variant="secondary" onClick={load} icon={<Search className="h-3.5 w-3.5" />}>检索</Button>
        </div>
      </SectionCard>

      <SectionCard
        title={logPath || 'app.log'}
        icon={<FileText className="h-4 w-4 text-kumo-brand" />}
        meta={<span className="text-[10px] font-mono text-kumo-subtle">{lines.length} lines</span>}
        bodyPadding="none"
        bodyClassName="bg-[#08090b] text-zinc-100"
      >
        {lines.length === 0 ? (
          <div className="flex min-h-80 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-zinc-500">
            <FileText className="h-8 w-8" />
            <div className="text-sm font-semibold text-zinc-300">暂无日志</div>
            <div className="text-xs">调整筛选条件或刷新后再查看。</div>
          </div>
        ) : (
          <div ref={logViewportRef} className="max-h-[calc(100vh-19rem)] min-h-[26rem] overflow-auto px-3 py-2 font-mono text-xs leading-5">
            {renderedLines.map((line, index) => (
              <div
                key={`${line.time}-${index}`}
                className="min-w-max whitespace-pre border-b border-white/[0.045] py-0.5 hover:bg-white/[0.06]"
                title={lines[index]?.raw}
              >
                <span className="mr-2 font-semibold text-blue-400">{line.source}</span>
                <span className="mr-2 text-zinc-400">{line.time}</span>
                <span className={`mr-2 font-semibold ${levelClass(line.level)}`}>[{line.level}]</span>
                <span className="mr-2 font-semibold text-sky-300">[{line.module}]</span>
                <span className={lines[index]?.matched ? 'bg-yellow-500/20 text-yellow-100' : 'text-zinc-100'}>
                  {renderMessageParts(line.message)}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
