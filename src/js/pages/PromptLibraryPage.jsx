import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardText, Empty, Field, LayerCard, Tabs } from '@cloudflare/kumo';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { Switch } from '@cloudflare/kumo/components/switch';
import DocumentWorkspace from '../components/editor/DocumentWorkspace.jsx';
import useStore from '../store.js';
import { MODULE_TABS_PROPS } from '../modules/kumoTabs.js';
import { dialog } from '../modules/dialog.js';
import { toast } from '../modules/toast.js';
import { CheckDouble, ExternalLink, FileText, Folder, Plus, Star, Trash } from '../components/Icons.jsx';
import { AlertTriangle } from '../components/IconsCore.jsx';
import { iconButtonIconClass } from '../components/ui/AppPrimitives.jsx';

const API = '/api/prompts';
const TABS = [
  { value: 'workspace', label: '工作区' },
  { value: 'collections', label: '集合' },
  { value: 'published', label: '已发布' },
  { value: 'settings', label: '设置' },
];

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...(useStore.getState().getAuthHeaders?.() || {}), ...options.headers },
  });
  if (!response.ok && response.status !== 204) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return response.json().catch(() => ({}));
}

const parseTags = value => {
  try { return JSON.parse(value || '[]'); } catch { return []; }
};

export default function PromptLibraryPage() {
  const [activeTab, setActiveTab] = useState('workspace');
  const [collections, setCollections] = useState([]);
  const [entries, setEntries] = useState([]);
  const [publishedEntries, setPublishedEntries] = useState([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState(null);
  const [selectedEntryId, setSelectedEntryId] = useState(null);
  const [entry, setEntry] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftRev, setDraftRev] = useState(0);
  const [versions, setVersions] = useState([]);
  const [settings, setSettings] = useState(null);
  const [search, setSearch] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);

  const loadCollections = useCallback(async () => {
    const data = await apiFetch('/collections');
    setCollections(data.collections || []);
  }, []);

  const loadEntries = useCallback(async () => {
    const params = new URLSearchParams();
    if (selectedCollectionId) params.set('collection_id', String(selectedCollectionId));
    if (search) params.set('q', search);
    if (starredOnly) params.set('starred', 'true');
    try {
      const data = await apiFetch(`/entries?${params}`);
      setEntries(data.entries || []);
    } catch (error) {
      toast.error(`提示词加载失败：${error.message}`);
    }
  }, [search, selectedCollectionId, starredOnly]);

  const loadPublished = useCallback(async () => {
    const data = await apiFetch('/entries?published=true');
    setPublishedEntries(data.entries || []);
  }, []);

  const loadEntry = useCallback(async (id) => {
    if (!id) return;
    try {
      const [entryData, draftData, versionData] = await Promise.all([
        apiFetch(`/entries/${id}`), apiFetch(`/entries/${id}/draft`), apiFetch(`/entries/${id}/versions`),
      ]);
      setEntry(entryData.entry);
      setDraft(draftData.draft);
      setDraftRev(entryData.entry.current_draft_rev);
      setVersions(versionData.versions || []);
    } catch (error) {
      toast.error(`提示词加载失败：${error.message}`);
    }
  }, []);

  useEffect(() => { loadCollections().catch(error => toast.error(error.message)); }, [loadCollections]);
  useEffect(() => { loadEntries(); }, [loadEntries]);
  useEffect(() => { loadPublished().catch(() => {}); }, [loadPublished]);
  useEffect(() => { loadEntry(selectedEntryId); }, [loadEntry, selectedEntryId]);
  useEffect(() => {
    if (!settings) apiFetch('/settings').then(data => setSettings(data.settings)).catch(() => {});
  }, [settings]);
	useEffect(() => {
		if (!entry?.id) return;
		const timer = window.setTimeout(() => {
			apiFetch(`/entries/${entry.id}`, {
				method: 'PUT',
				body: JSON.stringify({
					title: entry.title, collection_id: entry.collection_id, tags_json: entry.tags_json || '[]',
					starred: Boolean(entry.starred), archived: Boolean(entry.archived), visibility: entry.visibility || 'unlisted',
				}),
			}).then(loadEntries).catch(() => {});
		}, 700);
		return () => window.clearTimeout(timer);
	}, [entry?.id, entry?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const createCollection = async (parentId = null) => {
    const name = await dialog.prompt({ title: '新建集合', message: '输入集合名称', placeholder: '例如：运维自动化' });
    if (!name?.trim()) return;
    await apiFetch('/collections', { method: 'POST', body: JSON.stringify({ name: name.trim(), parent_id: parentId }) });
    await loadCollections();
  };

  const createEntry = async () => {
    const title = await dialog.prompt({ title: '新建提示词', message: '输入提示词标题', defaultValue: '未命名提示词' });
    if (!title?.trim()) return;
    const data = await apiFetch('/entries', {
      method: 'POST',
      body: JSON.stringify({ title: title.trim(), collection_id: selectedCollectionId, tags_json: '[]', visibility: settings?.default_visibility || 'unlisted' }),
    });
    await loadEntries();
    setSelectedEntryId(data.entry.id);
    setActiveTab('workspace');
  };

  const updateEntry = async (patch) => {
    if (!entry) return;
    const next = { ...entry, ...patch };
    await apiFetch(`/entries/${entry.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        title: next.title,
        collection_id: next.collection_id,
        tags_json: next.tags_json || '[]',
        starred: Boolean(next.starred),
        archived: Boolean(next.archived),
        visibility: next.visibility || 'unlisted',
      }),
    });
    setEntry(next);
    await Promise.all([loadEntries(), loadPublished()]);
  };

  const saveDraft = async (markdown) => {
    try {
      const data = await apiFetch(`/entries/${entry.id}/draft`, {
        method: 'PUT', body: JSON.stringify({ content_md: markdown, expected_draft_rev: draftRev }),
      });
      setDraft(data.draft);
      setDraftRev(data.draftRev);
      await loadEntries();
    } catch (error) {
      if (error.status === 409) setConflictOpen(true);
      throw error;
    }
  };

  const publish = async () => {
    try {
      await apiFetch(`/entries/${entry.id}/publish`, { method: 'POST', body: JSON.stringify({ expected_draft_rev: draftRev }) });
      await Promise.all([loadEntry(entry.id), loadPublished()]);
      toast.success('已发布新版本');
    } catch (error) {
      toast.error(`发布失败：${error.message}`);
    }
  };

  const deleteEntry = target => dialog.deleteResource({
    resourceType: '提示词', resourceName: target.title,
    onDelete: async () => {
      await apiFetch(`/entries/${target.id}`, { method: 'DELETE' });
      if (selectedEntryId === target.id) { setSelectedEntryId(null); setEntry(null); setDraft(null); }
      await Promise.all([loadEntries(), loadPublished()]);
    },
  });

  const tags = useMemo(() => parseTags(entry?.tags_json), [entry?.tags_json]);
  const publicPageUrl = entry?.public_id ? `${window.location.origin}/p/${entry.public_id}` : '';
  const directLinkUrl = entry?.public_id ? `${window.location.origin}/api/prompts/d/${entry.public_id}` : '';
  const detailsPanel = entry ? (
    <div className="space-y-4 p-3 text-xs">
      <Field label="可见性" hideLabel><Select label="可见性" value={entry.visibility} onValueChange={value => updateEntry({ visibility: value })} renderValue={value => ({ private: '私有', unlisted: '不公开索引', public: '公开' }[value] || value)}><Select.Option value="private">私有</Select.Option><Select.Option value="unlisted">不公开索引</Select.Option><Select.Option value="public">公开</Select.Option></Select></Field>
	  <Input size="sm" label="标签" key={`${entry.id}-${entry.tags_json}`} defaultValue={tags.join(', ')} placeholder="用逗号分隔" onBlur={event => updateEntry({ tags_json: JSON.stringify(event.target.value.split(',').map(item => item.trim()).filter(Boolean)) })} />
      <div className="space-y-2 border-t border-kumo-line pt-3">
        <div className="font-medium text-kumo-strong">公开链接</div>
        {entry.latest_published_version_no > 0 ? <><ClipboardText size="sm" text={publicPageUrl} className="w-full min-w-0" tooltip={{ text: '复制公开页地址', copiedText: '地址已复制' }} /><ClipboardText size="sm" text={directLinkUrl} className="w-full min-w-0" tooltip={{ text: '复制最新直链', copiedText: '地址已复制' }} /></> : <div className="text-kumo-subtle">发布后生成公开链接</div>}
      </div>
      <div className="space-y-2 border-t border-kumo-line pt-3">
        <div className="font-medium text-kumo-strong">发布版本</div>
        {versions.length === 0 && <Empty size="sm" title="暂无发布版本" />}
        {versions.map(version => <div key={version.id} className="space-y-2 border-b border-kumo-line pb-3 last:border-b-0"><div className="flex items-center justify-between"><span className="font-medium text-kumo-strong">v{version.version_no}</span><Button size="sm" variant="secondary" onClick={async () => { await apiFetch(`/entries/${entry.id}/versions/${version.id}/restore`, { method: 'POST' }); await loadEntry(entry.id); toast.success('已恢复到草稿'); }}>恢复</Button></div><ClipboardText size="sm" text={`${directLinkUrl}/versions/${version.version_no}`} className="w-full min-w-0" tooltip={{ text: '复制固定直链', copiedText: '地址已复制' }} /></div>)}
      </div>
    </div>
  ) : null;

  const workspaceView = (
    <div className="flex min-h-0 flex-1">
	  <aside className="hidden w-72 shrink-0 flex-col border-r border-kumo-line md:flex">
        <div className="space-y-2 border-b border-kumo-line p-2">
          <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索提示词" />
          <div className="flex gap-2"><Button size="sm" variant="primary" className="flex-1" icon={<Plus className={iconButtonIconClass} />} onClick={createEntry}>新建</Button><Button size="sm" variant={starredOnly ? 'primary' : 'secondary'} shape="square" aria-label="仅看收藏" icon={<Star className={iconButtonIconClass} />} onClick={() => setStarredOnly(value => !value)} /></div>
        </div>
        <div className="border-b border-kumo-line p-2">
          <Button size="sm" variant={!selectedCollectionId ? 'primary' : 'ghost'} className="w-full !justify-start" onClick={() => setSelectedCollectionId(null)}>全部提示词</Button>
          {collections.map(collection => <Button key={collection.id} size="sm" variant={selectedCollectionId === collection.id ? 'primary' : 'ghost'} className="w-full !justify-start" icon={<Folder className="h-3 w-3" />} onClick={() => setSelectedCollectionId(collection.id)}>{collection.name}</Button>)}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {entries.map(item => <div key={item.id} className="mb-1 flex items-center gap-1"><Button size="sm" variant={selectedEntryId === item.id ? 'primary' : 'ghost'} className="min-w-0 flex-1 !justify-start" icon={<FileText className="h-3 w-3" />} onClick={() => setSelectedEntryId(item.id)}><span className="truncate">{item.title}</span></Button><Button size="sm" variant="ghost" shape="square" aria-label={item.starred ? '取消收藏' : '收藏'} icon={<Star className={`h-3 w-3 ${item.starred ? 'fill-current' : ''}`} />} onClick={() => { if (entry?.id === item.id) updateEntry({ starred: !item.starred }); else apiFetch(`/entries/${item.id}`).then(data => { const target = data.entry; return apiFetch(`/entries/${item.id}`, { method: 'PUT', body: JSON.stringify({ ...target, starred: !target.starred }) }); }).then(loadEntries); }} /></div>)}
          {entries.length === 0 && <Empty size="sm" title="当前集合暂无提示词" description="新建提示词后会显示在这里。" />}
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
		<div className="flex shrink-0 items-center gap-2 border-b border-kumo-line pb-2 md:hidden">
		  <Select value={String(selectedEntryId || '')} onValueChange={value => setSelectedEntryId(Number(value) || null)} aria-label="选择提示词" renderValue={value => entries.find(item => item.id === Number(value))?.title || '选择提示词'}>
			{entries.map(item => <Select.Option key={item.id} value={String(item.id)}>{item.title}</Select.Option>)}
		  </Select>
		  <Button size="sm" variant="primary" shape="square" aria-label="新建提示词" icon={<Plus className={iconButtonIconClass} />} onClick={createEntry} />
		</div>
        {entry && draft ? <DocumentWorkspace key={entry.id} initialMarkdown={draft.content_md} title={entry.title} onTitleChange={title => setEntry(current => ({ ...current, title }))} onSave={saveDraft} autosaveDelay={1800} showOutline rightPanel={{ title: '属性与版本', content: detailsPanel }} extraToolbarActions={<><Button size="sm" variant={entry.starred ? 'primary' : 'secondary'} shape="square" aria-label={entry.starred ? '取消收藏' : '收藏'} icon={<Star className={iconButtonIconClass} />} onClick={() => updateEntry({ starred: !entry.starred })} /><Button size="sm" variant="primary" icon={<CheckDouble className={iconButtonIconClass} />} onClick={publish}>发布</Button></>} /> : <Empty className="flex-1" icon={<FileText className="h-10 w-10 text-kumo-inactive" />} title="尚未选择提示词" description="选择现有提示词或新建条目开始编辑。" contents={<Button size="sm" variant="primary" icon={<Plus className={iconButtonIconClass} />} onClick={createEntry}>新建提示词</Button>} />}
      </main>
    </div>
  );

  const collectionsView = <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto"><div><Button size="sm" variant="primary" icon={<Plus className={iconButtonIconClass} />} onClick={() => createCollection()}>新建集合</Button></div>{collections.length === 0 && <Empty className="min-h-64" icon={<Folder className="h-10 w-10 text-kumo-inactive" />} title="暂无集合" description="创建集合来整理提示词。" />}{collections.map(collection => <LayerCard key={collection.id} className="flex items-center justify-between gap-3 p-4"><div className="min-w-0"><div className="truncate text-sm font-medium text-kumo-strong">{collection.name}</div><div className="truncate text-xs text-kumo-subtle">{collection.description || '无描述'}</div></div><Button size="sm" variant="ghost" shape="square" aria-label={`删除集合 ${collection.name}`} icon={<Trash className={iconButtonIconClass} />} onClick={() => dialog.deleteResource({ resourceType: '集合', resourceName: collection.name, onDelete: async () => { await apiFetch(`/collections/${collection.id}`, { method: 'DELETE' }); await loadCollections(); await loadEntries(); } })} /></LayerCard>)}</div>;

  const publishedView = <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">{publishedEntries.map(item => <LayerCard key={item.id} className="flex items-center justify-between gap-3 p-4"><div className="min-w-0"><div className="truncate text-sm font-medium text-kumo-strong">{item.title}</div><div className="text-xs text-kumo-subtle">v{item.latest_published_version_no} · {item.latest_published_at?.slice(0, 16)}</div></div><div className="flex shrink-0 gap-1"><Button size="sm" variant="secondary" icon={<ExternalLink className={iconButtonIconClass} />} onClick={() => { setSelectedEntryId(item.id); setActiveTab('workspace'); }}>打开</Button><Button size="sm" variant="ghost" shape="square" aria-label={`删除提示词 ${item.title}`} icon={<Trash className={iconButtonIconClass} />} onClick={() => deleteEntry(item)} /></div></LayerCard>)}{publishedEntries.length === 0 && <Empty className="min-h-64" title="暂无已发布提示词" description="发布版本后会显示在这里。" />}</div>;

  const saveSettings = async () => { await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(settings) }); toast.success('设置已保存'); };
  const settingsView = settings ? <div className="max-w-2xl flex-1 space-y-5 overflow-auto pr-1"><Field label="默认可见性" hideLabel><Select label="默认可见性" value={settings.default_visibility} onValueChange={value => setSettings(current => ({ ...current, default_visibility: value }))} renderValue={value => ({ private: '私有', unlisted: '不公开索引', public: '公开' }[value] || value)}><Select.Option value="private">私有</Select.Option><Select.Option value="unlisted">不公开索引</Select.Option><Select.Option value="public">公开</Select.Option></Select></Field><Field controlFirst label="公开页面" description="允许人类可读公开页"><Switch aria-label="公开页面" checked={settings.allow_public_pages} onCheckedChange={checked => setSettings(current => ({ ...current, allow_public_pages: checked }))} /></Field><Field controlFirst label="AI 原始直链" description="允许外部程序读取已发布内容"><Switch aria-label="AI 原始直链" checked={settings.allow_direct_links} onCheckedChange={checked => setSettings(current => ({ ...current, allow_direct_links: checked }))} /></Field><Button size="sm" variant="primary" onClick={saveSettings}>保存设置</Button></div> : <Empty size="sm" title="正在加载设置" />;

  return <div className="flex h-full min-h-0 flex-1 flex-col gap-3"><Tabs className="shrink-0 self-start" {...MODULE_TABS_PROPS} value={activeTab} onValueChange={setActiveTab} tabs={TABS} /><div className="flex min-h-0 flex-1">{activeTab === 'workspace' && workspaceView}{activeTab === 'collections' && collectionsView}{activeTab === 'published' && publishedView}{activeTab === 'settings' && settingsView}</div><Dialog.Root open={conflictOpen} onOpenChange={setConflictOpen} role="alertdialog"><Dialog className="p-6"><div className="flex items-center gap-3"><AlertTriangle className="h-5 w-5 text-kumo-warning" /><Dialog.Title>草稿冲突</Dialog.Title></div><Dialog.Description className="mt-3 text-kumo-subtle">另一会话已更新此草稿。加载最新内容后再继续编辑。</Dialog.Description><div className="mt-6 flex justify-end"><Button size="sm" variant="primary" onClick={() => { setConflictOpen(false); loadEntry(entry.id); }}>加载最新草稿</Button></div></Dialog></Dialog.Root></div>;
}
