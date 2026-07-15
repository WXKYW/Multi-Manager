import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  ChartPalette,
  ClipboardText,
  Empty,
  Grid,
  LayerCard,
  Tabs,
  Text,
  TimeseriesChart,
} from '@cloudflare/kumo';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { Switch } from '@cloudflare/kumo/components/switch';
import { Table } from '@cloudflare/kumo/components/table';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { toast } from '../modules/toast.js';
import { dialog } from '../modules/dialog.js';
import { MODULE_TABS_PROPS } from '../modules/kumoTabs.js';
import useStore from '../store.js';
import { AppTable, ChartBoundaryBox, DataTableFrame } from '../components/ui/AppPrimitives.jsx';
import {
  Activity,
  AlertTriangle,
  Bell,
  Check,
  Clock,
  ExternalLink,
  GitBranch,
  GitHubBrand,
  Key,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Settings,
  Star,
  Trash,
  TrendingUp,
  Users,
  X,
} from '../components/Icons.jsx';

echarts.use([LineChart, GridComponent, TooltipComponent, AriaComponent, CanvasRenderer]);

const tabs = [
  { value: 'repositories', label: '仓库' },
  { value: 'actions', label: 'Actions' },
  { value: 'trends', label: '趋势' },
  { value: 'events', label: '事件' },
  { value: 'settings', label: '设置' },
];

const tokenTypeOptions = [
  { value: 'fine_grained', label: 'Fine-grained PAT' },
  { value: 'classic', label: 'Classic PAT' },
  { value: 'app', label: 'GitHub App' },
];

const fineGrainedTokenURL = 'https://github.com/settings/personal-access-tokens/new?name=API-Monitor&description=API-Monitor+GitHub+observability&expires_in=none&actions=write&administration=write&contents=write&issues=write&pull_requests=write&repository_hooks=write&workflows=write';

const rangeOptions = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '365 天' },
];

const githubEmojiMap = {
  house_with_garden: '🏡',
  rocket: '🚀',
  sparkles: '✨',
  tada: '🎉',
  fire: '🔥',
  zap: '⚡',
  lightning: '⚡',
  star: '⭐',
  star2: '🌟',
  bug: '🐛',
  lock: '🔒',
  key: '🔑',
  warning: '⚠️',
  white_check_mark: '✅',
  x: '❌',
  construction: '🚧',
  memo: '📝',
  books: '📚',
  package: '📦',
  computer: '💻',
  robot: '🤖',
  cloud: '☁️',
  globe_with_meridians: '🌐',
  shield: '🛡️',
  wrench: '🔧',
  gear: '⚙️',
  heart: '❤️',
  eyes: '👀',
  bulb: '💡',
};

const statusTone = (status) => {
  const value = String(status || '').toLowerCase();
  if (['success', 'completed', 'active'].includes(value)) return 'success';
  if (['failure', 'failed', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'critical'].includes(value)) return 'error';
  if (['in_progress', 'queued', 'pending', 'requested', 'waiting', 'running', 'warning', 'rate_limited'].includes(value)) return 'warning';
  return 'neutral';
};

const statusLabel = (status) => ({
  success: '成功',
  completed: '已完成',
  active: '已启用',
  failure: '失败',
  failed: '失败',
  error: '错误',
  timed_out: '超时',
  cancelled: '已取消',
  action_required: '需要操作',
  startup_failure: '启动失败',
  critical: '严重',
  in_progress: '运行中',
  running: '运行中',
  queued: '排队中',
  pending: '等待中',
  requested: '已请求',
  waiting: '等待中',
  warning: '警告',
  rate_limited: '已限流',
  skipped: '已跳过',
  stale: '已过期',
  disabled: '已停用',
  neutral: '未知',
  unknown: '未知',
  info: '信息',
}[String(status || '').toLowerCase()] || status || '未知');

const tokenTestStatusLabel = (status) => ({
  success: '权限通过',
  warning: '权限不完整',
  failed: 'Token 无效',
  unknown: '未检测',
}[String(status || '').toLowerCase()] || status || '未检测');

const formatNumber = (value) => Number(value || 0).toLocaleString();
const formatDateTime = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
};

const formatResetCountdown = (value, now) => {
  const resetAt = new Date(value).getTime();
  if (!Number.isFinite(resetAt)) return '';
  const remainingMinutes = Math.max(0, Math.ceil((resetAt - now) / 60000));
  if (remainingMinutes === 0) return '即将重置';
  return `${Math.floor(remainingMinutes / 60)}时${remainingMinutes % 60}分重置`;
};

const formatActionDuration = (startedAt, finishedAt, now) => {
  const started = new Date(startedAt).getTime();
  const finished = new Date(finishedAt).getTime();
  if (!Number.isFinite(started)) return '-';
  const end = Number.isFinite(finished) ? finished : now;
  const totalSeconds = Math.max(0, Math.floor((end - started) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}时${minutes}分${seconds}秒` : `${minutes}分${seconds}秒`;
};

const parseTimestamp = (value) => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Date.now();
};

const renderGitHubEmoji = (value) => String(value || '').replace(/:([a-z0-9_+-]+):/gi, (match, name) => githubEmojiMap[name] || match);
const parseJSON = (value, fallback = {}) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

function RepositoryMetric({ icon, label, value, detail }) {
  return (
    <LayerCard className="min-w-0 self-start px-3 py-2 shadow-none">
      <div className="flex min-w-0 items-center gap-1.5 text-kumo-subtle">
        {icon}
        <Text variant="secondary" size="sm" truncate>{label}</Text>
      </div>
      <div className="mt-1 flex min-w-0 items-baseline justify-between gap-2">
        <Text variant="heading3" as="span" truncate>{value}</Text>
        {detail && <Text variant="secondary" size="xs" truncate>{detail}</Text>}
      </div>
    </LayerCard>
  );
}

function FillEmpty({ title, description }) {
  return (
    <div className="flex items-center justify-center p-8">
      <Empty title={title} description={description} />
    </div>
  );
}

function RepositoryStat({ label, value }) {
  return (
    <LayerCard className="min-w-0 p-2 text-center shadow-none">
      <div className="truncate text-[10px] font-medium text-kumo-subtle">{label}</div>
      <div className="truncate text-xs font-bold text-kumo-strong">{value}</div>
    </LayerCard>
  );
}

function PermissionChecks({ token }) {
  const permissions = parseJSON(token.permissions_json);
  const checks = Array.isArray(permissions.checks) ? permissions.checks : [];
  const scopes = Array.isArray(permissions.scopes) ? permissions.scopes : [];
  if (checks.length === 0 && scopes.length === 0 && !token.last_test_error) {
    if (token.last_test_status === 'success' && token.last_test_at) {
      return <Text variant="secondary" size="xs">基础认证通过。选择仓库后再次检测，可验证 Actions 和 Traffic 权限。检测时间：{formatDateTime(token.last_test_at)}</Text>;
    }
    return <Text variant="secondary" size="xs">尚未检测。点击“检测权限”验证 Token；选择仓库后可同时验证仓库权限。</Text>;
  }
  return (
    <div className="grid gap-2">
      {scopes.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-kumo-subtle">
          <span>Classic scopes</span>
          {scopes.map((scope) => <Badge key={scope} variant="neutral">{scope}</Badge>)}
        </div>
      )}
      {checks.length > 0 && (
        <div className="grid gap-1 sm:grid-cols-2">
          {checks.map((check) => (
            <div key={check.key || check.label} className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-kumo-line px-2 py-1.5 text-[11px]">
              <span className="min-w-0 truncate text-kumo-strong">{check.label}</span>
              <div className="flex min-w-0 items-center gap-1">
                <span className="hidden max-w-32 truncate text-kumo-subtle md:inline">{check.level}</span>
                <Badge variant={check.status === 'success' ? 'success' : check.status === 'skipped' ? 'neutral' : 'danger'}>
                  {check.status === 'success' ? '通过' : check.status === 'skipped' ? '跳过' : '失败'}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
      {token.last_test_error && <div className="truncate text-xs text-kumo-danger">{token.last_test_error}</div>}
    </div>
  );
}

function GitHubPage() {
  const { theme } = useStore();
  const isDarkMode = theme === 'dark';
  const getAuthHeaders = useCallback(() => ({
    'Content-Type': 'application/json',
    'x-admin-password': localStorage.getItem('admin_password') || '',
  }), []);

  const [activeTab, setActiveTab] = useState('repositories');
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [repositories, setRepositories] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [settings, setSettings] = useState(null);
  const [collector, setCollector] = useState(null);
  const [selectedRepoId, setSelectedRepoId] = useState(null);
  const [trends, setTrends] = useState([]);
  const [actions, setActions] = useState([]);
  const [events, setEvents] = useState([]);
  const [traffic, setTraffic] = useState([]);
  const [contributors, setContributors] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [branches, setBranches] = useState([]);
  const [detailsRepoId, setDetailsRepoId] = useState(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rangeDays, setRangeDays] = useState('30');
  const [repoForm, setRepoForm] = useState({ url: '', token_id: '', collect_interval_seconds: 900, retention_days: 90, webhook_enabled: false });
  const [tokenForm, setTokenForm] = useState({ name: '', token: '', type: 'fine_grained', default_token: false });
  const [dispatchForm, setDispatchForm] = useState({ workflowId: '', ref: '' });
  const eventSourceRef = useRef(null);
  const dispatchDefaultedRepoRef = useRef(null);

  const selectedRepo = useMemo(
    () => repositories.find((repo) => String(repo.id) === String(selectedRepoId)) || repositories[0] || null,
    [repositories, selectedRepoId]
  );
  const canAttemptActionOperations = Boolean(
    selectedRepo?.authenticated && selectedRepo?.can_operate_actions
  );

  const api = useCallback(async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...getAuthHeaders(),
        ...(options.headers || {}),
      },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) {
      throw new Error(result.error || `请求失败: ${response.status}`);
    }
    return result.data !== undefined ? result.data : result;
  }, [getAuthHeaders]);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const [overview, tokenList] = await Promise.all([
        api('/api/github'),
        api('/api/github/tokens'),
      ]);
      const repos = overview.repositories || [];
      setRepositories(repos);
      setTokens(tokenList || []);
      setSettings(overview.settings || null);
      setCollector(overview.collector || null);
      setSelectedRepoId((current) => current || repos[0]?.id || null);
    } catch (error) {
      toast.error(error.message || '加载 GitHub 模块失败');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadRepoDetails = useCallback(async (repoId = selectedRepo?.id) => {
    if (!repoId) return;
    try {
      const [trendData, actionData, eventData, trafficData, contributorData, workflowData, branchData] = await Promise.all([
        api(`/api/github/repositories/${repoId}/trends?days=${rangeDays}`),
        api(`/api/github/repositories/${repoId}/actions/runs?limit=50`),
        api(`/api/github/repositories/${repoId}/events?limit=100`),
        api(`/api/github/repositories/${repoId}/traffic?limit=100`),
        api(`/api/github/repositories/${repoId}/contributors?limit=100`),
        api(`/api/github/repositories/${repoId}/actions/workflows`).catch(() => []),
        api(`/api/github/repositories/${repoId}/branches`).catch(() => []),
      ]);
      setTrends(trendData.snapshots || []);
      setActions(actionData || []);
      setEvents(eventData || []);
      setTraffic(trafficData || []);
      setContributors(contributorData || []);
      setWorkflows(workflowData || []);
      setBranches(branchData || []);
      setDetailsRepoId(String(repoId));
    } catch (error) {
      toast.error(error.message || '加载仓库详情失败');
    }
  }, [api, rangeDays, selectedRepo?.id]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    loadRepoDetails();
  }, [loadRepoDetails]);

  useEffect(() => {
    setWorkflows([]);
    setBranches([]);
    setDetailsRepoId(null);
    setDispatchForm({ workflowId: '', ref: '' });
    dispatchDefaultedRepoRef.current = null;
  }, [selectedRepo?.id]);

  useEffect(() => {
    const source = new EventSource('/api/github/events/stream', { withCredentials: true });
    eventSourceRef.current = source;
    source.addEventListener('github', (event) => {
      try {
        const payload = JSON.parse(event.data);
        setEvents((current) => [payload, ...current].slice(0, 100));
      } catch (error) {
        console.warn('Failed to parse GitHub event stream payload:', error);
      }
    });
    return () => {
      source.close();
      eventSourceRef.current = null;
    };
  }, []);

  const createToken = async () => {
    if (!tokenForm.name.trim() || !tokenForm.token.trim()) {
      toast.warning('请填写 Token 名称和 Token');
      return;
    }
    setSaving(true);
    try {
      await api('/api/github/tokens', {
        method: 'POST',
        body: JSON.stringify(tokenForm),
      });
      toast.success('GitHub Token 已保存');
      setTokenForm({ name: '', token: '', type: 'fine_grained', default_token: false });
      await loadOverview();
    } catch (error) {
      toast.error(error.message || '保存 Token 失败');
    } finally {
      setSaving(false);
    }
  };

  const testToken = async (id) => {
    try {
      const suffix = selectedRepo?.id ? `?repositoryId=${encodeURIComponent(selectedRepo.id)}&bind=true` : '';
      await api(`/api/github/tokens/${id}/test${suffix}`, { method: 'POST', body: '{}' });
      if (selectedRepo?.id) {
        await api(`/api/github/repositories/${selectedRepo.id}/refresh`, { method: 'POST', body: '{}' });
      }
      toast.success(selectedRepo?.id ? `Token 已检测并绑定到 ${selectedRepo.full_name}` : 'Token 基础权限检测完成');
      await loadOverview();
    } catch (error) {
      toast.error(error.message || 'Token 权限检测失败');
      await loadOverview();
    }
  };

  const deleteToken = async (token) => {
    if (!(await dialog.deleteResource({ resourceType: 'GitHub Token', resourceName: token.name }))) return;
    try {
      await api(`/api/github/tokens/${token.id}`, { method: 'DELETE' });
      toast.success('Token 已删除');
      await loadOverview();
    } catch (error) {
      toast.error(error.message || '删除 Token 失败');
    }
  };

  const createRepository = async () => {
    if (!repoForm.url.trim()) {
      toast.warning('请粘贴 GitHub 仓库 URL 或 owner/repo');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...repoForm,
        token_id: repoForm.token_id ? Number(repoForm.token_id) : null,
        collect_interval_seconds: Number(repoForm.collect_interval_seconds) || 900,
        retention_days: Number(repoForm.retention_days) || 90,
      };
      const repo = await api('/api/github/repositories', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast.success('仓库已添加，后台开始采集');
      setRepoForm({ url: '', token_id: '', collect_interval_seconds: 900, retention_days: 90, webhook_enabled: false });
      setRepoDialogOpen(false);
      setSelectedRepoId(repo.id);
      await loadOverview();
    } catch (error) {
      toast.error(error.message || '添加仓库失败');
    } finally {
      setSaving(false);
    }
  };

  const refreshRepository = async (id) => {
    try {
      await api(`/api/github/repositories/${id}/refresh`, { method: 'POST', body: '{}' });
      toast.success('仓库刷新完成');
      await loadOverview();
      await loadRepoDetails(id);
    } catch (error) {
      toast.error(error.message || '刷新仓库失败');
    }
  };

  const updateRepositoryToken = async (value) => {
    if (!selectedRepo?.id) return;
    setSaving(true);
    try {
      await api(`/api/github/repositories/${selectedRepo.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ token_id: value ? Number(value) : null }),
      });
      await api(`/api/github/repositories/${selectedRepo.id}/refresh`, { method: 'POST', body: '{}' });
      toast.success('仓库访问凭据已更新');
      await loadOverview();
      await loadRepoDetails(selectedRepo.id);
    } catch (error) {
      toast.error(error.message || '更新仓库访问凭据失败');
    } finally {
      setSaving(false);
    }
  };

  const deleteRepository = async (id) => {
    const repo = repositories.find((item) => item.id === id);
    if (!(await dialog.deleteResource({ resourceType: 'GitHub 仓库', resourceName: repo?.full_name || String(id) }))) return;
    try {
      await api(`/api/github/repositories/${id}?clean=false`, { method: 'DELETE' });
      toast.success('仓库已删除');
      setSelectedRepoId(null);
      await loadOverview();
    } catch (error) {
      toast.error(error.message || '删除仓库失败');
    }
  };

  const runCollector = async () => {
    try {
      await api('/api/github/collector/run', { method: 'POST', body: '{}' });
      toast.success('后台采集已执行');
      await loadOverview();
      await loadRepoDetails();
    } catch (error) {
      toast.error(error.message || '执行采集失败');
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const next = await api('/api/github/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      setSettings(next);
      toast.success('GitHub 设置已保存');
    } catch (error) {
      toast.error(error.message || '保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  const actionOperation = async (runId, operation) => {
    if (!selectedRepo) return;
    try {
      await api(`/api/github/repositories/${selectedRepo.id}/actions/runs/${runId}/${operation}`, {
        method: 'POST',
        body: '{}',
      });
      toast.success('Actions 操作已提交');
      await loadRepoDetails(selectedRepo.id);
    } catch (error) {
      toast.error(error.message || 'Actions 操作失败');
      await loadOverview();
    }
  };

  const dispatchWorkflow = async () => {
    if (!selectedRepo || !dispatchForm.workflowId.trim()) {
      toast.warning('请填写 workflow ID 或文件名');
      return;
    }
    try {
      await api(`/api/github/repositories/${selectedRepo.id}/actions/workflows/${encodeURIComponent(dispatchForm.workflowId.trim())}/dispatch`, {
        method: 'POST',
        body: JSON.stringify({ ref: dispatchForm.ref || selectedRepo.default_branch }),
      });
      toast.success('Workflow dispatch 已提交');
    } catch (error) {
      toast.error(error.message || '触发 Workflow 失败');
      await loadOverview();
    }
  };

  const configureWebhook = async () => {
    if (!selectedRepo) return;
    setSaving(true);
    try {
      const result = await api(`/api/github/repositories/${selectedRepo.id}/webhook/configure`, {
        method: 'POST',
        body: JSON.stringify({ payload_url: `${window.location.origin}/api/github/webhook/${selectedRepo.id}` }),
      });
      toast.success(result.created ? 'GitHub Webhook 已自动创建' : 'GitHub Webhook 已自动更新');
      await loadOverview();
    } catch (error) {
      toast.error(error.message || '自动配置 Webhook 失败');
    } finally {
      setSaving(false);
    }
  };

  const chartData = useMemo(() => {
    const points = trends.map((point) => ({
      ts: parseTimestamp(point.collected_at),
      stars: Number(point.stars) || 0,
      issues: Number(point.open_issues) || 0,
      prs: Number(point.open_pull_requests) || 0,
      commits: Number(point.commit_count) || 0,
      successRate: point.actions_total ? Math.round((Number(point.actions_success || 0) / Number(point.actions_total || 1)) * 100) : 0,
    }));
    return [
      { name: 'Stars', color: ChartPalette.semantic('Attention', isDarkMode), data: points.map((p) => [p.ts, p.stars]) },
      { name: 'Issues', color: ChartPalette.semantic('Warning', isDarkMode), data: points.map((p) => [p.ts, p.issues]) },
      { name: 'PR', color: ChartPalette.semantic('Info', isDarkMode), data: points.map((p) => [p.ts, p.prs]) },
      { name: '提交', color: ChartPalette.semantic('Success', isDarkMode), data: points.map((p) => [p.ts, p.commits]) },
      { name: 'Actions 成功率', color: ChartPalette.categorical(3, isDarkMode), data: points.map((p) => [p.ts, p.successRate]) },
    ];
  }, [isDarkMode, trends]);

  const repoOptions = repositories.map((repo) => ({ value: String(repo.id), label: repo.full_name }));
  const tokenOptions = [{ value: '', label: '默认/公开访问' }, ...tokens.map((token) => ({ value: String(token.id), label: token.name }))];
  const workflowOptions = [
    { value: '', label: workflows.length > 0 ? '选择 Workflow' : '未发现 Workflow' },
    ...workflows
      .filter((workflow) => !workflow.state || workflow.state === 'active')
      .map((workflow) => ({
        value: String(workflow.id || workflow.path),
        label: workflow.name ? `${workflow.name} (${workflow.path})` : workflow.path,
      })),
  ];
  const branchOptions = useMemo(() => {
    const branchNames = branches.map((branch) => branch.name).filter(Boolean);
    const availableBranchNames = selectedRepo?.default_branch && !branchNames.includes(selectedRepo.default_branch)
      ? [selectedRepo.default_branch, ...branchNames]
      : branchNames;
    return availableBranchNames.map((name) => ({ value: name, label: name }));
  }, [branches, selectedRepo?.default_branch]);

  useEffect(() => {
    if (branchOptions.length === 0) return;
    setDispatchForm((current) => ({
      ...current,
      ref: branchOptions.some((branch) => branch.value === current.ref) ? current.ref : branchOptions[0].value,
    }));
  }, [selectedRepo?.id, branchOptions]);

  useEffect(() => {
    if (String(detailsRepoId) !== String(selectedRepo?.id)) return;
    if (dispatchDefaultedRepoRef.current === String(selectedRepo?.id)) return;
    const lastSuccessfulRun = actions.find((run) => String(run.conclusion || '').toLowerCase() === 'success');
    if (!lastSuccessfulRun) return;
    const runWorkflowName = String(lastSuccessfulRun.workflow_name || lastSuccessfulRun.display_title || '').toLowerCase();
    const workflow = workflows.find((item) => (
      String(item.name || '').toLowerCase() === runWorkflowName ||
      String(item.path || '').toLowerCase() === runWorkflowName
    ));
    if (!workflow) return;
    const workflowId = String(workflow.id || workflow.path);
    const ref = branchOptions.some((branch) => branch.value === lastSuccessfulRun.branch)
      ? lastSuccessfulRun.branch
      : branchOptions[0]?.value || selectedRepo?.default_branch || '';
    dispatchDefaultedRepoRef.current = String(selectedRepo?.id);
    setDispatchForm((current) => (
      current.workflowId === workflowId && current.ref === ref ? current : { workflowId, ref }
    ));
  }, [actions, branchOptions, detailsRepoId, selectedRepo?.default_branch, selectedRepo?.id, workflows]);

  return (
    <div className="flex min-h-full w-full min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line pb-3">
        <Tabs
          {...MODULE_TABS_PROPS}
          value={activeTab}
          onValueChange={(value) => setActiveTab(String(value))}
          tabs={tabs}
        />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={loadOverview} loading={loading}>刷新</Button>
          <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />} onClick={runCollector}>立即采集</Button>
        </div>
      </div>

      {activeTab === 'repositories' && (
        <div className="min-w-0">
          <LayerCard className="p-0 shadow-none">
            <LayerCard.Secondary className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-kumo-line px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <GitBranch className="h-4 w-4 text-kumo-brand" />
                <Text variant="body" size="sm" bold>仓库列表</Text>
                <Badge variant="neutral">{repositories.length} 个仓库</Badge>
                <Badge variant={collector?.running ? 'success' : 'neutral'}>
                  {collector?.running ? '后台采集中' : '采集器待命'}
                </Badge>
              </div>
              <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRepoDialogOpen(true)}>添加仓库</Button>
            </LayerCard.Secondary>
            <LayerCard.Primary className="p-0">
            {repositories.length === 0 ? (
              <FillEmpty title="暂无 GitHub 仓库" description="粘贴仓库 URL 后即可开始观察指标、Actions 和趋势。" />
            ) : (
              <div className="grid items-start gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {repositories.map((repo) => {
                  const isSelected = String(repo.id) === String(selectedRepo?.id);
                  const actionStatus = repo.latest_action_conclusion || repo.latest_action_status || '未知';
                  const collectStatus = repo.last_status || 'pending';
                  const actionStartedAt = repo.latest_action_started_at || repo.latest_action_created_at;
                  const actionDuration = formatActionDuration(actionStartedAt, repo.latest_action_updated_at, currentTime);
                  return (
                    <LayerCard key={repo.id} className={`min-w-0 p-0 shadow-none ${isSelected ? 'ring-1 ring-kumo-brand/50' : ''}`}>
                      <LayerCard.Primary className="grid gap-3 p-3">
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 !items-start !justify-start !px-0 text-left" onClick={() => setSelectedRepoId(repo.id)}>
                            <span className="block min-w-0">
                              <span className="block truncate text-sm font-bold text-kumo-strong">{repo.full_name}</span>
                              <span className="block truncate text-[11px] text-kumo-subtle">{renderGitHubEmoji(repo.description || repo.html_url)}</span>
                            </span>
                          </Button>
                          <div className="flex shrink-0 items-center gap-1">
                            <Badge variant={repo.private ? 'warning' : 'success'}>{repo.private ? '私有' : '公开'}</Badge>
                            <Badge variant={repo.owned_by_token || repo.can_operate_actions ? 'success' : 'neutral'}>
                              {repo.owned_by_token ? '本人仓库' : repo.can_operate_actions ? '有写权限' : repo.authenticated ? '只读权限' : '未认证'}
                            </Badge>
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                          <RepositoryStat label="Stars" value={formatNumber(repo.stars)} />
                          <RepositoryStat label="Forks" value={formatNumber(repo.forks)} />
                          <RepositoryStat label="Issues" value={formatNumber(repo.open_issues)} />
                        </div>

                        <div className="grid gap-2 text-[11px] text-kumo-subtle">
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <span>Actions</span>
                            <div className="flex min-w-0 items-center justify-end gap-2">
                              {actionStartedAt && <span className="min-w-0 truncate" title={formatDateTime(actionStartedAt)}>{formatDateTime(actionStartedAt)}</span>}
                              <Badge variant={statusTone(actionStatus)}>{actionStartedAt ? `${statusLabel(actionStatus)} · ${actionDuration}` : statusLabel(actionStatus)}</Badge>
                            </div>
                          </div>
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <span>采集</span>
                            <div className="flex min-w-0 items-center justify-end gap-2">
                              <span className="min-w-0 truncate">{formatDateTime(repo.last_collected_at)}</span>
                              <Badge variant={statusTone(collectStatus)}>{statusLabel(collectStatus)}</Badge>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-1 border-t border-kumo-line pt-2">
                          {repo.html_url && <Button size="sm" variant="ghost" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => window.open(repo.html_url, '_blank')} aria-label="打开 GitHub" />}
                          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => refreshRepository(repo.id)} aria-label="刷新仓库" />
                          <Button size="sm" variant="ghost" icon={<Trash className="h-3.5 w-3.5" />} onClick={() => deleteRepository(repo.id)} aria-label="删除仓库" />
                        </div>
                      </LayerCard.Primary>
                    </LayerCard>
                  );
                })}
              </div>
            )}
            </LayerCard.Primary>
          </LayerCard>
        </div>
      )}

      {selectedRepo && activeTab !== 'repositories' && (
        <div className="flex min-w-0 flex-col gap-4">
          <LayerCard className="p-0 shadow-none">
            <LayerCard.Secondary className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-kumo-line px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <GitHubBrand className="h-4 w-4 text-kumo-brand" />
                <Text variant="body" size="sm" bold truncate>{selectedRepo.full_name}</Text>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Select
                  size="sm"
                  aria-label="仓库访问凭据"
                  value={selectedRepo.token_id ? String(selectedRepo.token_id) : ''}
                  onValueChange={updateRepositoryToken}
                  items={tokenOptions}
                  disabled={saving}
                />
                <Select
                  size="sm"
                  aria-label="选择 GitHub 仓库"
                  value={String(selectedRepo.id)}
                  onValueChange={setSelectedRepoId}
                  items={repoOptions}
                />
                <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => refreshRepository(selectedRepo.id)}>刷新仓库</Button>
              </div>
            </LayerCard.Secondary>
            <LayerCard.Primary className="p-4">
              <Grid variant="6up" gap="sm" className="items-start xl:grid-cols-5">
                <RepositoryMetric icon={<Star className="h-3.5 w-3.5" />} label="Stars" value={formatNumber(selectedRepo.stars)} />
                <RepositoryMetric icon={<GitBranch className="h-3.5 w-3.5" />} label="Forks" value={formatNumber(selectedRepo.forks)} />
                <RepositoryMetric icon={<Activity className="h-3.5 w-3.5" />} label="Issues / PR" value={`${formatNumber(selectedRepo.open_issues)} / ${formatNumber(selectedRepo.open_pull_requests)}`} />
                <RepositoryMetric icon={<Rocket className="h-3.5 w-3.5" />} label="Latest Release" value={selectedRepo.latest_release || '-'} />
                <RepositoryMetric icon={<Clock className="h-3.5 w-3.5" />} label="Rate Limit" value={selectedRepo.rate_limit_remaining ?? '-'} detail={selectedRepo.rate_limit_reset ? formatResetCountdown(selectedRepo.rate_limit_reset, currentTime) : ''} />
              </Grid>
            </LayerCard.Primary>
          </LayerCard>

          {activeTab === 'actions' && (
            <LayerCard className="p-0 shadow-none">
              <LayerCard.Secondary className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-kumo-line px-4 py-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-kumo-brand" />
                  <Text variant="body" size="sm" bold>Actions 活动</Text>
                </div>
                {canAttemptActionOperations ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select size="sm" className="w-64" aria-label="选择 Workflow" value={dispatchForm.workflowId} onValueChange={(value) => setDispatchForm((p) => ({ ...p, workflowId: value }))} items={workflowOptions} disabled={workflowOptions.length <= 1} />
                    <Select size="sm" className="w-40" aria-label="选择触发分支" value={dispatchForm.ref} onValueChange={(value) => setDispatchForm((p) => ({ ...p, ref: value }))} items={branchOptions} disabled={branchOptions.length === 0} />
                    <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />} onClick={dispatchWorkflow}>触发</Button>
                  </div>
                ) : (
                  <Badge variant="neutral">{selectedRepo.authenticated ? '当前 Token 未获得仓库写权限' : '未配置 Token，仅观察'}</Badge>
                )}
              </LayerCard.Secondary>
              <LayerCard.Primary className="p-0">
              {actions.length === 0 ? <FillEmpty title="暂无 Actions 记录" description="等待后台采集或手动刷新仓库后显示 workflow 运行记录。" /> : (
                <DataTableFrame variant="embedded" density="compact" className="overflow-auto scrollbar-thin">
                  <AppTable layout="fixed">
                    <colgroup>
                      <col style={{ width: '18%' }} />
                      <col style={{ width: '32%' }} />
                      <col style={{ width: '11%' }} />
                      <col style={{ width: '11%' }} />
                      <col style={{ width: '17%' }} />
                      <col style={{ width: '11%' }} />
                    </colgroup>
                    <Table.Header sticky variant="compact">
                      <Table.Row><Table.Head>Workflow</Table.Head><Table.Head className="align-middle">提交说明</Table.Head><Table.Head className="align-middle">分支</Table.Head><Table.Head className="align-middle text-center">状态</Table.Head><Table.Head className="align-middle text-center">时间</Table.Head><Table.Head className="align-middle text-center">操作</Table.Head></Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {actions.map((run) => (
                        <Table.Row key={run.run_id}>
                          <Table.Cell><div className="font-bold text-kumo-strong">{run.workflow_name || run.run_id}</div><div className="text-[11px] text-kumo-subtle">{run.actor} · {String(run.commit_sha || '').slice(0, 8)}</div></Table.Cell>
                          <Table.Cell className="align-middle"><div className="truncate text-sm leading-6 text-kumo-strong" title={run.commit_message || run.display_title || ''}>{run.commit_message || run.display_title || '暂无提交说明'}</div></Table.Cell>
                          <Table.Cell className="align-middle">{run.branch || '-'}</Table.Cell>
                          <Table.Cell className="align-middle text-center"><Badge variant={statusTone(run.conclusion || run.status)}>{`${statusLabel(run.conclusion || run.status)} · ${formatActionDuration(run.run_started_at || run.created_at, run.updated_at, currentTime)}`}</Badge></Table.Cell>
                          <Table.Cell className="align-middle text-center text-sm leading-6 text-kumo-strong">{formatDateTime(run.run_started_at || run.created_at)}</Table.Cell>
                          <Table.Cell className="align-middle text-center">
                            <div className="flex justify-center gap-1">
                              {run.html_url && <Button size="sm" variant="ghost" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => window.open(run.html_url, '_blank')} aria-label="打开 Actions" />}
                              {canAttemptActionOperations && (
                                <>
                                  <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => actionOperation(run.run_id, 'rerun')} aria-label="重新运行" />
                                  <Button size="sm" variant="ghost" icon={<Check className="h-3.5 w-3.5" />} onClick={() => actionOperation(run.run_id, 'rerun-failed-jobs')} aria-label="重跑失败任务" />
                                  <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => actionOperation(run.run_id, 'cancel')} aria-label="取消" />
                                </>
                              )}
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </AppTable>
                </DataTableFrame>
              )}
              </LayerCard.Primary>
            </LayerCard>
          )}

          {activeTab === 'trends' && (
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(20rem,0.7fr)]">
              <LayerCard className="p-0 shadow-none">
                <LayerCard.Secondary className="flex min-h-14 items-center justify-between gap-3 border-b border-kumo-line px-4 py-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-kumo-brand" />
                    <Text variant="body" size="sm" bold>仓库趋势</Text>
                  </div>
                  <Select size="sm" aria-label="趋势时间范围" value={rangeDays} onValueChange={setRangeDays} items={rangeOptions} />
                </LayerCard.Secondary>
                <LayerCard.Primary className="p-4">
                {trends.length >= 2 ? (
                  <ChartBoundaryBox>
                    {(tooltipBoundary) => (
                      <TimeseriesChart
                        echarts={echarts}
                        isDarkMode={isDarkMode}
                        type="line"
                        data={chartData}
                        height={320}
                        xAxisName="时间"
                        yAxisName="指标"
                        xAxisTickCount={4}
                        xAxisTickFormat={(value) => new Date(value).toLocaleDateString()}
                        yAxisTickFormat={(value) => `${Math.round(value)}`}
                        tooltipValueFormat={(value) => `${Math.round(value)}`}
                        tooltipBoundary={tooltipBoundary ?? undefined}
                        tooltipFollowCursor="x"
                        ariaDescription="GitHub 仓库趋势"
                      />
                    )}
                  </ChartBoundaryBox>
                ) : <FillEmpty title="趋势数据不足" description="等待后台完成至少两次采集后显示曲线。" />}
                </LayerCard.Primary>
              </LayerCard>
              <LayerCard className="self-start p-0 shadow-none">
                <LayerCard.Secondary className="flex min-h-14 items-center gap-2 border-b border-kumo-line px-4 py-3">
                  <Users className="h-4 w-4 text-kumo-brand" />
                  <Text variant="body" size="sm" bold>Traffic / Contributors</Text>
                </LayerCard.Secondary>
                <LayerCard.Primary className="grid content-start gap-3 p-4">
                  <RepositoryMetric label="Views" value={formatNumber(traffic[0]?.views)} detail={`唯一访客 ${formatNumber(traffic[0]?.view_uniques)}`} />
                  <RepositoryMetric label="Clones" value={formatNumber(traffic[0]?.clones)} detail={`唯一克隆 ${formatNumber(traffic[0]?.clone_uniques)}`} />
                  <RepositoryMetric label="Contributors" value={formatNumber(contributors.length)} detail={contributors.slice(0, 3).map((item) => item.login).join(', ') || '暂无贡献者数据'} />
                </LayerCard.Primary>
              </LayerCard>
            </div>
          )}

          {activeTab === 'events' && (
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
              <LayerCard className="p-0 shadow-none">
                <LayerCard.Secondary className="flex min-h-14 items-center gap-2 border-b border-kumo-line px-4 py-3">
                  <Bell className="h-4 w-4 text-kumo-brand" />
                  <Text variant="body" size="sm" bold>事件与通知源</Text>
                </LayerCard.Secondary>
                <LayerCard.Primary className="p-0">
                {events.length === 0 ? <FillEmpty title="暂无 GitHub 事件" description="Webhook 或后台采集触发后，事件会实时出现在这里。" /> : (
                  <DataTableFrame variant="embedded" density="compact" className="overflow-auto scrollbar-thin">
                    <AppTable layout="fixed">
                      <colgroup>
                        <col style={{ width: '42%' }} />
                        <col style={{ width: '16%' }} />
                        <col style={{ width: '18%' }} />
                        <col style={{ width: '24%' }} />
                      </colgroup>
                      <Table.Header sticky variant="compact">
                        <Table.Row><Table.Head>事件</Table.Head><Table.Head className="align-middle text-center">等级</Table.Head><Table.Head className="align-middle text-center">来源</Table.Head><Table.Head className="align-middle text-center">时间</Table.Head></Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {events.map((event, index) => (
                          <Table.Row key={event.id || `${event.event_type}-${index}`}>
                            <Table.Cell><div className="font-bold text-kumo-strong">{event.title || event.event_type}</div><div className="max-w-2xl truncate text-[11px] text-kumo-subtle">{event.message}</div></Table.Cell>
                            <Table.Cell className="align-middle text-center"><Badge variant={statusTone(event.severity)}>{statusLabel(event.severity)}</Badge></Table.Cell>
                            <Table.Cell className="align-middle text-center">{event.source || 'stream'}</Table.Cell>
                            <Table.Cell className="align-middle text-center text-[11px] text-kumo-subtle">{formatDateTime(event.created_at)}</Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </AppTable>
                  </DataTableFrame>
                )}
                </LayerCard.Primary>
              </LayerCard>
              <LayerCard className="self-start p-0 shadow-none">
                <LayerCard.Secondary className="flex min-h-14 items-center justify-between gap-2 border-b border-kumo-line px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Key className="h-4 w-4 text-kumo-brand" />
                    <Text variant="body" size="sm" bold>Webhook 配置</Text>
                  </div>
                  <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />} onClick={configureWebhook} loading={saving}>自动配置</Button>
                </LayerCard.Secondary>
                <LayerCard.Primary className="grid content-start gap-4 p-4">
                  <div className="grid gap-1">
                    <Text variant="secondary" size="xs">Payload URL</Text>
                    <ClipboardText size="sm" text={`${window.location.origin}/api/github/webhook/${selectedRepo.id}`} />
                  </div>
                  <div className="grid gap-1">
                    <Text variant="secondary" size="xs">Secret</Text>
                    <ClipboardText size="sm" text={selectedRepo.webhook_secret || '-'} />
                  </div>
                  <Text variant="secondary" size="xs">GitHub Webhook 选择 application/json，并启用 workflow_run、release、issues、pull_request、star 和 ping 事件。</Text>
                </LayerCard.Primary>
              </LayerCard>
            </div>
          )}
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <LayerCard className="self-start p-0 shadow-none">
            <LayerCard.Secondary className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-kumo-line px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <Key className="h-4 w-4 text-kumo-brand" />
                <Text variant="body" size="sm" bold>GitHub Token</Text>
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon={<ExternalLink className="h-3.5 w-3.5" />}
                onClick={() => window.open(fineGrainedTokenURL, '_blank', 'noopener,noreferrer')}
              >
                打开 GitHub 创建页
              </Button>
            </LayerCard.Secondary>
            <LayerCard.Primary className="grid gap-3 p-4">
              <Input size="sm" label="Token 名称" value={tokenForm.name} onChange={(e) => setTokenForm((p) => ({ ...p, name: e.target.value }))} placeholder="生产账号" />
              <Input size="sm" label="Token" value={tokenForm.token} onChange={(e) => setTokenForm((p) => ({ ...p, token: e.target.value }))} placeholder="github_pat_..." autoComplete="off" spellCheck={false} className="font-mono" />
              <Grid variant="2up" gap="sm">
                <Select size="sm" label="Token 类型" value={tokenForm.type} onValueChange={(value) => setTokenForm((p) => ({ ...p, type: value }))} items={tokenTypeOptions} />
                <Switch size="sm" label="设为默认" controlFirst={false} checked={tokenForm.default_token} onCheckedChange={(checked) => setTokenForm((p) => ({ ...p, default_token: Boolean(checked) }))} />
              </Grid>
              <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />} onClick={createToken} loading={saving}>保存 Token</Button>
              {tokens.length > 0 && (
                <div className="grid items-start gap-3 sm:grid-cols-2">
                  {tokens.map((token) => (
                    <LayerCard key={token.id} className="min-w-0 p-0 shadow-none">
                      <LayerCard.Primary className="grid gap-3 p-3">
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <Text variant="body" size="sm" bold truncate>{token.name}</Text>
                              {token.default_token && <Badge variant="success">默认</Badge>}
                            </div>
                            <Text variant="secondary" size="xs">{token.type}</Text>
                          </div>
                          <Badge variant={statusTone(token.last_test_status)}>{tokenTestStatusLabel(token.last_test_status)}</Badge>
                        </div>
                        <PermissionChecks token={token} />
                        <div className="flex items-center justify-end gap-2 border-t border-kumo-line pt-2">
                          <Button size="sm" variant="secondary" onClick={() => testToken(token.id)}>
                            {selectedRepo ? '检测并用于当前仓库' : '检测权限'}
                          </Button>
                          <Button size="sm" variant="ghost" icon={<Trash className="h-3.5 w-3.5" />} onClick={() => deleteToken(token)} aria-label="删除 Token" />
                        </div>
                      </LayerCard.Primary>
                    </LayerCard>
                  ))}
                </div>
              )}
            </LayerCard.Primary>
          </LayerCard>

          <LayerCard className="self-start p-0 shadow-none">
            <LayerCard.Secondary className="flex min-h-14 items-center gap-2 border-b border-kumo-line px-4 py-3">
              <Settings className="h-4 w-4 text-kumo-brand" />
              <Text variant="body" size="sm" bold>采集与保留</Text>
            </LayerCard.Secondary>
            <LayerCard.Primary className="p-4">
            {settings ? (
              <div className="grid gap-3">
                <Switch size="sm" label="启用后台采集" controlFirst={false} checked={settings.enabled} onCheckedChange={(checked) => setSettings((p) => ({ ...p, enabled: Boolean(checked) }))} />
                <Input size="sm" label="默认采集间隔（秒）" type="number" min="60" value={settings.default_collect_interval_seconds} onChange={(e) => setSettings((p) => ({ ...p, default_collect_interval_seconds: Number(e.target.value) }))} />
                <Input size="sm" label="默认保留天数" type="number" min="1" value={settings.default_retention_days} onChange={(e) => setSettings((p) => ({ ...p, default_retention_days: Number(e.target.value) }))} />
                <Input size="sm" label="Rate Limit 低额度阈值" type="number" min="0" value={settings.rate_limit_low_threshold} onChange={(e) => setSettings((p) => ({ ...p, rate_limit_low_threshold: Number(e.target.value) }))} />
                <Input size="sm" label="Star 激增阈值" type="number" min="1" value={settings.star_spike_threshold} onChange={(e) => setSettings((p) => ({ ...p, star_spike_threshold: Number(e.target.value) }))} />
                <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />} onClick={saveSettings} loading={saving}>保存设置</Button>
              </div>
            ) : (
              <FillEmpty title="设置加载中" />
            )}
            </LayerCard.Primary>
          </LayerCard>
        </div>
      )}

      {!selectedRepo && activeTab !== 'repositories' && (
        <LayerCard className="p-0 shadow-none">
          <FillEmpty title="暂无仓库详情" description="请先添加或选择一个 GitHub 仓库。" />
        </LayerCard>
      )}

      <Dialog.Root open={repoDialogOpen} onOpenChange={setRepoDialogOpen}>
        <Dialog className="flex max-h-[min(calc(100dvh-2rem),34rem)] w-[min(calc(100vw-2rem),38rem)] flex-col overflow-hidden p-0">
          <div className="border-b border-kumo-line bg-kumo-recessed/20 px-5 py-4">
            <Dialog.Title className="text-base font-semibold text-kumo-strong">添加 GitHub 仓库</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-kumo-subtle">
              支持 GitHub URL、owner/repo、公开仓库和私有仓库。
            </Dialog.Description>
          </div>
          <form
            className="min-h-0 flex-1 overflow-y-auto"
            onSubmit={(event) => {
              event.preventDefault();
              createRepository();
            }}
          >
            <div className="grid gap-4 px-5 py-4">
              <Input
                size="sm"
                label="GitHub 仓库"
                value={repoForm.url}
                onChange={(e) => setRepoForm((p) => ({ ...p, url: e.target.value }))}
                placeholder="https://github.com/owner/repo 或 owner/repo"
                autoFocus
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  size="sm"
                  label="访问凭据"
                  value={repoForm.token_id}
                  onValueChange={(value) => setRepoForm((p) => ({ ...p, token_id: value }))}
                  items={tokenOptions}
                />
                <Input
                  size="sm"
                  label="采集间隔（秒）"
                  type="number"
                  min="60"
                  value={repoForm.collect_interval_seconds}
                  onChange={(e) => setRepoForm((p) => ({ ...p, collect_interval_seconds: e.target.value }))}
                />
                <Input
                  size="sm"
                  label="数据保留（天）"
                  type="number"
                  min="1"
                  value={repoForm.retention_days}
                  onChange={(e) => setRepoForm((p) => ({ ...p, retention_days: e.target.value }))}
                />
                <Switch
                  size="sm"
                  label="启用 Webhook"
                  controlFirst={false}
                  checked={repoForm.webhook_enabled}
                  onCheckedChange={(checked) => setRepoForm((p) => ({ ...p, webhook_enabled: Boolean(checked) }))}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-kumo-line bg-kumo-recessed/25 px-5 py-3">
              <Dialog.Close render={(props) => <Button type="button" size="sm" variant="secondary" {...props}>取消</Button>} />
              <Button type="submit" size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={saving}>添加仓库</Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}

export default GitHubPage;
