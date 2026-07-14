import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Input, Textarea } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { Switch } from '@cloudflare/kumo/components/switch';
import { Table } from '@cloudflare/kumo/components/table';
import { Tabs } from '@cloudflare/kumo';
import { toast } from '../modules/toast.js';
import { dialog } from '../modules/dialog.js';
import useStore, {
  DEFAULT_MODULE_ORDER,
  MODULE_CONFIG,
  MODULE_GROUPS,
  applyCustomCss,
  getGroupModuleIds,
  normalizeUserSettings,
} from '../store.js';
import { MODULE_TABS_PROPS } from '../modules/kumoTabs.js';
import { AppCard, SectionCard, cx } from '../components/ui/AppPrimitives.jsx';
import { BackupPanel } from './BackupPage.jsx';
import {
  Activity,
  Bell,
  Check,
  Database,
  Download,
  FileText,
  Globe,
  HardDrive,
  LayoutDashboard,
  Lock,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shield,
  Sun,
  Terminal,
  Trash,
  Upload,
  getModuleIconComponent,
} from '../components/Icons.jsx';

const SETTINGS_TABS = [
  { value: 'general', label: <span className="inline-flex items-center gap-1.5"><LayoutDashboard className="h-4 w-4" />常规</span> },
  { value: 'modules', label: <span className="inline-flex items-center gap-1.5"><Activity className="h-4 w-4" />模块</span> },
  { value: 'security', label: <span className="inline-flex items-center gap-1.5"><Shield className="h-4 w-4" />安全</span> },
  { value: 'database', label: <span className="inline-flex items-center gap-1.5"><Database className="h-4 w-4" />数据库</span> },
  { value: 'logs', label: <span className="inline-flex items-center gap-1.5"><FileText className="h-4 w-4" />审计</span> },
  { value: 'appearance', label: <span className="inline-flex items-center gap-1.5"><Sun className="h-4 w-4" />外观</span> },
  { value: 'about', label: <span className="inline-flex items-center gap-1.5"><Settings className="h-4 w-4" />关于</span> },
];

const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const PAGE_WIDTH_OPTIONS = [
  { value: 'standard', label: '标准' },
  { value: 'wide', label: '宽屏' },
  { value: 'full', label: '全宽' },
];

const TIMEZONE_OPTIONS = [
  { value: 'system', label: '跟随服务器' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Asia/Shanghai', label: '中国标准时间 (Asia/Shanghai)' },
  { value: 'Asia/Tokyo', label: '日本时间 (Asia/Tokyo)' },
  { value: 'Asia/Singapore', label: '新加坡时间 (Asia/Singapore)' },
  { value: 'Europe/London', label: '伦敦时间 (Europe/London)' },
  { value: 'Europe/Berlin', label: '柏林时间 (Europe/Berlin)' },
  { value: 'America/New_York', label: '纽约时间 (America/New_York)' },
  { value: 'America/Los_Angeles', label: '洛杉矶时间 (America/Los_Angeles)' },
];



const getAuthHeaders = () => ({
  'Content-Type': 'application/json',
  'x-admin-password': localStorage.getItem('admin_password') || useStore.getState().loginPassword || '',
});

const getUploadHeaders = () => ({
  'x-admin-password': localStorage.getItem('admin_password') || useStore.getState().loginPassword || '',
});

const formatFileSize = (bytes) => {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(2)} KB`;
  return `${size} B`;
};

const toInt = (value, fallback = 0) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const moduleRows = DEFAULT_MODULE_ORDER.map((moduleId) => {
  const group = MODULE_GROUPS.find((item) => getGroupModuleIds(item).includes(moduleId));
  return {
    id: moduleId,
    groupId: group?.id || 'other',
    groupName: group?.name || '其他模块',
    config: MODULE_CONFIG[moduleId] || { name: moduleId },
  };
});

function FieldRow({ title, description, children }) {
  return (
    <div className="grid gap-3 border-b border-kumo-line px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] md:items-center">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-kumo-strong">{title}</div>
        {description && <div className="mt-1 text-xs leading-relaxed text-kumo-subtle">{description}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function StatCard({ label, value, hint, icon: Icon }) {
  return (
    <AppCard padding="lg">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-normal text-kumo-subtle">{label}</div>
          <div className="mt-2 truncate text-lg font-bold text-kumo-strong">{value}</div>
          {hint && <div className="mt-1 text-xs text-kumo-subtle">{hint}</div>}
        </div>
        {Icon && (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-kumo-line bg-kumo-recessed text-kumo-brand">
            <Icon className="h-4 w-4" />
          </div>
        )}
      </div>
    </AppCard>
  );
}

function SummaryMetricCard({ label, value, hint, tone = 'default', compact = false }) {
  const valueToneClass = {
    default: 'text-kumo-strong',
    brand: 'text-kumo-brand',
    warning: 'text-kumo-warning',
    info: 'text-kumo-info',
    success: 'text-kumo-success',
    danger: 'text-kumo-danger',
  };

  return (
    <AppCard
      padding={compact ? 'sm' : 'md'}
      className={cx(
        'flex min-w-0',
        compact ? 'min-h-[4.5rem] flex-col items-start justify-center gap-1.5' : 'flex-col gap-1',
      )}
    >
      <span className={cx('font-bold uppercase tracking-wider text-kumo-subtle', compact ? 'text-[11px] leading-none' : 'text-[10px]')}>
        {label}
      </span>
      <span className={cx('font-mono font-bold leading-none', compact ? 'text-lg sm:text-base' : 'text-xl', valueToneClass[tone] || valueToneClass.default)}>
        {value}
      </span>
      {!compact && hint ? <span className="truncate text-[11px] text-kumo-subtle">{hint}</span> : null}
    </AppCard>
  );
}

function MaintenanceActionCard({
  title,
  description,
  icon,
  tone = 'default',
  meta,
  children,
}) {
  const toneClassName = {
    default: 'border-kumo-line/80 bg-kumo-recessed/15',
    brand: 'border-kumo-brand/15 bg-kumo-brand/5',
    danger: 'border-kumo-danger/20 bg-kumo-danger/5',
    warning: 'border-kumo-warning/20 bg-kumo-warning/5',
  };
  const compact = !description;

  return (
    <AppCard
      padding="md"
      className={cx(
        'flex min-h-[102px] min-w-0 flex-col gap-2 border',
        compact ? 'justify-center' : '',
        toneClassName[tone] || toneClassName.default,
      )}
    >
      <div className={cx('flex justify-between gap-3', compact ? 'items-center' : 'items-start')}>
        <div className={cx('flex min-w-0 gap-3', compact ? 'items-center' : 'items-start')}>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-kumo-line/70 bg-kumo-base text-kumo-brand">
            {icon}
          </div>
          <div className={cx('min-w-0', compact ? 'flex min-h-7 items-center' : '')}>
            <div className={cx('truncate text-sm font-semibold text-kumo-strong', compact ? 'leading-none' : '')}>{title}</div>
            {description ? <div className="mt-1 text-xs leading-relaxed text-kumo-subtle">{description}</div> : null}
          </div>
        </div>
        {meta ? <div className={cx('shrink-0', compact ? 'flex min-h-7 items-center' : '')}>{meta}</div> : null}
      </div>
      <div className={cx(compact ? 'pt-0.5' : 'mt-auto')}>{children}</div>
    </AppCard>
  );
}

function SettingsPage() {
  const {
    themeMode,
    theme,
    setThemeMode,
    pageWidthMode,
    setPageWidthMode,
    setVibrationEnabled,
    applyUserSettings,
    loadUserSettings,
    logout,
    isDemoMode,
  } = useStore();

  const fileInputRef = useRef(null);
  const [activeTab, setActiveTab] = useState('general');
  const [settings, setSettings] = useState(() => normalizeUserSettings());
  const [settingsPatch, setSettingsPatch] = useState({});
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [moduleSearch, setModuleSearch] = useState('');



  const [passwordForm, setPasswordForm] = useState({
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [passwordSaving, setPasswordSaving] = useState(false);

  const [twoFA, setTwoFA] = useState({
    enabled: false,
    setupMode: false,
    disableMode: false,
    loading: false,
    secret: '',
    qrCode: '',
    token: '',
    disablePassword: '',
    error: '',
  });

  const [dbStats, setDbStats] = useState(null);
  const [dbAnalysis, setDbAnalysis] = useState(null);
  const [deprecatedTables, setDeprecatedTables] = useState(null);
  const [databaseBusy, setDatabaseBusy] = useState(false);
  const [databaseLoaded, setDatabaseLoaded] = useState(false);
  const [dbImportPreview, setDbImportPreview] = useState(null);

  const [logSettings, setLogSettings] = useState({
    days: 0,
    count: 0,
    dbSizeMB: 0,
    logFileSizeMB: 10,
  });
  const [logFileInfo, setLogFileInfo] = useState(null);
  const [operationLogs, setOperationLogs] = useState([]);
  const [logsBusy, setLogsBusy] = useState(false);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [twoFALoaded, setTwoFALoaded] = useState(false);

  const currentOrigin = useMemo(() => {
    if (typeof window === 'undefined') return 'http://localhost';
    return window.location.origin;
  }, []);

  const tableRows = useMemo(() => {
    if (dbAnalysis?.tables?.length) return dbAnalysis.tables;
    return Object.entries(dbStats?.tables || {}).map(([table, rows]) => ({ table, rows }));
  }, [dbAnalysis, dbStats]);
  const formatTableRows = useCallback((rows) => {
    const value = Number(rows);
    return Number.isFinite(value) && value >= 0 ? value : '-';
  }, []);
  const formatTableMetricSize = useCallback((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? formatFileSize(parsed) : '-';
  }, []);

  const patchSettings = useCallback((patch) => {
    setSettings((prev) => normalizeUserSettings({ ...prev, ...patch }));
    setSettingsPatch((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleThemeModeChange = useCallback((value) => {
    const nextMode = String(value);
    setThemeMode(nextMode);
    patchSettings({ themeMode: nextMode });
  }, [patchSettings, setThemeMode]);

  const handlePageWidthModeChange = useCallback((value) => {
    const nextMode = String(value);
    setPageWidthMode(nextMode);
    patchSettings({ pageWidthMode: nextMode });
  }, [patchSettings, setPageWidthMode]);

  const handleVibrationEnabledChange = useCallback((checked) => {
    setVibrationEnabled(checked);
    patchSettings({ vibrationEnabled: Boolean(checked) });
  }, [patchSettings, setVibrationEnabled]);

  const fetchSettings = useCallback(async () => {
    const response = await fetch('/api/settings', { headers: getAuthHeaders() });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '加载用户设置失败');
    const normalized = normalizeUserSettings(result.data || {});
    setSettings(normalized);
    setSettingsPatch({});
    applyUserSettings(normalized);
    return normalized;
  }, [applyUserSettings]);

  const fetchDbState = useCallback(async () => {
    setDatabaseBusy(true);
    try {
      const [statsResponse, analysisResponse, deprecatedResponse] = await Promise.all([
        fetch('/api/settings/database-stats', { headers: getAuthHeaders() }),
        fetch('/api/settings/database-analysis?deep=1', { headers: getAuthHeaders() }),
        fetch('/api/settings/deprecated-tables', { headers: getAuthHeaders() }),
      ]);

      const statsResult = await statsResponse.json();
      if (statsResult.success) setDbStats(statsResult.data);

      const analysisResult = await analysisResponse.json();
      if (analysisResult.success) setDbAnalysis(analysisResult.data);

      const deprecatedResult = await deprecatedResponse.json();
      if (deprecatedResult.success) setDeprecatedTables(deprecatedResult.data);
      setDatabaseLoaded(true);
    } finally {
      setDatabaseBusy(false);
    }
  }, []);

  const fetchLogState = useCallback(async () => {
    setLogsBusy(true);
    try {
      const [logSettingsResponse, operationLogsResponse] = await Promise.all([
        fetch('/api/settings/log-settings', { headers: getAuthHeaders() }),
        fetch('/api/settings/operation-logs', { headers: getAuthHeaders() }),
      ]);

      const logSettingsResult = await logSettingsResponse.json();
      if (logSettingsResult.success) {
        setLogSettings(logSettingsResult.data);
        setLogFileInfo(logSettingsResult.fileInfo || null);
      }

      const operationLogsResult = await operationLogsResponse.json();
      if (operationLogsResult.success) {
        setOperationLogs(operationLogsResult.data || []);
      }
      setLogsLoaded(true);
    } finally {
      setLogsBusy(false);
    }
  }, []);

  const fetchTwoFAStatus = useCallback(async () => {
    const response = await fetch('/api/auth/2fa/status', { headers: getAuthHeaders() });
    const result = await response.json();
    if (result.success) {
      setTwoFA((prev) => ({ ...prev, enabled: !!result.enabled }));
      setTwoFALoaded(true);
    }
  }, []);



  const refreshCurrent = useCallback(async (showFeedback = false) => {
    setSettingsLoading(true);
    try {
      await fetchSettings();
      if (activeTab === 'database') await fetchDbState();
      if (activeTab === 'logs') await fetchLogState();
      if (activeTab === 'security') await fetchTwoFAStatus();
      if (showFeedback) toast.success('设置已刷新');
    } catch (error) {
      toast.error(error.message || '加载设置失败');
    } finally {
      setSettingsLoading(false);
    }
  }, [activeTab, fetchDbState, fetchLogState, fetchSettings, fetchTwoFAStatus]);

  useEffect(() => {
    let cancelled = false;
    setSettingsLoading(true);
    fetchSettings()
      .catch((error) => {
        if (!cancelled) toast.error(error.message || '加载设置失败');
      })
      .finally(() => {
        if (!cancelled) setSettingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchSettings]);

  useEffect(() => {
    if (activeTab === 'database' && !databaseLoaded && !databaseBusy) {
      fetchDbState().catch((error) => toast.error(error.message || '加载数据库统计失败'));
    }
  }, [activeTab, databaseBusy, databaseLoaded, fetchDbState]);

  useEffect(() => {
    if (activeTab === 'logs' && !logsLoaded && !logsBusy) {
      fetchLogState().catch((error) => toast.error(error.message || '加载审计日志失败'));
    }
  }, [activeTab, fetchLogState, logsBusy, logsLoaded]);

  useEffect(() => {
    if (activeTab === 'security' && !twoFALoaded) {
      fetchTwoFAStatus().catch((error) => toast.error(error.message || '加载 2FA 状态失败'));
    }
  }, [activeTab, fetchTwoFAStatus, twoFALoaded]);

  const persistSettings = async (successMessage = '设置已保存') => {
    const patch = settingsPatch;
    if (Object.keys(patch).length === 0) {
      toast.info('没有需要保存的设置');
      return true;
    }
    setSettingsSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify(patch),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '保存设置失败');

      const normalized = normalizeUserSettings(result.data || { ...settings, ...patch });
      setSettingsPatch({});
      setSettings(normalized);
      applyUserSettings(normalized);
      applyCustomCss(normalized.customCss);
      toast.success(successMessage);
      return true;
    } catch (error) {
      toast.error(error.message || '保存设置失败');
      return false;
    } finally {
      setSettingsSaving(false);
    }
  };



  const changePassword = async () => {
    if (passwordForm.newPassword.length < 6) {
      toast.warning('新密码至少需要 6 位');
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast.error('两次输入的新密码不一致');
      return;
    }

    setPasswordSaving(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          oldPassword: passwordForm.oldPassword,
          newPassword: passwordForm.newPassword,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || result.msg || '修改密码失败');

      toast.success('密码已修改，请重新登录');
      setPasswordForm({ oldPassword: '', newPassword: '', confirmPassword: '' });
      setTimeout(() => logout(), 1200);
    } catch (error) {
      toast.error(error.message || '修改密码失败');
    } finally {
      setPasswordSaving(false);
    }
  };

  const start2FASetup = async () => {
    setTwoFA((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const response = await fetch('/api/auth/2fa/setup', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '获取 2FA 二维码失败');

      setTwoFA((prev) => ({
        ...prev,
        setupMode: true,
        secret: result.secret,
        qrCode: result.qrCode,
        token: '',
        error: '',
      }));
    } catch (error) {
      setTwoFA((prev) => ({ ...prev, error: error.message || '获取 2FA 二维码失败' }));
      toast.error(error.message || '获取 2FA 二维码失败');
    } finally {
      setTwoFA((prev) => ({ ...prev, loading: false }));
    }
  };

  const confirm2FASetup = async () => {
    if (!/^\d{6}$/.test(twoFA.token)) {
      setTwoFA((prev) => ({ ...prev, error: '请输入 6 位验证码' }));
      return;
    }

    setTwoFA((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const response = await fetch('/api/auth/2fa/enable', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ secret: twoFA.secret, token: twoFA.token }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '启用 2FA 失败');

      setTwoFA((prev) => ({
        ...prev,
        enabled: true,
        setupMode: false,
        secret: '',
        qrCode: '',
        token: '',
        error: '',
      }));
      toast.success('2FA 已启用');
    } catch (error) {
      setTwoFA((prev) => ({ ...prev, error: error.message || '启用 2FA 失败' }));
    } finally {
      setTwoFA((prev) => ({ ...prev, loading: false }));
    }
  };

  const disable2FA = async () => {
    if (!twoFA.disablePassword) {
      setTwoFA((prev) => ({ ...prev, error: '请输入当前密码' }));
      return;
    }

    setTwoFA((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const response = await fetch('/api/auth/2fa/disable', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ password: twoFA.disablePassword }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '禁用 2FA 失败');

      setTwoFA((prev) => ({
        ...prev,
        enabled: false,
        disableMode: false,
        disablePassword: '',
        error: '',
      }));
      toast.success('2FA 已禁用');
    } catch (error) {
      setTwoFA((prev) => ({ ...prev, error: error.message || '禁用 2FA 失败' }));
    } finally {
      setTwoFA((prev) => ({ ...prev, loading: false }));
    }
  };

  const saveLogSettings = async () => {
    setLogsBusy(true);
    try {
      const response = await fetch('/api/settings/log-settings', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(logSettings),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '保存日志设置失败');
      setLogFileInfo(result.fileInfo || logFileInfo);
      toast.success('日志保留设置已保存');
    } catch (error) {
      toast.error(error.message || '保存日志设置失败');
    } finally {
      setLogsBusy(false);
    }
  };

  const postSettingsAction = async (path, successMessage, refresh = null, body = undefined) => {
    setLogsBusy(true);
    setDatabaseBusy(true);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '操作失败');
      toast.success(successMessage || result.message || '操作完成');
      if (refresh) await refresh();
    } catch (error) {
      toast.error(error.message || '操作失败');
    } finally {
      setLogsBusy(false);
      setDatabaseBusy(false);
    }
  };

  const exportDatabase = () => {
    window.location.href = '/api/settings/export-database';
  };

  const importDatabase = () => {
    fileInputRef.current?.click();
  };

  const previewDatabaseImport = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('database', file);
    setDatabaseBusy(true);
    setDbImportPreview(null);
    try {
      const response = await fetch('/api/settings/database/import/preview', {
        method: 'POST',
        headers: getUploadHeaders(),
        body: formData,
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '数据库预检失败');
      setDbImportPreview(result.data);
      if (result.data?.warnings?.length) {
        toast.warning('数据库预检通过，但存在警告');
      } else {
        toast.success('数据库预检通过，请确认后导入');
      }
    } catch (error) {
      toast.error(error.message || '数据库预检失败');
    } finally {
      setDatabaseBusy(false);
      if (event.target) event.target.value = '';
    }
  };

  const commitDatabaseImport = async () => {
    if (!dbImportPreview?.token) {
      toast.warning('请先上传数据库并完成预检');
      return;
    }
    if (!(await dialog.confirm('确定要替换当前数据库吗？系统会先备份当前数据库，导入后页面将刷新。'))) {
      return;
    }

    setDatabaseBusy(true);
    try {
      const response = await fetch('/api/settings/database/import/commit', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ token: dbImportPreview.token, confirm: true }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '导入数据库失败');
      toast.success('数据库已导入，页面将刷新');
      setTimeout(() => window.location.reload(), 800);
    } catch (error) {
      toast.error(error.message || '导入数据库失败');
    } finally {
      setDatabaseBusy(false);
    }
  };

  const cleanupDeprecatedTables = async () => {
    const candidates = deprecatedTables?.tables || [];
    if (candidates.length === 0) {
      toast.success('没有可清理的废弃表');
      return;
    }
    const ok = await dialog.confirm({
      title: '清理废弃表',
      message: `将删除 ${candidates.length} 张废弃表、${deprecatedTables.totalRows || 0} 行数据。系统会先自动备份当前数据库。`,
      confirmText: '清理',
      cancelText: '取消',
      variant: 'destructive',
    });
    if (!ok) return;
    await postSettingsAction(
      '/api/settings/cleanup-deprecated-tables',
      '废弃表已清理',
      fetchDbState,
      { tables: candidates.map((item) => item.table) }
    );
  };

  const toggleModule = (moduleId, checked) => {
    patchSettings({
      moduleVisibility: {
        ...settings.moduleVisibility,
        [moduleId]: moduleId === 'dashboard' ? true : checked,
      },
    });
  };

  const orderedModuleRows = useMemo(() => {
    const rowById = new Map(moduleRows.map((row) => [row.id, row]));
    const orderedIds = MODULE_GROUPS.flatMap((group) => [
      ...settings.moduleOrder.filter((moduleId) => (group.modules || []).includes(moduleId)),
      ...(group.subgroups || []).flatMap((subgroup) => (
        settings.moduleOrder.filter((moduleId) => (subgroup.modules || []).includes(moduleId))
      )),
      ...settings.moduleOrder.filter((moduleId) => (group.trailingModules || []).includes(moduleId)),
    ]);

    return orderedIds.map((moduleId) => rowById.get(moduleId)).filter(Boolean);
  }, [settings.moduleOrder]);
  const moduleGroups = useMemo(() => (
    MODULE_GROUPS
      .map((group) => ({
        id: group.id,
        name: group.name,
        count: orderedModuleRows.filter((item) => item.groupId === group.id).length,
      }))
      .filter((group) => group.count > 0)
  ), [orderedModuleRows]);
  const normalizedModuleSearch = moduleSearch.trim().toLocaleLowerCase();
  const filteredModuleRows = orderedModuleRows.filter((item) => {
    const matchesSearch = !normalizedModuleSearch || [item.config.name, item.config.description, item.groupName]
      .filter(Boolean)
      .some((value) => value.toLocaleLowerCase().includes(normalizedModuleSearch));
    return matchesSearch;
  });

  const databaseStorage = dbStats?.storage || dbAnalysis?.storage || null;
  const databaseSizeBytes = dbStats?.totalSize ?? dbStats?.dbSize;
  const databaseSizeHint = databaseStorage
    ? `主库 ${formatFileSize(databaseStorage.mainSizeBytes)} · WAL ${formatFileSize(databaseStorage.walSizeBytes)} · 空闲 ${formatFileSize(databaseStorage.freePageBytes)}`
    : (dbStats?.dbPath || '等待统计');
  const deprecatedTableItems = deprecatedTables?.tables || [];
  const contentViewportClassName = 'min-h-0 md:flex-1 md:overflow-auto';

  return (
    <div className="flex min-h-full w-full min-w-0 flex-col gap-3 px-px py-px sm:gap-4 md:h-full md:min-h-0 md:flex-1 md:overflow-hidden">
      <div className="flex shrink-0 flex-col gap-3 border-b border-kumo-line pb-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs
          {...MODULE_TABS_PROPS}
          value={activeTab}
          onValueChange={setActiveTab}
          tabs={SETTINGS_TABS}
        />

        <div className="flex flex-row flex-wrap items-center gap-2 lg:justify-end">
          <Button size="sm"
            onClick={() => refreshCurrent(true)}
            loading={settingsLoading || (activeTab === 'database' && databaseBusy) || (activeTab === 'logs' && logsBusy)}
            icon={<RefreshCw className="h-4 w-4" />}
          >
            刷新
          </Button>
          {['general', 'modules', 'appearance'].includes(activeTab) && (
            <Button size="sm"
              variant="primary"
              onClick={() => persistSettings()}
              loading={settingsSaving}
              icon={<Save className="h-4 w-4" />}
            >
              保存当前页设置
            </Button>
          )}
        </div>
      </div>

      <div className={contentViewportClassName}>
      {activeTab === 'general' && (
        <div className="grid min-h-0 items-start gap-4 px-px py-px pr-px md:h-full md:overflow-auto xl:grid-cols-[minmax(16rem,1fr)_minmax(0,3fr)]">
          <div className="grid min-h-0 gap-4">
            <StatCard label="运行状态" value="正常" hint={settingsLoading ? '同步中' : '已连接后端'} icon={Check} />
            <StatCard label="公网入口" value={settings.publicApiUrl || currentOrigin} hint="/api 自动拼接" icon={Globe} />
            <StatCard label="数据库大小" value={formatFileSize(databaseSizeBytes)} hint={databaseSizeHint} icon={Database} />
            <StatCard label="日志文件" value={logFileInfo?.sizeFormatted || `${logSettings.logFileSizeMB || 10} MB 上限`} hint="app.log" icon={FileText} />
          </div>

          <SectionCard
            title="部署访问地址"
            description="用于生成公开状态页、回调地址和对外 API 连接配置。"
            icon={<Globe className="h-4 w-4 text-kumo-brand" />}
            className="min-h-0 self-start"
            bodyPadding="none"
          >
            <FieldRow title="公网 API 地址" description="主控端可从公网访问时填写，留空则使用当前访问来源。">
              <Input size="sm"
                label="公网 API 地址"
                value={settings.publicApiUrl}
                onChange={(e) => patchSettings({ publicApiUrl: e.target.value })}
                placeholder="https://monitor.example.com"
              />
            </FieldRow>
            <FieldRow title="系统时区" description="用于后续展示本地化时间；跟随服务器时使用后端运行环境默认时区。">
              <Select
                size="sm"
                label="系统时区"
                value={settings.timezone}
                onValueChange={(value) => patchSettings({ timezone: value })}
                items={TIMEZONE_OPTIONS}
              />
            </FieldRow>
          </SectionCard>
        </div>
      )}



      {activeTab === 'modules' && (
        <div className="min-h-0 overflow-auto px-px py-px md:h-full">
        <SectionCard
          className="flex min-h-0 md:h-full"
          headerClassName="max-sm:min-h-12 max-sm:flex-row max-sm:items-center max-sm:px-3 max-sm:py-2"
          title="功能模块"
          description="集中管理现有侧栏入口；修改后即时生效，保存后长期保留。"
          icon={<Activity className="h-4 w-4 text-kumo-brand" />}
          actionsClassName="max-sm:ml-auto max-sm:w-auto max-sm:gap-1.5"
          actions={
              <>
                <Input
                  size="sm"
                  aria-label="搜索模块"
                  value={moduleSearch}
                  onChange={(event) => setModuleSearch(event.target.value)}
                  placeholder="搜索模块"
                  className="hidden w-52 sm:block"
                  prefix={<Search className="h-4 w-4" />}
                />
              </>
          }
          bodyClassName="flex min-h-0 flex-1 flex-col gap-3 overflow-auto"
        >
          <div className="sm:hidden">
            <Input
              size="sm"
              aria-label="搜索模块"
              value={moduleSearch}
              onChange={(event) => setModuleSearch(event.target.value)}
              placeholder="搜索模块名称或用途"
              className="w-full"
              prefix={<Search className="h-4 w-4" />}
            />
          </div>

          <div className="flex flex-col gap-3 sm:gap-4">
            {moduleGroups.map((group) => {
              const groupRows = filteredModuleRows.filter((row) => row.groupId === group.id);
              if (groupRows.length === 0) return null;

              return (
                <section key={group.id} className="min-w-0">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-kumo-subtle">
                    <span>{group.name}</span>
                    <span className="h-px min-w-4 flex-1 bg-kumo-line" />
                    <span className="font-normal">{groupRows.length} 项</span>
                  </div>
                  <div className="grid gap-1.5 lg:grid-cols-2 xl:grid-cols-3">
                    {groupRows.map((row) => {
                      const ModuleIcon = getModuleIconComponent(row.id);
                      const isVisible = settings.moduleVisibility[row.id] !== false;

                      return (
                        <div key={row.id} className={cx('flex min-h-15 items-center gap-2.5 rounded-md border px-2.5 py-2 transition-colors sm:min-h-16 sm:gap-3 sm:px-3', isVisible ? 'border-kumo-line bg-kumo-base' : 'border-kumo-line/70 bg-kumo-recessed/35 opacity-75')}>
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-kumo-line bg-kumo-recessed text-kumo-brand">
                            <ModuleIcon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-kumo-strong">{row.config.name}</div>
                            <div className="hidden truncate text-xs text-kumo-subtle sm:block">{row.config.description}</div>
                          </div>
                          <Switch
                            checked={isVisible}
                            onCheckedChange={(checked) => toggleModule(row.id, checked)}
                            disabled={row.id === 'dashboard'}
                            aria-label={`切换 ${row.config.name}`}
                          />
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
          {filteredModuleRows.length === 0 && (
            <div className="rounded-lg border border-dashed border-kumo-line p-8 text-center text-sm text-kumo-subtle">没有找到匹配的模块，请调整搜索或分组筛选。</div>
          )}
        </SectionCard>
        </div>
      )}

      {activeTab === 'security' && (
        <div className="grid h-full min-h-0 items-start gap-4 overflow-auto px-px py-px pr-px xl:grid-cols-2">
          <SectionCard
            title="管理员密码"
            description="后端接口为 /api/auth/change-password，修改成功后会退出当前会话。"
            icon={<Lock className="h-4 w-4 text-kumo-brand" />}
            bodyPadding="none"
          >
            <div className="grid max-w-xl gap-4 p-5">
              <Input size="sm"
                label="当前密码"
                type="text"
                value={passwordForm.oldPassword}
                onChange={(e) => setPasswordForm((prev) => ({ ...prev, oldPassword: e.target.value }))}
                disabled={isDemoMode}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
                spellCheck={false}
              />
              <Input size="sm"
                label="新密码"
                type="text"
                value={passwordForm.newPassword}
                onChange={(e) => setPasswordForm((prev) => ({ ...prev, newPassword: e.target.value }))}
                disabled={isDemoMode}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
                spellCheck={false}
              />
              <Input size="sm"
                label="确认新密码"
                type="text"
                value={passwordForm.confirmPassword}
                onChange={(e) => setPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                disabled={isDemoMode}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
                spellCheck={false}
              />
              <div>
                <Button size="sm" variant="primary" onClick={changePassword} loading={passwordSaving} disabled={isDemoMode}>
                  更新密码
                </Button>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="双因子认证"
            description="当前登录保护状态"
            icon={<Shield className="h-4 w-4 text-kumo-brand" />}
            meta={(
              <Badge variant={twoFA.enabled ? 'success' : 'warning'}>
                {twoFA.enabled ? '已启用' : '未启用'}
              </Badge>
            )}
            bodyPadding="lg"
          >

            {twoFA.error && (
              <div className="rounded-md border border-kumo-danger/20 bg-kumo-danger/10 px-3 py-2 text-xs text-kumo-danger">
                {twoFA.error}
              </div>
            )}

            {!twoFA.enabled && !twoFA.setupMode && (
              <Button size="sm" className={`${twoFA.error ? 'mt-5' : ''} w-full`} variant="primary" onClick={start2FASetup} loading={twoFA.loading} disabled={isDemoMode}>
                启用 2FA
              </Button>
            )}

            {twoFA.setupMode && (
              <div className="mt-5 grid gap-4">
                {twoFA.qrCode && (
                  <AppCard padding="none" className="flex justify-center p-4">
                    <img src={twoFA.qrCode} alt="2FA QR Code" className="h-44 w-44" />
                  </AppCard>
                )}
                <Input size="sm" label="手动密钥" value={twoFA.secret} readOnly className="font-mono" />
                <Input size="sm"
                  label="6 位验证码"
                  value={twoFA.token}
                  onChange={(e) => setTwoFA((prev) => ({ ...prev, token: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                  placeholder="000000"
                  className="font-mono"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setTwoFA((prev) => ({ ...prev, setupMode: false, token: '', error: '' }))}>取消</Button>
                  <Button size="sm" variant="primary" onClick={confirm2FASetup} loading={twoFA.loading}>确认启用</Button>
                </div>
              </div>
            )}

            {twoFA.enabled && !twoFA.disableMode && (
              <Button size="sm" className="mt-5 w-full" variant="secondary-destructive" onClick={() => setTwoFA((prev) => ({ ...prev, disableMode: true, error: '' }))} disabled={isDemoMode}>
                禁用 2FA
              </Button>
            )}

            {twoFA.disableMode && (
              <div className="mt-5 grid gap-4">
                <Input size="sm"
                  label="当前密码"
                  type="text"
                  value={twoFA.disablePassword}
                  onChange={(e) => setTwoFA((prev) => ({ ...prev, disablePassword: e.target.value }))}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                  spellCheck={false}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setTwoFA((prev) => ({ ...prev, disableMode: false, disablePassword: '', error: '' }))}>取消</Button>
                  <Button size="sm" variant="destructive" onClick={disable2FA} loading={twoFA.loading}>确认禁用</Button>
                </div>
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {activeTab === 'database' && (
        <div className="grid items-start gap-3 px-px py-px pr-px xl:grid-cols-[minmax(0,1.1fr)_minmax(24rem,0.9fr)]">
          <SectionCard
            className="flex h-full min-h-0 flex-1"
            title="数据库统计"
            description={dbStats?.dbPath || 'SQLite 数据文件'}
            icon={<Database className="h-4 w-4 text-kumo-brand" />}
            actions={
                <Button size="sm" onClick={() => fetchDbState().catch((error) => toast.error(error.message || '加载数据库统计失败'))} loading={databaseBusy} icon={<RefreshCw className="h-4 w-4" />}>刷新统计</Button>
            }
            bodyPadding="none"
            bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {databaseStorage && (
              <div className="shrink-0 border-b border-kumo-line px-3 py-3">
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <SummaryMetricCard
                    label="总占用"
                    value={formatFileSize(databaseStorage.totalSizeBytes)}
                    tone="brand"
                    compact
                  />
                  <SummaryMetricCard
                    label="主库文件"
                    value={formatFileSize(databaseStorage.mainSizeBytes)}
                    tone="default"
                    compact
                  />
                  <SummaryMetricCard
                    label="WAL / SHM"
                    value={formatFileSize((databaseStorage.walSizeBytes || 0) + (databaseStorage.shmSizeBytes || 0))}
                    tone="warning"
                    compact
                  />
                  <SummaryMetricCard
                    label="空闲页"
                    value={formatFileSize(databaseStorage.freePageBytes)}
                    tone="info"
                    compact
                  />
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto pr-px">
              <Table layout="fixed">
                <colgroup>
                  <col className="w-[28%]" />
                  <col className="w-[14%]" />
                  <col className="w-[19%]" />
                  <col className="w-[18%]" />
                  <col className="w-[21%]" />
                </colgroup>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>表名</Table.Head>
                    <Table.Head>记录数</Table.Head>
                    <Table.Head>占用</Table.Head>
                    <Table.Head>索引</Table.Head>
                    <Table.Head>行大小</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {tableRows.length === 0 ? (
                    <Table.Row>
                      <Table.Cell colSpan={5} className="p-8 text-center text-kumo-subtle">
                        {databaseBusy ? '正在加载统计...' : '暂无统计数据'}
                      </Table.Cell>
                    </Table.Row>
                  ) : tableRows.map((row) => (
                    <Table.Row key={row.table}>
                      <Table.Cell className="truncate font-mono text-xs text-kumo-strong" title={row.table}>{row.table}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{formatTableRows(row.rows)}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{formatTableMetricSize(row.estimatedSizeBytes)}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{formatTableMetricSize(row.indexSizeBytes)}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{formatTableMetricSize(row.avgRowSizeBytes)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          </SectionCard>

          <div className="grid content-start gap-3 px-px py-px">
            <SectionCard
              title="数据库导入导出"
              description="导出当前数据库，或预检后替换。"
              icon={<Download className="h-4 w-4 text-kumo-brand" />}
              bodyPadding="sm"
              bodyClassName="space-y-3"
            >
              <Input
                ref={fileInputRef}
                type="file"
                accept=".db"
                aria-label="选择数据库文件"
                className="hidden"
                onChange={previewDatabaseImport}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  shape="square"
                  onClick={exportDatabase}
                  aria-label="导出数据库"
                  title="导出数据库"
                  icon={<Upload className="h-4 w-4" />}
                />
                <Button
                  size="sm"
                  variant="primary"
                  shape="square"
                  onClick={importDatabase}
                  loading={databaseBusy}
                  aria-label="导入数据库"
                  title="导入数据库"
                  icon={<Download className="h-4 w-4" />}
                />
              </div>
              {dbImportPreview && (
                <AppCard padding="none" className="bg-kumo-recessed/40 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-kumo-strong truncate">{dbImportPreview.originalName}</span>
                    <Badge variant={dbImportPreview.analysis?.integrity === 'ok' ? 'success' : 'warning'}>
                      {dbImportPreview.analysis?.integrity || 'unknown'}
                    </Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-md border border-kumo-line/70 bg-kumo-base px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-kumo-subtle">大小</div>
                      <div className="mt-1 font-mono text-kumo-strong">{formatFileSize(dbImportPreview.analysis?.sizeBytes)}</div>
                    </div>
                    <div className="rounded-md border border-kumo-line/70 bg-kumo-base px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-kumo-subtle">表数量</div>
                      <div className="mt-1 font-mono text-kumo-strong">{dbImportPreview.analysis?.tableCount || 0}</div>
                    </div>
                  </div>
                  {dbImportPreview.warnings?.length > 0 && (
                    <div className="mt-2 space-y-1 rounded border border-kumo-warning/30 bg-kumo-warning/10 p-2 text-[11px] text-kumo-warning">
                      {dbImportPreview.warnings.map((warning) => (
                        <div key={warning}>{warning}</div>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 max-h-44 overflow-y-auto rounded border border-kumo-line bg-kumo-base">
                    <Table layout="fixed">
                      <Table.Header variant="compact">
                        <Table.Row>
                          <Table.Head>表名</Table.Head>
                          <Table.Head className="w-20">记录数</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {(dbImportPreview.analysis?.tables || []).slice(0, 20).map((row) => (
                          <Table.Row key={row.name}>
                            <Table.Cell className="truncate font-mono text-[11px]">{row.name}</Table.Cell>
                            <Table.Cell className="font-mono text-[11px]">{row.rows}</Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="primary" className="flex-1 justify-center" onClick={commitDatabaseImport} loading={databaseBusy}>
                      确认导入
                    </Button>
                    <Button size="sm" variant="secondary" className="flex-1 justify-center" onClick={() => setDbImportPreview(null)}>
                      取消
                    </Button>
                  </div>
                </AppCard>
              )}
            </SectionCard>

            <BackupPanel embedded />

            <SectionCard
              title="维护操作"
              icon={<HardDrive className="h-4 w-4 text-kumo-brand" />}
              bodyPadding="sm"
              bodyClassName="space-y-3"
            >
              <div className="grid gap-3 xl:grid-cols-3">
                <MaintenanceActionCard
                  title="压缩数据库"
                  icon={<Database className="h-4 w-4" />}
                  tone="brand"
                >
                  <Button
                    size="sm"
                    className="w-full justify-center"
                    onClick={() => postSettingsAction('/api/settings/vacuum-database', '数据库已压缩', fetchDbState)}
                    loading={databaseBusy}
                  >
                    立即压缩
                  </Button>
                </MaintenanceActionCard>

                <MaintenanceActionCard
                  title="清理运行日志"
                  icon={<FileText className="h-4 w-4" />}
                  tone="danger"
                >
                  <Button
                    size="sm"
                    variant="secondary-destructive"
                    className="w-full justify-center"
                    onClick={() => postSettingsAction('/api/settings/clear-logs', '数据库日志已清理', fetchDbState)}
                    loading={databaseBusy}
                    icon={<Trash className="h-4 w-4" />}
                  >
                    清理日志
                  </Button>
                </MaintenanceActionCard>

                <MaintenanceActionCard
                  title="清理废弃表"
                  icon={<Trash className="h-4 w-4" />}
                  tone="warning"
                  meta={<Badge variant={deprecatedTableItems.length > 0 ? 'warning' : 'secondary'}>{deprecatedTableItems.length} 张</Badge>}
                >
                  <Button
                    size="sm"
                    variant="secondary-destructive"
                    className="w-full justify-center"
                    onClick={cleanupDeprecatedTables}
                    loading={databaseBusy}
                    disabled={deprecatedTableItems.length === 0}
                    icon={<Trash className="h-4 w-4" />}
                  >
                    清理废弃表
                  </Button>
                </MaintenanceActionCard>
              </div>

              <div className="rounded-lg border border-kumo-line/80 bg-kumo-base px-3 pt-3 pb-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-kumo-strong">废弃表候选</div>
                    <div className="mt-1 text-xs text-kumo-subtle">这里会列出可清理的旧表及预计释放空间。</div>
                  </div>
                  <Badge variant={deprecatedTableItems.length > 0 ? 'warning' : 'secondary'}>
                    {deprecatedTableItems.length} 张
                  </Badge>
                </div>

                <div className="mt-2 rounded-md border border-kumo-line/70 bg-kumo-recessed/20 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span className="text-kumo-subtle">候选表 <span className="font-semibold text-kumo-strong">{deprecatedTableItems.length}</span></span>
                    <span className="text-kumo-subtle">记录数 <span className="font-semibold text-kumo-strong">{deprecatedTables?.totalRows || 0}</span></span>
                    <span className="text-kumo-subtle">占用 <span className="font-semibold text-kumo-strong">{formatFileSize(deprecatedTables?.totalSize)}</span></span>
                  </div>
                </div>

                {deprecatedTableItems.length > 0 && (
                  <div className="mt-3 max-h-40 overflow-y-auto divide-y divide-kumo-line rounded-md border border-kumo-line/70 bg-kumo-recessed/10 text-[11px]">
                    {deprecatedTableItems.slice(0, 8).map((item) => (
                      <div key={item.table} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate font-mono text-kumo-strong" title={item.table}>{item.table}</div>
                          <div className="mt-0.5 truncate text-kumo-subtle" title={item.reason}>{item.reason}</div>
                        </div>
                        <span className="font-mono text-kumo-subtle">{formatFileSize(item.sizeBytes)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </SectionCard>
          </div>
        </div>
      )}

      {activeTab === 'logs' && (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden px-px py-px pr-px">
          <SectionCard
            className="shrink-0"
            title="审计与保留"
            description="这里只管理数据库审计记录与日志保留策略；应用运行日志请到左侧「系统日志」查看。"
            icon={<FileText className="h-4 w-4 text-kumo-brand" />}
            actions={
                <>
                  <Button size="sm" onClick={saveLogSettings} loading={logsBusy} icon={<Save className="h-4 w-4" />}>保存保留策略</Button>
                  <Button size="sm" onClick={() => postSettingsAction('/api/settings/enforce-log-limits', '日志限制已执行', fetchLogState)} loading={logsBusy}>立即执行限制</Button>
                </>
            }
            bodyPadding="none"
          >
            <div className="grid gap-4 p-5 md:grid-cols-4">
              <Input size="sm" label="保留天数" type="number" min="0" value={logSettings.days} onChange={(e) => setLogSettings((prev) => ({ ...prev, days: Math.max(0, toInt(e.target.value, 0)) }))} />
              <Input size="sm" label="单表最大条数" type="number" min="0" value={logSettings.count} onChange={(e) => setLogSettings((prev) => ({ ...prev, count: Math.max(0, toInt(e.target.value, 0)) }))} />
              <Input size="sm" label="数据库最大 MB" type="number" min="0" value={logSettings.dbSizeMB} onChange={(e) => setLogSettings((prev) => ({ ...prev, dbSizeMB: Math.max(0, toInt(e.target.value, 0)) }))} />
              <Input size="sm" label="app.log 最大 MB" type="number" min="1" value={logSettings.logFileSizeMB} onChange={(e) => setLogSettings((prev) => ({ ...prev, logFileSizeMB: Math.max(1, toInt(e.target.value, 10)) }))} />
            </div>
          </SectionCard>

          <div className="flex min-h-0 flex-1">
            <SectionCard
              className="min-h-0 flex-1"
              title="审计记录"
              description="最近 100 条数据库操作记录"
              icon={<Database className="h-4 w-4 text-kumo-brand" />}
              bodyPadding="none"
              bodyClassName="min-h-0 flex-1 overflow-auto"
            >
              <Table layout="fixed">
                <colgroup>
                  <col className="w-[170px]" />
                  <col className="w-[150px]" />
                  <col className="w-[130px]" />
                  <col />
                </colgroup>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>时间</Table.Head>
                    <Table.Head>操作</Table.Head>
                    <Table.Head>对象</Table.Head>
                    <Table.Head>Trace</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {operationLogs.slice(0, 100).map((log) => (
                    <Table.Row key={log.id}>
                      <Table.Cell className="font-mono text-xs">{log.created_at}</Table.Cell>
                      <Table.Cell><Badge variant="outline">{log.operation_type}</Badge></Table.Cell>
                      <Table.Cell className="font-mono text-xs">{log.table_name}</Table.Cell>
                      <Table.Cell className="truncate font-mono text-xs text-kumo-subtle">{log.trace_id || '-'}</Table.Cell>
                    </Table.Row>
                  ))}
                  {operationLogs.length === 0 && (
                    <Table.Row>
                      <Table.Cell colSpan={4} className="p-8 text-center text-kumo-subtle">暂无审计记录</Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table>
            </SectionCard>
          </div>
        </div>
      )}

      {activeTab === 'appearance' && (
        <div className="grid h-full min-h-0 items-start gap-3 overflow-auto px-px py-px pr-px xl:grid-cols-[minmax(20rem,0.82fr)_minmax(0,1.18fr)]">
          <SectionCard
            title="界面外观"
            description={`当前生效主题: ${theme === 'dark' ? '深色' : '浅色'}`}
            icon={<Sun className="h-4 w-4 text-kumo-brand" />}
            bodyPadding="none"
          >
            <FieldRow title="主题模式" description="云端偏好，切换后立即生效并自动同步。">
              <Select size="sm" label="主题模式" value={themeMode} onValueChange={handleThemeModeChange} items={THEME_OPTIONS} />
            </FieldRow>
            <FieldRow title="页面宽度" description="云端偏好，顶部宽度切换器也会同步。">
              <Select size="sm" label="页面宽度" value={pageWidthMode} onValueChange={handlePageWidthModeChange} items={PAGE_WIDTH_OPTIONS} />
            </FieldRow>
            <FieldRow title="触感反馈" description="移动端交互振动开关。">
              <Switch checked={settings.vibrationEnabled} onCheckedChange={handleVibrationEnabledChange} />
            </FieldRow>
          </SectionCard>

          <SectionCard
            title="自定义 CSS"
            description="应用会立即注入当前页面，保存后写入后端用户设置。"
            icon={<Terminal className="h-4 w-4 text-kumo-brand" />}
            className="xl:min-h-[28rem]"
            actions={
                <>
                  <Button size="sm" onClick={() => applyCustomCss(settings.customCss)}>预览</Button>
                  <Button size="sm" variant="secondary-destructive" onClick={() => {
                    patchSettings({ customCss: '' });
                    applyCustomCss('');
                  }}>清空</Button>
                </>
            }
            bodyPadding="none"
          >
            <div className="p-4">
              <Textarea
                label="CSS"
                value={settings.customCss}
                onChange={(e) => patchSettings({ customCss: e.target.value })}
                placeholder="/* 在此输入自定义 CSS */"
                className="min-h-[22rem] font-mono text-sm"
              />
            </div>
          </SectionCard>
        </div>
      )}

      {activeTab === 'about' && (
        <div className="grid items-start gap-4 overflow-auto px-px py-px pr-px lg:grid-cols-1">
          <SectionCard
            title="API Monitor"
            description="React 前端 + Go 后端"
            icon={<img src="/logo.svg" alt="" className="h-6 w-6 object-contain" />}
            bodyPadding="lg"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-kumo-line bg-kumo-recessed p-3">
                <div className="text-xs text-kumo-subtle">当前源</div>
                <div className="mt-1 truncate font-mono text-sm text-kumo-strong">{currentOrigin}</div>
              </div>
              <div className="rounded-lg border border-kumo-line bg-kumo-recessed p-3">
                <div className="text-xs text-kumo-subtle">API 地址</div>
                <div className="mt-1 truncate font-mono text-sm text-kumo-strong">{`${currentOrigin}/api`}</div>
              </div>
              <div className="rounded-lg border border-kumo-line bg-kumo-recessed p-3">
                <div className="text-xs text-kumo-subtle">仓库地址</div>
                <div className="mt-1 truncate font-mono text-sm text-kumo-strong">
                  <a
                    href="https://github.com/iwvw/API-Monitor"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline text-kumo-strong"
                  >
                    https://github.com/iwvw/API-Monitor
                  </a>
                </div>
              </div>
            </div>
          </SectionCard>

          {/* <LayerCard className="p-6">
            <h2 className="text-base font-bold text-kumo-strong">已对接接口</h2>
            <div className="mt-4 grid gap-2 text-xs text-kumo-default">
              {[
                '/api/settings',
                '/api/settings/log-settings',
                '/api/settings/database-stats',
                '/api/settings/database-analysis',
                '/api/auth/change-password',
                '/api/auth/2fa/*',
              ].map((item) => (
                <div key={item} className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-kumo-success" />
                  <span className="font-mono">{item}</span>
                </div>
              ))}
            </div>
          </LayerCard> */}
        </div>
      )}
      </div>
    </div>
  );
}

export default SettingsPage;
