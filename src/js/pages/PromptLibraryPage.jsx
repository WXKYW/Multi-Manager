import React, { useState, useEffect, useCallback } from 'react';
import { Tabs } from '@cloudflare/kumo';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import useStore from '../store.js';
import { MODULE_TABS_PROPS } from '../modules/kumoTabs.js';
import { toast } from '../modules/toast.js';
import { dialog } from '../modules/dialog.js';
import DocumentWorkspace from '../components/editor/DocumentWorkspace.jsx';
import {
  Plus, Folder, FileText, Star, Trash, Copy,
  Clock, Settings, CheckDouble, ExternalLink,
} from '../components/Icons.jsx';
import { iconButtonIconClass } from '../components/ui/AppPrimitives.jsx';

const API = '/api/prompts';

const TABS = [
  { value: 'workspace', label: '工作区' },
  { value: 'collections', label: '集合' },
  { value: 'published', label: '已发布' },
  { value: 'settings', label: '设置' },
];

async function apiFetch(path, opts = {}) {
  const headers = {
    ...(useStore.getState().getAuthHeaders?.() || {}),
    ...opts.headers,
  };
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `HTTP ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

export default function PromptLibraryPage() {
  const [activeTab, setActiveTab] = useState('workspace');
  const [collections, setCollections] = useState([]);
  const [entries, setEntries] = useState([]);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftRev, setDraftRev] = useState(0);
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQ, setSearchQ] = useState('');
  const [selectedCollectionId, setSelectedCollectionId] = useState(null);
  const [starredOnly, setStarredOnly] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [collData, entryParams] = await Promise.all([
        apiFetch('/collections'),
        apiFetch(`/entries?${new URLSearchParams({
          ...(searchQ ? { q: searchQ } : {}),
          ...(selectedCollectionId ? { collection_id: String(selectedCollectionId) } : {}),
          ...(starredOnly ? { starred: 'true' } : {}),
        })}`),
      ]);
      setCollections(collData.collections || []);
      setEntries(entryParams.entries || []);
    } catch (e) {
      console.error('Failed to fetch data:', e);
    } finally {
      setLoading(false);
    }
  }, [searchQ, selectedCollectionId, starredOnly]);

  const fetchEntryDetail = useCallback(async (id) => {
    try {
      const [entryData, draftData, verData] = await Promise.all([
        apiFetch(`/entries/${id}`),
        apiFetch(`/entries/${id}/draft`).catch(() => null),
        apiFetch(`/entries/${id}/versions`).catch(() => ({ versions: [] })),
      ]);
      setSelectedEntry(entryData.entry);
      setDraft(draftData?.draft || null);
      setDraftRev(entryData.entry?.current_draft_rev || 1);
      setVersions(verData.versions || []);
    } catch (e) {
      console.error('Failed to fetch entry:', e);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    if (selectedEntry?.id) fetchEntryDetail(selectedEntry.id);
  }, [selectedEntry?.id]);

  const handleCreateEntry = async () => {
    try {
      const title = prompt('提示词标题:') || '未命名提示词';
      const data = await apiFetch('/entries', {
        method: 'POST',
        body: JSON.stringify({ title, collection_id: selectedCollectionId, tags_json: '[]', visibility: 'unlisted' }),
      });
      toast.success('提示词已创建');
      setSelectedEntry(data.entry);
      fetchData();
    } catch (e) {
      toast.error('创建失败: ' + e.message);
    }
  };

  const handleCreateCollection = async () => {
    try {
      const name = prompt('集合名称:');
      if (!name) return;
      await apiFetch('/collections', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      toast.success('集合已创建');
      fetchData();
    } catch (e) {
      toast.error('创建失败: ' + e.message);
    }
  };

  const handleSave = async (markdown) => {
    if (!selectedEntry?.id) return;
    try {
      const data = await apiFetch(`/entries/${selectedEntry.id}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content_md: markdown, expected_draft_rev: draftRev }),
      });
      setDraftRev(data.draftRev);
    } catch (e) {
      throw e;
    }
  };

  const handlePublish = async () => {
    if (!selectedEntry?.id) return;
    try {
      await apiFetch(`/entries/${selectedEntry.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({ expected_draft_rev: draftRev }),
      });
      toast.success('发布成功');
      fetchEntryDetail(selectedEntry.id);
    } catch (e) {
      toast.error('发布失败: ' + e.message);
    }
  };

  const handleToggleStar = async (entry) => {
    try {
      await apiFetch(`/entries/${entry.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...entry, starred: !entry.starred }),
      });
      fetchData();
    } catch (e) {
      toast.error('操作失败: ' + e.message);
    }
  };

  const handleDelete = (entry) => {
    dialog.deleteResource({
      resourceType: '提示词',
      resourceName: entry.title,
      onDelete: async () => {
        await apiFetch(`/entries/${entry.id}`, { method: 'DELETE' });
        if (selectedEntry?.id === entry.id) setSelectedEntry(null);
        fetchData();
      },
    });
  };

  const renderWorkspace = () => (
    <div className="flex h-full min-h-0 flex-1">
      {/* Left sidebar: Collections + Entry list */}
      <div className="flex w-56 shrink-0 flex-col border-r border-kumo-line">
        <div className="flex items-center justify-between border-b border-kumo-line px-3 py-2">
          <span className="text-xs font-semibold text-kumo-strong">集合</span>
          <Button type="button" size="sm" variant="ghost" shape="square" aria-label="新建集合"
            icon={<Plus className="h-3 w-3" />} onClick={handleCreateCollection} />
        </div>
        <div className="flex-1 overflow-auto">
          <Button
            type="button"
            size="sm"
            variant={!selectedCollectionId ? 'primary' : 'ghost'}
            className="w-full !justify-start"
            onClick={() => setSelectedCollectionId(null)}
          >
            全部
          </Button>
          {collections.map(coll => (
            <Button
              key={coll.id}
              type="button"
              size="sm"
              variant={selectedCollectionId === coll.id ? 'primary' : 'ghost'}
              className="w-full !justify-start"
              onClick={() => setSelectedCollectionId(coll.id)}
              icon={<Folder className="h-3 w-3" />}
            >
              {coll.name}
            </Button>
          ))}
        </div>
        <div className="border-t border-kumo-line p-2">
          <Button type="button" size="sm" variant="primary" className="w-full" icon={<Plus className="h-3 w-3" />} onClick={handleCreateEntry}>
            新建提示词
          </Button>
        </div>
      </div>

      {/* Center: DocumentWorkspace */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedEntry ? (
          <DocumentWorkspace
            initialMarkdown={draft?.content_md || ''}
            title={selectedEntry.title}
            onSave={handleSave}
            showOutline
            showStatusBar
            placeholder="输入提示词内容…"
            extraToolbarActions={
              <>
                <Button type="button" size="sm" variant="secondary"
                  icon={<CheckDouble className={iconButtonIconClass} />}
                  onClick={handlePublish}>
                  发布
                </Button>
                {selectedEntry.public_id && (
                  <Button type="button" size="sm" variant="ghost" shape="square" aria-label="复制直链"
                    icon={<ExternalLink className={iconButtonIconClass} />}
                    onClick={() => {
                      navigator.clipboard.writeText(`${window.location.origin}/api/prompts/d/${selectedEntry.public_id}`);
                      toast.success('直链已复制');
                    }} />
                )}
              </>
            }
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-kumo-subtle">
            选择一个提示词或创建新的
          </div>
        )}
      </div>
    </div>
  );

  const renderCollections = () => (
    <div className="flex flex-1 flex-col gap-3">
      <Button type="button" size="sm" variant="primary" icon={<Plus className={iconButtonIconClass} />} onClick={handleCreateCollection}>
        新建集合
      </Button>
      {collections.map(coll => (
        <div key={coll.id} className="flex items-center justify-between rounded-lg border border-kumo-line px-4 py-3">
          <div className="flex items-center gap-2">
            <Folder className="h-4 w-4 text-kumo-subtle" />
            <span className="text-sm font-semibold text-kumo-strong">{coll.name}</span>
          </div>
          <Button type="button" size="sm" variant="ghost" shape="square" aria-label="删除集合"
            icon={<Trash className="h-3 w-3" />}
            onClick={() => dialog.deleteResource({
              resourceType: '集合',
              resourceName: coll.name,
              onDelete: async () => {
                await apiFetch(`/collections/${coll.id}`, { method: 'DELETE' });
                fetchData();
              },
            })} />
        </div>
      ))}
    </div>
  );

  const renderPublished = () => (
    <div className="flex flex-1 flex-col gap-3">
      {entries.filter(e => e.latest_published_version_no > 0).map(entry => (
        <div key={entry.id} className="flex items-center justify-between rounded-lg border border-kumo-line px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-kumo-strong">{entry.title}</div>
            <div className="text-xs text-kumo-subtle">v{entry.latest_published_version_no} · {entry.latest_published_at?.slice(0, 10)}</div>
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" shape="square" aria-label="复制公开页"
              icon={<Share className="h-3 w-3" />}
              onClick={async () => {
                // Find public_id from entry detail
                const data = await apiFetch(`/entries/${entry.id}`);
                if (data.entry?.public_id) {
                  navigator.clipboard.writeText(`${window.location.origin}/api/prompts/d/${data.entry.public_id}`);
                  toast.success('直链已复制');
                }
              }} />
          </div>
        </div>
      ))}
      {entries.filter(e => e.latest_published_version_no > 0).length === 0 && (
        <div className="flex min-h-[200px] items-center justify-center text-sm text-kumo-subtle">暂无已发布的提示词</div>
      )}
    </div>
  );

  const renderSettings = () => (
    <div className="flex flex-1 flex-col gap-4">
      <h3 className="text-sm font-semibold text-kumo-strong">提示词库设置</h3>
      <div className="max-w-md space-y-3 text-sm text-kumo-subtle">
        <p>提示词库模块设置将在后续版本中完善。</p>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col gap-3 overflow-hidden px-px pt-px sm:gap-4">
      <div className="flex shrink-0 items-center justify-between border-b border-kumo-line pb-3">
        <Tabs {...MODULE_TABS_PROPS} value={activeTab} onValueChange={setActiveTab} tabs={TABS} />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={starredOnly ? 'primary' : 'secondary'}
            onClick={() => setStarredOnly(!starredOnly)}
            icon={<Star className={`h-3 w-3 ${starredOnly ? 'fill-current' : ''}`} />}
          >
            收藏
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {activeTab === 'workspace' && renderWorkspace()}
        {activeTab === 'collections' && renderCollections()}
        {activeTab === 'published' && renderPublished()}
        {activeTab === 'settings' && renderSettings()}
      </div>
    </div>
  );
}
