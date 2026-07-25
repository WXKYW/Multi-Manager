import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { Switch } from '@cloudflare/kumo/components/switch';
import { Table } from '@cloudflare/kumo/components/table';
import { ClipboardText, Tabs } from '@cloudflare/kumo';
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
import { APP_VERSION } from '../modules/appVersion.js';
import { AppCard, SectionCard, cx } from '../components/ui/AppPrimitives.jsx';
import CodeEditor from '../components/ui/CodeEditor.jsx';
import { BackupPanel } from './BackupPage.jsx';
import { browserSupportsWebAuthn, createPasskeyCredential } from '../modules/webauthn.js';
import {
  Activity,
  Bell,
  Check,
  Database,
  Download,
  ExternalLink,
  FileText,
  Globe,
  GitHubBrand,
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

const SECURITY_MASONRY_CARD_CLASS = 'mb-4 inline-block w-full align-top [break-inside:avoid] last:mb-0';

const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const GITHUB_NEW_OAUTH_APP_URL = 'https://github.com/settings/applications/new';

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
});

const getUploadHeaders = () => ({
});

const formatFileSize = (bytes) => {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(2)} KB`;
  return `${size} B`;
};

const formatSessionTime = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
};

const describeUserAgent = (value) => {
  const ua = String(value || '');
  const browser = ua.includes('Edg/') ? 'Edge' : ua.includes('Chrome/') ? 'Chrome' : ua.includes('Firefox/') ? 'Firefox' : ua.includes('Safari/') ? 'Safari' : '浏览器';
  const platform = ua.includes('Windows') ? 'Windows' : ua.includes('Mac OS') ? 'macOS' : ua.includes('Android') ? 'Android' : ua.includes('iPhone') || ua.includes('iPad') ? 'iOS' : ua.includes('Linux') ? 'Linux' : '未知系统';
  return `${browser} · ${platform}`;
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
    setDashboardFooterVisible,
    setDashboardFooterRecordNumber,
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
  const [loginSessions, setLoginSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [githubAuth, setGitHubAuth] = useState({
    enabled: false,
    clientId: '',
    clientSecret: '',
    hasClientSecret: false,
    allowedLoginsText: '',
    allowedEmailsText: '',
  });
  const [githubAuthLoading, setGitHubAuthLoading] = useState(false);
  const [githubAuthSaving, setGitHubAuthSaving] = useState(false);
  const [githubAuthLoaded, setGitHubAuthLoaded] = useState(false);
  const [passkeys, setPasskeys] = useState([]);
  const [passkeysLoading, setPasskeysLoading] = useState(false);
  const [passkeysLoaded, setPasskeysLoaded] = useState(false);
  const [passkeyForm, setPasskeyForm] = useState({
    label: '',
  });
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const currentOrigin = useMemo(() => {
    if (typeof window === 'undefined') return 'http://localhost';
    return window.location.origin;
  }, []);
  const githubOAuthCallback = useMemo(() => `${settings.publicApiUrl || currentOrigin}/api/auth/github/callback`, [currentOrigin, settings.publicApiUrl]);

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

  const handleDashboardFooterVisibleChange = useCallback((checked) => {
    setDashboardFooterVisible(checked);
    patchSettings({ dashboardFooterVisible: Boolean(checked) });
  }, [patchSettings, setDashboardFooterVisible]);

  const handleDashboardFooterRecordNumberChange = useCallback((event) => {
    const recordNumber = event.target.value;
    setDashboardFooterRecordNumber(recordNumber);
    patchSettings({ dashboardFooterRecordNumber: recordNumber });
  }, [patchSettings, setDashboardFooterRecordNumber]);

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

  const fetchLoginSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const response = await fetch('/api/auth/sessions', { headers: getAuthHeaders() });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(result.error || '加载登录设备失败');
      const payload = result.data || result;
      setLoginSessions(payload.sessions || []);
      setSessionsLoaded(true);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const fetchGitHubAuthConfig = useCallback(async () => {
    setGitHubAuthLoading(true);
    try {
      const response = await fetch('/api/auth/github/config', { headers: getAuthHeaders() });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(result.error || '加载 GitHub 登录配置失败');
      const payload = result.data || result;
      setGitHubAuth({
        enabled: !!payload.enabled,
        clientId: payload.clientId || '',
        clientSecret: '',
        hasClientSecret: !!payload.hasClientSecret,
        allowedLoginsText: payload.allowedLoginsText || '',
        allowedEmailsText: payload.allowedEmailsText || '',
      });
      setGitHubAuthLoaded(true);
    } finally {
      setGitHubAuthLoading(false);
    }
  }, []);

  const fetchPasskeys = useCallback(async () => {
    setPasskeysLoading(true);
    try {
      const response = await fetch('/api/auth/webauthn/credentials', { headers: getAuthHeaders() });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(result.error || '加载通行密钥失败');
      const payload = result.data || result;
      setPasskeys(payload.credentials || []);
      setPasskeysLoaded(true);
    } finally {
      setPasskeysLoading(false);
    }
  }, []);



  const refreshCurrent = useCallback(async (showFeedback = false) => {
    setSettingsLoading(true);
    try {
      await fetchSettings();
      if (activeTab === 'database') await fetchDbState();
      if (activeTab === 'logs') await fetchLogState();
      if (activeTab === 'security') await Promise.all([fetchTwoFAStatus(), fetchLoginSessions(), fetchGitHubAuthConfig(), fetchPasskeys()]);
      if (showFeedback) toast.success('设置已刷新');
    } catch (error) {
      toast.error(error.message || '加载设置失败');
    } finally {
      setSettingsLoading(false);
    }
  }, [activeTab, fetchDbState, fetchGitHubAuthConfig, fetchLogState, fetchLoginSessions, fetchPasskeys, fetchSettings, fetchTwoFAStatus]);

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

  useEffect(() => {
    if (activeTab === 'security' && !sessionsLoaded && !sessionsLoading) {
      fetchLoginSessions().catch((error) => toast.error(error.message || '加载登录设备失败'));
    }
  }, [activeTab, fetchLoginSessions, sessionsLoaded, sessionsLoading]);

  useEffect(() => {
    if (activeTab === 'security' && !githubAuthLoaded && !githubAuthLoading) {
      fetchGitHubAuthConfig().catch((error) => toast.error(error.message || '加载 GitHub 登录配置失败'));
    }
  }, [activeTab, fetchGitHubAuthConfig, githubAuthLoaded, githubAuthLoading]);

  useEffect(() => {
    if (activeTab === 'security' && !passkeysLoaded && !passkeysLoading) {
      fetchPasskeys().catch((error) => toast.error(error.message || '加载通行密钥失败'));
    }
  }, [activeTab, fetchPasskeys, passkeysLoaded, passkeysLoading]);

  const forceSessionOffline = async (session) => {
    try {
      const response = await fetch(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE', headers: getAuthHeaders() });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(result.error || '强制下线失败');
      toast.success(session.current ? '当前设备已下线' : '设备已强制下线');
      if (session.current) {
        await logout();
        return;
      }
      await fetchLoginSessions();
    } catch (error) {
      toast.error(error.message || '强制下线失败');
    }
  };

  const forceAllSessionsOffline = async () => {
    const confirmed = await dialog.confirm({
      title: '确认强制全部设备下线',
      message: '这会立即终止全部主程序会话，并使浏览器插件停止取码。确定要继续吗？',
      confirmText: '确认全部下线',
      confirmClass: '!bg-kumo-danger !text-white',
    });
    if (!confirmed) return;
    try {
      const response = await fetch('/api/auth/sessions/revoke-all', { method: 'POST', headers: getAuthHeaders() });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(result.error || '全部下线失败');
      toast.success('全部设备已下线');
      await logout();
    } catch (error) {
      toast.error(error.message || '全部下线失败');
    }
  };

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

  const saveGitHubLoginConfig = async () => {
    setGitHubAuthSaving(true);
    try {
      const response = await fetch('/api/auth/github/config', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(githubAuth),
      });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(result.error || '保存 GitHub 登录配置失败');
      const payload = result.data || result;
      setGitHubAuth({
        enabled: !!payload.enabled,
        clientId: payload.clientId || '',
        clientSecret: '',
        hasClientSecret: !!payload.hasClientSecret,
        allowedLoginsText: payload.allowedLoginsText || '',
        allowedEmailsText: payload.allowedEmailsText || '',
      });
      toast.success('GitHub 登录配置已保存');
    } catch (error) {
      toast.error(error.message || '保存 GitHub 登录配置失败');
    } finally {
      setGitHubAuthSaving(false);
    }
  };

  const registerPasskey = async () => {
    if (!browserSupportsWebAuthn()) {
      toast.error('当前浏览器不支持通行密钥');
      return;
    }

    setPasskeyBusy(true);
    try {
      const beginResponse = await fetch('/api/auth/webauthn/register/begin', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(passkeyForm),
      });
      const beginResult = await beginResponse.json();
      if (!beginResponse.ok || beginResult.success === false) throw new Error(beginResult.error || '创建通行密钥挑战失败');

      const credential = await createPasskeyCredential(beginResult.options);
      const finishResponse = await fetch('/api/auth/webauthn/register/finish', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          flowId: beginResult.flowId,
          credential,
        }),
      });
      const finishResult = await finishResponse.json();
      if (!finishResponse.ok || finishResult.success === false) throw new Error(finishResult.error || '保存通行密钥失败');

      toast.success('通行密钥已添加');
      setPasskeyForm({ label: '' });
      await fetchPasskeys();
    } catch (error) {
      const message = error?.name === 'NotAllowedError'
        ? '通行密钥操作已取消或被浏览器拦截'
        : (error.message || '保存通行密钥失败');
      toast.error(message);
    } finally {
      setPasskeyBusy(false);
    }
  };

  const removePasskey = async (passkey) => {
    if (!(await dialog.confirm(`确定删除“${passkey.label || '通行密钥'}”吗？`))) return;

    setPasskeyBusy(true);
    try {
      const response = await fetch(`/api/auth/webauthn/credentials/${encodeURIComponent(passkey.id)}/delete`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const result = await response.json();
      if (!response.ok || result.success === false) throw new Error(result.error || '删除通行密钥失败');
      toast.success('通行密钥已删除');
      await fetchPasskeys();
    } catch (error) {
      toast.error(error.message || '删除通行密钥失败');
    } finally {
      setPasskeyBusy(false);
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
  const contentViewportClassName = 'min-w-0';

  return (
    <div className="flex min-h-full w-full min-w-0 flex-col gap-3 sm:gap-4">
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
        <div className="grid min-h-0 items-start gap-4 px-px pt-px pr-px md:h-full md:overflow-auto xl:grid-cols-[minmax(16rem,1fr)_minmax(0,3fr)]">
          <div className="grid min-h-0 gap-4">
            <StatCard label="运行状态" value="正常" hint={settingsLoading ? '同步中' : '已连接后端'} icon={Check} />
            <StatCard label="公网入口" value={settings.publicApiUrl || currentOrigin} hint="/api 自动拼接" icon={Globe} />
            <StatCard label="数据库大小" value={formatFileSize(databaseSizeBytes)} hint={databaseSizeHint} icon={Database} />
            <StatCard label="日志文件" value={logFileInfo?.sizeFormatted || `${logSettings.logFileSizeMB || 10} MB 上限`} hint="app.log" icon={FileText} />
          </div>

          <SectionCard
            title="部署访问地址"
            description="公开页与回调地址"
            icon={<Globe className="h-4 w-4 text-kumo-brand" />}
            className="min-h-0 self-start"
            bodyPadding="none"
          >
            <FieldRow title="公网 API 地址" description="公网可访问时填写，留空用当前来源。">
              <Input size="sm"
                label="公网 API 地址"
                value={settings.publicApiUrl}
                onChange={(e) => patchSettings({ publicApiUrl: e.target.value })}
                placeholder="https://monitor.example.com"
              />
            </FieldRow>
            <FieldRow title="系统时区" description="本地化时间；跟随服务器用默认时区。">
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
        <div className="min-h-0 overflow-auto px-px pt-px md:h-full">
        <SectionCard
          className="flex min-h-0 md:h-full"
          headerClassName="max-sm:min-h-12 max-sm:flex-row max-sm:items-center max-sm:px-3 max-sm:py-2"
          title="功能模块"
          description="管理侧栏入口"
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
              placeholder="搜索模块"
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
            <div className="rounded-lg border border-dashed border-kumo-line p-8 text-center text-sm text-kumo-subtle">没有匹配模块，请调整搜索。</div>
          )}
        </SectionCard>
        </div>
      )}

      {activeTab === 'security' && (
        <div className="min-w-0 overflow-auto px-px pt-px [column-gap:1rem] xl:columns-2">
          <SectionCard
            className={SECURITY_MASONRY_CARD_CLASS}
            title="管理员密码"
            icon={<Lock className="h-4 w-4 text-kumo-brand" />}
            bodyPadding="none"
          >
            <div className="flex w-full flex-col gap-4 p-5">
              <div>
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
                  className="w-full"
                />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                  className="w-full"
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
                  className="w-full"
                />
              </div>
              <div>
                <Button size="sm" variant="primary" onClick={changePassword} loading={passwordSaving} disabled={isDemoMode}>
                  更新密码
                </Button>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            className={SECURITY_MASONRY_CARD_CLASS}
            title="双因子认证与通行密钥"
            icon={<Shield className="h-4 w-4 text-kumo-brand" />}
            meta={(
              <div className="flex items-center gap-2">
                <Badge variant={twoFA.enabled ? 'success' : 'warning'}>
                  {twoFA.enabled ? 'TOTP 已启用' : 'TOTP 未启用'}
                </Badge>
                <Badge variant={passkeys.length > 0 ? 'success' : 'secondary'}>
                  {passkeys.length > 0 ? `${passkeys.length} 个通行密钥` : '无通行密钥'}
                </Badge>
              </div>
            )}
            bodyPadding="lg"
          >
            <div className="grid items-start gap-4 xl:grid-cols-2">
              <AppCard padding="md" className="flex h-auto flex-col gap-4 self-start border border-kumo-line/80">
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-kumo-strong">验证器</div>
                  <div className="text-xs leading-relaxed text-kumo-subtle">为密码和 GitHub 登录增加 6 位验证码；通行密钥不依赖 TOTP。</div>
                </div>

                {twoFA.error && (
                  <div className="rounded-md border border-kumo-danger/20 bg-kumo-danger/10 px-3 py-2 text-xs text-kumo-danger">
                    {twoFA.error}
                  </div>
                )}

                {!twoFA.enabled && !twoFA.setupMode && (
                  <Button size="sm" variant="primary" onClick={start2FASetup} loading={twoFA.loading} disabled={isDemoMode}>
                    启用 2FA
                  </Button>
                )}

                {twoFA.setupMode && (
                  <div className="grid gap-4">
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
                  <Button size="sm" variant="secondary-destructive" onClick={() => setTwoFA((prev) => ({ ...prev, disableMode: true, error: '' }))} disabled={isDemoMode}>
                    禁用 2FA
                  </Button>
                )}

                {twoFA.disableMode && (
                  <div className="grid gap-4">
                    <Input size="sm"
                      label="当前密码"
                      type="password"
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
              </AppCard>

              <AppCard padding="md" className="flex h-auto flex-col gap-4 self-start border border-kumo-line/80">
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-kumo-strong">通行密钥</div>
                  <div className="text-xs leading-relaxed text-kumo-subtle">支持 Windows Hello、Touch ID、安全密钥等。</div>
                </div>

                <div className="grid gap-3">
                  <Input
                    size="sm"
                    label="通行密钥名称"
                    value={passkeyForm.label}
                    onChange={(event) => setPasskeyForm((prev) => ({ ...prev, label: event.target.value }))}
                    placeholder="如：Windows Hello"
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={registerPasskey}
                    loading={passkeyBusy}
                    disabled={isDemoMode || !browserSupportsWebAuthn()}
                  >
                    添加通行密钥
                  </Button>
                  {!browserSupportsWebAuthn() && (
                    <span className="text-xs text-kumo-warning">当前环境不支持 WebAuthn</span>
                  )}
                </div>

                <div className="divide-y divide-kumo-line rounded-md border border-kumo-line/80">
                  {passkeysLoading && (
                    <div className="px-4 py-6 text-sm text-kumo-subtle">加载中...</div>
                  )}
                  {!passkeysLoading && passkeys.map((passkey) => (
                    <div key={passkey.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-kumo-strong">{passkey.label || '通行密钥'}</span>
                          {passkey.attachment && <Badge variant="secondary">{passkey.attachment}</Badge>}
                          {passkey.backedUp ? <Badge variant="success">可同步</Badge> : null}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-kumo-subtle">
                          <span>添加时间: <span className="text-kumo-strong">{formatSessionTime(passkey.createdAt)}</span></span>
                          <span>最近使用: <span className="text-kumo-strong">{formatSessionTime(passkey.lastUsedAt)}</span></span>
                        </div>
                        <div className="mt-1 truncate font-mono text-[10px] text-kumo-subtle">{passkey.id}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary-destructive"
                        onClick={() => removePasskey(passkey)}
                        loading={passkeyBusy}
                        disabled={isDemoMode}
                      >
                        删除
                      </Button>
                    </div>
                  ))}
                  {!passkeysLoading && passkeys.length === 0 && (
                    <div className="px-4 py-8 text-center text-sm text-kumo-subtle">暂无通行密钥</div>
                  )}
                </div>
              </AppCard>
            </div>
          </SectionCard>

          <SectionCard
            className={SECURITY_MASONRY_CARD_CLASS}
            title="GitHub 一键登录"
            icon={<GitHubBrand className="h-4 w-4 text-kumo-brand" />}
            meta={(
              <Badge variant={githubAuth.enabled ? 'success' : 'secondary'}>
                {githubAuth.enabled ? '已启用' : '未启用'}
              </Badge>
            )}
            bodyPadding="lg"
          >
            <div className="grid gap-4">
              <div className="grid gap-4 border-b border-kumo-line/70 pb-4 xl:grid-cols-2 xl:gap-0">
                  <div className="grid gap-2 xl:pr-5">
                    <div className="inline-flex items-center gap-2 text-sm font-semibold text-kumo-strong">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-kumo-brand/10 text-xs font-bold text-kumo-brand">1</span>
                      <span>创建 OAuth App</span>
                    </div>
                    <div className="text-xs leading-relaxed text-kumo-subtle">
                      <code className="app-inline-code">Homepage URL</code> 填当前站点地址即可。
                    </div>
                    <ClipboardText
                      size="sm"
                      text={settings.publicApiUrl || currentOrigin}
                      className="min-w-0 w-full font-mono text-[11px]"
                      tooltip={{ text: '复制主页地址', copiedText: '主页地址已复制' }}
                      labels={{ copyAction: '复制主页地址' }}
                    />
                    <div className="flex flex-wrap gap-2 pt-1">
                      <a href={GITHUB_NEW_OAUTH_APP_URL} target="_blank" rel="noreferrer">
                        <Button size="sm" variant="secondary" icon={<ExternalLink className="h-4 w-4" />}>
                          新建 OAuth App
                        </Button>
                      </a>
                    </div>
                  </div>

                  <div className="grid gap-2 border-t border-kumo-line/70 pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
                    <div className="inline-flex items-center gap-2 text-sm font-semibold text-kumo-strong">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-kumo-brand/10 text-xs font-bold text-kumo-brand">2</span>
                      <span>填回调并保存到下方</span>
                    </div>
                    <div className="text-xs leading-relaxed text-kumo-subtle">
                      <code className="app-inline-code">Authorization callback URL</code> 用下方地址；创建后把 <code className="app-inline-code">Client ID / Secret</code> 填到下面。
                    </div>
                    <ClipboardText
                      size="sm"
                      text={githubOAuthCallback}
                      className="min-w-0 w-full font-mono text-[11px]"
                      tooltip={{ text: '复制回调地址', copiedText: 'GitHub 回调地址已复制' }}
                      labels={{ copyAction: '复制回调地址' }}
                    />
                  </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  size="sm"
                  label="Client ID"
                  value={githubAuth.clientId}
                  onChange={(event) => setGitHubAuth((prev) => ({ ...prev, clientId: event.target.value }))}
                  placeholder="GitHub OAuth App Client ID"
                />
                <Input
                  size="sm"
                  label={githubAuth.hasClientSecret ? 'Client Secret（留空表示保持不变）' : 'Client Secret'}
                  type="password"
                  value={githubAuth.clientSecret}
                  onChange={(event) => setGitHubAuth((prev) => ({ ...prev, clientSecret: event.target.value }))}
                  placeholder={githubAuth.hasClientSecret ? '如需替换再填写' : 'GitHub OAuth App Client Secret'}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                  spellCheck={false}
                />
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                <label className="grid gap-1.5 text-xs text-kumo-subtle">
                  <span className="font-semibold text-kumo-strong">允许登录的 GitHub 用户名</span>
                  <textarea
                    value={githubAuth.allowedLoginsText}
                    onChange={(event) => setGitHubAuth((prev) => ({ ...prev, allowedLoginsText: event.target.value }))}
                    placeholder={'一行一个或逗号分隔\n如：iwvw'}
                    className="min-h-24 rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-strong outline-none transition-colors focus:border-kumo-brand"
                  />
                </label>
                <label className="grid gap-1.5 text-xs text-kumo-subtle">
                  <span className="font-semibold text-kumo-strong">允许登录的邮箱</span>
                  <textarea
                    value={githubAuth.allowedEmailsText}
                    onChange={(event) => setGitHubAuth((prev) => ({ ...prev, allowedEmailsText: event.target.value }))}
                    placeholder={'可选；支持私人邮箱校验\n如：admin@example.com'}
                    className="min-h-24 rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-strong outline-none transition-colors focus:border-kumo-brand"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Switch
                  checked={githubAuth.enabled}
                  onCheckedChange={(checked) => setGitHubAuth((prev) => ({ ...prev, enabled: checked }))}
                  aria-label="启用 GitHub 登录"
                />
                <span className="text-sm text-kumo-strong">启用 GitHub 登录入口</span>
                <span className="text-xs text-kumo-subtle">保存后显示 GitHub 按钮。</span>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={saveGitHubLoginConfig}
                  loading={githubAuthSaving || githubAuthLoading}
                  disabled={isDemoMode}
                >
                  保存 GitHub 配置
                </Button>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            className={SECURITY_MASONRY_CARD_CLASS}
            title="登录设备"
            icon={<Globe className="h-4 w-4 text-kumo-brand" />}
            actions={(
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  shape="square"
                  variant="secondary"
                  onClick={() => fetchLoginSessions().catch((error) => toast.error(error.message || '加载登录设备失败'))}
                  loading={sessionsLoading}
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  aria-label="刷新登录设备"
                  title="刷新登录设备"
                />
                <Button size="sm" variant="secondary-destructive" onClick={forceAllSessionsOffline}>
                  全部下线
                </Button>
              </div>
            )}
            bodyPadding="none"
          >
            <div className="divide-y divide-kumo-line">
              {loginSessions.map((session) => (
                <div key={session.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-kumo-strong">{describeUserAgent(session.userAgent)}</span>
                      {session.current && <Badge variant="success">当前设备</Badge>}
                      <span className="font-mono text-[10px] text-kumo-subtle">{session.id}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-kumo-subtle">
                      <span>IP: <span className="font-mono text-kumo-strong">{session.ipAddress || '-'}</span></span>
                      <span>最后活动: <span className="text-kumo-strong">{formatSessionTime(session.lastAccessedAt)}</span></span>
                      <span>会话到期: <span className="text-kumo-strong">{formatSessionTime(session.expiresAt)}</span></span>
                    </div>
                    {session.userAgent && <div className="mt-1 truncate text-[10px] text-kumo-subtle" title={session.userAgent}>{session.userAgent}</div>}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary-destructive"
                    onClick={() => forceSessionOffline(session)}
                  >
                    强制下线
                  </Button>
                </div>
              ))}
              {!sessionsLoading && loginSessions.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-kumo-subtle">暂无有效登录设备</div>
              )}
            </div>
          </SectionCard>
        </div>
      )}

      {activeTab === 'database' && (
        <div className="grid items-start gap-3 px-px pt-px pr-px xl:grid-cols-[minmax(0,1.1fr)_minmax(24rem,0.9fr)]">
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

          <div className="grid content-start gap-3 px-px pt-px">
            <SectionCard
              title="数据库导入导出"
              description="导出数据库，或预检后替换。"
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
                  variant="secondary"
                  onClick={exportDatabase}
                  aria-label="导出数据库"
                  title="导出数据库"
                  icon={<Upload className="h-3.5 w-3.5" />}
                >
                  导出数据库
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={importDatabase}
                  loading={databaseBusy}
                  aria-label="导入数据库"
                  title="导入数据库"
                  icon={<Download className="h-3.5 w-3.5" />}
                >
                  导入数据库
                </Button>
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
                    <div className="mt-1 text-xs text-kumo-subtle">显示可清理旧表与预计空间。</div>
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
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden px-px pt-px pr-px">
          <SectionCard
            className="shrink-0"
            title="审计与保留"
            description="数据库审计与日志保留"
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
              description="最近 100 条记录"
              icon={<Database className="h-4 w-4 text-kumo-brand" />}
              bodyPadding="none"
              bodyClassName="min-h-0 flex-1 overflow-auto"
            >
              <Table layout="fixed">
                <colgroup>
                  <col className="w-[170px]" />
                  <col className="w-[220px]" />
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
        <div className="grid min-h-0 items-start gap-3 overflow-auto px-px pt-px pr-px xl:grid-cols-[minmax(20rem,0.82fr)_minmax(0,1.18fr)]">
          <SectionCard
            title="界面外观"
            description={`当前生效主题: ${theme === 'dark' ? '深色' : '浅色'}`}
            icon={<Sun className="h-4 w-4 text-kumo-brand" />}
            bodyPadding="none"
          >
            <FieldRow title="主题模式" description="切换后立即生效">
              <Select size="sm" label="主题模式" value={themeMode} onValueChange={handleThemeModeChange} items={THEME_OPTIONS} />
            </FieldRow>
            <FieldRow title="页面宽度" description="与顶部宽度切换同步">
              <Select size="sm" label="页面宽度" value={pageWidthMode} onValueChange={handlePageWidthModeChange} items={PAGE_WIDTH_OPTIONS} />
            </FieldRow>
            <FieldRow title="显示首页页脚" description="控制仪表盘底部页脚">
              <Switch aria-label="显示首页页脚" checked={settings.dashboardFooterVisible} onCheckedChange={handleDashboardFooterVisibleChange} />
            </FieldRow>
            <FieldRow title="备案号" description="显示在首页页脚右侧；留空不显示。">
              <Input
                size="sm"
                aria-label="首页页脚备案号"
                value={settings.dashboardFooterRecordNumber}
                onChange={handleDashboardFooterRecordNumberChange}
                placeholder="例如：京ICP备12345678号"
                className="w-full min-w-52"
              />
            </FieldRow>
            <FieldRow title="触感反馈" description="移动端振动反馈。">
              <Switch checked={settings.vibrationEnabled} onCheckedChange={handleVibrationEnabledChange} />
            </FieldRow>
          </SectionCard>

          <SectionCard
            title="自定义 CSS"
            description="保存后写入用户设置"
            icon={<Terminal className="h-4 w-4 text-kumo-brand" />}
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
            <CodeEditor
              variant="embedded"
              label="CSS"
              language="css"
              value={settings.customCss}
              onChange={(customCss) => patchSettings({ customCss })}
              placeholder="/* 在此输入自定义 CSS */"
              minHeight="18rem"
              showHeader={false}
              showLanguage={false}
            />
          </SectionCard>
        </div>
      )}

      {activeTab === 'about' && (
        <div className="grid items-start gap-4 overflow-auto px-px pt-px pr-px lg:grid-cols-1">
          <SectionCard
            title={<span className="app-brand-wordmark">API Monitor</span>}
            description={APP_VERSION}
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
