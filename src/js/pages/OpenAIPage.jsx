import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { CalendarDotsIcon } from '@phosphor-icons/react';
import { toast } from '../modules/toast.js';
import { dialog } from '../modules/dialog.js';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input, Textarea } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { Switch } from '@cloudflare/kumo/components/switch';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import { Autocomplete } from '@cloudflare/kumo/components/autocomplete';
import {
  ClipboardText,
  DatePicker,
  Label,
  LayerCard,
  Loader,
  Meter,
  Pagination,
  Popover,
  Table,
  Tabs,
} from '@cloudflare/kumo';
import { MODULE_TABS_PROPS, TOOL_TABS_PROPS } from '../modules/kumoTabs.js';
import { handleEditableRowDoubleClick } from '../modules/tableInteractions.js';
import { renderMarkdown, formatDateTime } from '../modules/utils.js';
import {
  DEFAULT_MODEL_HEALTH_CONCURRENCY,
  MAX_BATCH_MODEL_HEALTH_TARGETS,
  countModelHealthResults,
  endpointModelIds,
  limitModelHealthTargets,
  modelHealthKey,
  modelHealthTargets,
  normalizeModelHealthRecord,
  resolveModelHealthConcurrency,
} from '../modules/openaiModelHealth.js';
import {
  PageStack,
  PageToolbar,
  AppCard,
  InlineStatusPill,
  EmptyState,
  iconButtonIconClass,
  actionIconClass,
  cx,
} from '../components/ui/AppPrimitives.jsx';
import {
  Server,
  MessageSquare,
  Plus,
  Trash,
  RotateCw,
  Search,
  Upload,
  Download,
  Edit,
  X,
  RefreshCw,
  History,
  PieChart,
  Bot,
  Star,
  Pin,
  Activity,
  Send,
  Check,
  Paperclip,
  Brain,
  Sliders,
  Settings as SettingsIcon,
  Copy,
  AlertTriangle,
  Key,
  Reboot,
} from '../components/Icons.jsx';

function createHealthCheckProgress(total = 0, running = false) {
  return { running, total, completed: 0, healthy: 0, degraded: 0, failed: 0 };
}

const GATEWAY_EXPIRY_HOURS = Array.from({ length: 24 }, (_, hour) => {
  const value = String(hour).padStart(2, '0');
  return { value, label: value };
});

const GATEWAY_EXPIRY_MINUTES = Array.from({ length: 60 }, (_, minute) => {
  const value = String(minute).padStart(2, '0');
  return { value, label: value };
});

function toLocalDateTimeValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function parseLocalDateTime(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function GatewaySection({
  title,
  description,
  icon,
  actions,
  className = '',
  bodyClassName = '',
  children,
}) {
  return (
    <section className={cx('flex flex-col gap-3', className)}>
      <header className="flex min-h-10 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <h2 className="flex items-center gap-2 font-semibold text-kumo-strong">
            {icon}
            <span>{title}</span>
          </h2>
          {description && <p className="text-kumo-subtle">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

function OpenAIPage() {
  const gatewayOrigin = useMemo(() => {
    if (typeof window === 'undefined') return 'http://localhost:3000';
    const url = new URL(window.location.origin);
    if (url.port === '5173' || url.port === '4173') url.port = '3000';
    return url.origin;
  }, []);

  // Tab State
  const [activeTab, setActiveTab] = useState('endpoints'); // 'endpoints' | 'keys' | 'analytics'

  // Gateway Analytics States
  const [analyticsDays, setAnalyticsDays] = useState(7);
  const [analyticsSummary, setAnalyticsSummary] = useState({
    totalRequests: 0,
    avgLatency: 0,
    totalTokens: 0,
    errorRate: 0,
  });
  const [analyticsCharts, setAnalyticsCharts] = useState({
    models: [],
  });
  const [analyticsLogs, setAnalyticsLogs] = useState([]);
  const [analyticsPage, setAnalyticsPage] = useState(1);
  const [analyticsPageSize, setAnalyticsPageSize] = useState(20);
  const [analyticsTotal, setAnalyticsTotal] = useState(0);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const getAuthHeaders = useCallback(() => {
    return {
      'Content-Type': 'application/json',
    };
  }, []);

  const fetchAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    try {
      const headers = getAuthHeaders();
      const [sumRes, chartsRes, logsRes] = await Promise.all([
        fetch(`/api/openai/analytics/summary?days=${analyticsDays}`, { headers }),
        fetch(`/api/openai/analytics/charts?days=${analyticsDays}`, { headers }),
        fetch(
          `/api/openai/analytics/logs?days=${analyticsDays}&page=${analyticsPage}&pageSize=${analyticsPageSize}`,
          { headers }
        ),
      ]);

      if (sumRes.ok) {
        const data = await sumRes.json();
        setAnalyticsSummary(data);
      }
      if (chartsRes.ok) {
        const data = await chartsRes.json();
        setAnalyticsCharts(data);
      }
      if (logsRes.ok) {
        const data = await logsRes.json();
        setAnalyticsLogs(data.records || []);
        setAnalyticsTotal(data.total || 0);
      }
    } catch (err) {
      console.error('Failed to fetch analytics:', err);
      toast.error('获取分析数据失败');
    } finally {
      setAnalyticsLoading(false);
    }
  }, [analyticsDays, analyticsPage, analyticsPageSize, getAuthHeaders]);

  useEffect(() => {
    if (activeTab === 'analytics') {
      fetchAnalytics();
    }
  }, [activeTab, fetchAnalytics]);

  const chatStorage = useMemo(() => {
    const personasKey = 'openai_chat_personas_v2';
    const sessionsKey = 'openai_chat_sessions_v2';
    const messagesKey = 'openai_chat_messages_v2';
    const defaultPersona = {
      id: 1,
      name: '默认助手',
      icon: 'fa-robot',
      system_prompt: '你是一个有用的 AI 助手。',
      is_default: 1,
    };

    const readJson = (key, fallback) => {
      try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
      } catch {
        return fallback;
      }
    };
    const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    const readPersonas = () => {
      const loaded = readJson(personasKey, [defaultPersona]);
      return Array.isArray(loaded) && loaded.length > 0 ? loaded : [defaultPersona];
    };
    const readSessions = () => {
      const loaded = readJson(sessionsKey, []);
      return Array.isArray(loaded) ? loaded : [];
    };
    const readMessages = () => readJson(messagesKey, {});
    const writeMessagesForSession = (sessionId, nextMessages) => {
      const bySession = readMessages();
      bySession[sessionId] = nextMessages;
      writeJson(messagesKey, bySession);
    };

    return {
      defaultPersona,
      readPersonas,
      savePersonas: nextPersonas => writeJson(personasKey, nextPersonas),
      readSessions,
      saveSessions: nextSessions => writeJson(sessionsKey, nextSessions),
      readSessionMessages: sessionId => {
        const messagesBySession = readMessages();
        return Array.isArray(messagesBySession[sessionId]) ? messagesBySession[sessionId] : [];
      },
      saveSessionMessages: writeMessagesForSession,
      deleteSessionMessages: sessionId => {
        const bySession = readMessages();
        delete bySession[sessionId];
        writeJson(messagesKey, bySession);
      },
      newId: () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    };
  }, []);

  // ==================== 1. Endpoints & Gateway Keys State ====================
  const [endpoints, setEndpoints] = useState([]);
  const [endpointsLoading, setEndpointsLoading] = useState(false);
  const [endpointsRefreshing, setEndpointsRefreshing] = useState(false);
  const [endpointToggleLoading, setEndpointToggleLoading] = useState({});
  const [selectedEndpointId, setSelectedEndpointId] = useState('');
  const [endpointFormOpen, setEndpointFormOpen] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState(null);
  const [endpointForm, setEndpointForm] = useState({
    name: '',
    baseUrl: '',
    apiKey: '',
    notes: '',
  });
  const [endpointFormError, setEndpointFormError] = useState('');
  const [endpointSaving, setEndpointSaving] = useState(false);
  const [gatewayKeys, setGatewayKeys] = useState([]);
  const [gatewayKeysLoading, setGatewayKeysLoading] = useState(false);
  const [gatewayKeyToggleLoading, setGatewayKeyToggleLoading] = useState({});
  const [gatewayKeyDialogOpen, setGatewayKeyDialogOpen] = useState(false);
  const [editingGatewayKey, setEditingGatewayKey] = useState(null);
  const [gatewayKeyForm, setGatewayKeyForm] = useState({ name: '', expiresAt: '' });
  const [gatewayKeyFormError, setGatewayKeyFormError] = useState('');
  const [gatewayKeySaving, setGatewayKeySaving] = useState(false);
  const [newGatewayKey, setNewGatewayKey] = useState(null);

  // Batch adding endpoints
  // Load Endpoints
  const loadEndpoints = useCallback(
    async (silent = false) => {
      if (!silent) setEndpointsLoading(true);
      try {
        const response = await fetch('/api/openai/endpoints', {
          headers: getAuthHeaders(),
        });
        const data = await response.json();
        if (Array.isArray(data)) {
          setEndpoints(data.map(ep => ({ ...ep, showKey: false, refreshing: false })));
        }
      } catch (error) {
        console.error('Failed to load endpoints:', error);
        toast.error('加载端点失败');
      } finally {
        if (!silent) setEndpointsLoading(false);
      }
    },
    [getAuthHeaders]
  );

  useEffect(() => {
    localStorage.removeItem('openai_endpoints_cache');
    loadEndpoints();
  }, [loadEndpoints]);

  const loadGatewayKeys = useCallback(async () => {
    setGatewayKeysLoading(true);
    try {
      const response = await fetch('/api/openai/keys', { headers: getAuthHeaders() });
      const data = await response.json().catch(() => []);
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setGatewayKeys(Array.isArray(data) ? data : []);
    } catch (error) {
      toast.error('加载网关密钥失败: ' + error.message);
    } finally {
      setGatewayKeysLoading(false);
    }
  }, [getAuthHeaders]);

  useEffect(() => {
    if (activeTab === 'keys') {
      loadGatewayKeys();
    }
  }, [activeTab, loadGatewayKeys]);

  const selectedEndpoint = useMemo(
    () => endpoints.find(endpoint => endpoint.id === selectedEndpointId) || endpoints[0] || null,
    [endpoints, selectedEndpointId]
  );

  useEffect(() => {
    if (endpoints.length === 0) {
      setSelectedEndpointId('');
      return;
    }
    if (!endpoints.some(endpoint => endpoint.id === selectedEndpointId)) {
      setSelectedEndpointId(endpoints[0].id);
    }
  }, [endpoints, selectedEndpointId]);

  // Endpoint Verification & Model Refresh
  const verifyEndpoint = async endpoint => {
    try {
      toast.info(`正在验证 ${endpoint.name || '端点'}...`);
      const response = await fetch(`/api/openai/endpoints/${endpoint.id}/verify`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await response.json();
      if (data.valid) {
        toast.success(`验证成功！找到 ${data.modelsCount || 0} 个模型`);
        await loadEndpoints(true);
      } else {
        toast.error('验证失败: ' + (data.error || 'API Key 无效'));
      }
    } catch (error) {
      toast.error('验证失败: ' + error.message);
    }
  };

  const refreshEndpointModels = async endpoint => {
    if (endpoint.refreshing) return;
    // Set local refreshing
    setEndpoints(prev => prev.map(e => (e.id === endpoint.id ? { ...e, refreshing: true } : e)));
    try {
      const response = await fetch(`/api/openai/endpoints/${endpoint.id}/verify`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await response.json();
      if (data.valid) {
        toast.success(`${endpoint.name || '端点'} 模型列表已更新`);
        await loadEndpoints(true);
      } else {
        toast.error('刷新失败: ' + (data.error || 'API Key 无效'));
      }
    } catch (error) {
      toast.error('刷新失败: ' + error.message);
    } finally {
      setEndpoints(prev => prev.map(e => (e.id === endpoint.id ? { ...e, refreshing: false } : e)));
    }
  };

  const refreshAllEndpoints = async () => {
    setEndpointsRefreshing(true);
    try {
      const response = await fetch('/api/openai/endpoints/refresh', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await response.json();
      if (data.success) {
        const successCount = data.results?.filter(r => r.success).length || 0;
        toast.success(`刷新完成！已更新 ${successCount} 个启用端点`);
        await loadEndpoints(true);
      } else {
        toast.error('刷新失败: ' + (data.error || '未知错误'));
      }
    } catch (error) {
      toast.error('刷新失败: ' + error.message);
    } finally {
      setEndpointsRefreshing(false);
    }
  };

  const toggleEndpointEnabled = async endpoint => {
    if (endpointToggleLoading[endpoint.id]) return;
    const updatedEnabled = !endpoint.enabled;
    setEndpointToggleLoading(prev => ({ ...prev, [endpoint.id]: true }));
    try {
      const response = await fetch(`/api/openai/endpoints/${endpoint.id}/toggle`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ enabled: updatedEnabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || '未知错误');

      const confirmedEnabled = Boolean(data.enabled);
      setEndpoints(prev =>
        prev.map(e => (e.id === endpoint.id ? { ...e, enabled: confirmedEnabled } : e))
      );
      const endpointName = endpoint.name || '端点';
      toast.success(confirmedEnabled ? `${endpointName} 已启用` : `${endpointName} 已停用`);
      await loadAllModels(true);
    } catch (error) {
      toast.error('操作失败: ' + error.message);
    } finally {
      setEndpointToggleLoading(prev => ({ ...prev, [endpoint.id]: false }));
    }
  };

  const openAddEndpointModal = () => {
    setEditingEndpoint(null);
    setEndpointForm({ name: '', baseUrl: '', apiKey: '', notes: '' });
    setEndpointFormError('');
    setEndpointFormOpen(true);
  };

  const openEditEndpointModal = endpoint => {
    setEditingEndpoint(endpoint);
    setEndpointForm({
      name: endpoint.name || '',
      baseUrl: endpoint.baseUrl || '',
      apiKey: endpoint.apiKey || '',
      notes: endpoint.notes || '',
    });
    setEndpointFormError('');
    setEndpointFormOpen(true);
  };

  const saveEndpoint = async () => {
    if (!endpointForm.baseUrl || !endpointForm.apiKey) {
      setEndpointFormError('请填写 API 地址和 API Key');
      return;
    }
    setEndpointSaving(true);
    setEndpointFormError('');
    try {
      const url = editingEndpoint
        ? `/api/openai/endpoints/${editingEndpoint.id}`
        : '/api/openai/endpoints';
      const response = await fetch(url, {
        method: editingEndpoint ? 'PUT' : 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(endpointForm),
      });
      const data = await response.json();
      if (response.ok && (data.success || data.endpoint || data.id)) {
        toast.success(editingEndpoint ? '端点已更新' : '端点已添加');
        setEndpointFormOpen(false);
        await loadEndpoints(true);
        loadAllModels(true);
      } else {
        setEndpointFormError(data.error || '保存失败');
      }
    } catch (error) {
      setEndpointFormError('保存失败: ' + error.message);
    } finally {
      setEndpointSaving(false);
    }
  };

  const deleteEndpoint = async endpoint => {
    if (!(await dialog.confirm(`确定要删除端点 "${endpoint.name || endpoint.baseUrl}" 吗？`))) {
      return;
    }
    try {
      const response = await fetch(`/api/openai/endpoints/${endpoint.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        toast.success('端点已删除');
        await loadEndpoints(true);
        loadAllModels(true);
      } else {
        toast.error('删除失败: ' + (data.error || '未知错误'));
      }
    } catch (error) {
      toast.error('删除失败: ' + error.message);
    }
  };

  // ==================== 2. Health Checking ====================
  const [openaiModelHealth, setOpenaiModelHealth] = useState(() => {
    try {
      const saved = localStorage.getItem('openai_model_health_cache');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem('openai_model_health_cache', JSON.stringify(openaiModelHealth));
  }, [openaiModelHealth]);

  const [modelHealthBatchLoading, setModelHealthBatchLoading] = useState(false);
  const [healthCheckProgress, setHealthCheckProgress] = useState(() => createHealthCheckProgress());
  const [healthCheckModal, setHealthCheckModal] = useState(false);
  const [healthCheckForm, setHealthCheckForm] = useState({
    timeout: 30,
    concurrency: DEFAULT_MODEL_HEALTH_CONCURRENCY,
  });
  const modelHealthAbortControllersRef = useRef(new Map());

  const markModelsChecking = targets => {
    const checkedAt = Date.now();
    setOpenaiModelHealth(prev => {
      const next = { ...prev };
      targets.forEach(({ endpointId, modelId }) => {
        next[modelHealthKey(endpointId, modelId)] = {
          status: 'checking',
          loading: true,
          latency: null,
          checkedAt,
        };
      });
      return next;
    });
  };

  const openAddGatewayKeyModal = () => {
    setEditingGatewayKey(null);
    setGatewayKeyForm({ name: '', expiresAt: '' });
    setGatewayKeyFormError('');
    setGatewayKeyDialogOpen(true);
  };

  const openEditGatewayKeyModal = key => {
    setEditingGatewayKey(key);
    setGatewayKeyForm({
      name: key.name || '',
      expiresAt: key.expiresAt ? toLocalDateTimeValue(new Date(key.expiresAt)) : '',
    });
    setGatewayKeyFormError('');
    setGatewayKeyDialogOpen(true);
  };

  const normalizeGatewayKeyForm = () => ({
    name: gatewayKeyForm.name.trim(),
    expiresAt: gatewayKeyForm.expiresAt ? new Date(gatewayKeyForm.expiresAt).toISOString() : '',
  });

  const updateGatewayKeyExpiryDate = date => {
    if (!date) return;
    setGatewayKeyForm(current => {
      const existing = parseLocalDateTime(current.expiresAt);
      const next = new Date(date);
      next.setHours(existing?.getHours() ?? 23, existing?.getMinutes() ?? 59, 0, 0);
      return { ...current, expiresAt: toLocalDateTimeValue(next) };
    });
  };

  const updateGatewayKeyExpiryTime = (part, value) => {
    setGatewayKeyForm(current => {
      const next = parseLocalDateTime(current.expiresAt);
      if (!next) return current;
      if (part === 'hour') next.setHours(Number(value));
      if (part === 'minute') next.setMinutes(Number(value));
      return { ...current, expiresAt: toLocalDateTimeValue(next) };
    });
  };

  const saveGatewayKey = async () => {
    const payload = normalizeGatewayKeyForm();
    if (!payload.name) {
      setGatewayKeyFormError('请填写密钥名称');
      return;
    }
    setGatewayKeySaving(true);
    setGatewayKeyFormError('');
    try {
      const response = await fetch(
        editingGatewayKey ? `/api/openai/keys/${editingGatewayKey.id}` : '/api/openai/keys',
        {
          method: editingGatewayKey ? 'PUT' : 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || '保存失败');
      setGatewayKeyDialogOpen(false);
      if (data.apiKey) {
        setNewGatewayKey({ name: payload.name, apiKey: data.apiKey });
      }
      toast.success(editingGatewayKey ? '密钥已更新' : '密钥已创建');
      await loadGatewayKeys();
    } catch (error) {
      setGatewayKeyFormError(error.message);
    } finally {
      setGatewayKeySaving(false);
    }
  };

  const toggleGatewayKey = async key => {
    if (gatewayKeyToggleLoading[key.id]) return;
    const nextEnabled = !key.enabled;
    setGatewayKeyToggleLoading(prev => ({ ...prev, [key.id]: true }));
    try {
      const response = await fetch(`/api/openai/keys/${key.id}/toggle`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || '更新失败');
      const confirmedEnabled = Boolean(data.enabled);
      setGatewayKeys(prev =>
        prev.map(item => (item.id === key.id ? { ...item, enabled: confirmedEnabled } : item))
      );
      toast.success(confirmedEnabled ? `${key.name} 已启用` : `${key.name} 已停用`);
    } catch (error) {
      toast.error('更新密钥状态失败: ' + error.message);
    } finally {
      setGatewayKeyToggleLoading(prev => ({ ...prev, [key.id]: false }));
    }
  };

  const rotateGatewayKey = async key => {
    if (!(await dialog.confirm(`确认轮换 "${key.name}"？旧密钥会立即失效。`))) return;
    try {
      const response = await fetch(`/api/openai/keys/${key.id}/rotate`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || '轮换失败');
      setNewGatewayKey({ name: key.name, apiKey: data.apiKey });
      toast.success('密钥已轮换');
      await loadGatewayKeys();
    } catch (error) {
      toast.error('轮换密钥失败: ' + error.message);
    }
  };

  const deleteGatewayKey = async key => {
    if (!(await dialog.confirm(`确定删除网关密钥 "${key.name}" 吗？`))) return;
    try {
      const response = await fetch(`/api/openai/keys/${key.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || '删除失败');
      toast.success('密钥已删除');
      await loadGatewayKeys();
    } catch (error) {
      toast.error('删除密钥失败: ' + error.message);
    }
  };

  const applyEndpointHealthResults = (endpointId, modelIds, records, fallbackError) => {
    const recordsByModel = new Map(
      (Array.isArray(records) ? records : []).map(record => [
        String(record?.model || '').trim(),
        record,
      ])
    );
    const results = modelIds.map(modelId =>
      normalizeModelHealthRecord(recordsByModel.get(modelId), fallbackError)
    );

    setOpenaiModelHealth(prev => {
      const next = { ...prev };
      modelIds.forEach((modelId, index) => {
        next[modelHealthKey(endpointId, modelId)] = results[index];
      });
      return next;
    });

    return results;
  };

  const testModelHealth = async (model, targetEndpointId, silentToast = false) => {
    const modelId = String(model?.id || '').trim();
    if (!modelId || !targetEndpointId) return null;
    const healthKey = modelHealthKey(targetEndpointId, modelId);
    const activeController = modelHealthAbortControllersRef.current.get(healthKey);
    if (activeController) {
      activeController.abort();
      modelHealthAbortControllersRef.current.delete(healthKey);
      setOpenaiModelHealth(prev => ({
        ...prev,
        [healthKey]: {
          status: 'cancelled',
          loading: false,
          latency: null,
          checkedAt: Date.now(),
          error: '检测已停止',
        },
      }));
      if (!silentToast) toast.warning(`${modelId} 检测已停止`);
      return null;
    }

    const controller = new AbortController();
    modelHealthAbortControllersRef.current.set(healthKey, controller);

    markModelsChecking([{ endpointId: targetEndpointId, modelId }]);

    try {
      const response = await fetch(
        `/api/openai/endpoints/${encodeURIComponent(targetEndpointId)}/health-check`,
        {
          method: 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: modelId,
            timeout: Math.max(1, Number(healthCheckForm.timeout) || 30) * 1000,
          }),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      const result = applyEndpointHealthResults(targetEndpointId, [modelId], [data])[0];
      if (!silentToast) {
        if (result.status === 'healthy') {
          toast.success(`${modelId} 可用，延迟 ${result.latency ?? '-'} ms`);
        } else if (result.status === 'degraded') {
          toast.warning(`${modelId} 响应较慢，延迟 ${result.latency ?? '-'} ms`);
        } else {
          toast.error(`${modelId} 检测失败: ${result.error || '未知错误'}`);
        }
      }
      return result;
    } catch (e) {
      if (controller.signal.aborted) return null;
      const result = applyEndpointHealthResults(targetEndpointId, [modelId], [], e.message)[0];
      if (!silentToast) toast.error(`${modelId} 检测失败: ${result.error || e.message}`);
      return result;
    } finally {
      if (modelHealthAbortControllersRef.current.get(healthKey) === controller) {
        modelHealthAbortControllersRef.current.delete(healthKey);
      }
    }
  };

  const runModelHealthChecksWithPool = async targets => {
    if (!Array.isArray(targets) || targets.length === 0) return [];

    const results = new Array(targets.length);
    const concurrency = resolveModelHealthConcurrency(healthCheckForm.concurrency, targets.length);
    let cursor = 0;

    const commitProgress = result => {
      const healthy = result?.status === 'healthy' ? 1 : 0;
      const degraded = result?.status === 'degraded' ? 1 : 0;
      const failed = healthy || degraded ? 0 : 1;
      setHealthCheckProgress(prev => ({
        ...prev,
        completed: Math.min(prev.total, prev.completed + 1),
        healthy: prev.healthy + healthy,
        degraded: prev.degraded + degraded,
        failed: prev.failed + failed,
      }));
    };

    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= targets.length) return;

        const target = targets[index];
        const result = await testModelHealth({ id: target.modelId }, target.endpointId, true);
        const normalizedResult =
          result ||
          normalizeModelHealthRecord(
            {
              status: 'failed',
              error: '检测未返回结果',
              checkedAt: Date.now(),
            },
            '检测未返回结果'
          );

        results[index] = normalizedResult;
        commitProgress(normalizedResult);
      }
    });

    await Promise.all(workers);
    return results;
  };

  const runEndpointHealthCheck = async endpoint =>
    runModelHealthChecksWithPool(
      endpointModelIds(endpoint).map(modelId => ({ endpointId: endpoint.id, modelId }))
    );

  const runAllEndpointHealthChecks = async targets => runModelHealthChecksWithPool(targets);

  const startBatchHealthCheck = async () => {
    const endpointTargets = endpoints.filter(
      endpoint => endpoint.enabled && endpointModelIds(endpoint).length > 0
    );
    const allTargets = modelHealthTargets(endpointTargets);
    const targets = limitModelHealthTargets(allTargets);
    const concurrency = resolveModelHealthConcurrency(healthCheckForm.concurrency, targets.length);
    if (allTargets.length === 0) {
      toast.warning('没有找到任何启用的端点或模型');
      return;
    }

    setHealthCheckModal(false);
    setModelHealthBatchLoading(true);
    setHealthCheckProgress(createHealthCheckProgress(targets.length, true));
    toast.info(
      allTargets.length > targets.length
        ? `正在按 ${concurrency} 并发实时检测前 ${targets.length} 个模型（全部检测上限 ${MAX_BATCH_MODEL_HEALTH_TARGETS}）...`
        : `正在按 ${concurrency} 并发实时检测 ${targets.length} 个模型...`
    );

    try {
      const results = await runAllEndpointHealthChecks(targets);
      const counts = countModelHealthResults(results);
      setHealthCheckProgress({
        running: false,
        total: targets.length,
        completed: results.length,
        ...counts,
      });

      const message =
        allTargets.length > targets.length
          ? `检测完成：已检测前 ${targets.length} 个模型，可用 ${counts.healthy}，较慢 ${counts.degraded}，失败 ${counts.failed}`
          : `检测完成：可用 ${counts.healthy}，较慢 ${counts.degraded}，失败 ${counts.failed}`;
      if (counts.failed > 0) toast.warning(message);
      else toast.success(message);
    } finally {
      setModelHealthBatchLoading(false);
    }
  };

  const openHealthCheckForEndpoint = async endpointId => {
    const ep = endpoints.find(e => e.id === endpointId);
    const modelIds = endpointModelIds(ep);
    const concurrency = resolveModelHealthConcurrency(healthCheckForm.concurrency, modelIds.length);
    if (!ep || modelIds.length === 0) {
      toast.warning('该端点无可用模型');
      return;
    }

    setModelHealthBatchLoading(true);
    setHealthCheckProgress(createHealthCheckProgress(modelIds.length, true));
    toast.info(
      `正在按 ${concurrency} 并发实时检测 ${ep.name || '端点'} 的 ${modelIds.length} 个模型...`
    );

    try {
      const results = await runEndpointHealthCheck(ep);
      const counts = countModelHealthResults(results);
      setHealthCheckProgress({
        running: false,
        total: modelIds.length,
        completed: results.length,
        ...counts,
      });
      const message = `${ep.name || '端点'}：可用 ${counts.healthy}，较慢 ${counts.degraded}，失败 ${counts.failed}`;
      if (counts.failed > 0) toast.warning(message);
      else toast.success(message);
    } finally {
      setModelHealthBatchLoading(false);
    }
  };

  // ==================== 3. Models List & Pinning ====================
  const [allModels, setAllModels] = useState([]);
  const [pinnedModels, setPinnedModels] = useState(() => {
    try {
      const saved = localStorage.getItem('openai_pinned_models');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [hiddenModels, setHiddenModels] = useState(() => {
    try {
      const saved = localStorage.getItem('openai_hidden_models');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [chatEndpoint, setChatEndpoint] = useState(() => {
    return localStorage.getItem('openai_chat_endpoint') || '';
  });
  const [chatModel, setChatModel] = useState(() => {
    return localStorage.getItem('openai_chat_model') || '';
  });
  const [defaultChatModel, setDefaultChatModel] = useState(() => {
    return localStorage.getItem('openai_default_model') || '';
  });

  // Settings configurations
  const [showHChatSettingsModal, setShowHChatSettingsModal] = useState(false);
  const [openaiSettingsTab, setOpenaiSettingsTab] = useState('general');
  const [openaiChatSystemPrompt, setOpenaiChatSystemPrompt] = useState(() => {
    return localStorage.getItem('openai_system_prompt') || '你是一个有用的 AI 助手。';
  });
  const [openaiChatSettings, setOpenaiChatSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('openai_chat_settings');
      return saved ? JSON.parse(saved) : { temperature: 0.7, max_tokens: 2000 };
    } catch {
      return { temperature: 0.7, max_tokens: 2000 };
    }
  });

  const [openaiAutoTitleEnabled, setOpenaiAutoTitleEnabled] = useState(() => {
    return localStorage.getItem('openai_auto_title_enabled') === 'true';
  });
  const [openaiTitleModels, setOpenaiTitleModels] = useState(() => {
    try {
      const saved = localStorage.getItem('openai_title_models');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [openaiTitleModelToAdd, setOpenaiTitleModelToAdd] = useState('');
  const [openaiTitleGenerating, setOpenaiTitleGenerating] = useState(false);
  const [openaiTitleLastResult, setOpenaiTitleLastResult] = useState(null);

  // Model selection helper dropdowns UI states
  const [showEndpointDropdown, setShowEndpointDropdown] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [dropdownModelSearch, setDropdownModelSearch] = useState('');
  const [openaiModelSearch, setOpenaiModelSearch] = useState('');
  const [openaiSelectedEndpointId, setOpenaiSelectedEndpointId] = useState('');
  const [openaiShowHiddenModels, setOpenaiShowHiddenModels] = useState(false);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleOutsideClick = () => {
      setShowEndpointDropdown(false);
      setShowModelDropdown(false);
      setShowPersonaDropdown(false);
    };
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  const loadAllModels = useCallback(
    async (silent = false) => {
      try {
        const response = await fetch('/api/openai/v1/models', {
          headers: getAuthHeaders(),
        });
        const data = await response.json();
        if (data && Array.isArray(data.data)) {
          const sorted = data.data.sort((a, b) => {
            if (a.owned_by !== b.owned_by) return a.owned_by.localeCompare(b.owned_by);
            return a.id.localeCompare(b.id);
          });
          setAllModels(sorted);

          // Smart initialize model
          if (sorted.length > 0) {
            const currentModel = localStorage.getItem('openai_chat_model');
            let modelIsValid = false;
            if (currentModel) {
              modelIsValid = sorted.some(m => m.id === currentModel);
            }
            if (!modelIsValid) {
              const defModel = localStorage.getItem('openai_default_model');
              if (defModel && sorted.some(m => m.id === defModel)) {
                setChatModel(defModel);
                localStorage.setItem('openai_chat_model', defModel);
              } else {
                setChatModel(sorted[0].id);
                localStorage.setItem('openai_chat_model', sorted[0].id);
              }
            }
          }
        }
      } catch (error) {
        console.error('Failed to load models list:', error);
      }
    },
    [getAuthHeaders]
  );

  useEffect(() => {
    loadAllModels(true);
  }, [loadAllModels]);

  const togglePinModel = modelId => {
    if (!modelId) return;
    setPinnedModels(prev => {
      let next;
      if (prev.includes(modelId)) {
        next = prev.filter(id => id !== modelId);
      } else {
        next = [...prev, modelId];
      }
      localStorage.setItem('openai_pinned_models', JSON.stringify(next));
      return next;
    });
  };

  const toggleHideModel = modelId => {
    if (!modelId) return;
    setHiddenModels(prev => {
      let next;
      if (prev.includes(modelId)) {
        next = prev.filter(id => id !== modelId);
      } else {
        next = [...prev, modelId];
      }
      localStorage.setItem('openai_hidden_models', JSON.stringify(next));
      return next;
    });
  };

  const handleSetDefaultModel = () => {
    if (!chatModel) return;
    setDefaultChatModel(chatModel);
    localStorage.setItem('openai_default_model', chatModel);
    toast.success(`已将 ${chatModel} 设为默认模型`);
  };

  const handleClearDefaultModel = () => {
    setDefaultChatModel('');
    localStorage.removeItem('openai_default_model');
    toast.success('已清除默认模型');
  };

  const saveChatSettings = () => {
    localStorage.setItem('openai_system_prompt', openaiChatSystemPrompt);
    localStorage.setItem('openai_chat_settings', JSON.stringify(openaiChatSettings));
    setShowHChatSettingsModal(false);
    toast.success('对话设置已保存');
  };

  const saveAutoTitleSettings = (enabled, models) => {
    localStorage.setItem('openai_auto_title_enabled', enabled ? 'true' : 'false');
    localStorage.setItem('openai_title_models', JSON.stringify(models));
  };

  const addTitleModel = () => {
    if (!openaiTitleModelToAdd) return;
    if (!openaiTitleModels.includes(openaiTitleModelToAdd)) {
      const next = [...openaiTitleModels, openaiTitleModelToAdd];
      setOpenaiTitleModels(next);
      saveAutoTitleSettings(openaiAutoTitleEnabled, next);
    }
    setOpenaiTitleModelToAdd('');
  };

  const removeTitleModel = modelId => {
    const next = openaiTitleModels.filter(m => m !== modelId);
    setOpenaiTitleModels(next);
    saveAutoTitleSettings(openaiAutoTitleEnabled, next);
  };

  // Helper title models filtering
  const filteredTitleModelOptions = () => {
    const allModelsMap = new Map();
    allModels.forEach(m => allModelsMap.set(m.id, m));
    endpoints.forEach(ep => {
      if (ep.models) {
        ep.models.forEach(m => {
          const id = typeof m === 'string' ? m : m.id;
          if (id && !allModelsMap.has(id)) {
            allModelsMap.set(id, { id, owned_by: ep.name || 'custom' });
          }
        });
      }
    });
    return Array.from(allModelsMap.values()).filter(m => !openaiTitleModels.includes(m.id));
  };

  // ==================== 4. Personas State ====================
  const [personas, setPersonas] = useState([]);
  const [currentPersonaId, setCurrentPersonaId] = useState(null);
  const [showPersonaDropdown, setShowPersonaDropdown] = useState(false);
  const [personaModalOpen, setPersonaModalOpen] = useState(false);
  const [editingPersona, setEditingPersona] = useState(null);
  const [personaForm, setPersonaForm] = useState({ name: '', icon: 'fa-robot', systemPrompt: '' });

  const fetchPersonas = useCallback(async () => {
    try {
      const response = await fetch('/api/openai/personas', { headers: getAuthHeaders() });
      if (response.ok) {
        const data = await response.json();
        setPersonas(data || []);
        if (data && data.length > 0 && !currentPersonaId) {
          setCurrentPersonaId(data[0].id);
          setOpenaiChatSystemPrompt(data[0].system_prompt);
        }
      }
    } catch (e) {
      console.error('Failed to fetch personas:', e);
    }
  }, [getAuthHeaders, currentPersonaId]);

  useEffect(() => {
    if (activeTab === 'chat') {
      fetchPersonas();
    }
  }, [activeTab, fetchPersonas]);

  const handleSelectPersona = personaId => {
    setCurrentPersonaId(personaId);
    setShowPersonaDropdown(false);
    const p = personas.find(item => item.id === personaId);
    if (p) {
      setOpenaiChatSystemPrompt(p.system_prompt);
      toast.success(`切换人设为: ${p.name}`);
    }
  };

  const openPersonaModal = (persona = null) => {
    setEditingPersona(persona);
    if (persona) {
      setPersonaForm({
        name: persona.name || '',
        icon: persona.icon || 'fa-robot',
        systemPrompt: persona.system_prompt || '',
      });
    } else {
      setPersonaForm({ name: '', icon: 'fa-robot', systemPrompt: '' });
    }
    setPersonaModalOpen(true);
  };

  const savePersona = async () => {
    if (!personaForm.name.trim() || !personaForm.systemPrompt.trim()) {
      toast.warning('请输入名称和提示词');
      return;
    }
    try {
      const id = editingPersona?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const payload = {
        id,
        name: personaForm.name,
        icon: personaForm.icon,
        system_prompt: personaForm.systemPrompt,
      };

      const response = await fetch(
        editingPersona ? `/api/openai/personas/${editingPersona.id}` : '/api/openai/personas',
        {
          method: editingPersona ? 'PUT' : 'POST',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await fetchPersonas();
      if (!currentPersonaId) {
        setCurrentPersonaId(id);
        setOpenaiChatSystemPrompt(personaForm.systemPrompt);
      }
      toast.success(editingPersona ? '人设已更新' : '人设已创建');
      setPersonaModalOpen(false);
    } catch (e) {
      toast.error('保存失败: ' + e.message);
    }
  };

  const deletePersona = async personaId => {
    if (!(await dialog.confirm('确定要删除这个 AI 人设吗？'))) {
      return;
    }
    try {
      const persona = personas.find(item => item.id === personaId);
      if (persona?.is_default) {
        toast.warning('无法删除默认人设');
        return;
      }
      const response = await fetch(`/api/openai/personas/${personaId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await fetchPersonas();
      if (currentPersonaId === personaId) {
        const fallback = personas.find(item => item.is_default === 1) || {
          id: '1',
          system_prompt: '你是一个有用的 AI 助手。',
        };
        setCurrentPersonaId(fallback.id);
        setOpenaiChatSystemPrompt(fallback.system_prompt);
      }
      toast.success('人设已删除');
    } catch (e) {
      toast.error('删除失败: ' + e.message);
    }
  };

  // ==================== 5. Chat History & Streaming ====================
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [chatHistoryCollapsed, setChatHistoryCollapsed] = useState(false);

  const abortControllerRef = useRef(null);
  const messagesEndRef = useRef(null);

  const fetchSessions = useCallback(async () => {
    try {
      const response = await fetch('/api/openai/sessions', { headers: getAuthHeaders() });
      if (response.ok) {
        const data = await response.json();
        setSessions(data || []);
      }
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
    }
  }, [getAuthHeaders]);

  const fetchMessages = useCallback(
    async sessionId => {
      if (!sessionId) {
        setMessages([]);
        return;
      }
      setChatHistoryLoading(true);
      try {
        const response = await fetch(`/api/openai/sessions/${sessionId}/messages`, {
          headers: getAuthHeaders(),
        });
        if (response.ok) {
          const data = await response.json();
          setMessages(data || []);
        }
      } catch (e) {
        console.error('Failed to fetch messages:', e);
        toast.error('加载消息失败');
      } finally {
        setChatHistoryLoading(false);
      }
    },
    [getAuthHeaders]
  );

  useEffect(() => {
    if (activeTab === 'chat') {
      fetchSessions();
    }
  }, [activeTab, fetchSessions]);

  // One-time data migration from localStorage to backend SQLite
  useEffect(() => {
    const migrateData = async () => {
      try {
        const legacyPersonas = localStorage.getItem('openai_chat_personas_v2');
        const legacySessions = localStorage.getItem('openai_chat_sessions_v2');
        const legacyMessages = localStorage.getItem('openai_chat_messages_v2');

        if (legacyPersonas) {
          const parsedPersonas = JSON.parse(legacyPersonas);
          for (const p of parsedPersonas) {
            if (String(p.id) === '1') continue; // Skip default
            await fetch('/api/openai/personas', {
              method: 'POST',
              headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: String(p.id),
                name: p.name,
                icon: p.icon,
                system_prompt: p.system_prompt,
              }),
            });
          }
          localStorage.removeItem('openai_chat_personas_v2');
        }

        if (legacySessions) {
          const parsedSessions = JSON.parse(legacySessions);
          const parsedMessages = legacyMessages ? JSON.parse(legacyMessages) : {};

          for (const s of parsedSessions) {
            await fetch('/api/openai/sessions', {
              method: 'POST',
              headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: String(s.id),
                title: s.title,
                model: s.model,
                endpoint_id: s.endpoint_id,
                persona_id: String(s.persona_id),
                system_prompt: s.system_prompt,
              }),
            });

            const msgs = parsedMessages[s.id] || [];
            for (const m of msgs) {
              await fetch(`/api/openai/sessions/${s.id}/messages`, {
                method: 'POST',
                headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  id: m.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                  role: m.role,
                  content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                  reasoning: m.reasoning || '',
                  timestamp: m.timestamp,
                }),
              });
            }
          }
          localStorage.removeItem('openai_chat_sessions_v2');
          if (legacyMessages) {
            localStorage.removeItem('openai_chat_messages_v2');
          }
        }

        if (activeTab === 'chat') {
          await fetchPersonas();
          await fetchSessions();
        }
      } catch (err) {
        console.error('Data migration error:', err);
      }
    };

    migrateData();
  }, [activeTab, fetchPersonas, fetchSessions, getAuthHeaders]);

  const loadSession = async sessionId => {
    if (chatLoading) return;
    setCurrentSessionId(sessionId);
    await fetchMessages(sessionId);

    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      if (session.model) {
        setChatModel(session.model);
        localStorage.setItem('openai_chat_model', session.model);
      }
      if (session.endpoint_id) {
        setChatEndpoint(session.endpoint_id);
        localStorage.setItem('openai_chat_endpoint', session.endpoint_id);
      }
      if (session.persona_id) {
        setCurrentPersonaId(session.persona_id);
        const p = personas.find(item => item.id === session.persona_id);
        if (p) setOpenaiChatSystemPrompt(p.system_prompt);
      }
    }
    setMobileSidebarOpen(false);
  };

  const createSession = async (resetToDefault = false) => {
    try {
      const globalSystemPrompt =
        localStorage.getItem('openai_system_prompt') || '你是一个有用的 AI 助手。';
      let finalModel = chatModel;
      if (defaultChatModel && (resetToDefault || !chatModel)) {
        finalModel = defaultChatModel;
        setChatModel(finalModel);
        localStorage.setItem('openai_chat_model', finalModel);
      }

      const currentPersona = personas.find(p => p.id === currentPersonaId);
      const systemPrompt = currentPersona ? currentPersona.system_prompt : globalSystemPrompt;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const response = await fetch('/api/openai/sessions', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          title: '新对话',
          model: finalModel,
          endpoint_id: chatEndpoint || '',
          persona_id: currentPersonaId || '1',
          system_prompt: systemPrompt,
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      await fetchSessions();
      setCurrentSessionId(id);
      setMessages([]);
      toast.success('新建会话成功');
    } catch (error) {
      toast.error('创建会话失败: ' + error.message);
    }
  };

  const deleteSession = async (sessionId, e) => {
    if (e) e.stopPropagation();
    if (!(await dialog.confirm('确定要删除这个对话吗？此操作不可撤销。'))) return;
    try {
      const response = await fetch(`/api/openai/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await fetchSessions();
      if (currentSessionId === sessionId) {
        setCurrentSessionId(null);
        setMessages([]);
      }
      toast.success('会话已删除');
    } catch (error) {
      toast.error('删除会话失败: ' + error.message);
    }
  };

  const deleteSelectedSessions = async () => {
    if (selectedSessionIds.length === 0) return;
    if (!(await dialog.confirm(`确定要删除选中的 ${selectedSessionIds.length} 个对话吗？`))) return;
    try {
      for (const id of selectedSessionIds) {
        await fetch(`/api/openai/sessions/${id}`, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        });
      }
      await fetchSessions();
      if (selectedSessionIds.includes(currentSessionId)) {
        setCurrentSessionId(null);
        setMessages([]);
      }
      setSelectedSessionIds([]);
      toast.success('所选会话已删除');
    } catch (error) {
      toast.error('删除会话失败: ' + error.message);
    }
  };

  const clearAllSessions = async () => {
    if (sessions.length === 0) return;
    if (!(await dialog.confirm('确定要清空所有会话历史吗？此操作不可撤销。'))) return;
    try {
      const response = await fetch('/api/openai/sessions', {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await fetchSessions();
      setCurrentSessionId(null);
      setMessages([]);
      setSelectedSessionIds([]);
      toast.success('所有会话已清空');
    } catch (error) {
      toast.error('清空会话失败: ' + error.message);
    }
  };

  const toggleSessionSelection = (sessionId, e) => {
    if (e) e.stopPropagation();
    setSelectedSessionIds(prev =>
      prev.includes(sessionId) ? prev.filter(id => id !== sessionId) : [...prev, sessionId]
    );
  };

  const toggleSelectAllSessions = () => {
    if (selectedSessionIds.length === sessions.length) {
      setSelectedSessionIds([]);
    } else {
      setSelectedSessionIds(sessions.map(s => s.id));
    }
  };

  // Generate Title
  const generateTitleWithFallback = async messagesList => {
    const modelsToTry = openaiTitleModels.length > 0 ? [...openaiTitleModels] : [chatModel];
    const conversationText = messagesList
      .slice(0, 4)
      .map(msg => {
        const role = msg.role === 'user' ? '用户' : '助手';
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter(p => p.type === 'text').map(p => p.text);
          text = textParts.join(' ') || '[图片]';
        }
        return `${role}: ${text.slice(0, 200)}`;
      })
      .join('\n');

    const titlePrompt = `请根据以下对话内容，生成一个简洁的中文标题（最多15个字，不要使用标点符号，直接输出标题内容）：\n\n${conversationText}\n\n标题：`;

    for (const modelId of modelsToTry) {
      try {
        const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
        const endpoint = endpoints.find(
          ep => ep.models && ep.models.some(m => (typeof m === 'string' ? m : m.id) === modelId)
        );
        if (endpoint) {
          headers['x-endpoint-id'] = endpoint.id;
        }

        const response = await fetch('/api/openai/v1/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: titlePrompt }],
            max_tokens: 30,
            temperature: 0.7,
          }),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        let generatedTitle = result.choices?.[0]?.message?.content?.trim() || '';

        if (!generatedTitle && result.choices?.[0]?.message?.reasoning_content) {
          const reasoning = result.choices[0].message.reasoning_content.trim();
          const lines = reasoning.split('\n').filter(l => l.trim());
          if (lines.length > 0) generatedTitle = lines[lines.length - 1].trim();
        }

        if (generatedTitle) {
          return { success: true, title: generatedTitle, model: modelId };
        }
      } catch (e) {
        console.warn(`Generate title with model ${modelId} failed:`, e);
      }
    }
    throw new Error('All models failed to generate title');
  };

  const updateSession = useCallback(
    async (sessionId, patch) => {
      try {
        const response = await fetch(`/api/openai/sessions/${sessionId}`, {
          method: 'PUT',
          headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (response.ok) {
          setSessions(prev =>
            prev.map(session =>
              session.id === sessionId
                ? { ...session, ...patch, updated_at: new Date().toISOString() }
                : session
            )
          );
        }
      } catch (e) {
        console.error('Failed to update session:', e);
      }
    },
    [getAuthHeaders]
  );

  const generateChatTitle = async (currentMsgs, sessionId) => {
    if (!sessionId || currentMsgs.length < 2) return;
    const session = sessions.find(s => s.id === sessionId);
    if (!session || session.title !== '新对话') return;

    if (!openaiAutoTitleEnabled) {
      const firstUser = currentMsgs.find(m => m.role === 'user');
      if (firstUser) {
        let simpleTitle = typeof firstUser.content === 'string' ? firstUser.content : '📷 图片对话';
        simpleTitle = simpleTitle.slice(0, 18) + (simpleTitle.length > 18 ? '...' : '');
        updateSession(sessionId, { title: simpleTitle });
      }
      return;
    }

    try {
      const result = await generateTitleWithFallback(currentMsgs);
      if (result.success) {
        updateSession(sessionId, {
          title: result.title,
          model: chatModel,
          endpoint_id: chatEndpoint || '',
          system_prompt: openaiChatSystemPrompt,
        });
      }
    } catch (error) {
      const firstUser = currentMsgs.find(m => m.role === 'user');
      if (firstUser) {
        let fallbackTitle =
          typeof firstUser.content === 'string' ? firstUser.content : '📷 图片对话';
        fallbackTitle = fallbackTitle.slice(0, 18) + (fallbackTitle.length > 18 ? '...' : '');
        updateSession(sessionId, { title: fallbackTitle });
      }
    }
  };

  const testTitleGeneration = async () => {
    setOpenaiTitleGenerating(true);
    setOpenaiTitleLastResult(null);
    const testMessages = [
      { role: 'user', content: '帮我解释一下什么是机器学习' },
      { role: 'assistant', content: '机器学习是人工智能的一个分支，它使计算机能够从数据中学习...' },
    ];
    try {
      const result = await generateTitleWithFallback(testMessages);
      setOpenaiTitleLastResult(result);
    } catch (e) {
      setOpenaiTitleLastResult({ success: false, error: e.message });
    } finally {
      setOpenaiTitleGenerating(false);
    }
  };

  // Chat message sending / streaming API
  const saveChatMessage = async (sessionId, role, content, reasoning = null) => {
    if (!sessionId) return null;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const message = {
      id,
      role,
      content,
      reasoning: reasoning || '',
      timestamp: new Date().toISOString(),
    };
    try {
      const response = await fetch(`/api/openai/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (response.ok) {
        await updateSession(sessionId, { model: chatModel, endpoint_id: chatEndpoint || '' });
        return message;
      }
    } catch (e) {
      console.error('Failed to save message:', e);
    }
    return null;
  };

  const stopGenerating = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setChatLoading(false);
  };

  const scrollToBottom = (behavior = 'smooth') => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, chatLoading]);

  const handleSendChat = async () => {
    if ((!messageInput.trim() && attachments.length === 0) || chatLoading) return;

    const userText = messageInput;
    const currentAttachments = [...attachments];
    setMessageInput('');
    setAttachments([]);

    let activeSessionId = currentSessionId;
    if (!activeSessionId) {
      // Create session first
      try {
        const session = {
          id: chatStorage.newId(),
          title: '新对话',
          model: chatModel,
          endpoint_id: chatEndpoint || '',
          persona_id: currentPersonaId,
          system_prompt: openaiChatSystemPrompt,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        persistSessions(prev => [session, ...prev]);
        activeSessionId = session.id;
        setCurrentSessionId(activeSessionId);
        chatStorage.saveSessionMessages(activeSessionId, []);
      } catch (err) {
        toast.error('创建会话失败');
        return;
      }
    }

    let userContent;
    if (currentAttachments.length > 0) {
      userContent = [{ type: 'text', text: userText }];
      currentAttachments.forEach(att => {
        userContent.push({
          type: 'image_url',
          image_url: { url: att.url },
        });
      });
    } else {
      userContent = userText;
    }

    const contentToSave =
      typeof userContent === 'string' ? userContent : JSON.stringify(userContent);
    const userMsg = {
      role: 'user',
      content: userContent,
      timestamp: new Date().toISOString(),
      isNew: true,
    };

    setMessages(prev => [...prev, userMsg]);
    setChatLoading(true);

    // Save user message
    saveChatMessage(activeSessionId, 'user', contentToSave).then(saved => {
      if (saved && saved.id) {
        userMsg.id = saved.id;
      }
    });

    abortControllerRef.current = new AbortController();

    try {
      const messagesPayload = [
        { role: 'system', content: openaiChatSystemPrompt },
        ...messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        { role: 'user', content: contentToSave },
      ];

      const headers = {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      };

      let targetEpId = chatEndpoint;
      if (!targetEpId && chatModel) {
        const found = endpoints.find(
          ep => ep.models && ep.models.some(m => (typeof m === 'string' ? m : m.id) === chatModel)
        );
        if (found) targetEpId = found.id;
      }
      if (targetEpId) {
        headers['x-endpoint-id'] = targetEpId;
      }

      const response = await fetch('/api/openai/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: chatModel,
          messages: messagesPayload,
          stream: true,
          ...openaiChatSettings,
        }),
        signal: abortControllerRef.current?.signal,
      });

      if (!response.ok) {
        let errText = `HTTP 错误 ${response.status}`;
        try {
          const json = await response.json();
          errText = json.error?.message || json.message || JSON.stringify(json);
        } catch {}
        throw new Error(errText);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantMsg = {
        role: 'assistant',
        content: '',
        reasoning: '',
        showReasoning: true,
        timestamp: new Date().toISOString(),
        model: chatModel,
        isNew: true,
      };

      setMessages(prev => [...prev, assistantMsg]);

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') break;
            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed.choices?.[0]?.delta;
              if (delta) {
                if (delta.reasoning_content) {
                  assistantMsg.reasoning += delta.reasoning_content;
                }
                if (delta.content) {
                  assistantMsg.content += delta.content;
                }
                setMessages(prev =>
                  prev.map((m, idx) => (idx === prev.length - 1 ? { ...assistantMsg } : m))
                );
              }
            } catch (e) {}
          }
        }
      }

      // Save assistant message to DB
      const saved = await saveChatMessage(
        activeSessionId,
        'assistant',
        assistantMsg.content,
        assistantMsg.reasoning || null
      );
      if (saved && saved.id) {
        assistantMsg.id = saved.id;
        setMessages(prev =>
          prev.map((m, idx) => (idx === prev.length - 1 ? { ...m, id: saved.id } : m))
        );
      }

      // Check auto title
      const sess = sessions.find(s => s.id === activeSessionId);
      if (sess && sess.title === '新对话') {
        const currentMsgs = [...messages, userMsg, assistantMsg];
        generateChatTitle(currentMsgs, activeSessionId);
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      toast.error('对话失败: ' + error.message);
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: `**??**: ${error.message}`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setChatLoading(false);
      abortControllerRef.current = null;
    }
  };

  const deleteChatMessage = async index => {
    if (index < 0 || index >= messages.length) return;
    const msg = messages[index];
    if (msg && msg.id && currentSessionId) {
      try {
        await fetch(`/api/openai/sessions/${currentSessionId}/messages/${msg.id}`, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        });
      } catch (e) {
        console.error('Failed to delete message from backend:', e);
      }
    }
    setMessages(prev => prev.filter((_, idx) => idx !== index));
  };

  const regenerateChat = async (index = -1) => {
    if (chatLoading || messages.length === 0) return;
    let targetIndex = index;
    if (targetIndex === -1) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
          targetIndex = i;
          break;
        }
      }
    }
    if (targetIndex === -1) {
      targetIndex = messages.length - 1;
    }

    const targetMsg = messages[targetIndex];
    if (!targetMsg) return;

    const deleteCount =
      messages.length - (targetMsg.role === 'assistant' ? targetIndex : targetIndex + 1);
    const msgsToKeep = messages.slice(0, messages.length - deleteCount);
    const msgsToDelete = messages.slice(messages.length - deleteCount);
    for (const m of msgsToDelete) {
      if (m.id && currentSessionId) {
        try {
          await fetch(`/api/openai/sessions/${currentSessionId}/messages/${m.id}`, {
            method: 'DELETE',
            headers: getAuthHeaders(),
          });
        } catch (e) {
          console.error('Failed to delete message:', e);
        }
      }
    }

    setMessages(msgsToKeep);
    setChatLoading(true);
    abortControllerRef.current = new AbortController();

    try {
      const messagesPayload = [
        { role: 'system', content: openaiChatSystemPrompt },
        ...msgsToKeep.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      ];

      const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
      if (chatEndpoint) {
        headers['x-endpoint-id'] = chatEndpoint;
      }

      const response = await fetch('/api/openai/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: chatModel,
          messages: messagesPayload,
          stream: true,
          ...openaiChatSettings,
        }),
        signal: abortControllerRef.current?.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantMsg = {
        role: 'assistant',
        content: '',
        reasoning: '',
        showReasoning: true,
        timestamp: new Date().toISOString(),
        model: chatModel,
        isNew: true,
      };

      setMessages(prev => [...prev, assistantMsg]);

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') break;
            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed.choices?.[0]?.delta;
              if (delta) {
                if (delta.reasoning_content) {
                  assistantMsg.reasoning += delta.reasoning_content;
                }
                if (delta.content) {
                  assistantMsg.content += delta.content;
                }
                setMessages(prev =>
                  prev.map((m, idx) => (idx === prev.length - 1 ? { ...assistantMsg } : m))
                );
              }
            } catch (e) {}
          }
        }
      }

      const saved = await saveChatMessage(
        currentSessionId,
        'assistant',
        assistantMsg.content,
        assistantMsg.reasoning || null
      );
      if (saved && saved.id) {
        setMessages(prev =>
          prev.map((m, idx) => (idx === prev.length - 1 ? { ...m, id: saved.id } : m))
        );
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      toast.error('重新生成失败: ' + error.message);
    } finally {
      setChatLoading(false);
      abortControllerRef.current = null;
    }
  };

  const clearChatLocal = async () => {
    if (currentSessionId) {
      try {
        const response = await fetch(`/api/openai/sessions/${currentSessionId}/messages`, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        });
        if (response.ok) {
          setMessages([]);
          toast.success('已清空当前对话消息');
        }
      } catch (e) {
        console.error('Failed to clear messages:', e);
        toast.error('清空消息失败');
      }
    } else {
      setMessages([]);
    }
  };

  // Image Upload handler
  const fileInputRef = useRef(null);
  const handleFileChange = e => {
    const files = Array.from(e.target.files);
    files.forEach(file => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = event => {
        setAttachments(prev => [...prev, { file, url: event.target.result }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeAttachment = idx => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  // Paste handler for images
  const handlePaste = e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = event => {
          setAttachments(prev => [...prev, { file, url: event.target.result }]);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  // Model Selector Filtering
  const filteredModelsList = useMemo(() => {
    const list = allModels.filter(m => {
      const matchesSearch = m.id.toLowerCase().includes(openaiModelSearch.toLowerCase());
      const matchesEndpoint =
        !openaiSelectedEndpointId ||
        m.owned_by === endpoints.find(e => e.id === openaiSelectedEndpointId)?.name;
      const matchesHidden = openaiShowHiddenModels ? true : !hiddenModels.includes(m.id);
      return matchesSearch && matchesEndpoint && matchesHidden;
    });
    return list;
  }, [
    allModels,
    openaiModelSearch,
    openaiSelectedEndpointId,
    endpoints,
    hiddenModels,
    openaiShowHiddenModels,
  ]);

  const chatDropdownFilteredModels = useMemo(() => {
    const allModelsMap = new Map();
    // Gather all models
    allModels.forEach(m => allModelsMap.set(m.id, m));
    // Complement with models from enabled endpoints
    endpoints.forEach(ep => {
      if (ep.models) {
        ep.models.forEach(m => {
          const id = typeof m === 'string' ? m : m.id;
          if (id && !allModelsMap.has(id)) {
            allModelsMap.set(id, { id, owned_by: ep.name || 'custom' });
          }
        });
      }
    });

    const fullList = Array.from(allModelsMap.values());
    return fullList.filter(m => {
      const matchesSearch = m.id.toLowerCase().includes(dropdownModelSearch.toLowerCase());
      // Filter by active endpoint
      const matchesEndpoint =
        !chatEndpoint || m.owned_by === endpoints.find(e => e.id === chatEndpoint)?.name;
      const isHidden = hiddenModels.includes(m.id);
      return matchesSearch && matchesEndpoint && !isHidden;
    });
  }, [allModels, endpoints, chatEndpoint, dropdownModelSearch, hiddenModels]);

  const selectChatModel = modelId => {
    setChatModel(modelId);
    localStorage.setItem('openai_chat_model', modelId);
    setShowModelDropdown(false);
  };

  const selectEndpoint = epId => {
    setChatEndpoint(epId);
    if (epId) {
      localStorage.setItem('openai_chat_endpoint', epId);
    } else {
      localStorage.removeItem('openai_chat_endpoint');
    }
    setShowEndpointDropdown(false);
  };

  // Auto-resize chat textarea
  const textareaRef = useRef(null);
  const handleTextareaInput = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(200, textareaRef.current.scrollHeight)}px`;
    }
  };

  return (
    <PageStack viewport className="min-h-full max-w-full md:h-full md:min-h-0 md:flex-1">
      {/* Tab Navigation */}
      <PageToolbar className="shrink-0 select-none">
        <Tabs
          {...MODULE_TABS_PROPS}
          value={activeTab}
          onValueChange={setActiveTab}
          tabs={[
            {
              value: 'endpoints',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Server className="w-3.5 h-3.5" />
                  API 端点
                </span>
              ),
            },
            {
              value: 'keys',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5" />
                  API 密钥
                </span>
              ),
            },
            {
              value: 'analytics',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5" />
                  网关分析
                </span>
              ),
            },
          ]}
        />
      </PageToolbar>

      {/* ==================== 1. API 端点 Tab ==================== */}
      {activeTab === 'endpoints' && (
        <GatewaySection
          className="min-h-0 flex-1"
          title="API 端点"
          description={
            modelHealthBatchLoading ? '正在批量检测模型可用性...' : `共 ${endpoints.length} 个端点`
          }
          icon={<Server className="h-4 w-4 text-kumo-brand" />}
          actions={
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => setHealthCheckModal(true)}
                disabled={modelHealthBatchLoading}
                className="flex items-center gap-1.5"
              >
                <Activity
                  className={cx(iconButtonIconClass, modelHealthBatchLoading && 'animate-pulse')}
                />
                <span>健康检测</span>
              </Button>
              <Button
                size="sm"
                onClick={refreshAllEndpoints}
                disabled={endpointsRefreshing}
                className="flex items-center gap-1.5"
              >
                <RefreshCw
                  className={cx(iconButtonIconClass, endpointsRefreshing && 'animate-spin')}
                />
                <span>刷新列表</span>
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={openAddEndpointModal}
                className="flex items-center gap-1.5"
              >
                <Plus className={iconButtonIconClass} />
                <span>新增端点</span>
              </Button>
            </div>
          }
          bodyClassName="flex min-h-0 flex-1 flex-col gap-2.5"
        >
          <LayerCard className="flex flex-col gap-2 p-2 shadow-none sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <Server className="h-4 w-4 shrink-0 text-kumo-brand" />
              <span className="shrink-0 text-xs font-medium text-kumo-subtle">OpenAI 兼容入口</span>
              <ClipboardText
                size="sm"
                text={`${gatewayOrigin}/v1`}
                className="min-w-0 max-w-md flex-1 font-mono text-[0.9em]"
                tooltip={{ text: '复制 API Base URL', copiedText: '地址已复制' }}
                labels={{ copyAction: '复制 API Base URL' }}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <InlineStatusPill tone="neutral">
                {endpoints.filter(endpoint => endpoint.enabled).length} 个启用端点
              </InlineStatusPill>
              <InlineStatusPill tone="brand">
                {
                  Array.from(
                    new Set(
                      endpoints
                        .filter(endpoint => endpoint.enabled)
                        .flatMap(endpoint => endpoint.models || [])
                        .map(model => (typeof model === 'string' ? model : model.id))
                        .filter(Boolean)
                    )
                  ).length
                }{' '}
                个模型
              </InlineStatusPill>
            </div>
          </LayerCard>
          {endpointsLoading ? (
            <div className="space-y-2.5">
              {[...Array(2)].map((_, i) => (
                <AppCard key={i} padding="md" className="space-y-2.5">
                  <div className="flex items-center gap-3">
                    <SkeletonLine className="w-10 h-10 rounded-lg" />
                    <div className="flex-1 space-y-1.5">
                      <SkeletonLine className="w-1/4 h-3.5" />
                      <SkeletonLine className="w-1/2 h-2.5" />
                    </div>
                  </div>
                </AppCard>
              ))}
            </div>
          ) : endpoints.length === 0 ? (
            <EmptyState
              icon={Bot}
              title="暂无 API 端点"
              description="新增 OpenAI 兼容端点"
            />
          ) : (
            (() => {
              const endpoint = selectedEndpoint;
              const validStatus = endpoint.status === 'valid';
              const invalidStatus = endpoint.status === 'invalid';

              return (
                <div className="grid min-h-0 min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
                  <section className="flex min-h-0 min-w-0 flex-col gap-2">
                    <div className="flex min-h-8 items-center justify-between gap-2 px-1">
                      <div className="flex items-center gap-2 text-xs text-kumo-subtle">
                        <Server className="h-3.5 w-3.5" />
                        <span className="font-medium text-kumo-strong">上游端点</span>
                      </div>
                      <span className="text-xs text-kumo-subtle">{endpoints.length} 个</span>
                    </div>
                    <LayerCard className="min-h-0 flex-1 overflow-hidden p-0 shadow-none">
                      <div className="h-full overflow-auto scrollbar-thin">
                        <Table layout="fixed" className="w-full text-xs">
                          <colgroup>
                            <col />
                            <col style={{ width: 60 }} />
                            <col style={{ width: 60 }} />
                          </colgroup>
                          <Table.Header sticky variant="compact">
                            <Table.Row className="h-8">
                              <Table.Head className="!px-2.5 !py-1.5">端点</Table.Head>
                              <Table.Head className="!px-2 !py-1.5 text-center">模型</Table.Head>
                              <Table.Head className="!px-2 !py-1.5 text-center">状态</Table.Head>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {endpoints.map(item => (
                              <Table.Row
                                key={item.id}
                                variant={item.id === endpoint.id ? 'selected' : 'default'}
                                className="h-11 cursor-pointer"
                                onClick={() => setSelectedEndpointId(item.id)}
                              >
                                <Table.Cell className="!px-2.5 !py-1.5">
                                  <div className="min-w-0">
                                    <div
                                      className="truncate font-semibold text-kumo-strong"
                                      title={item.name}
                                    >
                                      {item.name || '未命名端点'}
                                    </div>
                                    <div
                                      className="truncate font-mono text-[10px] text-kumo-subtle"
                                      title={item.baseUrl}
                                    >
                                      {item.baseUrl}
                                    </div>
                                  </div>
                                </Table.Cell>
                                <Table.Cell className="!px-2 !py-1.5 text-center font-mono text-kumo-strong">
                                  {item.models?.length || 0}
                                </Table.Cell>
                                <Table.Cell className="!px-2 !py-1.5 text-center">
                                  <div
                                    className="flex justify-center"
                                    onClick={event => event.stopPropagation()}
                                  >
                                    <Switch
                                      size="sm"
                                      aria-label={item.enabled ? '停用端点' : '启用端点'}
                                      checked={item.enabled}
                                      onCheckedChange={() => toggleEndpointEnabled(item)}
                                      disabled={!!endpointToggleLoading[item.id]}
                                    />
                                  </div>
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table>
                      </div>
                    </LayerCard>
                  </section>

                  <section className="flex min-h-0 min-w-0 flex-col gap-2">
                    <div className="flex min-h-8 flex-wrap items-center justify-between gap-2 px-1">
                      <div className="flex min-w-0 items-center gap-2 text-xs">
                        <span className="truncate font-medium text-kumo-strong">
                          {endpoint.name || '未命名端点'}
                        </span>
                        <InlineStatusPill
                          tone={validStatus ? 'success' : invalidStatus ? 'danger' : 'neutral'}
                        >
                          {validStatus ? '有效' : invalidStatus ? '无效' : '待检测'}
                        </InlineStatusPill>
                        <span
                          className="hidden truncate font-mono text-[10px] text-kumo-subtle sm:block"
                          title={endpoint.baseUrl}
                        >
                          {endpoint.baseUrl}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          shape="square"
                          size="sm"
                          variant="secondary"
                          aria-label="模型健康检测"
                          onClick={() => openHealthCheckForEndpoint(endpoint.id)}
                          disabled={modelHealthBatchLoading}
                          title="模型健康检测"
                          icon={
                            modelHealthBatchLoading ? (
                              <Loader size="sm" />
                            ) : (
                              <Activity className={actionIconClass} />
                            )
                          }
                        />
                        <Button
                          shape="square"
                          size="sm"
                          variant="secondary"
                          aria-label="刷新模型列表"
                          onClick={() => refreshEndpointModels(endpoint)}
                          disabled={endpoint.refreshing}
                          title="刷新模型列表"
                          icon={
                            <RefreshCw
                              className={cx(actionIconClass, endpoint.refreshing && 'animate-spin')}
                            />
                          }
                        />
                        <Button
                          shape="square"
                          size="sm"
                          variant="secondary"
                          aria-label="编辑端点"
                          onClick={() => openEditEndpointModal(endpoint)}
                          title="编辑端点"
                        >
                          <Edit className={actionIconClass} />
                        </Button>
                        <Button
                          shape="square"
                          size="sm"
                          variant="secondary-destructive"
                          aria-label="删除端点"
                          onClick={() => deleteEndpoint(endpoint)}
                          title="删除端点"
                        >
                          <Trash className={actionIconClass} />
                        </Button>
                      </div>
                    </div>

                    <LayerCard className="min-h-0 min-w-0 flex-1 overflow-hidden p-0 shadow-none">
                      <div className="h-full overflow-auto scrollbar-thin">
                        <Table layout="fixed" className="min-w-[640px] text-xs">
                          <colgroup>
                            <col />
                            <col style={{ width: 92 }} />
                            <col style={{ width: 96 }} />
                            <col style={{ width: 150 }} />
                            <col style={{ width: 88 }} />
                          </colgroup>
                          <Table.Header sticky variant="compact">
                            <Table.Row className="h-8">
                              <Table.Head className="!px-2.5 !py-1.5">模型</Table.Head>
                              <Table.Head className="!px-2 !py-1.5 text-center">健康</Table.Head>
                              <Table.Head className="!px-2 !py-1.5 text-right">延迟</Table.Head>
                              <Table.Head className="!px-2 !py-1.5">最近检测</Table.Head>
                              <Table.Head className="app-table-action !px-2 !py-1.5">操作</Table.Head>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {endpoint.models && endpoint.models.length > 0 ? (
                              endpoint.models.map(model => {
                                const modelId =
                                  typeof model === 'string'
                                    ? model.trim()
                                    : (model.id || '').trim();
                                const healthKey = modelHealthKey(endpoint.id, modelId);
                                const health = openaiModelHealth[healthKey];
                                const canStopHealthCheck =
                                  health?.loading &&
                                  modelHealthAbortControllersRef.current.has(healthKey);
                                const healthCheckAnimating = !!health?.loading;
                                const healthTone = health?.loading
                                  ? 'info'
                                  : health?.status === 'healthy'
                                    ? 'success'
                                    : health?.status === 'degraded'
                                      ? 'warning'
                                      : health?.status === 'error'
                                        ? 'danger'
                                        : 'neutral';
                                const healthLabel = health?.loading
                                  ? '检测中'
                                  : health?.status === 'healthy'
                                    ? '可用'
                                    : health?.status === 'degraded'
                                      ? '较慢'
                                      : health?.status === 'error'
                                        ? '失败'
                                        : health?.status === 'cancelled'
                                          ? '已停止'
                                          : '未检测';

                                return (
                                  <Table.Row key={modelId} className="h-9">
                                    <Table.Cell className="!px-2.5 !py-1.5">
                                      <span
                                        className="block truncate font-medium text-kumo-strong"
                                        title={modelId}
                                      >
                                        {modelId}
                                      </span>
                                    </Table.Cell>
                                    <Table.Cell className="!px-2 !py-1.5 text-center">
                                      <InlineStatusPill tone={healthTone}>
                                        {healthLabel}
                                      </InlineStatusPill>
                                    </Table.Cell>
                                    <Table.Cell className="!px-2 !py-1.5 text-right font-mono text-kumo-strong">
                                      {health?.latency != null ? `${health.latency} ms` : '-'}
                                    </Table.Cell>
                                    <Table.Cell className="!px-2 !py-1.5 text-kumo-subtle">
                                      {health?.checkedAt ? formatDateTime(health.checkedAt) : '-'}
                                    </Table.Cell>
                                    <Table.Cell className="!px-2 !py-1.5 text-center">
                                      <div className="inline-flex gap-1">
                                        <Button
                                          shape="square"
                                          size="sm"
                                          variant={
                                            canStopHealthCheck
                                              ? 'secondary-destructive'
                                              : 'secondary'
                                          }
                                          aria-label={
                                            canStopHealthCheck
                                              ? `停止检测 ${modelId}`
                                              : `检测 ${modelId}`
                                          }
                                          onClick={() =>
                                            testModelHealth({ id: modelId }, endpoint.id)
                                          }
                                          disabled={!!health?.loading}
                                          title={
                                            health?.error ||
                                            (canStopHealthCheck
                                              ? '停止检测'
                                              : health?.loading
                                                ? '检测中'
                                                : '检测模型')
                                          }
                                          icon={
                                            healthCheckAnimating ? (
                                              <Loader size="sm" />
                                            ) : (
                                              <Activity className="h-3.5 w-3.5" />
                                            )
                                          }
                                        />
                                        <Button
                                          shape="square"
                                          size="sm"
                                          variant="secondary"
                                          aria-label={`复制 ${modelId}`}
                                          onClick={() => {
                                            navigator.clipboard.writeText(modelId);
                                            toast.success('已复制模型名称');
                                          }}
                                          title="复制模型名称"
                                          icon={<Copy className="h-3.5 w-3.5" />}
                                        />
                                      </div>
                                    </Table.Cell>
                                  </Table.Row>
                                );
                              })
                            ) : (
                              <Table.Row>
                                <Table.Cell
                                  colSpan={5}
                                  className="py-10 text-center text-kumo-subtle"
                                >
                                  暂无模型数据，可刷新端点获取
                                </Table.Cell>
                              </Table.Row>
                            )}
                          </Table.Body>
                        </Table>
                      </div>
                    </LayerCard>
                  </section>
                </div>
              );
            })()
          )}
        </GatewaySection>
      )}

      {/* ==================== 2. API 密钥 Tab ==================== */}
      {activeTab === 'keys' && (
        <GatewaySection
          className="min-h-0 flex-1"
          title="API 密钥"
          description="管理客户端密钥"
          icon={<Key className="h-4 w-4 text-kumo-brand" />}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={loadGatewayKeys}
                disabled={gatewayKeysLoading}
                className="flex items-center gap-1.5"
              >
                <RefreshCw
                  className={cx(iconButtonIconClass, gatewayKeysLoading && 'animate-spin')}
                />
                <span>刷新</span>
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={openAddGatewayKeyModal}
                className="flex items-center gap-1.5"
              >
                <Plus className={iconButtonIconClass} />
                <span>新建密钥</span>
              </Button>
            </div>
          }
          bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
        >
          <LayerCard className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden p-0 shadow-none">
            <div className="min-h-0 min-w-0 flex-1 overflow-auto scrollbar-thin">
              <Table layout="fixed" className="min-w-[1084px]">
                <colgroup>
                  <col style={{ width: 180 }} />
                  <col style={{ width: 320 }} />
                  <col style={{ width: 92 }} />
                  <col style={{ width: 140 }} />
                  <col style={{ width: 140 }} />
                  <col style={{ width: 96 }} />
                  <col style={{ width: 172 }} />
                </colgroup>
                <Table.Header sticky variant="compact">
                  <Table.Row>
                    <Table.Head>名称</Table.Head>
                    <Table.Head>密钥</Table.Head>
                    <Table.Head className="text-center">状态</Table.Head>
                    <Table.Head>最近使用</Table.Head>
                    <Table.Head>过期时间</Table.Head>
                    <Table.Head className="text-right">请求数</Table.Head>
                    <Table.Head className="app-table-action">操作</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {gatewayKeysLoading ? (
                    [...Array(3)].map((_, i) => (
                      <Table.Row key={i}>
                        <Table.Cell>
                          <SkeletonLine className="h-4 w-24" />
                        </Table.Cell>
                        <Table.Cell>
                          <SkeletonLine className="h-4 w-28" />
                        </Table.Cell>
                        <Table.Cell className="text-center">
                          <SkeletonLine className="mx-auto h-4 w-12" />
                        </Table.Cell>
                        <Table.Cell>
                          <SkeletonLine className="h-4 w-24" />
                        </Table.Cell>
                        <Table.Cell>
                          <SkeletonLine className="h-4 w-24" />
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <SkeletonLine className="ml-auto h-4 w-12" />
                        </Table.Cell>
                        <Table.Cell>
                          <SkeletonLine className="mx-auto h-4 w-24" />
                        </Table.Cell>
                      </Table.Row>
                    ))
                  ) : gatewayKeys.length === 0 ? (
                    <Table.Row>
                      <Table.Cell colSpan={7} className="p-8 text-center text-kumo-subtle">
                        暂无网关 API 密钥
                      </Table.Cell>
                    </Table.Row>
                  ) : (
                    gatewayKeys.map(key => (
                      <Table.Row
                        key={key.id}
                        className="hover:bg-kumo-recessed/5 cursor-pointer"
                        title="双击编辑密钥"
                        onDoubleClick={event =>
                          handleEditableRowDoubleClick(event, () => openEditGatewayKeyModal(key))
                        }
                      >
                        <Table.Cell
                          className="truncate font-semibold text-kumo-strong"
                          title={key.name}
                        >
                          {key.name || '未命名密钥'}
                        </Table.Cell>
                        <Table.Cell>
                          {key.apiKey ? (
                            <ClipboardText
                              size="sm"
                              text={key.apiKey}
                              className="min-w-0 w-full font-mono text-[0.9em]"
                              tooltip={{ text: '复制 API Key', copiedText: 'API Key 已复制' }}
                              labels={{ copyAction: `复制 ${key.name} 的 API Key` }}
                            />
                          ) : (
                            <span className="text-sm text-kumo-subtle">轮换后可查看并复制</span>
                          )}
                        </Table.Cell>
                        <Table.Cell className="text-center">
                          <InlineStatusPill tone={key.enabled ? 'success' : 'neutral'}>
                            {key.enabled ? '已启用' : '已停用'}
                          </InlineStatusPill>
                        </Table.Cell>
                        <Table.Cell className="truncate text-sm text-kumo-subtle">
                          {key.lastUsed ? formatDateTime(key.lastUsed) : '从未使用'}
                        </Table.Cell>
                        <Table.Cell className="truncate text-sm text-kumo-subtle">
                          {key.expiresAt ? formatDateTime(key.expiresAt) : '永不过期'}
                        </Table.Cell>
                        <Table.Cell className="text-right font-mono text-[0.9em] text-kumo-strong">
                          {(key.requestCount || 0).toLocaleString()}
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex justify-center gap-1.5">
                            <Button
                              shape="square"
                              size="sm"
                              variant={key.enabled ? 'secondary-destructive' : 'primary'}
                              aria-label={key.enabled ? '停用密钥' : '启用密钥'}
                              onClick={() => toggleGatewayKey(key)}
                              title={key.enabled ? '停用密钥' : '启用密钥'}
                              disabled={!!gatewayKeyToggleLoading[key.id]}
                            >
                              <span className="flex h-4 w-4 items-center justify-center">
                                <Reboot
                                  className={cx(
                                    'h-3.5 w-3.5',
                                    gatewayKeyToggleLoading[key.id] && 'animate-spin'
                                  )}
                                />
                              </span>
                            </Button>
                            <Button
                              shape="square"
                              size="sm"
                              variant="outline"
                              aria-label="轮换密钥"
                              onClick={() => rotateGatewayKey(key)}
                              className="text-kumo-subtle hover:text-kumo-brand"
                              title="轮换密钥"
                            >
                              <RotateCw className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              shape="square"
                              size="sm"
                              variant="outline"
                              aria-label="编辑密钥"
                              onClick={() => openEditGatewayKeyModal(key)}
                              className="hover:text-kumo-brand text-kumo-subtle"
                              title="编辑密钥"
                            >
                              <Edit className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              shape="square"
                              size="sm"
                              variant="secondary-destructive"
                              aria-label="删除密钥"
                              onClick={() => deleteGatewayKey(key)}
                              title="删除密钥"
                            >
                              <Trash className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    ))
                  )}
                </Table.Body>
              </Table>
            </div>
          </LayerCard>
        </GatewaySection>
      )}

      {/* ==================== 3. 网关分析 Tab ==================== */}
      {activeTab === 'analytics' && (
        <GatewaySection
          className="min-h-0 flex-1"
          title="网关分析"
          description="可靠性、Token、调用方"
          icon={<Activity className="h-4 w-4 text-kumo-brand" />}
          actions={
            <div className="flex items-center gap-3">
              <Select
                size="sm"
                aria-label="选择分析范围"
                value={String(analyticsDays)}
                onValueChange={val => {
                  setAnalyticsDays(Number(val));
                  setAnalyticsPage(1);
                }}
                items={[
                  { value: '1', label: '最近 24 小时' },
                  { value: '7', label: '最近 7 天' },
                  { value: '30', label: '最近 30 天' },
                ]}
                className="w-36 text-sm text-kumo-strong"
              />
              <Button
                size="sm"
                onClick={fetchAnalytics}
                disabled={analyticsLoading}
                className="flex items-center gap-1.5"
              >
                <RefreshCw className={cx('w-3.5 h-3.5', analyticsLoading && 'animate-spin')} />
                <span>刷新</span>
              </Button>
            </div>
          }
          bodyClassName="flex min-h-0 flex-1 flex-col gap-3"
        >
          <div className="grid shrink-0 gap-3 xl:h-44 xl:grid-cols-[minmax(24rem,1.15fr)_minmax(18rem,0.85fr)_minmax(18rem,0.85fr)]">
            <LayerCard className="grid overflow-hidden p-0 shadow-none sm:grid-cols-2">
              <div className="flex min-w-0 items-center justify-between gap-3 border-b border-kumo-line px-4 py-3 sm:border-r">
                <span className="text-sm font-medium text-kumo-subtle">网关请求</span>
                <span className="font-mono text-lg font-semibold text-kumo-strong">
                  {analyticsLoading ? (
                    <SkeletonLine className="h-5 w-16" />
                  ) : (
                    analyticsSummary.totalRequests
                  )}
                </span>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-3 border-b border-kumo-line px-4 py-3">
                <span className="text-sm font-medium text-kumo-subtle">平均端到端延迟</span>
                <span className="font-mono text-lg font-semibold text-kumo-warning">
                  {analyticsLoading ? (
                    <SkeletonLine className="h-5 w-16" />
                  ) : (
                    `${analyticsSummary.avgLatency.toFixed(0)} ms`
                  )}
                </span>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-3 border-b border-kumo-line px-4 py-3 sm:border-b-0 sm:border-r">
                <span className="text-sm font-medium text-kumo-subtle">Token 用量</span>
                <span className="font-mono text-lg font-semibold text-kumo-brand">
                  {analyticsLoading ? (
                    <SkeletonLine className="h-5 w-20" />
                  ) : (
                    analyticsSummary.totalTokens.toLocaleString()
                  )}
                </span>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm font-medium text-kumo-subtle">上游错误率</span>
                <span className="font-mono text-lg font-semibold text-kumo-danger">
                  {analyticsLoading ? (
                    <SkeletonLine className="h-5 w-16" />
                  ) : (
                    `${(analyticsSummary.errorRate * 100).toFixed(1)}%`
                  )}
                </span>
              </div>
            </LayerCard>

            <AppCard padding="md" className="flex min-h-0 flex-col gap-3 xl:h-full">
              <div className="flex items-center gap-1.5">
                <PieChart className="w-4 h-4 text-kumo-brand" />
                <h4 className="text-sm font-semibold text-kumo-strong">模型 Token 分布</h4>
              </div>
              <div className="max-h-44 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1 scrollbar-thin xl:max-h-none">
                {analyticsLoading ? (
                  <div className="space-y-2">
                    <SkeletonLine className="w-full h-4" />
                    <SkeletonLine className="w-full h-4" />
                  </div>
                ) : !analyticsCharts.models || analyticsCharts.models.length === 0 ? (
                  <div className="text-center py-16 text-kumo-subtle text-sm">暂无模型数据</div>
                ) : (
                  (() => {
                    const totalTokens =
                      analyticsCharts.models.reduce(
                        (sum, model) => sum + (Number(model.tokens) || 0),
                        0
                      ) || 1;
                    return [...analyticsCharts.models]
                      .sort((a, b) => (Number(b.tokens) || 0) - (Number(a.tokens) || 0))
                      .map(model => {
                        const tokens = Number(model.tokens) || 0;
                        const percent = (tokens / totalTokens) * 100;
                        const pct = percent.toFixed(1);
                        return (
                          <div key={model.model} className="space-y-1 text-sm">
                            <Meter
                              label={model.model}
                              value={percent}
                              customValue={`${tokens.toLocaleString()} Token (${pct}%)`}
                              trackClassName="h-2 bg-kumo-recessed"
                              indicatorClassName="bg-kumo-brand"
                            />
                          </div>
                        );
                      });
                  })()
                )}
              </div>
            </AppCard>

            <AppCard padding="md" className="flex min-h-0 flex-col gap-3 xl:h-full">
              <div className="flex items-center gap-1.5">
                <Activity className="h-4 w-4 text-kumo-brand" />
                <h4 className="text-sm font-semibold text-kumo-strong">模型调用次数</h4>
              </div>
              <div className="max-h-44 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1 scrollbar-thin xl:max-h-none">
                {analyticsLoading ? (
                  <div className="space-y-2">
                    <SkeletonLine className="h-4 w-full" />
                    <SkeletonLine className="h-4 w-full" />
                  </div>
                ) : !analyticsCharts.models || analyticsCharts.models.length === 0 ? (
                  <div className="py-16 text-center text-sm text-kumo-subtle">暂无模型数据</div>
                ) : (
                  (() => {
                    const totalCount =
                      analyticsCharts.models.reduce(
                        (sum, model) => sum + (Number(model.count) || 0),
                        0
                      ) || 1;
                    return [...analyticsCharts.models]
                      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
                      .map(model => {
                        const count = Number(model.count) || 0;
                        const percent = (count / totalCount) * 100;
                        return (
                          <div key={model.model} className="space-y-1 text-sm">
                            <Meter
                              label={model.model}
                              value={percent}
                              customValue={`${count.toLocaleString()} 次 (${percent.toFixed(1)}%)`}
                              trackClassName="h-2 bg-kumo-recessed"
                              indicatorClassName="bg-kumo-brand"
                            />
                          </div>
                        );
                      });
                  })()
                )}
              </div>
            </AppCard>
          </div>

          {/* Logs table and pagination */}
          <LayerCard className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden p-0 shadow-none">
            <div className="min-h-0 min-w-0 flex-1 overflow-auto scrollbar-thin">
              <Table layout="fixed" className="min-w-[1128px]">
                <colgroup>
                  <col style={{ width: 156 }} />
                  <col style={{ width: 112 }} />
                  <col style={{ width: 136 }} />
                  <col style={{ width: 132 }} />
                  <col style={{ width: 220 }} />
                  <col style={{ width: 84 }} />
                  <col style={{ width: 92 }} />
                  <col style={{ width: 132 }} />
                  <col style={{ width: 92 }} />
                </colgroup>
                <Table.Header sticky variant="compact">
                  <Table.Row>
                    <Table.Head>时间</Table.Head>
                    <Table.Head>路由</Table.Head>
                    <Table.Head>端点</Table.Head>
                    <Table.Head>调用密钥</Table.Head>
                    <Table.Head>模型</Table.Head>
                    <Table.Head className="text-center">状态</Table.Head>
                    <Table.Head className="text-right">延迟</Table.Head>
                    <Table.Head className="text-right">Prompt / Completion</Table.Head>
                    <Table.Head className="text-right">总消耗</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {analyticsLoading && analyticsLogs.length === 0 ? (
                    <Table.Row>
                      <Table.Cell colSpan={9} className="text-center py-8">
                        <RotateCw className="w-5 h-5 animate-spin mx-auto text-kumo-subtle" />
                      </Table.Cell>
                    </Table.Row>
                  ) : analyticsLogs.length === 0 ? (
                    <Table.Row>
                      <Table.Cell colSpan={9} className="text-center py-8 text-kumo-subtle text-sm">
                        暂无网关日志记录
                      </Table.Cell>
                    </Table.Row>
                  ) : (
                    analyticsLogs.map(log => (
                      <Table.Row key={log.id} className="text-sm">
                        <Table.Cell className="truncate text-kumo-subtle font-mono">
                          {formatDateTime(log.timestamp)}
                        </Table.Cell>
                        <Table.Cell
                          className="truncate font-mono text-kumo-subtle"
                          title={log.route}
                        >
                          {log.route === 'chat.completions'
                            ? '对话完成'
                            : log.route === 'models'
                              ? '模型列表'
                              : log.route || '-'}
                        </Table.Cell>
                        <Table.Cell
                          className="truncate text-kumo-strong font-semibold"
                          title={log.endpointName}
                        >
                          {log.endpointName}
                        </Table.Cell>
                        <Table.Cell
                          className="truncate text-kumo-subtle"
                          title={log.gatewayKeyName}
                        >
                          {log.gatewayKeyName || '未识别密钥'}
                        </Table.Cell>
                        <Table.Cell
                          className="truncate text-kumo-strong font-mono font-medium"
                          title={log.model}
                        >
                          {log.model}
                        </Table.Cell>
                        <Table.Cell className="text-center">
                          <InlineStatusPill tone={log.statusCode < 400 ? 'success' : 'danger'}>
                            {log.statusCode}
                          </InlineStatusPill>
                        </Table.Cell>
                        <Table.Cell className="text-right text-kumo-strong font-mono font-semibold">
                          {log.latencyMs} ms
                        </Table.Cell>
                        <Table.Cell className="text-right text-kumo-subtle font-mono">
                          {log.promptTokens} / {log.completionTokens}
                        </Table.Cell>
                        <Table.Cell className="text-right text-kumo-brand font-mono font-semibold">
                          {log.totalTokens}
                        </Table.Cell>
                      </Table.Row>
                    ))
                  )}
                </Table.Body>
              </Table>
            </div>

            {analyticsTotal > 0 && (
              <Pagination
                page={analyticsPage}
                setPage={setAnalyticsPage}
                perPage={analyticsPageSize}
                totalCount={analyticsTotal}
                labels={{
                  navigation: '网关日志分页',
                  firstPage: '第一页',
                  previousPage: '上一页',
                  nextPage: '下一页',
                  lastPage: '最后一页',
                  pageNumber: '页码',
                  pageSize: '每页数量',
                }}
                className="shrink-0 border-x-0 border-b-0 border-t border-kumo-line bg-kumo-base px-3 py-2 text-sm shadow-none"
              >
                <Pagination.Info>
                  {({ pageShowingRange, totalCount }) => (
                    <span className="text-kumo-subtle">
                      显示 {pageShowingRange}，共 {totalCount} 条
                    </span>
                  )}
                </Pagination.Info>
                <Pagination.Separator />
                <Pagination.PageSize
                  value={analyticsPageSize}
                  onChange={size => {
                    setAnalyticsPageSize(size);
                    setAnalyticsPage(1);
                  }}
                  options={[10, 20, 50, 100]}
                  label="每页"
                />
                <Pagination.Controls />
              </Pagination>
            )}
          </LayerCard>
        </GatewaySection>
      )}

      {/* ==================== dialogs & modals ==================== */}

      {/* 1. Endpoint Add/Edit Dialog */}
      <Dialog.Root open={endpointFormOpen} onOpenChange={setEndpointFormOpen}>
        <Dialog className="!w-[min(32rem,calc(100vw-2rem))] !max-w-[min(32rem,calc(100vw-2rem))] p-6">
          <Dialog.Title className="text-sm font-semibold text-kumo-strong mb-1">
            {editingEndpoint ? '编辑端点' : '添加 API 端点'}
          </Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle mb-4">
            配置 OpenAI 兼容的 API 端点以供中转或对话使用。
          </Dialog.Description>

          <div className="space-y-4">
            <Input
              size="sm"
              label="名称"
              type="text"
              value={endpointForm.name}
              onChange={e => setEndpointForm({ ...endpointForm, name: e.target.value })}
              placeholder="如：DeepSeek 官方"
              className="w-full text-kumo-strong text-sm font-sans"
            />

            <Input
              size="sm"
              label="Base URL"
              type="text"
              value={endpointForm.baseUrl}
              onChange={e => setEndpointForm({ ...endpointForm, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              className="w-full text-kumo-strong text-[0.9em] font-mono"
            />

            <Input
              size="sm"
              label="API Key"
              type="text"
              value={endpointForm.apiKey}
              onChange={e => setEndpointForm({ ...endpointForm, apiKey: e.target.value })}
              placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              spellCheck={false}
              className="w-full text-kumo-strong text-[0.9em] font-mono"
            />

            <Input
              size="sm"
              label="备注"
              type="text"
              value={endpointForm.notes}
              onChange={e => setEndpointForm({ ...endpointForm, notes: e.target.value })}
              placeholder="选填"
              className="w-full text-kumo-strong text-sm font-sans"
            />

            {endpointFormError && (
              <p className="text-sm text-kumo-danger font-semibold">{endpointFormError}</p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Dialog.Close
                render={props => (
                  <Button size="sm" {...props} variant="secondary">
                    取消
                  </Button>
                )}
              />
              <Button size="sm" variant="primary" disabled={endpointSaving} onClick={saveEndpoint}>
                {endpointSaving ? '保存中...' : '保存端点'}
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      {/* 2. Gateway Key Dialogs */}
      <Dialog.Root open={gatewayKeyDialogOpen} onOpenChange={setGatewayKeyDialogOpen}>
        <Dialog className="!w-[min(30rem,calc(100vw-2rem))] !max-w-[min(30rem,calc(100vw-2rem))] p-6">
          <Dialog.Title className="mb-1 text-sm font-semibold text-kumo-strong">
            {editingGatewayKey ? '编辑 API 密钥' : '新建 API 密钥'}
          </Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-kumo-subtle">
            此密钥用于客户端调用 /v1 兼容接口，不会暴露上游供应商 API Key。
          </Dialog.Description>

          <div className="space-y-4">
            <Input
              size="sm"
              label="名称"
              value={gatewayKeyForm.name}
              onChange={e => setGatewayKeyForm({ ...gatewayKeyForm, name: e.target.value })}
              placeholder="如：生产环境、Open WebUI"
              className="w-full text-sm text-kumo-strong"
            />
            <div className="space-y-1.5">
              <Label showOptional>过期时间</Label>
              <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_0.75rem_4.5rem] items-center gap-2">
                <Popover>
                  <Popover.Trigger
                    render={
                      <Button
                        size="sm"
                        variant="outline"
                        icon={CalendarDotsIcon}
                        className="min-w-0 justify-start font-normal"
                      />
                    }
                  >
                    <span className="truncate">
                      {gatewayKeyForm.expiresAt
                        ? formatDateTime(gatewayKeyForm.expiresAt)
                        : '永不过期'}
                    </span>
                  </Popover.Trigger>
                  <Popover.Content className="p-3">
                    <DatePicker
                      size="sm"
                      mode="single"
                      selected={parseLocalDateTime(gatewayKeyForm.expiresAt)}
                      onChange={updateGatewayKeyExpiryDate}
                    />
                    {gatewayKeyForm.expiresAt && (
                      <div className="mt-2 flex justify-end border-t border-kumo-line pt-2">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setGatewayKeyForm(current => ({ ...current, expiresAt: '' }))
                          }
                        >
                          清除
                        </Button>
                      </div>
                    )}
                  </Popover.Content>
                </Popover>
                <Select
                  size="sm"
                  aria-label="过期小时"
                  disabled={!gatewayKeyForm.expiresAt}
                  value={gatewayKeyForm.expiresAt.slice(11, 13)}
                  onValueChange={value => updateGatewayKeyExpiryTime('hour', value)}
                  items={GATEWAY_EXPIRY_HOURS}
                />
                <span className="text-center text-sm text-kumo-subtle">:</span>
                <Select
                  size="sm"
                  aria-label="过期分钟"
                  disabled={!gatewayKeyForm.expiresAt}
                  value={gatewayKeyForm.expiresAt.slice(14, 16)}
                  onValueChange={value => updateGatewayKeyExpiryTime('minute', value)}
                  items={GATEWAY_EXPIRY_MINUTES}
                />
              </div>
            </div>
            {gatewayKeyFormError && (
              <p className="text-sm font-semibold text-kumo-danger">{gatewayKeyFormError}</p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Dialog.Close
                render={props => (
                  <Button size="sm" {...props} variant="secondary">
                    取消
                  </Button>
                )}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={gatewayKeySaving}
                onClick={saveGatewayKey}
              >
                {gatewayKeySaving ? '保存中...' : '保存密钥'}
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={!!newGatewayKey} onOpenChange={open => !open && setNewGatewayKey(null)}>
        <Dialog className="!w-[min(34rem,calc(100vw-2rem))] !max-w-[min(34rem,calc(100vw-2rem))] p-6">
          <Dialog.Title className="mb-1 text-sm font-semibold text-kumo-strong">
            API 密钥已创建
          </Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-kumo-subtle">
            可立即复制，也可稍后从 API 密钥列表查看并复制。
          </Dialog.Description>
          <div className="space-y-4">
            <p className="text-sm font-medium text-kumo-strong">
              {newGatewayKey?.name || 'API Key'}
            </p>
            <ClipboardText
              size="sm"
              text={newGatewayKey?.apiKey || ''}
              className="min-w-0 w-full"
              tooltip={{ text: '复制 API Key', copiedText: 'API Key 已复制' }}
              labels={{ copyAction: '复制 API Key' }}
            />
            <div className="flex justify-end">
              <Dialog.Close
                render={props => (
                  <Button size="sm" variant="primary" {...props}>
                    我已保存
                  </Button>
                )}
              />
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      {/* 3. Health Check Config Dialog */}
      <Dialog.Root open={healthCheckModal} onOpenChange={setHealthCheckModal}>
        <Dialog className="!w-[min(32rem,calc(100vw-2rem))] !max-w-[min(32rem,calc(100vw-2rem))] p-6">
          <Dialog.Title className="text-sm font-semibold text-kumo-strong mb-1">
            模型健康检测
          </Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle mb-4">
            按设定并发逐批发送轻量请求，测试每个模型的可用性与延迟。
          </Dialog.Description>

          <div className="space-y-4">
            <div className="bg-kumo-warning/10 border border-kumo-warning/20 text-kumo-warning px-3 py-2 text-sm space-y-1">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                警告
              </p>
              <p>批量检测会发送真实请求；并发数越高，越容易触发供应商限流、风控或短时失败。</p>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-kumo-strong">检测方式</span>
              <InlineStatusPill tone="info">实时逐项回填</InlineStatusPill>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-kumo-strong">超时限制</span>
              <div className="flex items-center gap-1.5">
                <Input
                  size="sm"
                  aria-label="健康检测超时限制"
                  type="number"
                  value={healthCheckForm.timeout}
                  onChange={e =>
                    setHealthCheckForm({ ...healthCheckForm, timeout: Number(e.target.value) })
                  }
                  min={1}
                  max={60}
                  className="w-16 text-kumo-strong text-sm px-2 py-1 text-center"
                />
                <span className="text-kumo-subtle">秒</span>
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-kumo-strong">并发数</span>
              <div className="flex items-center gap-1.5">
                <Input
                  size="sm"
                  aria-label="健康检测并发数"
                  type="number"
                  value={healthCheckForm.concurrency}
                  onChange={e =>
                    setHealthCheckForm({
                      ...healthCheckForm,
                      concurrency: Number(e.target.value),
                    })
                  }
                  min={1}
                  max={30}
                  className="w-16 text-kumo-strong text-sm px-2 py-1 text-center"
                />
                <span className="text-kumo-subtle">个请求</span>
              </div>
            </div>

            <p className="text-xs text-kumo-subtle">
              默认 {DEFAULT_MODEL_HEALTH_CONCURRENCY}；点击“开始检测”时最多检测前{' '}
              {MAX_BATCH_MODEL_HEALTH_TARGETS} 个模型，并按返回顺序实时显示结果。
            </p>

            <div className="flex justify-end gap-3 pt-2">
              <Dialog.Close
                render={props => (
                  <Button size="sm" {...props} variant="secondary">
                    取消
                  </Button>
                )}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={modelHealthBatchLoading}
                onClick={startBatchHealthCheck}
              >
                {modelHealthBatchLoading ? '检测中...' : '开始检测'}
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </PageStack>
  );
}

export default OpenAIPage;
