import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import jsQR from 'jsqr';
import { toast } from '../modules/toast.js';
import { dialog } from '../modules/dialog.js';
import { Button, LinkButton } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input, Textarea } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { Switch } from '@cloudflare/kumo/components/switch';
import { Table } from '@cloudflare/kumo/components/table';
import { SkeletonLine } from '@cloudflare/kumo/components/loader';
import { LayerCard, Tabs } from '@cloudflare/kumo';
import useStore, { DEFAULT_TOTP_SETTINGS } from '../store.js';
import { MODULE_TABS_PROPS, TOOL_TABS_PROPS } from '../modules/kumoTabs.js';
import { handleEditableRowDoubleClick } from '../modules/tableInteractions.js';
import { buildTotpAccountPayload } from '../modules/totpPayload.js';
import { AnimatedCollapse } from '../components/AnimatedCollapse.jsx';
import BrandIcon, { BRAND_COLOR_FALLBACK, getIssuerColor } from '../components/ui/BrandIcon.jsx';
import { AppCard, SectionCard } from '../components/ui/AppPrimitives.jsx';
import {
  Key,
  FolderOpen,
  Settings,
  Plus,
  Trash,
  RotateCw,
  Search,
  Upload,
  Download,
  Edit,
  X,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  History,
  Shield,
  Bot
} from '../components/Icons.jsx';

const maskEmail = (email) => {
  if (!email) return '';
  if (!email.includes('@')) return email;
  const [local, domain] = email.split('@');
  if (local.length <= 3) return local[0] + '***@' + domain;
  return local.slice(0, 2) + '***' + local.slice(-1) + '@' + domain;
};

const GROUP_FILTER_ALL = '__all__';

const isSVGRepoIcon = (icon) => typeof icon === 'string' && icon.startsWith('svgrepo:');
const isCustomUploadedIcon = (icon) => typeof icon === 'string' && icon.startsWith('custom:');
const SVG_REPO_ICON_REF_PATTERN = /(?:svgrepo:)?(?:https?:\/\/(?:www\.)?svgrepo\.com\/(?:show|download|svg)\/)?([0-9]{3,9})[-/:]([a-z0-9][a-z0-9-]{0,80})(?:\.svg)?/i;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const normalizeHexColor = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const withHash = text.startsWith('#') ? text : `#${text}`;
  return HEX_COLOR_PATTERN.test(withHash) ? withHash.toLowerCase() : text;
};

const resolveFormColor = (form) => {
  const color = normalizeHexColor(form.color);
  return HEX_COLOR_PATTERN.test(color) ? color : getIssuerColor(form.issuer);
};

const normalizeSVGRepoIconRef = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(SVG_REPO_ICON_REF_PATTERN);
  if (!match) return text;
  return `svgrepo:${match[1]}-${match[2].replace(/^-+|-+$/g, '').toLowerCase()}`;
};

const normalizeRemoteBrandIconURL = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
  } catch (_) {
    return '';
  }
};

const TotpBrandMark = ({ issuer, icon, color, size = 'card' }) => {
  const isHeader = size === 'header';
  const markColor = color || getIssuerColor(issuer);
  const remoteIcon = isSVGRepoIcon(icon) || isCustomUploadedIcon(icon);
  return (
    <span
      className={`app-totp-brand-mark ${remoteIcon ? 'app-totp-brand-mark--remote' : 'border border-kumo-line'} ${isHeader ? 'size-7 rounded-md text-[17px]' : 'size-7 rounded-md text-[18px]'} flex shrink-0 items-center justify-center`}
      style={{ background: remoteIcon ? 'transparent' : markColor, color: '#fff' }}
    >
      <BrandIcon issuer={issuer} icon={icon} color="inherit" />
    </span>
  );
};

const buildBrandStyleOptions = ({ issuer, icon, color, name, options: detectedOptions = [] } = {}) => {
  const displayName = name || issuer || '品牌';
  const baseColor = color || getIssuerColor(issuer);
  const firstLetter = String(displayName || issuer || '?').trim().slice(0, 1).toUpperCase() || '?';
  const options = [];
  const repoOptions = Array.isArray(detectedOptions) && detectedOptions.length > 0
    ? detectedOptions
    : (icon ? [{ icon, color, name }] : []);
  repoOptions.forEach((item, index) => {
    options.push({
      id: `svgrepo-${index}-${item.icon || icon}`,
      label: `SVG Repo ${repoOptions.length > 1 ? index + 1 : ''}`.trim(),
      caption: item.name || displayName,
      icon: item.icon || icon,
      color: item.color || baseColor,
    });
  });
  options.push(
    {
      id: 'badge',
      label: '品牌徽标',
      caption: '系统图标',
      icon: '',
      color: baseColor,
    },
    {
      id: 'letter',
      label: '首字母',
      caption: firstLetter,
      icon: `letter:${firstLetter}`,
      color: baseColor,
    },
  );
  return options;
};

const buildCustomBrandStyleOptions = ({ issuer, entries = [], fallbackColor = '' } = {}) => {
  const issuerKey = String(issuer || '').trim().toLowerCase();
  const sorted = [...entries].sort((a, b) => {
    const aMatched = issuerKey && String(a.issuer || '').trim().toLowerCase() === issuerKey;
    const bMatched = issuerKey && String(b.issuer || '').trim().toLowerCase() === issuerKey;
    if (aMatched !== bMatched) return aMatched ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });
  return sorted.map((entry) => ({
    id: `custom-${entry.id}`,
    label: entry.name || entry.issuer || '自定义图标',
    caption: entry.issuer ? `图标库 / ${entry.issuer}` : '图标库',
    icon: entry.icon || (entry.id ? `custom:${entry.id}` : ''),
    color: entry.color || fallbackColor,
    source: 'custom',
  }));
};

const mergeBrandStyleOptions = (...groups) => {
  const seen = new Set();
  const merged = [];
  groups.flat().forEach((option) => {
    if (!option) return;
    const key = option.icon || option.id;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(option);
  });
  return merged;
};

// ==================== TotpPage 组件 ====================
function TotpPage() {
  const triggerHaptic = useStore((state) => state.triggerHaptic);
  const [totpCurrentTab, setTotpCurrentTab] = useState('accounts');
  const [totpAccounts, setTotpAccounts] = useState([]);
  const [totpGroups, setTotpGroups] = useState([]);
  const [totpCodes, setTotpCodes] = useState({});
  const [totpLoading, setTotpLoading] = useState(false);
  const [totpSearchQuery, setTotpSearchQuery] = useState('');
  const [totpFilterGroup, setTotpFilterGroup] = useState('');
  const [showExtensionGuide, setShowExtensionGuide] = useState(false);

  // 用户设置状态
  const [totpSettings, setTotpSettings] = useState({
    ...DEFAULT_TOTP_SETTINGS,
  });

  // Modal 状态
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountModalMode, setAccountModalMode] = useState('add');
  const [editingAccountId, setEditingAccountId] = useState(null);
  const [accountForm, setAccountForm] = useState({
    otp_type: 'totp',
    issuer: '',
    account: '',
    secret: '',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    counter: 0,
    group_id: '',
    icon: '',
    color: '',
  });
  const [accountModalError, setAccountModalError] = useState('');
  const [totpShowSecret, setTotpShowSecret] = useState(false);
  const [importUris, setImportUris] = useState('');
  const [accountModalSaving, setAccountModalSaving] = useState(false);
  const [brandDetecting, setBrandDetecting] = useState(false);
  const [brandStyleOptions, setBrandStyleOptions] = useState([]);
  const [showBrandStyleModal, setShowBrandStyleModal] = useState(false);
  const [customBrandIcons, setCustomBrandIcons] = useState([]);
  const [customBrandIconsLoading, setCustomBrandIconsLoading] = useState(false);
  const [customBrandIconUploading, setCustomBrandIconUploading] = useState(false);
  const [accountAddTab, setAccountAddTab] = useState('scan');

  // QR 扫码状态
  const [isScanning, setIsScanning] = useState(false);
  const [qrParsing, setQrParsing] = useState(false);
  const [qrError, setQrError] = useState('');
  const scannerRef = useRef(null);
  const fileInputRef = useRef(null);
  const brandUploadInputRef = useRef(null);

  // Group Modal 状态
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupModalMode, setGroupModalMode] = useState('add');
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [groupForm, setGroupForm] = useState({ name: '', color: BRAND_COLOR_FALLBACK });

  // Export Modal 状态
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportUris, setExportUris] = useState('');
  const [exportMeta, setExportMeta] = useState(null);

  // Local card reveal state
  const [revealedCodes, setRevealedCodes] = useState({});

  // 获取请求 Headers
  const getAuthHeaders = () => {
    const password = localStorage.getItem('admin_password') || '';
    return {
      'Content-Type': 'application/json',
      'x-admin-password': password,
    };
  };

  const getAuthOnlyHeaders = () => {
    const password = localStorage.getItem('admin_password') || '';
    return {
      'x-admin-password': password,
    };
  };

  const cacheDetectedBrandIcon = async (item) => {
    const sourceUrl = item?.sourceUrl;
    const icon = item?.icon;
    if (!sourceUrl || !isSVGRepoIcon(icon)) return;
    try {
      const remoteRes = await fetch(sourceUrl, { mode: 'cors', credentials: 'omit' });
      if (!remoteRes.ok) return;
      const svg = await remoteRes.text();
      if (!svg || !svg.toLowerCase().includes('<svg')) return;
      await fetch('/api/totp/icons/cache', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ icon, svg }),
      });
    } catch (_) {
      // Browser-side caching is best-effort because many icon hosts block CORS.
    }
  };

  // ==================== 数据接口交互 ====================
  const loadData = async () => {
    setTotpLoading(true);
    try {
      const headers = getAuthHeaders();
      const [accountsRes, groupsRes, settingsRes] = await Promise.all([
        fetch('/api/totp/accounts', { headers }),
        fetch('/api/totp/groups', { headers }),
        fetch('/api/settings', { headers }),
      ]);

      const accountsData = await accountsRes.json();
      const groupsData = await groupsRes.json();
      const settingsData = await settingsRes.json();

      if (accountsData.success) {
        setTotpAccounts(accountsData.data);
      }
      if (groupsData.success) {
        setTotpGroups(groupsData.data);
      }
      if (settingsData.success && settingsData.data?.totpSettings) {
        setTotpSettings((prev) => ({ ...prev, ...settingsData.data.totpSettings }));
      }
      
      // 首次加载验证码
      await refreshCodes();
    } catch (e) {
      console.error(e);
      toast.error('加载 2FA 数据失败');
    } finally {
      setTotpLoading(false);
    }
  };

  const isRefreshingRef = useRef(false);

  const refreshCodes = async () => {
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    try {
      const res = await fetch('/api/totp/codes', { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.success) {
        setTotpCodes(data.data);
      }
    } catch (e) {
      console.error('刷新验证码失败:', e);
    } finally {
      isRefreshingRef.current = false;
    }
  };

  // 持久化保存设置
  const saveSettingsToServer = async (newSettings) => {
    try {
      const headers = getAuthHeaders();
      await fetch('/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ totpSettings: newSettings }),
      });
    } catch (e) {
      console.error('保存设置失败:', e);
      toast.error('保存设置失败');
    }
  };

  const updateSetting = (key, value) => {
    const newSettings = { ...totpSettings, [key]: value };
    setTotpSettings(newSettings);
    saveSettingsToServer(newSettings);
  };

  // ==================== 倒计时逻辑 ====================
  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setTotpCodes((prevCodes) => {
        const updated = {};
        let needRefresh = false;
        let changed = false;
        for (const id in prevCodes) {
          const item = prevCodes[id];
          if (item.remaining !== undefined && item.remaining > 0) {
            const nextRemaining = item.remaining - 1;
            updated[id] = { ...item, remaining: nextRemaining };
            changed = true;
            if (nextRemaining <= 0) {
              needRefresh = true;
            }
          } else {
            updated[id] = item;
          }
        }
        
        if (needRefresh) {
          Promise.resolve().then(() => {
            refreshCodes();
          });
        }
        return changed ? updated : prevCodes;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // ==================== 过滤和分组运算 ====================
  const filteredAccounts = useMemo(() => {
    let list = [...totpAccounts];
    if (totpFilterGroup) {
      list = list.filter((a) => String(a.group_id) === String(totpFilterGroup));
    }
    if (totpSearchQuery.trim()) {
      const q = totpSearchQuery.toLowerCase();
      list = list.filter(
        (a) =>
          (a.issuer || '').toLowerCase().includes(q) ||
          (a.account || '').toLowerCase().includes(q)
      );
    }

    if (totpSettings.groupByPlatform) {
      list.sort((a, b) => (a.issuer || '').localeCompare(b.issuer || ''));
    }
    return list;
  }, [totpAccounts, totpFilterGroup, totpSearchQuery, totpSettings.groupByPlatform]);

  const platformCounts = useMemo(() => {
    const counts = {};
    totpAccounts.forEach((a) => {
      const key = (a.issuer || '').toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }, [totpAccounts]);

  const groupAccountCounts = useMemo(() => {
    const counts = {};
    totpAccounts.forEach((a) => {
      if (a.group_id) {
        counts[a.group_id] = (counts[a.group_id] || 0) + 1;
      }
    });
    return counts;
  }, [totpAccounts]);

  const groupFilterTabs = useMemo(() => [
    { value: GROUP_FILTER_ALL, label: '总' },
    ...totpGroups.map((group) => ({
      value: String(group.id),
      label: group.name,
    })),
  ], [totpGroups]);

  // ==================== 账号编辑与删除 ====================
  const handleOpenAddAccount = () => {
    const defaultMode = totpSettings.lockInputMode
      ? totpSettings.defaultInputMode
      : 'scan';

    setAccountAddTab(defaultMode === 'manual' ? 'manual' : 'scan');
    setAccountForm({
      otp_type: 'totp',
      issuer: '',
      account: '',
      secret: '',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      counter: 0,
      group_id: '',
      icon: '',
      color: '',
    });
    setAccountModalMode('add');
    setAccountModalError('');
    setTotpShowSecret(false);
    setImportUris('');
    setQrError('');
    setBrandStyleOptions([]);
    setCustomBrandIcons([]);
    setShowAccountModal(true);
  };

  const handleOpenEditAccount = async (account) => {
    setAccountModalMode('edit');
    setAccountAddTab('manual');
    setEditingAccountId(account.id);
    setAccountForm({
      otp_type: account.otp_type || 'totp',
      issuer: account.issuer || '',
      account: account.account || '',
      secret: '••••••••••••••••',
      algorithm: account.algorithm || 'SHA1',
      digits: account.digits || 6,
      period: account.period || 30,
      counter: account.counter || 0,
      group_id: account.group_id || '',
      icon: account.icon || '',
      color: account.color || '',
    });
    setAccountModalError('');
    setTotpShowSecret(false);
    setBrandStyleOptions([]);
    setCustomBrandIcons([]);
    setShowAccountModal(true);
  };

  const loadCustomBrandIcons = useCallback(async () => {
    setCustomBrandIconsLoading(true);
    try {
      const res = await fetch('/api/totp/icons/library', { headers: getAuthOnlyHeaders() });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || '加载图标库失败');
      }
      const list = Array.isArray(data.data) ? data.data : [];
      setCustomBrandIcons(list);
      return list;
    } catch (error) {
      toast.error(error.message || '加载图标库失败');
      return [];
    } finally {
      setCustomBrandIconsLoading(false);
    }
  }, []);

  const uploadCustomBrandIconAsset = useCallback(async (file, fallbackName = '') => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', String(accountForm.issuer || fallbackName || file.name || '自定义图标').trim());
    formData.append('issuer', String(accountForm.issuer || '').trim());
    formData.append('color', normalizeHexColor(accountForm.color) || resolveFormColor(accountForm));
    const res = await fetch('/api/totp/icons/library', {
      method: 'POST',
      headers: getAuthOnlyHeaders(),
      body: formData,
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || '上传图标失败');
    }
    const uploaded = data.data || {};
    const nextIcon = uploaded.icon || (uploaded.id ? `custom:${uploaded.id}` : '');
    setAccountForm((prev) => ({
      ...prev,
      icon: nextIcon,
      color: uploaded.color || prev.color,
    }));
    const nextLibrary = await loadCustomBrandIcons();
    const customOptions = buildCustomBrandStyleOptions({
      issuer: accountForm.issuer,
      entries: nextLibrary,
      fallbackColor: resolveFormColor(accountForm),
    });
    setBrandStyleOptions((prev) => mergeBrandStyleOptions(customOptions, prev));
    setShowBrandStyleModal(true);
    return uploaded;
  }, [accountForm.color, accountForm.issuer, loadCustomBrandIcons]);

  const importCustomBrandIconFromURL = useCallback(async (sourceURL) => {
    const normalizedURL = normalizeRemoteBrandIconURL(sourceURL);
    if (!normalizedURL) {
      throw new Error('请粘贴有效的 http/https 图片链接');
    }
    const res = await fetch('/api/totp/icons/library/import-url', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        url: normalizedURL,
        name: String(accountForm.issuer || '').trim(),
        issuer: String(accountForm.issuer || '').trim(),
        color: normalizeHexColor(accountForm.color) || resolveFormColor(accountForm),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || '下载图标失败');
    }
    const uploaded = data.data || {};
    const nextIcon = uploaded.icon || (uploaded.id ? `custom:${uploaded.id}` : '');
    setAccountForm((prev) => ({
      ...prev,
      icon: nextIcon,
      color: uploaded.color || prev.color,
    }));
    const nextLibrary = await loadCustomBrandIcons();
    const customOptions = buildCustomBrandStyleOptions({
      issuer: accountForm.issuer,
      entries: nextLibrary,
      fallbackColor: resolveFormColor(accountForm),
    });
    setBrandStyleOptions((prev) => mergeBrandStyleOptions(customOptions, prev));
    setShowBrandStyleModal(true);
    return uploaded;
  }, [accountForm.color, accountForm.issuer, loadCustomBrandIcons]);

  const openBrandStylePicker = useCallback(async (baseOptions = null) => {
    const fallbackOptions = baseOptions || buildBrandStyleOptions({
      issuer: accountForm.issuer,
      icon: accountForm.icon,
      color: resolveFormColor(accountForm),
      name: accountForm.issuer || accountForm.account || '品牌',
    });
    const library = await loadCustomBrandIcons();
    const customOptions = buildCustomBrandStyleOptions({
      issuer: accountForm.issuer,
      entries: library,
      fallbackColor: resolveFormColor(accountForm),
    });
    setBrandStyleOptions(mergeBrandStyleOptions(customOptions, fallbackOptions));
    setShowBrandStyleModal(true);
  }, [accountForm.account, accountForm.icon, accountForm.issuer, accountForm.color, loadCustomBrandIcons]);

  const detectAccountBrandIcon = async () => {
    setBrandDetecting(true);
    try {
      const res = await fetch('/api/totp/icons/detect', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          issuer: accountForm.issuer,
          account: accountForm.account,
          query: accountForm.icon,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || '检测失败');
      }
      if (!data.data?.matched) {
        await openBrandStylePicker(buildBrandStyleOptions({
          issuer: accountForm.issuer,
          icon: accountForm.icon,
          color: resolveFormColor(accountForm),
          name: accountForm.issuer || accountForm.account || '品牌',
        }));
        toast.info(data.data?.message || '未检测到远程图标，已提供系统图标样式');
        return;
      }
      const baseOptions = buildBrandStyleOptions({
        issuer: accountForm.issuer,
        icon: data.data.icon,
        color: data.data.color,
        name: data.data.name,
        options: data.data.options,
      });
      const detectedItems = [data.data, ...(Array.isArray(data.data.options) ? data.data.options : [])];
      detectedItems.forEach((item) => {
        cacheDetectedBrandIcon(item);
      });
      await openBrandStylePicker(baseOptions);
    } catch (error) {
      toast.error(error.message || '检测图标失败');
    } finally {
      setBrandDetecting(false);
    }
  };

  const handleCustomBrandIconUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setCustomBrandIconUploading(true);
    try {
      await uploadCustomBrandIconAsset(file, file.name);
      toast.success('已上传并应用自定义图标');
    } catch (error) {
      toast.error(error.message || '上传图标失败');
    } finally {
      setCustomBrandIconUploading(false);
    }
  };

  const uploadCustomBrandIconFromClipboardItems = useCallback(async (items = []) => {
    for (const item of items) {
      if (!item) continue;
      if (item.kind === 'file') {
        const file = item.getAsFile?.();
        if (file) {
          const ext = file.type === 'image/svg+xml'
            ? 'svg'
            : file.type === 'image/png'
              ? 'png'
              : file.type === 'image/jpeg'
                ? 'jpg'
                : file.type === 'image/webp'
                  ? 'webp'
                  : file.type === 'image/gif'
                    ? 'gif'
                    : 'png';
          return {
            type: 'file',
            value: new File([file], file.name || `clipboard-icon.${ext}`, { type: file.type || 'image/png' }),
          };
        }
      }
      if (item.kind === 'string' && item.type === 'text/plain') {
        const text = await new Promise((resolve) => item.getAsString(resolve));
        if (typeof text === 'string' && text.toLowerCase().includes('<svg')) {
          return { type: 'file', value: new File([text], 'clipboard-icon.svg', { type: 'image/svg+xml' }) };
        }
        const sourceURL = normalizeRemoteBrandIconURL(text);
        if (sourceURL) {
          return { type: 'url', value: sourceURL };
        }
      }
    }
    return null;
  }, []);

  const handleBrandLibraryPaste = useCallback(async (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    if (items.length === 0) return;
    event.preventDefault();
    setCustomBrandIconUploading(true);
    try {
      const asset = await uploadCustomBrandIconFromClipboardItems(items);
      if (!asset) {
        throw new Error('剪贴板里没有可用的图片、SVG 图标或图片链接');
      }
      if (asset.type === 'url') {
        await importCustomBrandIconFromURL(asset.value);
        toast.success('已从链接下载并应用图标');
      } else {
        await uploadCustomBrandIconAsset(asset.value, 'clipboard-icon');
        toast.success('已从剪贴板粘贴并应用图标');
      }
    } catch (error) {
      toast.error(error.message || '粘贴图标失败');
    } finally {
      setCustomBrandIconUploading(false);
    }
  }, [importCustomBrandIconFromURL, uploadCustomBrandIconAsset, uploadCustomBrandIconFromClipboardItems]);

  const handlePasteBrandIconFromClipboard = useCallback(async () => {
    if (!navigator.clipboard?.read) {
      toast.info('当前环境不支持直接读取剪贴板，请在下方区域按 Ctrl+V 粘贴');
      return;
    }
    setCustomBrandIconUploading(true);
    try {
      const clipboardItems = await navigator.clipboard.read();
      let uploaded = false;
      let clipboardText = '';
      for (const clipboardItem of clipboardItems) {
        const types = clipboardItem.types || [];
        const imageType = types.find((type) => ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type));
        if (imageType) {
          const blob = await clipboardItem.getType(imageType);
          const ext = imageType === 'image/svg+xml'
            ? 'svg'
            : imageType === 'image/png'
              ? 'png'
              : imageType === 'image/jpeg'
                ? 'jpg'
                : imageType === 'image/webp'
                  ? 'webp'
                  : 'gif';
          const file = new File([blob], `clipboard-icon.${ext}`, { type: imageType });
          await uploadCustomBrandIconAsset(file, 'clipboard-icon');
          uploaded = true;
          break;
        }
        if (!clipboardText && types.includes('text/plain')) {
          const textBlob = await clipboardItem.getType('text/plain');
          clipboardText = await textBlob.text();
        }
      }
      if (!uploaded && clipboardText.toLowerCase().includes('<svg')) {
        const file = new File([clipboardText], 'clipboard-icon.svg', { type: 'image/svg+xml' });
        await uploadCustomBrandIconAsset(file, 'clipboard-icon');
        uploaded = true;
      }
      let importedFromURL = false;
      if (!uploaded) {
        const sourceURL = normalizeRemoteBrandIconURL(clipboardText);
        if (sourceURL) {
          await importCustomBrandIconFromURL(sourceURL);
          uploaded = true;
          importedFromURL = true;
        }
      }
      if (!uploaded) {
        throw new Error('剪贴板里没有检测到可上传的图标或图片链接');
      }
      toast.success(importedFromURL ? '已从链接下载并应用图标' : '已从剪贴板粘贴并应用图标');
    } catch (error) {
      toast.error(error.message || '读取剪贴板失败');
    } finally {
      setCustomBrandIconUploading(false);
    }
  }, [importCustomBrandIconFromURL, uploadCustomBrandIconAsset]);

  const applyBrandStyleOption = (option) => {
    setAccountForm((prev) => ({
      ...prev,
      icon: option.icon || '',
      color: option.color || prev.color,
    }));
    setShowBrandStyleModal(false);
    toast.success(`已选择${option.label}`);
  };

  const toggleSecretVisibility = async () => {
    if (!totpShowSecret && accountModalMode === 'edit' && accountForm.secret.includes('•••')) {
      try {
        const res = await fetch(`/api/totp/accounts/${editingAccountId}?showSecret=true`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json();
        if (data.success && data.data.secret) {
          setAccountForm((prev) => ({ ...prev, secret: data.data.secret }));
        } else {
          toast.error('获取密钥失败');
        }
      } catch (e) {
        console.error(e);
        toast.error('获取密钥失败');
      }
    }
    setTotpShowSecret(!totpShowSecret);
  };

  const handleSaveAccount = async () => {
    setAccountModalError('');

    if (!accountForm.issuer.trim()) {
      setAccountModalError('请输入发行商名称');
      return;
    }
    if (accountModalMode === 'add' && !accountForm.secret.trim()) {
      setAccountModalError('请输入密钥');
      return;
    }

    setAccountModalSaving(true);
    try {
      const payload = buildTotpAccountPayload(accountForm, {
        includeSecret: accountModalMode === 'add',
      });

      const url =
        accountModalMode === 'add'
          ? '/api/totp/accounts'
          : `/api/totp/accounts/${editingAccountId}`;

      const res = await fetch(url, {
        method: accountModalMode === 'add' ? 'POST' : 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      });

      const result = await res.json();
      if (result.success) {
        toast.success(accountModalMode === 'add' ? '账号添加成功' : '账号更新成功');
        setShowAccountModal(false);
        await loadData();
      } else {
        setAccountModalError(result.error || '保存失败');
      }
    } catch (e) {
      console.error(e);
      setAccountModalError('保存失败');
    } finally {
      setAccountModalSaving(false);
    }
  };

  const handleDeleteAccount = async (account) => {
    if (!(await dialog.confirm(`确定要删除 "${account.issuer}" 的账号吗？`))) {
      return;
    }

    try {
      const res = await fetch(`/api/totp/accounts/${account.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        toast.success('账号已删除');
        await loadData();
      } else {
        toast.error(data.error || '删除失败');
      }
    } catch (e) {
      console.error(e);
      toast.error('删除失败');
    }
  };

  const incrementHotp = async (account) => {
    try {
      const res = await fetch(`/api/totp/accounts/${account.id}/increment`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        setTotpCodes((prev) => ({
          ...prev,
          [account.id]: {
            ...prev[account.id],
            code: data.data.code,
            counter: data.data.counter,
          },
        }));
        toast.success('HOTP 计数器已递增');
      }
    } catch (e) {
      console.error(e);
      toast.error('递增失败');
    }
  };

  // ==================== 扫码与导入解析 ====================
  const startQrScan = async () => {
    if (!window.Html5Qrcode) {
      toast.error('扫码库加载失败');
      return;
    }
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      setQrError('摄像头功能仅支持 HTTPS 环境。如果是移动端访问，请确认服务器域名已开启 SSL。');
      toast.warning('环境不受支持');
      return;
    }

    setIsScanning(true);
    setQrError('');

    setTimeout(async () => {
      try {
        const html5QrCode = new window.Html5Qrcode('qr-reader');
        scannerRef.current = html5QrCode;

        const config = {
          fps: 15,
          qrbox: { width: 250, height: 250 },
        };

        const successCallback = async (decodedText) => {
          if (decodedText.startsWith('otpauth://')) {
            triggerHaptic('success');
            await stopQrScan();

            if (totpSettings.autoSave) {
              await importUrisDirectly(decodedText);
            } else {
              setImportUris((prev) => (prev ? prev + '\n' + decodedText : decodedText));
              toast.success('扫码成功');
            }
          }
        };

        try {
          await html5QrCode.start({ facingMode: 'environment' }, config, successCallback, () => {});
        } catch (err) {
          try {
            await html5QrCode.start({ facingMode: 'user' }, config, successCallback, () => {});
          } catch (err2) {
            const devices = await window.Html5Qrcode.getCameras();
            if (devices && devices.length > 0) {
              await html5QrCode.start(devices[0].id, config, successCallback, () => {});
            } else {
              throw new Error('未检测到任何摄像头设备');
            }
          }
        }
      } catch (err) {
        console.error(err);
        let friendlyMsg = '启动摄像头失败';
        if (err.name === 'NotAllowedError') friendlyMsg = '未获得摄像头访问权限';
        else if (err.name === 'NotFoundError') friendlyMsg = '未发现可用的摄像头';
        else if (err.name === 'NotReadableError') friendlyMsg = '摄像头已被占用或故障';
        setQrError(`${friendlyMsg}: ${err.message || '未知错误'}`);
        setIsScanning(false);
      }
    }, 100);
  };

  const stopQrScan = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
      } catch (err) {
        console.error(err);
      }
      scannerRef.current = null;
    }
    setIsScanning(false);
  };

  const parseQrImage = async (blob) => {
    try {
      setQrParsing(true);
      setQrError('');

      const img = new Image();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
      });

      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (code && code.data.startsWith('otpauth://')) {
        const uri = code.data;
        if (totpSettings.autoSave) {
          await importUrisDirectly(uri);
        } else {
          setImportUris((prev) => (prev ? prev + '\n' + uri : uri));
          toast.success('二维码解析成功');
        }
      } else {
        setQrError('无法识别二维码或二维码不是有效的 OTP URI');
      }
      URL.revokeObjectURL(img.src);
    } catch (e) {
      console.error(e);
      setQrError('二维码解析失败');
    } finally {
      setQrParsing(false);
    }
  };

  const handleQrPaste = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        await parseQrImage(blob);
        return;
      }
    }
  };

  const handleQrUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await parseQrImage(file);
    e.target.value = ''; // Reset input
  };

  const importUrisDirectly = async (urisText) => {
    const uris = urisText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('otpauth://'));
    const backupPayload = uris.length === 0 ? urisText.trim() : '';

    if (uris.length === 0 && !backupPayload) {
      toast.warning('没有找到有效的 URI 或加密备份');
      return;
    }

    try {
      const importBody = uris.length > 0 ? { uris } : { backup: backupPayload };
      const previewRes = await fetch('/api/totp/import/preview', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(importBody),
      });
      const previewData = await previewRes.json();
      if (!previewRes.ok || !previewData.success) {
        throw new Error(previewData.error || '导入预览失败');
      }
      const preview = previewData.data;
      if (preview.errors?.length) {
        toast.warning(`导入预览发现 ${preview.errors.length} 个错误`);
      }
      if (preview.duplicates > 0) {
        toast.warning(`导入预览发现 ${preview.duplicates} 个重复项`);
      }

      const res = await fetch('/api/totp/import', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(importBody),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`导入成功: 新增 ${data.data.success} 个账号`);
        setShowAccountModal(false);
        await loadData();
      } else {
        toast.error(data.error || '导入失败');
      }
    } catch (e) {
      console.error(e);
      toast.error('导入失败');
    }
  };

  // ==================== 分组管理 ====================
  const handleOpenAddGroup = () => {
    setGroupModalMode('add');
    setGroupForm({ name: '', color: BRAND_COLOR_FALLBACK });
    setShowGroupModal(true);
  };

  const handleOpenEditGroup = (group) => {
    setGroupModalMode('edit');
    setEditingGroupId(group.id);
    setGroupForm({ name: group.name, color: group.color || BRAND_COLOR_FALLBACK });
    setShowGroupModal(true);
  };

  const handleSaveGroup = async () => {
    if (!groupForm.name.trim()) {
      toast.warning('请输入分组名称');
      return;
    }

    try {
      const url =
        groupModalMode === 'add'
          ? '/api/totp/groups'
          : `/api/totp/groups/${editingGroupId}`;

      const res = await fetch(url, {
        method: groupModalMode === 'add' ? 'POST' : 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(groupForm),
      });

      const data = await res.json();
      if (data.success) {
        toast.success(groupModalMode === 'add' ? '分组创建成功' : '分组更新成功');
        setShowGroupModal(false);
        await loadData();
      } else {
        toast.error(data.error || '保存失败');
      }
    } catch (e) {
      console.error(e);
      toast.error('保存失败');
    }
  };

  const handleDeleteGroup = async (group) => {
    if (!(await dialog.confirm(`确定要删除分组 "${group.name}" 吗？分组内的账号不会被删除。`))) {
      return;
    }

    try {
      const res = await fetch(`/api/totp/groups/${group.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        toast.success('分组已删除');
        await loadData();
      } else {
        toast.error(data.error || '删除失败');
      }
    } catch (e) {
      console.error(e);
      toast.error('删除失败');
    }
  };

  // ==================== 导出导入数据 ====================
  const handleExportAccounts = async () => {
    if (totpAccounts.length === 0) {
      toast.warning('没有可导出的账号');
      return;
    }
    try {
      const res = await fetch('/api/totp/export', { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.success) {
        if (data.format === 'encrypted-backup') {
          setExportUris(data.data.payload);
          setExportMeta(data.data);
        } else {
          setExportUris(Array.isArray(data.data) ? data.data.join('\n') : String(data.data || ''));
          setExportMeta({ format: data.format || 'uri' });
        }
        setShowExportModal(true);
        toast.success('已生成导出数据');
      } else {
        toast.error(data.error || '导出失败');
      }
    } catch (e) {
      console.error(e);
      toast.error('导出失败');
    }
  };

  const copyExportedUris = async () => {
    if (!exportUris) return;
    try {
      await navigator.clipboard.writeText(exportUris);
      toast.success('导出数据已复制到剪贴板');
    } catch (e) {
      toast.error('复制失败');
    }
  };

  const copyCodeToClipboard = async (account) => {
    const code = totpCodes[account.id]?.code;
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code);
      toast.success(`验证码已复制: ${code}`);
    } catch (e) {
      toast.error('复制失败');
    }
  };

  // 同步配置到浏览器扩展
  const syncConfigToExtension = () => {
    const password = localStorage.getItem('admin_password') || '';
    const serverUrl = window.location.origin;

    window.postMessage(
      {
        type: 'API_MONITOR_SYNC_CONFIG',
        serverUrl: serverUrl,
        password: password,
      },
      '*'
    );

    const successHandler = (e) => {
      if (e.data && e.data.type === 'API_MONITOR_SYNC_SUCCESS') {
        toast.success('配置已成功同步到浏览器插件！');
        window.removeEventListener('message', successHandler);
      }
    };
    window.addEventListener('message', successHandler);
    setTimeout(() => {
      window.removeEventListener('message', successHandler);
    }, 3000);
  };

  // Helper formats code displaying
  const formatTotpCode = (account, code) => {
    const digits = account.digits || 6;
    const isRevealed = revealedCodes[account.id] || false;
    
    if (totpSettings.hideCode && !isRevealed) {
      if (digits === 8) return '•••• ••••';
      return '••• •••';
    }

    if (!code) {
      if (digits === 8) return '0000 0000';
      return '000 000';
    }
    
    const cleanCode = code.replace(/\s/g, '');
    if (cleanCode.length === 6) {
      return cleanCode.slice(0, 3) + ' ' + cleanCode.slice(3);
    }
    if (cleanCode.length === 8) {
      return cleanCode.slice(0, 4) + ' ' + cleanCode.slice(4);
    }
    return cleanCode;
  };

  const getTotpCodeParts = (account, code) => {
    const formatted = formatTotpCode(account, code);
    const parts = formatted.split(' ');
    return parts.length > 1 ? parts : [formatted];
  };

  const handleCardMouseEnter = (accountId) => {
    if (totpSettings.allowRevealCode) {
      setRevealedCodes((prev) => ({ ...prev, [accountId]: true }));
    }
  };

  const handleCardMouseLeave = (accountId) => {
    if (totpSettings.allowRevealCode) {
      setRevealedCodes((prev) => ({ ...prev, [accountId]: false }));
    }
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-3 sm:gap-4">
      {/* ==================== 顶部 Tab 导航 ==================== */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line pb-3">
        <Tabs
          {...MODULE_TABS_PROPS}
          value={totpCurrentTab}
          onValueChange={setTotpCurrentTab}
          tabs={[
            { value: 'accounts', label: <span className="inline-flex items-center gap-1.5"><Key className="w-3.5 h-3.5" />验证码</span> },
            { value: 'groups', label: <span className="inline-flex items-center gap-1.5"><FolderOpen className="w-3.5 h-3.5" />分组</span> },
            { value: 'settings', label: <span className="inline-flex items-center gap-1.5"><Settings className="w-3.5 h-3.5" />设置</span> },
          ]}
        />

        {totpCurrentTab === 'accounts' && (
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 md:w-auto md:flex-1 md:justify-end">
            <Tabs
              {...TOOL_TABS_PROPS}
              value={totpFilterGroup || GROUP_FILTER_ALL}
              onValueChange={(value) => {
                const nextValue = String(value);
                setTotpFilterGroup(nextValue === GROUP_FILTER_ALL ? '' : nextValue);
              }}
              tabs={groupFilterTabs}
              className="min-w-0 max-w-full flex-1 md:flex-none"
              listClassName="max-w-full overflow-x-auto"
            />

            <div className="relative min-w-40 flex-1 md:max-w-48">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-kumo-subtle">
                <Search className="w-3.5 h-3.5" />
              </span>
              <Input size="sm"
                aria-label="搜索 TOTP 账号"
                type="text"
                placeholder="搜索账号..."
                value={totpSearchQuery}
                onChange={(e) => setTotpSearchQuery(e.target.value)}
                className="w-full text-kumo-strong text-xs pl-8 pr-3 py-1.5"
              />
            </div>

            <Button size="sm" variant="primary" icon={<Plus className="w-4 h-4" />} onClick={handleOpenAddAccount}>
              添加账号
            </Button>
          </div>
        )}

        {totpCurrentTab === 'groups' && (
          <Button size="sm" variant="primary" icon={<Plus className="w-4 h-4" />} onClick={handleOpenAddGroup}>
            新建分组
          </Button>
        )}
      </div>

      {/* ==================== 1. 验证码卡片列表 ==================== */}
      {totpCurrentTab === 'accounts' && (
        <div>
          {totpLoading ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {[...Array(6)].map((_, i) => (
                <LayerCard key={i} className="space-y-2 p-2 sm:space-y-3 sm:p-3">
                  <div className="flex items-center gap-2">
                    <SkeletonLine className="h-6 w-6 rounded-md" />
                    <div className="flex-1 space-y-1.5">
                      <SkeletonLine className="w-1/2 h-3" />
                      <SkeletonLine className="w-3/4 h-2" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <SkeletonLine className="h-5 w-2/3" />
                    <SkeletonLine className="w-1/3 h-2" />
                  </div>
                </LayerCard>
              ))}
            </div>
          ) : filteredAccounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-kumo-subtle app-empty-panel">
              <Shield className="w-12 h-12 opacity-30 mb-4" />
              <div className="text-sm">
                {totpSearchQuery ? '没有找到匹配的账号' : '暂无 2FA 账号，快来添加第一个吧'}
              </div>
              {!totpSearchQuery && (
                <Button size="sm" variant="primary" className="mt-4" onClick={handleOpenAddAccount}>
                  添加第一个账号
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {filteredAccounts.map((account, index) => {
                const isFirstOfPlatform =
                  index === 0 ||
                  (account.issuer || '').toLowerCase() !==
                    (filteredAccounts[index - 1].issuer || '').toLowerCase();

                const issuerColor = account.color || getIssuerColor(account.issuer);
                const codeDetail = totpCodes[account.id] || {};
                const remaining = codeDetail.remaining ?? 30;
                const period = account.period || 30;
                const ratio = Math.max(0, Math.min(100, (remaining / period) * 100));
                const codeParts = getTotpCodeParts(account, codeDetail.code);
                
                // Show platform header if settings enable it
                const showHeader =
                  totpSettings.groupByPlatform &&
                  totpSettings.showPlatformHeaders &&
                  isFirstOfPlatform;

                return (
                  <React.Fragment key={account.id}>
                    {showHeader && (
                      <div className="col-span-full mt-2 flex items-center justify-between border-b border-kumo-line pb-1.5">
                        {!totpSettings.hidePlatformText ? (
                          <div className="flex items-center gap-2">
                            <TotpBrandMark issuer={account.issuer} icon={account.icon} size="header" />
                            <span className="text-xs font-semibold text-kumo-strong">
                              {account.issuer || '未知平台'}
                            </span>
                            <span className="ml-1 rounded border border-kumo-line bg-kumo-recessed px-1 py-0.5 text-[9px] font-medium leading-none text-kumo-subtle">
                              {platformCounts[(account.issuer || '').toLowerCase()]} 个账号
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <span className="size-2.5 rounded-full" style={{ background: getIssuerColor(account.issuer) }} />
                            <span className="text-[10px] text-kumo-subtle font-medium">
                              {platformCounts[(account.issuer || '').toLowerCase()]} 个账号
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    <LayerCard
                      onMouseEnter={() => handleCardMouseEnter(account.id)}
                      onMouseLeave={() => handleCardMouseLeave(account.id)}
                      onClick={() => copyCodeToClipboard(account)}
                      className="group/card relative grid min-h-[96px] cursor-pointer grid-rows-[auto_1fr_auto] overflow-hidden p-0 transition-colors hover:border-kumo-brand sm:min-h-[112px]"
                    >
                      <div className="flex items-center gap-1.5 border-b border-kumo-line bg-kumo-recessed/35 px-2 py-1.5 sm:gap-2 sm:px-3 sm:py-2">
                        <TotpBrandMark issuer={account.issuer} icon={account.icon} color={issuerColor} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[10px] font-semibold leading-tight text-kumo-strong sm:text-[11px]">{account.issuer || '未知平台'}</div>
                          <div className="mt-0.5 truncate pb-px text-[9px] leading-tight text-kumo-subtle sm:mt-0.5 sm:text-[10px]">
                            {totpSettings.maskAccount ? maskEmail(account.account) : account.account}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1 opacity-65 transition-opacity group-hover/card:opacity-100">
                          <Button
                            shape="square" size="sm"
                            variant="secondary"
                            aria-label="编辑账号"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenEditAccount(account);
                            }}
                            className="flex h-5 w-5 items-center justify-center sm:h-6 sm:w-6"
                            title="编辑"
                          >
                            <Edit className="h-3 w-3" />
                          </Button>
                          <Button
                            shape="square" size="sm"
                            variant="secondary-destructive"
                            aria-label="删除账号"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteAccount(account);
                            }}
                            className="flex h-5 w-5 items-center justify-center sm:h-6 sm:w-6"
                            title="删除"
                          >
                            <Trash className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>

                      <div
                        className={`flex items-center justify-center gap-1 px-2 py-2 font-mono tabular-nums sm:gap-2 sm:px-3 sm:py-2.5 ${
                          remaining <= 5 ? 'text-kumo-danger' : 'text-kumo-strong'
                        }`}
                      >
                        {codeParts.map((part, partIndex) => (
                          <span
                            key={`${account.id}-${partIndex}`}
                            className="min-w-0 flex-1 rounded-md bg-kumo-recessed px-1.5 py-1 text-center text-[16px] font-semibold leading-none tracking-normal sm:min-w-[4.25rem] sm:flex-none sm:px-2 sm:text-[20px]"
                          >
                            {part}
                          </span>
                        ))}
                      </div>

                      <div className="border-t border-kumo-line px-2 py-1.5 font-mono text-[10px] text-kumo-subtle sm:px-3 sm:py-2">
                        {account.otp_type === 'hotp' ? (
                          <div className="flex items-center justify-between gap-2">
                            <span>counter #{codeDetail.counter || 0}</span>
                            <Button size="sm"
                              variant="secondary"
                              onClick={(e) => {
                                e.stopPropagation();
                                incrementHotp(account);
                              }}
                              className="flex h-6 items-center gap-1 px-2 text-[10px] text-kumo-strong"
                            >
                              <RefreshCw className="h-3 w-3" />
                              <span>递增</span>
                            </Button>
                          </div>
                        ) : (
                          <div className="grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-1.5 sm:grid-cols-[minmax(0,1fr)_2rem] sm:gap-2">
                            <div className="h-1.5 overflow-hidden rounded-full bg-kumo-recessed">
                              <div
                                className={`h-full rounded-full ${remaining === period ? '' : 'transition-all duration-1000 ease-linear'}`}
                                style={{
                                  width: `${ratio}%`,
                                  background: issuerColor,
                                }}
                              />
                            </div>
                            <span className="select-none text-right text-[10px]">{remaining}s</span>
                          </div>
                        )}
                      </div>
                    </LayerCard>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================== 2. 分组列表 ==================== */}
      {totpCurrentTab === 'groups' && (
        <AppCard padding="none" className="overflow-hidden">
          {totpGroups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-kumo-subtle">
              <FolderOpen className="w-12 h-12 opacity-30 mb-4" />
              <span>暂无分组，创建一个吧</span>
              <Button size="sm" variant="primary" className="mt-4" onClick={handleOpenAddGroup}>
                创建分组
              </Button>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <Table layout="fixed">
                <colgroup>
                  <col className="w-20" />
                  <col />
                  <col className="w-28" />
                  <col className="w-36" />
                </colgroup>
                <Table.Header variant="compact">
                  <Table.Row>
                    <Table.Head>
                      颜色
                    </Table.Head>
                    <Table.Head>
                      分组名称
                    </Table.Head>
                    <Table.Head className="text-center">
                      账号数
                    </Table.Head>
                    <Table.Head className="text-center">
                      操作
                    </Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {totpGroups.map((group) => (
                    <Table.Row
                      key={group.id}
                      className="cursor-pointer"
                      title="双击编辑分组"
                      onDoubleClick={(event) => handleEditableRowDoubleClick(event, () => handleOpenEditGroup(group))}
                    >
                      <Table.Cell>
                        <div
                          className="h-4 w-4 rounded-full border border-kumo-line"
                          style={{ background: group.color || BRAND_COLOR_FALLBACK }}
                        />
                      </Table.Cell>
                      <Table.Cell className="font-semibold text-kumo-strong">
                        {group.name}
                      </Table.Cell>
                      <Table.Cell className="text-center tabular-nums text-kumo-default">
                        {groupAccountCounts[group.id] || 0}
                      </Table.Cell>
                      <Table.Cell className="text-center">
                        <div className="flex items-center justify-center gap-2">
                          <Button
                            shape="square" size="sm"
                            variant="ghost"
                            aria-label="编辑分组"
                            onClick={() => handleOpenEditGroup(group)}
                            className="text-kumo-subtle hover:text-kumo-strong"
                            title="编辑"
                            icon={<Edit className="w-3.5 h-3.5" />}
                          >
                          </Button>
                          <Button
                            shape="square" size="sm"
                            variant="secondary-destructive"
                            aria-label="删除分组"
                            onClick={() => handleDeleteGroup(group)}
                            title="删除"
                            icon={<Trash className="w-3.5 h-3.5" />}
                          >
                          </Button>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
        </AppCard>
      )}

      {/* ==================== 3. 选项设置 ==================== */}
      {totpCurrentTab === 'settings' && (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
          {/* Settings Options (Span 2) */}
          <SectionCard
            title="安全与显示配置"
            icon={<Shield className="h-4 w-4 text-kumo-brand" />}
            className="lg:col-span-2"
            bodyPadding="md"
            bodyClassName="divide-y divide-kumo-line/80"
          >

            {/* Toggle 1: maskAccount */}
            <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 pr-4">
                <h4 className="text-xs font-semibold leading-5 text-kumo-strong">账号名称打码</h4>
                <p className="mt-0.5 text-[11px] leading-4 text-kumo-subtle">
                  对邮箱或长账号名称进行脱敏隐藏保护，避免屏幕泄露。
                </p>
              </div>
              <Switch
                checked={!!totpSettings.maskAccount}
                onCheckedChange={(checked) => updateSetting('maskAccount', checked)}
                size="sm"
              />
            </div>

            {/* Toggle 2: hideCode */}
            <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 pr-4">
                <h4 className="text-xs font-semibold leading-5 text-kumo-strong">遮挡实时验证码</h4>
                <p className="mt-0.5 text-[11px] leading-4 text-kumo-subtle">
                  隐藏验证码数值，仅在悬浮或点击复制时显示，防止身旁窥屏。
                </p>
              </div>
              <Switch
                checked={!!totpSettings.hideCode}
                onCheckedChange={(checked) => updateSetting('hideCode', checked)}
                size="sm"
              />
            </div>

            <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 pr-4">
                <h4 className="text-xs font-semibold leading-5 text-kumo-strong">允许悬浮显示验证码</h4>
                <p className="mt-0.5 text-[11px] leading-4 text-kumo-subtle">
                  开启后鼠标悬浮在验证码卡片上时临时显示被遮挡的验证码。
                </p>
              </div>
              <Switch
                checked={!!totpSettings.allowRevealCode}
                onCheckedChange={(checked) => updateSetting('allowRevealCode', checked)}
                size="sm"
              />
            </div>

            {/* Toggle 3: groupByPlatform */}
            <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 pr-4">
                <h4 className="text-xs font-semibold leading-5 text-kumo-strong">按站点分组</h4>
                <p className="mt-0.5 text-[11px] leading-4 text-kumo-subtle">
                  将相同站点或服务（如 Google, GitHub）下的账号汇聚在一起分组显示。
                </p>
              </div>
              <Switch
                checked={!!totpSettings.groupByPlatform}
                onCheckedChange={(checked) => updateSetting('groupByPlatform', checked)}
                size="sm"
              />
            </div>

            <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 pr-4">
                <h4 className="text-xs font-semibold leading-5 text-kumo-strong">显示站点标题</h4>
                <p className="mt-0.5 text-[11px] leading-4 text-kumo-subtle">
                  按站点分组时，在每组账号前显示站点名称和账号数量。
                </p>
              </div>
              <Switch
                checked={!!totpSettings.showPlatformHeaders}
                onCheckedChange={(checked) => updateSetting('showPlatformHeaders', checked)}
                disabled={!totpSettings.groupByPlatform}
                size="sm"
              />
            </div>

            <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 pr-4">
                <h4 className="text-xs font-semibold leading-5 text-kumo-strong">隐藏站点文字</h4>
                <p className="mt-0.5 text-[11px] leading-4 text-kumo-subtle">
                  只保留颜色标识和账号数量，减少站点名称在共享屏幕中暴露。
                </p>
              </div>
              <Switch
                checked={!!totpSettings.hidePlatformText}
                onCheckedChange={(checked) => updateSetting('hidePlatformText', checked)}
                disabled={!totpSettings.groupByPlatform || !totpSettings.showPlatformHeaders}
                size="sm"
              />
            </div>

            {/* Toggle 4: autoSave */}
            <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 pr-4">
                <h4 className="text-xs font-semibold leading-5 text-kumo-strong">解析二维码后自动导入</h4>
                <p className="mt-0.5 text-[11px] leading-4 text-kumo-subtle">
                  扫码或选取二维码图片后自动读取数据入库，不需要手动核对表单保存。
                </p>
              </div>
              <Switch
                checked={!!totpSettings.autoSave}
                onCheckedChange={(checked) => updateSetting('autoSave', checked)}
                size="sm"
              />
            </div>

            {/* Toggle 5: lockInputMode */}
            <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 pr-4">
                <h4 className="text-xs font-semibold leading-5 text-kumo-strong">锁定默认录入类型</h4>
                <p className="mt-0.5 text-[11px] leading-4 text-kumo-subtle">
                  开启后添加账号弹窗默认直接使用锁定的选项，不用每次手动选。
                </p>
              </div>
              <Switch
                checked={!!totpSettings.lockInputMode}
                onCheckedChange={(checked) => updateSetting('lockInputMode', checked)}
                size="sm"
              />
            </div>

            {totpSettings.lockInputMode && (
              <div className="flex flex-wrap items-center justify-between gap-3 py-3 pl-3 first:pt-0 last:pb-0">
                <label className="text-xs font-medium text-kumo-subtle">默认录入模式</label>
                <Select
                  aria-label="默认录入模式" size="sm"
                  value={totpSettings.defaultInputMode}
                  onValueChange={(value) => updateSetting('defaultInputMode', String(value))}
                  items={[
                    { value: 'scan', label: '扫描二维码' },
                    { value: 'upload', label: '上传二维码' },
                    { value: 'manual', label: '手动录入表单' },
                  ]}
                />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-3 first:pt-0 last:pb-0">
              <Button size="sm"
                shape="square"
                onClick={async () => {
                  const uris = await dialog.prompt({
                    message: '请输入批量导入的 otpauth:// 链接列表 (每行一条)',
                  });
                  importUrisDirectly(uris || '');
                }}
                aria-label="批量导入 URI"
                title="批量导入 URI"
                icon={<Download className="w-3.5 h-3.5" />}
              />
              <Button size="sm" shape="square" onClick={handleExportAccounts} aria-label="批量导出备份" title="批量导出备份" icon={<Upload className="w-3.5 h-3.5" />} />
              <Button size="sm" onClick={refreshCodes} icon={<RotateCw className="w-3.5 h-3.5" />}>
                手动刷新验证码
              </Button>
            </div>
          </SectionCard>

          {/* Right Column: Browser Extension Helper Card */}
          <SectionCard
            title="浏览器插件助手"
            icon={<Bot className="h-4 w-4 text-kumo-brand" />}
            className="lg:self-start"
            bodyPadding="md"
            bodyClassName="flex flex-col gap-3"
          >
            <div className="space-y-3.5">
              <p className="text-xs text-kumo-subtle leading-relaxed">
                下载安装 2FA 浏览器插件，在 PC 端登录账号需要验证码时可一键实现自动检索与快捷填充。
              </p>

              <div className="p-3 bg-kumo-recessed/60 border border-kumo-line rounded-lg flex items-start gap-3 mt-3">
                <div className="w-9 h-9 rounded-md bg-kumo-base flex items-center justify-center flex-shrink-0">
                  <img src="https://cdn.simpleicons.org/blueprint" className="w-6 h-6" alt="Extension" />
                </div>
                <div className="min-w-0">
                  <h4 className="text-xs font-bold text-kumo-strong">API Monitor 2FA 助手</h4>
                  <p className="text-[10px] text-kumo-subtle mt-0.5">本地免登录实时一键同步</p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <LinkButton
                size="sm"
                variant="secondary"
                href="/api/totp/extension/download"
                className="w-full justify-center"
                icon={<Download className="w-3.5 h-3.5" />}
              >
                下载插件 ZIP 包
              </LinkButton>

              <Button size="sm" variant="primary" className="w-full" onClick={syncConfigToExtension}>
                一键同步密码与地址到插件
              </Button>

              <Button size="sm"
                variant="ghost"
                className="w-full text-xs text-kumo-subtle hover:text-kumo-strong"
                onClick={() => setShowExtensionGuide(!showExtensionGuide)}
              >
                {showExtensionGuide ? '关闭教程' : '查看安装教程'}
              </Button>

              <AnimatedCollapse open={showExtensionGuide}>
                <div className="text-[11px] text-kumo-subtle space-y-2 mt-4 p-3 bg-kumo-recessed/50 rounded-lg border border-kumo-line">
                  <p className="font-bold text-kumo-strong">三步完成安装：</p>
                  <ol className="list-decimal pl-4 space-y-1">
                    <li>解压下载的 ZIP 压缩包至本地固定目录；</li>
                    <li>
                      打开 Chrome，访问 <code>chrome://extensions</code> 并开启右上角的
                      <strong>开发者模式</strong>；
                    </li>
                    <li>
                      点击<strong>加载已解压的扩展程序</strong>，选择刚才解压的目录文件夹。
                    </li>
                  </ol>
                  <div className="bg-kumo-brand/10 text-kumo-brand p-2 rounded border border-kumo-brand/20 mt-1 font-medium select-all">
                    配置插件地址: {window.location.origin}
                  </div>
                </div>
              </AnimatedCollapse>
            </div>
          </SectionCard>
        </div>
      )}

      {/* ==================== 模态框 1: 账号添加/修改 ==================== */}
      <Dialog.Root open={showAccountModal} onOpenChange={setShowAccountModal}>
        <Dialog className="!w-[min(40rem,calc(100vw-2rem))] !max-w-[min(40rem,calc(100vw-2rem))] p-6">
          <Dialog.Title className="text-base font-bold text-kumo-strong mb-1">
            {accountModalMode === 'add' ? '添加 / 导入 2FA 账号' : '编辑 2FA 账号'}
          </Dialog.Title>
          <Dialog.Description className="text-xs text-kumo-subtle mb-4">
            {accountModalMode === 'add' ? '扫码或手动填表记录新的动态验证码' : '修改现有 2FA 令牌的标签或分组配置'}
          </Dialog.Description>

          {accountModalMode === 'add' && (
            <div className="mb-4">
              <Tabs
                {...TOOL_TABS_PROPS}
                value={accountAddTab}
                onValueChange={(value) => {
                  stopQrScan();
                  setAccountAddTab(value);
                }}
                tabs={[
                  { value: 'scan', label: '扫码导入' },
                  { value: 'manual', label: '手动录入' },
                ]}
              />
            </div>
          )}

          {/* Form Content */}
          <div className="-mx-1 space-y-4 max-h-[50vh] overflow-y-auto px-1 pr-2 scrollbar-thin">
            {accountModalMode === 'add' && accountAddTab === 'scan' ? (
              <div className="space-y-4">
                <div className="flex gap-2 items-center">
                  <Button size="sm"
                    onClick={isScanning ? stopQrScan : startQrScan}
                    variant={isScanning ? 'destructive' : 'secondary'}
                  >
                    {isScanning ? '停止摄像头' : '开启摄像头扫码'}
                  </Button>
                  <Button size="sm" onClick={() => fileInputRef.current?.click()} icon={<Upload className="w-3.5 h-3.5" />}>
                    上传二维码图片
                  </Button>
                  <Input size="sm"
                    aria-label="上传二维码图片"
                    type="file"
                    ref={fileInputRef}
                    accept="image/*"
                    onChange={handleQrUpload}
                    className="hidden"
                  />
                </div>

                {isScanning && (
                  <div
                    id="qr-reader"
                    className="w-full aspect-square max-w-[280px] mx-auto rounded-xl overflow-hidden border border-kumo-line bg-black"
                  />
                )}

                {!isScanning && (
                  <div
                    onPaste={handleQrPaste}
                    tabIndex={0}
                    className="w-full py-10 app-empty-panel rounded-lg flex flex-col items-center justify-center text-kumo-subtle cursor-pointer focus:border-kumo-brand focus:outline-none group"
                  >
                    {qrParsing ? (
                      <span className="flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>解析中...</span>
                      </span>
                    ) : (
                      <>
                        <Upload className="w-6 h-6 mb-2 opacity-50 group-hover:scale-105 transition-transform" />
                        <span className="text-xs">Ctrl+V 粘贴二维码图片 或 拖拽图片至此</span>
                      </>
                    )}
                  </div>
                )}

                {qrError && (
                  <div className="p-3 bg-kumo-danger/10 border border-kumo-danger/20 text-kumo-danger text-xs rounded-md">
                    {qrError}
                  </div>
                )}

                <div className="space-y-1.5 pt-2">
                  <label className="text-xs font-semibold text-kumo-subtle">
                    批量 OTP Auth URIs 导入 (每行一条)
                  </label>
                  <Textarea
                    aria-label="批量 OTP Auth URIs"
                    rows={4}
                    placeholder="otpauth://totp/GitHub:user@example.com?secret=XXXX..."
                    value={importUris}
                    onChange={(e) => setImportUris(e.target.value)}
                    className="w-full font-mono"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {/* OTP Type */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-kumo-subtle">验证码类型</label>
                  <div className="flex gap-2">
                    <Button size="sm"
                      type="button"
                      variant={accountForm.otp_type === 'totp' ? 'primary' : 'secondary'}
                      onClick={() => setAccountForm((prev) => ({ ...prev, otp_type: 'totp' }))}
                      className={`flex-1 py-1.5 text-xs font-semibold transition-colors ${
                        accountForm.otp_type === 'totp'
                          ? 'text-kumo-brand'
                          : 'text-kumo-subtle'
                      }`}
                    >
                      TOTP (基于时间)
                    </Button>
                    <Button size="sm"
                      type="button"
                      variant={accountForm.otp_type === 'hotp' ? 'primary' : 'secondary'}
                      onClick={() => setAccountForm((prev) => ({ ...prev, otp_type: 'hotp' }))}
                      className={`flex-1 py-1.5 text-xs font-semibold transition-colors ${
                        accountForm.otp_type === 'hotp'
                          ? 'text-kumo-brand'
                          : 'text-kumo-subtle'
                      }`}
                    >
                      HOTP (基于计数)
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-kumo-subtle">发行商 / 服务商</label>
                  <Input size="sm"
                    aria-label="发行商"
                    type="text"
                    placeholder="如: GitHub, Microsoft"
                    value={accountForm.issuer}
                    onChange={(e) => setAccountForm((prev) => ({ ...prev, issuer: e.target.value }))}
                    className="w-full"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-kumo-subtle">账户名 / 标识</label>
                  <Input size="sm"
                    aria-label="账户名"
                    type="text"
                    placeholder="如: user@example.com"
                    value={accountForm.account}
                    onChange={(e) => setAccountForm((prev) => ({ ...prev, account: e.target.value }))}
                    className="w-full"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-kumo-subtle">品牌标识</label>
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_minmax(0,8rem)] items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      shape="square"
                      className="!h-auto p-0 transition-transform hover:scale-[1.03]"
                      onClick={() => openBrandStylePicker()}
                      title="点击选择或上传品牌图标"
                    >
                      <TotpBrandMark issuer={accountForm.issuer} icon={accountForm.icon} color={resolveFormColor(accountForm)} />
                    </Button>
                    <Input size="sm"
                      aria-label="图标关键字"
                      type="text"
                      placeholder="品牌名、SVG Repo 链接或 svgrepo:448239-microsoft"
                      value={accountForm.icon}
                      onChange={(e) => setAccountForm((prev) => ({ ...prev, icon: normalizeSVGRepoIconRef(e.target.value) }))}
                      onBlur={(e) => setAccountForm((prev) => ({ ...prev, icon: normalizeSVGRepoIconRef(e.target.value) }))}
                      className="w-full"
                    />
                    <Button size="sm" variant="secondary" onClick={detectAccountBrandIcon} loading={brandDetecting}>
                      检测
                    </Button>
                    <Button size="sm" variant="ghost" className="px-2 text-[11px]" onClick={() => setAccountForm((prev) => ({ ...prev, icon: '', color: '' }))}>
                      重置
                    </Button>
                    <span
                      className="h-7 w-7 rounded-md border border-kumo-line"
                      style={{ background: resolveFormColor(accountForm) }}
                      aria-hidden="true"
                    />
                    <Input size="sm"
                      aria-label="品牌色值"
                      type="text"
                      inputMode="text"
                      placeholder="#f50049"
                      value={accountForm.color}
                      onChange={(e) => setAccountForm((prev) => ({ ...prev, color: e.target.value }))}
                      onBlur={(e) => setAccountForm((prev) => ({ ...prev, color: normalizeHexColor(e.target.value) }))}
                      className="w-full font-mono text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-kumo-subtle">密钥 (Base32)</label>
                  <div className="relative">
                    <Input size="sm"
                      aria-label="TOTP 密钥"
                      type="text"
                      placeholder="JBSWY3DPEHPK3PXP"
                      disabled={accountModalMode === 'edit'}
                      value={accountForm.secret}
                      onChange={(e) => setAccountForm((prev) => ({ ...prev, secret: e.target.value }))}
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      data-bwignore="true"
                      data-form-type="other"
                      spellCheck={false}
                      className="w-full pr-16 disabled:opacity-60"
                    />
                    <Button
                      type="button" size="sm"
                      variant="ghost"
                      aria-label={totpShowSecret ? '隐藏密钥' : '显示密钥'}
                      onClick={toggleSecretVisibility}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-kumo-subtle hover:text-kumo-strong"
                    >
                      {totpShowSecret ? '隐藏' : '显示'}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-kumo-subtle">关联分组</label>
                  <Select size="sm"
                    aria-label="关联分组"
                    value={accountForm.group_id}
                    onValueChange={(value) => setAccountForm((prev) => ({ ...prev, group_id: String(value) }))}
                    placeholder="无分组"
                    className="w-full"
                    items={[
                      { value: '', label: '无分组' },
                      ...totpGroups.map((g) => ({ value: String(g.id), label: g.name })),
                    ]}
                  />
                </div>

                {/* Advanced parameters */}
                <details className="text-xs text-kumo-subtle cursor-pointer select-none">
                  <summary className="font-semibold text-kumo-strong hover:text-kumo-brand py-1">
                    高级设置选项
                  </summary>
                  <div className="pt-3 grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <label className="font-semibold">加密算法</label>
                      <Select
                        aria-label="加密算法" size="sm"
                        value={accountForm.algorithm}
                        onValueChange={(value) => setAccountForm((prev) => ({ ...prev, algorithm: String(value) }))}
                        className="w-full"
                        items={[
                          { value: 'SHA1', label: 'SHA1' },
                          { value: 'SHA256', label: 'SHA256' },
                          { value: 'SHA512', label: 'SHA512' },
                        ]}
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="font-semibold">码位长度</label>
                      <Select
                        aria-label="码位长度" size="sm"
                        value={accountForm.digits}
                        onValueChange={(value) => setAccountForm((prev) => ({ ...prev, digits: String(value) }))}
                        className="w-full"
                        items={[
                          { value: '6', label: '6 位' },
                          { value: '8', label: '8 位' },
                        ]}
                      />
                    </div>

                    {accountForm.otp_type === 'totp' ? (
                      <div className="space-y-1">
                        <label className="font-semibold">周期数 (s)</label>
                        <Select
                          aria-label="周期数" size="sm"
                          value={accountForm.period}
                          onValueChange={(value) => setAccountForm((prev) => ({ ...prev, period: String(value) }))}
                          className="w-full"
                          items={[
                            { value: '30', label: '30 秒' },
                            { value: '60', label: '60 秒' },
                          ]}
                        />
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <label className="font-semibold">计数起始</label>
                        <Input size="sm"
                          aria-label="计数起始"
                          type="number"
                          value={accountForm.counter}
                          onChange={(e) => setAccountForm((prev) => ({ ...prev, counter: e.target.value }))}
                          className="w-full font-mono"
                        />
                      </div>
                    )}

                  </div>
                </details>
              </div>
            )}
          </div>

          {accountModalError && (
            <div className="mt-4 p-3 bg-kumo-danger/10 border border-kumo-danger/20 text-kumo-danger text-xs rounded-md">
              {accountModalError}
            </div>
          )}

          <div className="flex justify-end gap-3 mt-6">
            <Dialog.Close
              render={(props) => (
                <Button size="sm"
                  {...props}
                  variant="secondary"
                  onClick={(event) => {
                    props.onClick?.(event);
                    stopQrScan();
                  }}
                >
                  取消
                </Button>
              )}
            />

            {accountModalMode === 'add' && accountAddTab === 'scan' ? (
              <Button size="sm"
                variant="primary"
                onClick={() => importUrisDirectly(importUris)}
                disabled={!importUris.trim()}
              >
                执行导入
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={handleSaveAccount} loading={accountModalSaving}>
                保存账号
              </Button>
            )}
          </div>
        </Dialog>
      </Dialog.Root>

      {/* ==================== 模态框: 品牌图标样式选择 ==================== */}
      <Dialog.Root open={showBrandStyleModal} onOpenChange={setShowBrandStyleModal}>
        <Dialog className="!w-[min(42rem,calc(100vw-2rem))] !max-w-[min(42rem,calc(100vw-2rem))] p-5">
          <Dialog.Title className="text-base font-bold text-kumo-strong mb-1">
            选择品牌标识样式
          </Dialog.Title>
          <Dialog.Description className="text-xs text-kumo-subtle mb-3">
            可直接选择系统样式，也可以上传自定义图标。保存账号后会同步到同发行商账号。
          </Dialog.Description>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] text-kumo-subtle">
              支持 `SVG / PNG / JPG / WebP / GIF`，也可直接粘贴图片、SVG 源码或 http(s) 图片链接。
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={brandUploadInputRef}
                type="file"
                accept=".svg,image/svg+xml,image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={handleCustomBrandIconUpload}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => brandUploadInputRef.current?.click()}
                loading={customBrandIconUploading}
              >
                <Upload className="w-3.5 h-3.5" />
                上传自定义图标
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={handlePasteBrandIconFromClipboard}
                loading={customBrandIconUploading}
              >
                粘贴图标
              </Button>
              <LinkButton
                size="sm"
                variant="secondary"
                href="https://www.svgrepo.com/"
                target="_blank"
                rel="noreferrer"
              >
                打开 SVG Repo
              </LinkButton>
            </div>
          </div>

          <div
            tabIndex={0}
            onPaste={handleBrandLibraryPaste}
            className="mb-3 rounded-md border border-dashed border-kumo-line bg-kumo-recessed/15 px-3 py-2.5 text-[11px] text-kumo-subtle outline-none transition-colors focus:border-kumo-brand focus:ring-2 focus:ring-kumo-brand/20"
          >
            选中这里后按 `Ctrl+V`，可以直接粘贴截图、图标文件、SVG 源码或图片链接，并自动下载应用。
          </div>

          <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2 md:grid-cols-3">
            {!customBrandIconsLoading && brandStyleOptions.length === 0 && (
              <div className="col-span-full rounded-md border border-kumo-line bg-kumo-recessed/20 px-3 py-6 text-center text-xs text-kumo-subtle">
                当前还没有可选图标。
              </div>
            )}
            {brandStyleOptions.map((option) => (
              <Button
                key={option.id}
                type="button"
                variant="secondary"
                onClick={() => applyBrandStyleOption(option)}
                className="!h-auto min-w-0 w-full self-start px-3 py-2 text-left"
              >
                <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
                  <TotpBrandMark
                    issuer={accountForm.issuer}
                    icon={option.icon}
                    color={option.color || resolveFormColor(accountForm)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-kumo-strong">{option.label}</span>
                    <span className="block truncate text-[11px] text-kumo-subtle">{option.caption}</span>
                  </span>
                </span>
              </Button>
            ))}
          </div>

          <div className="flex justify-end gap-3 mt-4">
            <Dialog.Close
              render={(props) => (
                <Button size="sm" {...props} variant="secondary">
                  取消
                </Button>
              )}
            />
          </div>
        </Dialog>
      </Dialog.Root>

      {/* ==================== 模态框 2: 新建/编辑分组 ==================== */}
      <Dialog.Root open={showGroupModal} onOpenChange={setShowGroupModal}>
        <Dialog className="!w-[min(32rem,calc(100vw-2rem))] !max-w-[min(32rem,calc(100vw-2rem))] p-6">
          <Dialog.Title className="text-base font-bold text-kumo-strong mb-1">
            {groupModalMode === 'add' ? '创建新分组' : '编辑分组属性'}
          </Dialog.Title>
          <Dialog.Description className="text-xs text-kumo-subtle mb-4">
            设置分组的名称与卡片主题色值
          </Dialog.Description>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-kumo-subtle">分组名称</label>
              <Input size="sm"
                aria-label="分组名称"
                type="text"
                placeholder="如: 财务, 工作, 个人"
                value={groupForm.name}
                onChange={(e) => setGroupForm((prev) => ({ ...prev, name: e.target.value }))}
                className="w-full"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-kumo-subtle">卡片标识色值</label>
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
                <span
                  className="h-7 w-7 rounded-md border border-kumo-line"
                  style={{ background: HEX_COLOR_PATTERN.test(normalizeHexColor(groupForm.color)) ? normalizeHexColor(groupForm.color) : BRAND_COLOR_FALLBACK }}
                  aria-hidden="true"
                />
                <Input size="sm"
                  aria-label="卡片标识色值"
                  type="text"
                  inputMode="text"
                  placeholder="#4285f4"
                  value={groupForm.color}
                  onChange={(e) => setGroupForm((prev) => ({ ...prev, color: e.target.value }))}
                  onBlur={(e) => setGroupForm((prev) => ({ ...prev, color: normalizeHexColor(e.target.value) || BRAND_COLOR_FALLBACK }))}
                  className="w-full font-mono text-xs"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <Dialog.Close
              render={(props) => (
                <Button size="sm" {...props} variant="secondary">
                  取消
                </Button>
              )}
            />
            <Button size="sm" variant="primary" onClick={handleSaveGroup}>
              保存分组
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>

      {/* ==================== 模态框 3: 备份导出账号 ==================== */}
      <Dialog.Root open={showExportModal} onOpenChange={setShowExportModal}>
        <Dialog className="!w-[min(40rem,calc(100vw-2rem))] !max-w-[min(40rem,calc(100vw-2rem))] p-6">
          <Dialog.Title className="text-base font-bold text-kumo-strong mb-1">
            备份与导出
          </Dialog.Title>
          <Dialog.Description className="text-xs text-kumo-subtle mb-4">
            已生成默认加密备份，可用于迁移或恢复 2FA 账号。
          </Dialog.Description>

          <div className="space-y-1.5">
            <Textarea
              aria-label="导出的加密 2FA 备份"
              readOnly
              rows={8}
              value={exportUris}
              className="w-full text-kumo-strong text-xs px-3 py-2 font-mono"
            />
            <span className="text-[10px] text-kumo-subtle block">
              {exportMeta?.accountCount !== undefined
                ? `已加密 ${exportMeta.accountCount} 个账号和 ${exportMeta.groupCount || 0} 个分组。`
                : '当前内容可能是显式请求的明文 URI，请谨慎保管。'}
            </span>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <Dialog.Close
              render={(props) => (
                <Button size="sm" {...props} variant="secondary">
                  关闭
                </Button>
              )}
            />
            <Button size="sm" variant="primary" onClick={copyExportedUris}>
              复制到剪贴板
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}

export default TotpPage;
