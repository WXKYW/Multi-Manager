import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Tabs, Badge } from '@cloudflare/kumo';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import useStore from '../store.js';
import { MODULE_TABS_PROPS } from '../modules/kumoTabs.js';
import { toast } from '../modules/toast.js';
import { dialog } from '../modules/dialog.js';
import {
  Plus, Upload, Download, Copy, Trash, FolderOpen,
  Clock, CodeFile, Settings, Image, Save,
} from '../components/Icons.jsx';
import { AlertTriangle } from '../components/IconsCore.jsx';
import { iconButtonIconClass } from '../components/ui/AppPrimitives.jsx';

const API = '/api/drawio';

const TABS = [
  { value: 'editor', label: '主界面' },
  { value: 'library', label: '图库' },
  { value: 'versions', label: '版本' },
  { value: 'settings', label: '设置' },
];

async function apiFetch(path, opts = {}) {
  const headers = {
    ...(useStore.getState().getAuthHeaders?.() || {}),
    ...opts.headers,
  };
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export default function DrawioPage() {
  const [activeTab, setActiveTab] = useState('editor');
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [currentDoc, setCurrentDoc] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftRev, setDraftRev] = useState(0);
  const [saveState, setSaveState] = useState('idle');
  const [dirty, setDirty] = useState(false);
  const [versions, setVersions] = useState([]);
  const [settings, setSettings] = useState(null);
  const [searchQ, setSearchQ] = useState('');
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictData, setConflictData] = useState(null);
  const iframeRef = useRef(null);

  const fetchDocuments = useCallback(async () => {
    try {
      const data = await apiFetch(`/documents?q=${encodeURIComponent(searchQ)}`);
      setDocuments(data.documents || []);
    } catch (e) {
      console.error('Failed to fetch documents:', e);
    } finally {
      setLoading(false);
    }
  }, [searchQ]);

  const fetchDocument = useCallback(async (id) => {
    try {
      const [docData, draftData, verData] = await Promise.all([
        apiFetch(`/documents/${id}`),
        apiFetch(`/documents/${id}/draft`).catch(() => null),
        apiFetch(`/documents/${id}/versions`).catch(() => ({ versions: [] })),
      ]);
      setCurrentDoc(docData.document);
      setDraft(draftData?.draft || null);
      setDraftRev(docData.document?.draft_rev || 1);
      setVersions(verData.versions || []);
    } catch (e) {
      console.error('Failed to fetch document:', e);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await apiFetch('/settings');
      setSettings(data.settings);
    } catch (e) {
      // silent
    }
  }, []);

  useEffect(() => { fetchDocuments(); }, [fetchDocuments]);
  useEffect(() => {
    if (selectedId) fetchDocument(selectedId);
  }, [selectedId, fetchDocument]);

  const handleCreate = async () => {
    try {
      const data = await apiFetch('/documents', {
        method: 'POST',
        body: JSON.stringify({ title: '新建图表', description: '', tags_json: '[]' }),
      });
      toast.success('图表已创建');
      setSelectedId(data.document.id);
      fetchDocuments();
    } catch (e) {
      toast.error('创建失败: ' + e.message);
    }
  };

  const handleSaveDraft = async () => {
    if (saveState === 'saving') return;
    setSaveState('saving');
    try {
      const data = await apiFetch(`/documents/${selectedId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({
          xml_content: draft?.xml_content || '',
          expected_draft_rev: draftRev,
          editor_state_json: '{}',
        }),
      });
      setDraft(data.draft);
      setDraftRev(data.draftRev);
      setDirty(false);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (e) {
      if (e.message.includes('409') || e.message.includes('conflict')) {
        setConflictData({ currentDraftRev: draftRev + 1 });
        setConflictOpen(true);
      } else {
        toast.error('保存失败: ' + e.message);
      }
      setSaveState('error');
    }
  };

  const handleImport = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const data = await apiFetch('/import', {
        method: 'POST',
        body: formData,
        headers: {}, // Let browser set content-type for FormData
      });
      toast.success('导入成功');
      setSelectedId(data.document.id);
      fetchDocuments();
    } catch (e) {
      toast.error('导入失败: ' + e.message);
    }
  };

  const handleDelete = (id) => {
    dialog.deleteResource({
      resourceType: '图表',
      resourceName: documents.find(d => d.id === id)?.title || '图表',
      onDelete: async () => {
        await apiFetch(`/documents/${id}`, { method: 'DELETE' });
        if (selectedId === id) setSelectedId(null);
        fetchDocuments();
      },
    });
  };

  const handleSaveVersion = async () => {
    const summary = prompt('版本备注（可选）:');
    try {
      await apiFetch(`/documents/${selectedId}/versions`, {
        method: 'POST',
        body: JSON.stringify({ summary: summary || '', expected_draft_rev: draftRev }),
      });
      toast.success('版本已保存');
      fetchDocument(selectedId);
    } catch (e) {
      toast.error('保存版本失败: ' + e.message);
    }
  };

  const renderEditor = () => (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-3">
          <Select
            value={String(selectedId || '')}
            onValueChange={(v) => setSelectedId(v ? parseInt(v, 10) : null)}
            aria-label="选择图表"
            renderValue={(v) => documents.find(d => d.id === parseInt(v, 10))?.title || '选择图表'}
          >
            {documents.map(doc => (
              <Select.Option key={doc.id} value={String(doc.id)}>{doc.title}</Select.Option>
            ))}
          </Select>
          <Button type="button" size="sm" variant="primary" icon={<Plus className={iconButtonIconClass} />} onClick={handleCreate}>
            新建
          </Button>
          <label>
            <Button type="button" size="sm" variant="secondary" icon={<Upload className={iconButtonIconClass} />} onClick={() => {}}>
              导入
            </Button>
            <input type="file" accept=".drawio,.xml" className="hidden" onChange={(e) => {
              if (e.target.files?.[0]) handleImport(e.target.files[0]);
              e.target.value = '';
            }} />
          </label>
        </div>
        <div className="flex items-center gap-2">
          {saveState === 'saving' && <Badge variant="warning">保存中…</Badge>}
          {saveState === 'saved' && <Badge variant="success">已保存</Badge>}
          {dirty && <Badge variant="warning">未保存</Badge>}
          <Button type="button" size="sm" variant="primary" onClick={handleSaveDraft} disabled={!dirty}>
            保存
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={handleSaveVersion} icon={<Save className={iconButtonIconClass} />}>
            保存版本
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-kumo-line">
        {selectedId && draft ? (
          <iframe
            ref={iframeRef}
            src={`/vendor/drawio/index.html?embed=1&proto=json`}
            className="h-full w-full border-0"
            title="Draw.io 编辑器"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-kumo-subtle">
            {documents.length === 0 ? '点击"新建"创建第一个图表' : '从上方选择一个图表'}
          </div>
        )}
      </div>
    </div>
  );

  const renderLibrary = () => (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex items-center gap-3">
        <Input
          placeholder="搜索图表…"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          className="max-w-xs"
          aria-label="搜索"
        />
        <Button type="button" size="sm" variant="primary" icon={<Plus className={iconButtonIconClass} />} onClick={handleCreate}>
          新建
        </Button>
        <label>
          <Button type="button" size="sm" variant="secondary" icon={<Upload className={iconButtonIconClass} />} onClick={() => {}}>
            导入
          </Button>
          <input type="file" accept=".drawio,.xml" className="hidden" onChange={(e) => {
            if (e.target.files?.[0]) handleImport(e.target.files[0]);
            e.target.value = '';
          }} />
        </label>
      </div>
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <SkeletonLine key={i} className="h-16 w-full" />)}
        </div>
      ) : documents.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center text-sm text-kumo-subtle">
          暂无图表，点击"新建"开始
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {documents.map(doc => (
            <div
              key={doc.id}
              className={`cursor-pointer rounded-lg border p-3 transition-colors hover:border-kumo-brand/60 ${
                selectedId === doc.id ? 'border-kumo-brand bg-kumo-brand/5' : 'border-kumo-line'
              }`}
              onClick={() => setSelectedId(doc.id)}
            >
              <div className="mb-2 flex items-start justify-between">
                <span className="truncate text-sm font-semibold text-kumo-strong">{doc.title}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  shape="square"
                  aria-label="删除"
                  icon={<Trash className="h-3 w-3" />}
                  onClick={(e) => { e.stopPropagation(); handleDelete(doc.id); }}
                />
              </div>
              <div className="flex items-center gap-2 text-[11px] text-kumo-subtle">
                <Image className="h-3 w-3" />
                <span>{doc.page_count} 页</span>
                <Clock className="h-3 w-3 ml-1" />
                <span>{doc.updated_at?.slice(0, 10)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderVersions = () => (
    <div className="flex flex-1 flex-col gap-3">
      {!selectedId ? (
        <div className="flex min-h-[200px] items-center justify-center text-sm text-kumo-subtle">请先从图库选择一个图表</div>
      ) : versions.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center text-sm text-kumo-subtle">暂无版本记录</div>
      ) : (
        <div className="space-y-2">
          {versions.map(v => (
            <div key={v.id} className="flex items-center justify-between rounded-lg border border-kumo-line px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-kumo-strong">v{v.version_no}</div>
                <div className="text-xs text-kumo-subtle">{v.summary || '无备注'} · {v.created_at?.slice(0, 16)}</div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={async () => {
                  try {
                    await apiFetch(`/documents/${selectedId}/versions/${v.id}/restore`, { method: 'POST' });
                    toast.success('已恢复到草稿');
                    fetchDocument(selectedId);
                  } catch (e) {
                    toast.error('恢复失败: ' + e.message);
                  }
                }}
              >
                恢复
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderSettings = () => (
    <div className="flex flex-1 flex-col gap-4">
      <h3 className="text-sm font-semibold text-kumo-strong">图编辑工具设置</h3>
      {settings ? (
        <div className="max-w-md space-y-3 text-sm text-kumo-subtle">
          <div className="flex justify-between"><span>默认导出格式</span><span className="text-kumo-strong">{settings.default_export_format}</span></div>
          <div className="flex justify-between"><span>自动保存</span><span className="text-kumo-strong">{settings.autosave_enabled ? '启用' : '禁用'}</span></div>
          <div className="flex justify-between"><span>文档大小限制</span><span className="text-kumo-strong">{(settings.document_size_limit_bytes / 1048576).toFixed(1)} MB</span></div>
          <div className="flex justify-between"><span>缩略图格式</span><span className="text-kumo-strong">{settings.thumbnail_format}</span></div>
        </div>
      ) : (
        <SkeletonLine className="h-32 w-full max-w-md" />
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col gap-3 overflow-hidden px-px pt-px sm:gap-4">
      <div className="flex shrink-0 items-center justify-between border-b border-kumo-line pb-3">
        <Tabs {...MODULE_TABS_PROPS} value={activeTab} onValueChange={setActiveTab} tabs={TABS} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === 'editor' && renderEditor()}
        {activeTab === 'library' && renderLibrary()}
        {activeTab === 'versions' && renderVersions()}
        {activeTab === 'settings' && renderSettings()}
      </div>

      {/* Conflict Dialog */}
      <Dialog.Root open={conflictOpen} onOpenChange={setConflictOpen} role="alertdialog">
        <Dialog className="p-6">
          <div className="mb-4 flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 text-kumo-warning" />
            <Dialog.Title className="text-lg font-semibold">编辑冲突</Dialog.Title>
          </div>
          <Dialog.Description className="text-kumo-subtle">
            此图表已被其他会话修改。请选择处理方式：
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close render={(p) => <Button {...p} variant="secondary">取消</Button>} />
            <Button variant="primary" onClick={() => {
              setConflictOpen(false);
              fetchDocument(selectedId);
            }}>
              刷新为最新版本
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
