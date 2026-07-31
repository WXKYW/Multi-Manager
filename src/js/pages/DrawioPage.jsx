import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Empty, Field, LayerCard, Tabs } from '@cloudflare/kumo';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input } from '@cloudflare/kumo/components/input';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import { Select } from '@cloudflare/kumo/components/select';
import { Switch } from '@cloudflare/kumo/components/switch';
import DrawioFrame from '../components/drawio/DrawioFrame.jsx';
import CodeEditor from '../components/ui/CodeEditor.jsx';
import useStore from '../store.js';
import { MODULE_TABS_PROPS } from '../modules/kumoTabs.js';
import { dialog } from '../modules/dialog.js';
import { toast } from '../modules/toast.js';
import { Clock, Copy, Download, Image, Plus, Save, Trash, Upload } from '../components/Icons.jsx';
import { AlertTriangle } from '../components/IconsCore.jsx';
import { iconButtonIconClass } from '../components/ui/AppPrimitives.jsx';

const API = '/api/drawio';
const TABS = [
  { value: 'editor', label: '主界面' },
  { value: 'library', label: '图库' },
  { value: 'settings', label: '设置' },
];

async function apiFetch(path, options = {}) {
  const headers = { ...(useStore.getState().getAuthHeaders?.() || {}), ...options.headers };
  const response = await fetch(`${API}${path}`, { ...options, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return response.json().catch(() => ({}));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function DrawioPage() {
  const theme = useStore(state => state.theme);
  const [activeTab, setActiveTab] = useState('editor');
  const [documents, setDocuments] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [currentDoc, setCurrentDoc] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftRev, setDraftRev] = useState(0);
  const [versions, setVersions] = useState([]);
  const [settings, setSettings] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('idle');
  const [conflictOpen, setConflictOpen] = useState(false);
  const [xmlOpen, setXmlOpen] = useState(false);
  const frameRef = useRef(null);
  const fileRef = useRef(null);
  const xmlSyncTimerRef = useRef(null);

  const loadDocuments = useCallback(async () => {
    try {
      const data = await apiFetch(`/documents?q=${encodeURIComponent(search)}`);
      setDocuments(data.documents || []);
      setSelectedId(current => current || data.documents?.[0]?.id || null);
    } catch (error) {
      toast.error(`图库加载失败：${error.message}`);
    } finally {
      setLoading(false);
    }
  }, [search]);

  const loadDocument = useCallback(async (id) => {
    if (!id) return;
    try {
      const [docData, draftData, versionData] = await Promise.all([
        apiFetch(`/documents/${id}`),
        apiFetch(`/documents/${id}/draft`),
        apiFetch(`/documents/${id}/versions`),
      ]);
      setCurrentDoc(docData.document);
      setDraft(draftData.draft);
      setDraftRev(docData.document.draft_rev);
      setVersions(versionData.versions || []);
      setDirty(false);
      setSaveState('idle');
    } catch (error) {
      toast.error(`图表加载失败：${error.message}`);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const data = await apiFetch('/settings');
      setSettings(data.settings);
    } catch (error) {
      toast.error(`设置加载失败：${error.message}`);
    }
  }, []);

  useEffect(() => { loadDocuments(); }, [loadDocuments]);
  useEffect(() => { loadDocument(selectedId); }, [loadDocument, selectedId]);
  useEffect(() => { if (!settings) loadSettings(); }, [loadSettings, settings]);
  useEffect(() => () => window.clearTimeout(xmlSyncTimerRef.current), [selectedId]);

  const updateXmlFromSource = useCallback((xml) => {
    setDraft(current => ({ ...current, xml_content: xml }));
    setDirty(true);
    window.clearTimeout(xmlSyncTimerRef.current);
    xmlSyncTimerRef.current = window.setTimeout(() => frameRef.current?.load(xml), 250);
  }, []);

  const saveDraft = useCallback(async (xml = draft?.xml_content) => {
    if (!selectedId || !xml || saveState === 'saving') return;
    setSaveState('saving');
    try {
      const data = await apiFetch(`/documents/${selectedId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ xml_content: xml, expected_draft_rev: draftRev, editor_state_json: '{}' }),
      });
      setDraft(data.draft);
      setDraftRev(data.draftRev);
      setDirty(false);
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1500);
      loadDocuments();
	  return data.draftRev;
    } catch (error) {
      setSaveState('error');
      if (error.status === 409) setConflictOpen(true);
      else toast.error(`保存失败：${error.message}`);
    }
  }, [draft?.xml_content, draftRev, loadDocuments, saveState, selectedId]);

  useEffect(() => {
    if (!dirty || !settings?.autosave_enabled) return;
    const timer = window.setTimeout(() => saveDraft(), settings.autosave_debounce_ms || 2000);
    return () => window.clearTimeout(timer);
  }, [dirty, saveDraft, settings?.autosave_debounce_ms, settings?.autosave_enabled]);

  const createDocument = async () => {
    const title = await dialog.prompt({ title: '新建图表', message: '输入图表名称', defaultValue: '新建图表' });
    if (!title?.trim()) return;
    const data = await apiFetch('/documents', { method: 'POST', body: JSON.stringify({ title: title.trim(), tags_json: '[]' }) });
    await loadDocuments();
    setSelectedId(data.document.id);
    setActiveTab('editor');
  };

  const importDocument = async (file) => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const data = await apiFetch('/import', { method: 'POST', body: form, headers: {} });
      await loadDocuments();
      setSelectedId(data.document.id);
      setActiveTab('editor');
      toast.success('图表已导入');
    } catch (error) {
      toast.error(`导入失败：${error.message}`);
    }
  };

  const exportDocument = async (format, versionId = null) => {
    if (!selectedId) return;
    try {
      if (format === 'svg') {
        const data = await frameRef.current?.exportSVG();
        const value = String(data || '');
        const blob = value.startsWith('data:')
          ? await fetch(value).then(response => response.blob())
          : new Blob([value], { type: 'image/svg+xml' });
        downloadBlob(blob, `${currentDoc?.title || 'diagram'}.svg`);
        return;
      }
	  const params = new URLSearchParams({ format });
	  if (versionId) { params.set('source', 'version'); params.set('versionId', String(versionId)); }
      const response = await fetch(`${API}/documents/${selectedId}/export?${params}`, {
        headers: useStore.getState().getAuthHeaders?.() || {},
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      downloadBlob(await response.blob(), `${currentDoc?.title || 'diagram'}.${format}`);
    } catch (error) {
      toast.error(`导出失败：${error.message}`);
    }
  };

  const saveVersion = async () => {
	const versionRevision = dirty ? await saveDraft() : draftRev;
    const summary = await dialog.prompt({ title: '保存版本', message: '填写本次版本备注（可留空）', defaultValue: '' });
    if (summary === null) return;
    try {
      await apiFetch(`/documents/${selectedId}/versions`, {
		method: 'POST', body: JSON.stringify({ summary, expected_draft_rev: versionRevision || draftRev }),
      });
      await loadDocument(selectedId);
      toast.success('版本已保存');
    } catch (error) {
      toast.error(`版本保存失败：${error.message}`);
    }
  };

  const deleteDocument = (document) => dialog.deleteResource({
    resourceType: '图表', resourceName: document.title,
    onDelete: async () => {
      await apiFetch(`/documents/${document.id}`, { method: 'DELETE' });
      if (selectedId === document.id) { setSelectedId(null); setCurrentDoc(null); setDraft(null); }
      await loadDocuments();
    },
  });

  const externalAssets = useMemo(() => {
    try { return JSON.parse(draft?.external_assets_json || '[]'); } catch { return []; }
  }, [draft?.external_assets_json]);

  const editorView = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select size="sm" className="w-40 max-w-full" value={String(selectedId || '')} onValueChange={value => setSelectedId(Number(value) || null)} aria-label="选择图表"
            renderValue={value => documents.find(item => item.id === Number(value))?.title || '选择图表'}>
            {documents.map(item => <Select.Option key={item.id} value={String(item.id)}>{item.title}</Select.Option>)}
          </Select>
          <Button size="sm" variant="primary" icon={<Plus className={iconButtonIconClass} />} onClick={createDocument}>新建</Button>
          <input ref={fileRef} type="file" accept=".drawio,.xml" className="hidden" onChange={event => { importDocument(event.target.files?.[0]); event.target.value = ''; }} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {saveState === 'saving' && <Badge variant="warning">保存中</Badge>}
          {saveState === 'saved' && <Badge variant="success">已保存</Badge>}
          {dirty && saveState !== 'saving' && <Badge variant="warning">未保存</Badge>}
          <div className="flex items-center gap-1">
            <Button size="sm" variant="secondary" icon={<Download className={iconButtonIconClass} />} onClick={() => fileRef.current?.click()}>导入</Button>
            <Button size="sm" variant="secondary" icon={<Upload className={iconButtonIconClass} />} onClick={() => exportDocument(settings?.default_export_format || 'drawio')}>导出</Button>
          </div>
          <Button size="sm" variant={dirty ? 'primary' : 'secondary'} onClick={() => saveDraft()} disabled={!dirty}>保存</Button>
          <Button size="sm" variant="secondary" icon={<Save className={iconButtonIconClass} />} onClick={saveVersion} disabled={!selectedId}>保存版本</Button>
        </div>
      </div>
      <LayerCard className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {selectedId && draft ? (
          <DrawioFrame ref={frameRef} key={selectedId} xml={draft.xml_content} theme={theme}
            onChange={xml => { setDraft(current => ({ ...current, xml_content: xml })); setDirty(true); }} />
        ) : (
          <Empty
            className="min-h-[32rem]"
            icon={<Image className="h-10 w-10 text-kumo-inactive" />}
            title="尚未选择图表"
            description="新建或从图库中选择一个图表开始编辑。"
            contents={<Button size="sm" variant="primary" icon={<Plus className={iconButtonIconClass} />} onClick={createDocument}>新建图表</Button>}
          />
        )}
        <div className="hidden min-h-0 flex-col border-l border-kumo-line lg:flex">
          <div className="flex shrink-0 items-center justify-between border-b border-kumo-line px-3 py-2">
            <span className="text-xs font-semibold text-kumo-strong">图表信息</span>
            <Button size="sm" variant="ghost" onClick={() => setXmlOpen(value => !value)}>{xmlOpen ? '收起 XML' : '编辑 XML'}</Button>
          </div>
          {xmlOpen && (
            <div className="h-48 min-h-0 shrink-0 overflow-hidden border-b border-kumo-line bg-kumo-base">
              <CodeEditor
                className="min-h-0"
                minHeight="0"
                height="100%"
                value={draft?.xml_content || ''}
                onChange={updateXmlFromSource}
                language="xml"
                label="图表 XML"
                variant="embedded"
                showHeader={false}
                showLanguage={false}
                lineWrapping
              />
            </div>
          )}
          <div className="shrink-0 space-y-2 p-3 text-xs text-kumo-subtle">
            <div>{currentDoc?.page_count || 0} 页 · 草稿 r{draftRev}</div>
            <div>{externalAssets.length ? `${externalAssets.length} 个外链资源` : '无外链资源'}</div>
            {externalAssets.length > 0 && <div className="text-kumo-warning">后台预览会阻止私网资源</div>}
          </div>
          <div className="flex min-h-0 flex-1 flex-col border-t border-kumo-line">
            <div className="flex shrink-0 items-center justify-between px-3 py-2">
              <span className="text-xs font-semibold text-kumo-strong">版本记录</span>
              <span className="text-xs text-kumo-subtle">{versions.length}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 scrollbar-thin">
              {!selectedId && <Empty size="sm" title="尚未选择图表" />}
              {selectedId && versions.length === 0 && <Empty size="sm" title="暂无版本" description="保存版本后会显示在这里。" />}
              {versions.map(version => (
                <div key={version.id} className="border-b border-kumo-line py-2 last:border-b-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-kumo-strong">v{version.version_no}</div>
                      <div className="truncate text-[11px] text-kumo-subtle" title={version.summary || '无备注'}>{version.summary || '无备注'}</div>
                      <div className="text-[10px] text-kumo-subtle">{version.created_at?.slice(0, 16)}</div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" onClick={() => exportDocument('drawio', version.id)}>导出</Button>
                      <Button size="sm" variant="ghost" onClick={async () => { await apiFetch(`/documents/${selectedId}/versions/${version.id}/restore`, { method: 'POST' }); await loadDocument(selectedId); toast.success('已恢复到草稿'); }}>恢复</Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </LayerCard>
    </div>
  );

  const libraryView = (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索图表" className="max-w-sm" />
        <Button size="sm" variant="primary" icon={<Plus className={iconButtonIconClass} />} onClick={createDocument}>新建</Button>
      </div>
      {loading ? <SkeletonLine className="h-32 w-full" /> : documents.length === 0 ? (
        <Empty
          className="min-h-64"
          icon={<Image className="h-10 w-10 text-kumo-inactive" />}
          title={search ? '没有匹配的图表' : '图库还是空的'}
          description={search ? '尝试调整搜索关键词。' : '创建图表或导入 draw.io 文件。'}
          contents={!search ? <Button size="sm" variant="primary" icon={<Plus className={iconButtonIconClass} />} onClick={createDocument}>新建图表</Button> : null}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {documents.map(document => (
            <LayerCard key={document.id}>
              <div className="min-w-0 p-4">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-kumo-strong">{document.title}</div>
                <div className="mt-3 flex items-center gap-3 text-xs text-kumo-subtle">
                  <span className="inline-flex items-center gap-1"><Image className="h-3 w-3" />{document.page_count} 页</span>
                  <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{document.updated_at?.slice(0, 10)}</span>
                </div>
                </div>
              </div>
              <div className="flex justify-end gap-1 border-t border-kumo-line px-2 py-2">
                <Button size="sm" variant="secondary" onClick={() => { setSelectedId(document.id); setActiveTab('editor'); }}>打开</Button>
                <Button size="sm" variant="ghost" shape="square" aria-label="复制图表" icon={<Copy className={iconButtonIconClass} />} onClick={async () => { const data = await apiFetch(`/documents/${document.id}/clone`, { method: 'POST' }); await loadDocuments(); setSelectedId(data.document.id); }} />
                <Button size="sm" variant="ghost" shape="square" aria-label="删除图表" icon={<Trash className={iconButtonIconClass} />} onClick={() => deleteDocument(document)} />
              </div>
            </LayerCard>
          ))}
        </div>
      )}
    </div>
  );

  const saveSettings = async () => {
    await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(settings) });
    toast.success('设置已保存');
  };
  const settingsView = settings ? (
    <div className="max-w-2xl space-y-5 overflow-auto pr-1">
      <Field label="默认导出格式" hideLabel><Select label="默认导出格式" value={settings.default_export_format} onValueChange={value => setSettings(current => ({ ...current, default_export_format: value }))} renderValue={value => value}><Select.Option value="drawio">drawio</Select.Option><Select.Option value="xml">XML</Select.Option><Select.Option value="svg">SVG</Select.Option></Select></Field>
      <Field controlFirst label="自动保存" description="编辑停止后保存当前草稿"><Switch aria-label="自动保存" checked={settings.autosave_enabled} onCheckedChange={checked => setSettings(current => ({ ...current, autosave_enabled: checked }))} /></Field>
      <Field controlFirst label="允许外链资源" description="保存不依赖资源可达性，后台仍阻止私网地址"><Switch aria-label="允许外链资源" checked={settings.allow_external_assets} onCheckedChange={checked => setSettings(current => ({ ...current, allow_external_assets: checked }))} /></Field>
      <Button size="sm" variant="primary" onClick={saveSettings}>保存设置</Button>
    </div>
  ) : <SkeletonLine className="h-40 w-full max-w-2xl" />;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
      <Tabs className="shrink-0 self-start" {...MODULE_TABS_PROPS} value={activeTab} onValueChange={setActiveTab} tabs={TABS} />
      <div className="flex min-h-0 flex-1">{activeTab === 'editor' && editorView}{activeTab === 'library' && libraryView}{activeTab === 'settings' && settingsView}</div>
      <Dialog.Root open={conflictOpen} onOpenChange={setConflictOpen} role="alertdialog">
        <Dialog className="p-6"><div className="flex items-center gap-3"><AlertTriangle className="h-5 w-5 text-kumo-warning" /><Dialog.Title>草稿冲突</Dialog.Title></div><Dialog.Description className="mt-3 text-kumo-subtle">另一会话已经保存了更新版本。你可以复制本地 XML，或加载数据库中的最新草稿。</Dialog.Description><div className="mt-6 flex justify-end gap-2"><Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(draft?.xml_content || '')}>复制本地 XML</Button><Button size="sm" variant="primary" onClick={() => { setConflictOpen(false); loadDocument(selectedId); }}>加载最新草稿</Button></div></Dialog>
      </Dialog.Root>
    </div>
  );
}
