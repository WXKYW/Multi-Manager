import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { ClipboardText } from '@cloudflare/kumo';
import { Download, FileText, FolderOpen } from '../components/Icons.jsx';
import { SectionCard } from '../components/ui/AppPrimitives.jsx';
import { toast } from '../modules/toast.js';
import { formatDateTime, formatFileSize } from '../modules/utils.js';

function shareCodeFromPath() {
  const match = window.location.pathname.match(/^\/share\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}

function downloadEndpoint(code) {
  return `/api/filebox/public/${encodeURIComponent(code)}/download`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'filebox-download';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function formatExpiry(value) {
  return Number(value) === 0 ? '永久有效' : formatDateTime(value);
}

function PublicSharePage() {
  const code = useMemo(shareCodeFromPath, []);
  const [entry, setEntry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [password, setPassword] = useState('');
  const [textPreview, setTextPreview] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await axios.get(`/api/filebox/public/${encodeURIComponent(code)}`);
        if (!cancelled) setEntry(res.data?.data || null);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || '分享不存在或已过期');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (code) load();
    else {
      setLoading(false);
      setError('分享码无效');
    }
    return () => {
      cancelled = true;
    };
  }, [code]);

  const fetchContent = async () => {
    if (!entry) return;
    setDownloading(true);
    setError('');
    try {
      const res = await axios.get(downloadEndpoint(entry.code), {
        responseType: 'blob',
        headers: password ? { 'X-Filebox-Password': password } : {},
      });
      const filename = entry.originalName || entry.filename || (entry.type === 'text' ? `${entry.code}.txt` : 'download');
      if (entry.type === 'text') {
        setTextPreview(await res.data.text());
        toast.success('文本已取回');
      } else {
        saveBlob(res.data, filename);
        toast.success('下载已开始');
      }
    } catch (err) {
      setError(err.response?.status === 403 ? '访问密码错误或缺失' : err.response?.data?.error || '取用失败');
    } finally {
      setDownloading(false);
    }
  };

  const isFile = entry?.type === 'file';
  const title = isFile ? entry?.originalName || entry?.filename || '文件分享' : '文本分享';
  const Icon = isFile ? FolderOpen : FileText;

  return (
    <div className="min-h-screen bg-kumo-canvas p-4 text-kumo-default sm:p-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3 border-b border-kumo-line pb-3">
          <div className="min-w-0">
            <div className="text-base font-bold text-kumo-strong">文件分享</div>
            <div className="mt-1 font-mono text-xs text-kumo-subtle">{code || '-'}</div>
          </div>
          <Badge variant={entry?.requiresPassword ? 'warning' : 'secondary'}>
            {entry?.requiresPassword ? '需要密码' : '公开'}
          </Badge>
        </div>

        <SectionCard title={loading ? '正在读取分享' : title} icon={<Icon className="h-4 w-4 text-kumo-brand" />}>
          {loading ? (
            <div className="py-10 text-center text-sm text-kumo-subtle">读取中</div>
          ) : error && !entry ? (
            <div className="rounded-md border border-kumo-error/30 bg-kumo-error/10 p-4 text-sm font-semibold text-kumo-error">{error}</div>
          ) : (
            <div className="grid gap-4">
              <div className="grid gap-2 rounded-md border border-kumo-line bg-kumo-recessed/30 p-3 text-xs sm:grid-cols-2">
                <div><span className="text-kumo-subtle">类型</span><div className="mt-1 font-semibold text-kumo-strong">{isFile ? '文件' : '文本'}</div></div>
                <div><span className="text-kumo-subtle">大小</span><div className="mt-1 font-semibold text-kumo-strong">{formatFileSize(entry?.size || 0)}</div></div>
                <div><span className="text-kumo-subtle">到期</span><div className="mt-1 font-semibold text-kumo-strong">{formatExpiry(entry?.expiry)}</div></div>
                <div><span className="text-kumo-subtle">下载次数</span><div className="mt-1 font-semibold text-kumo-strong">{entry?.downloads || 0}{entry?.maxDownloads ? ` / ${entry.maxDownloads}` : ' / 不限'}</div></div>
              </div>

              {entry?.preview && !textPreview && (
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-kumo-line bg-kumo-recessed/30 p-3 text-xs text-kumo-strong">{entry.preview}</pre>
              )}

              {entry?.requiresPassword && (
                <Input
                  size="sm"
                  label="访问密码"
                  type="text"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                  spellCheck={false}
                />
              )}

              {error && <div className="rounded-md border border-kumo-error/30 bg-kumo-error/10 p-3 text-xs font-semibold text-kumo-error">{error}</div>}

              {textPreview && (
                <div className="rounded-md border border-kumo-line bg-kumo-base p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold text-kumo-strong">文本内容</div>
                    <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(textPreview).then(() => toast.success('文本已复制'))}>复制</Button>
                  </div>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-kumo-line bg-kumo-recessed/40 p-3 text-xs text-kumo-strong">{textPreview}</pre>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-4">
                <ClipboardText text={window.location.href} tooltip={{ text: '复制链接', copiedText: '链接已复制' }} labels={{ copyAction: '复制链接' }} />
                <Button size="sm" variant="primary" loading={downloading} onClick={fetchContent} icon={<Download className="h-4 w-4" />}>
                  {isFile ? '下载文件' : '查看文本'}
                </Button>
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

export default PublicSharePage;
