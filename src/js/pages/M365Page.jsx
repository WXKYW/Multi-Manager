import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input, Textarea } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { Table } from '@cloudflare/kumo/components/table';
import { Loader, SkeletonLine } from '@cloudflare/kumo/components/loader';
import { Tabs } from '@cloudflare/kumo';
import { dialog } from '../modules/dialog.js';
import { toast } from '../modules/toast.js';
import { MODULE_TABS_PROPS } from '../modules/kumoTabs.js';
import {
  AppCard,
  EmptyState,
  PageStack,
  PageToolbar,
  SectionCard,
  StatusBadge,
} from '../components/ui/AppPrimitives.jsx';
import {
  Activity,
  Cloud,
  Database,
  Folder,
  Globe,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash,
  User,
  Users,
} from '../components/Icons.jsx';
import { formatDateTime, formatFileSize } from '../modules/utils.js';

const REPORT_TABS = [
  { value: 'office-activity', label: 'Office 活跃' },
  { value: 'm365-apps', label: 'M365 Apps' },
  { value: 'onedrive-usage', label: 'OneDrive' },
  { value: 'mailbox-usage', label: '邮箱' },
];

const REPORT_PERIODS = [
  { value: 'D7', label: '7 天' },
  { value: 'D30', label: '30 天' },
  { value: 'D90', label: '90 天' },
  { value: 'D180', label: '180 天' },
];

const defaultAccountForm = {
  name: '',
  tenantId: '',
  clientId: '',
  clientSecret: '',
  description: '',
  enabled: true,
};

const defaultUserForm = {
  displayName: '',
  mailNickname: '',
  userPrincipalName: '',
  password: '',
  department: '',
  jobTitle: '',
  officeLocation: '',
  usageLocation: '',
  accountEnabled: true,
  forceChangePasswordNextSignIn: true,
};

const defaultGroupForm = {
  displayName: '',
  mailNickname: '',
  securityEnabled: true,
  mailEnabled: false,
};

const getAuthHeaders = () => ({
  'Content-Type': 'application/json',
  'x-admin-password': localStorage.getItem('admin_password') || '',
});

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || '请求失败');
  }
  return payload.data ?? payload;
}

function M365Page() {
  const [activeTab, setActiveTab] = useState('tenants');
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [verifyingAccountId, setVerifyingAccountId] = useState('');
  const [showAccountDialog, setShowAccountDialog] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [accountForm, setAccountForm] = useState(defaultAccountForm);
  const [submittingAccount, setSubmittingAccount] = useState(false);

  const [userSearch, setUserSearch] = useState('');
  const [usersLoading, setUsersLoading] = useState(false);
  const [users, setUsers] = useState([]);
  const [showUserDialog, setShowUserDialog] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState(defaultUserForm);
  const [submittingUser, setSubmittingUser] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedUserDetails, setSelectedUserDetails] = useState(null);
  const [showUserDetails, setShowUserDetails] = useState(false);

  const [skuLoading, setSkuLoading] = useState(false);
  const [skus, setSkus] = useState([]);
  const [selectedSkuId, setSelectedSkuId] = useState('');
  const [selectedUserLicenses, setSelectedUserLicenses] = useState([]);
  const [assigningLicense, setAssigningLicense] = useState(false);

  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groups, setGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [groupMembers, setGroupMembers] = useState([]);
  const [groupMembersLoading, setGroupMembersLoading] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [groupForm, setGroupForm] = useState(defaultGroupForm);
  const [submittingGroup, setSubmittingGroup] = useState(false);
  const [memberInput, setMemberInput] = useState('');
  const [groupLicenseSkuId, setGroupLicenseSkuId] = useState('');
  const [assigningGroupLicense, setAssigningGroupLicense] = useState(false);

  const [reportType, setReportType] = useState('office-activity');
  const [reportPeriod, setReportPeriod] = useState('D7');
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportData, setReportData] = useState({ summary: {}, rows: [], cachedAt: null });
  const [quotaLoadingId, setQuotaLoadingId] = useState('');
  const [quotaDetail, setQuotaDetail] = useState(null);

  const selectedAccount = useMemo(
    () => accounts.find((account) => String(account.id) === String(selectedAccountId)) || null,
    [accounts, selectedAccountId]
  );

  const accountSelectItems = useMemo(
    () => accounts.map((account) => ({ value: String(account.id), label: account.name })),
    [accounts]
  );

  const skuItems = useMemo(
    () => skus.map((sku) => ({ value: sku.skuId, label: sku.skuPartNumber || sku.skuId })),
    [skus]
  );

  const selectedGroup = useMemo(
    () => groups.find((group) => String(group.id) === String(selectedGroupId)) || null,
    [groups, selectedGroupId]
  );

  const requestJSON = useCallback(async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...getAuthHeaders(),
        ...(options.headers || {}),
      },
    });
    return parseResponse(response);
  }, []);

  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const data = await requestJSON('/api/m365/accounts');
      const items = Array.isArray(data.items) ? data.items : [];
      setAccounts(items);
      setSelectedAccountId((current) => {
        if (current && items.some((item) => String(item.id) === String(current))) {
          return current;
        }
        return items[0] ? String(items[0].id) : '';
      });
    } catch (error) {
      toast.error(error.message || '加载租户失败');
    } finally {
      setLoadingAccounts(false);
    }
  }, [requestJSON]);

  const loadUsers = useCallback(async () => {
    if (!selectedAccountId) {
      setUsers([]);
      return;
    }
    setUsersLoading(true);
    try {
      const query = new URLSearchParams({ top: '50' });
      if (userSearch.trim()) query.set('search', userSearch.trim());
      const data = await requestJSON(`/api/m365/accounts/${selectedAccountId}/users?${query.toString()}`);
      setUsers(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      toast.error(error.message || '加载用户失败');
    } finally {
      setUsersLoading(false);
    }
  }, [requestJSON, selectedAccountId, userSearch]);

  const loadSkus = useCallback(async () => {
    if (!selectedAccountId) {
      setSkus([]);
      return;
    }
    setSkuLoading(true);
    try {
      const data = await requestJSON(`/api/m365/accounts/${selectedAccountId}/licenses/skus`);
      const items = Array.isArray(data.items) ? data.items : [];
      setSkus(items);
      setSelectedSkuId((current) => current || items[0]?.skuId || '');
      setGroupLicenseSkuId((current) => current || items[0]?.skuId || '');
    } catch (error) {
      toast.error(error.message || '加载许可证失败');
    } finally {
      setSkuLoading(false);
    }
  }, [requestJSON, selectedAccountId]);

  const loadGroups = useCallback(async () => {
    if (!selectedAccountId) {
      setGroups([]);
      return;
    }
    setGroupsLoading(true);
    try {
      const data = await requestJSON(`/api/m365/accounts/${selectedAccountId}/groups?top=100`);
      const items = Array.isArray(data.items) ? data.items : [];
      setGroups(items);
      setSelectedGroupId((current) => {
        if (current && items.some((item) => String(item.id) === String(current))) {
          return current;
        }
        return items[0] ? String(items[0].id) : '';
      });
    } catch (error) {
      toast.error(error.message || '加载组失败');
    } finally {
      setGroupsLoading(false);
    }
  }, [requestJSON, selectedAccountId]);

  const loadGroupMembers = useCallback(async () => {
    if (!selectedAccountId || !selectedGroupId) {
      setGroupMembers([]);
      return;
    }
    setGroupMembersLoading(true);
    try {
      const data = await requestJSON(`/api/m365/accounts/${selectedAccountId}/groups/${selectedGroupId}/members`);
      setGroupMembers(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      toast.error(error.message || '加载组成员失败');
    } finally {
      setGroupMembersLoading(false);
    }
  }, [requestJSON, selectedAccountId, selectedGroupId]);

  const loadUserLicenseDetails = useCallback(async (userId) => {
    if (!selectedAccountId || !userId) {
      setSelectedUserLicenses([]);
      return;
    }
    try {
      const data = await requestJSON(`/api/m365/accounts/${selectedAccountId}/users/${userId}/license-details`);
      setSelectedUserLicenses(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      toast.error(error.message || '加载用户许可证失败');
    }
  }, [requestJSON, selectedAccountId]);

  const loadUserDetails = useCallback(async (userId) => {
    if (!selectedAccountId || !userId) return;
    try {
      const [details] = await Promise.all([
        requestJSON(`/api/m365/accounts/${selectedAccountId}/users/${userId}`),
        loadUserLicenseDetails(userId),
      ]);
      setSelectedUserId(userId);
      setSelectedUserDetails(details);
      setShowUserDetails(true);
    } catch (error) {
      toast.error(error.message || '加载用户详情失败');
    }
  }, [loadUserLicenseDetails, requestJSON, selectedAccountId]);

  const loadReports = useCallback(async (refresh = false) => {
    if (!selectedAccountId) {
      setReportData({ summary: {}, rows: [], cachedAt: null });
      return;
    }
    setReportsLoading(true);
    try {
      const query = new URLSearchParams({ period: reportPeriod });
      if (refresh) query.set('refresh', '1');
      const data = await requestJSON(`/api/m365/accounts/${selectedAccountId}/reports/${reportType}?${query.toString()}`);
      setReportData({
        summary: data.summary || {},
        rows: Array.isArray(data.rows) ? data.rows : [],
        cachedAt: data.cachedAt || null,
      });
    } catch (error) {
      toast.error(error.message || '加载报表失败');
    } finally {
      setReportsLoading(false);
    }
  }, [reportPeriod, reportType, requestJSON, selectedAccountId]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    if (activeTab === 'users') loadUsers();
    if (activeTab === 'licenses') {
      loadUsers();
      loadSkus();
    }
    if (activeTab === 'groups') {
      loadGroups();
      loadSkus();
    }
    if (activeTab === 'reports') loadReports();
  }, [activeTab, loadGroups, loadReports, loadSkus, loadUsers]);

  useEffect(() => {
    if (activeTab === 'groups') {
      loadGroupMembers();
    }
  }, [activeTab, loadGroupMembers, selectedGroupId]);

  useEffect(() => {
    if (activeTab === 'licenses' && selectedUserId) {
      loadUserLicenseDetails(selectedUserId);
    }
  }, [activeTab, loadUserLicenseDetails, selectedUserId]);

  const openCreateAccount = () => {
    setEditingAccount(null);
    setAccountForm(defaultAccountForm);
    setShowAccountDialog(true);
  };

  const openEditAccount = (account) => {
    setEditingAccount(account);
    setAccountForm({
      name: account.name || '',
      tenantId: account.tenantId || '',
      clientId: account.clientId || '',
      clientSecret: '',
      description: account.description || '',
      enabled: account.enabled !== false,
    });
    setShowAccountDialog(true);
  };

  const submitAccount = async () => {
    if (!accountForm.name || !accountForm.tenantId || !accountForm.clientId || (!editingAccount && !accountForm.clientSecret)) {
      toast.warning('请填写完整租户凭据');
      return;
    }
    setSubmittingAccount(true);
    try {
      const target = editingAccount ? `/api/m365/accounts/${editingAccount.id}` : '/api/m365/accounts';
      const method = editingAccount ? 'PUT' : 'POST';
      await requestJSON(target, {
        method,
        body: JSON.stringify(accountForm),
      });
      toast.success(editingAccount ? '租户已更新' : '租户已创建');
      setShowAccountDialog(false);
      await loadAccounts();
    } catch (error) {
      toast.error(error.message || '保存租户失败');
    } finally {
      setSubmittingAccount(false);
    }
  };

  const deleteAccount = async (account) => {
    const confirmed = await dialog.deleteResource({
      resourceType: '租户',
      resourceName: account.name,
      message: `删除租户“${account.name}”后，其本地缓存与配置将一并移除。`,
    });
    if (!confirmed) return;
    try {
      await requestJSON(`/api/m365/accounts/${account.id}`, { method: 'DELETE' });
      toast.success('租户已删除');
      await loadAccounts();
    } catch (error) {
      toast.error(error.message || '删除租户失败');
    }
  };

  const verifyAccount = async (account) => {
    setVerifyingAccountId(String(account.id));
    try {
      const data = await requestJSON(`/api/m365/accounts/${account.id}/verify`, { method: 'POST' });
      toast.success(`已连接 ${data.organization?.displayName || account.name}`);
      await loadAccounts();
    } catch (error) {
      toast.error(error.message || '校验租户失败');
    } finally {
      setVerifyingAccountId('');
    }
  };

  const openCreateUser = () => {
    setEditingUser(null);
    setUserForm(defaultUserForm);
    setShowUserDialog(true);
  };

  const openEditUser = (user) => {
    setEditingUser(user);
    setUserForm({
      displayName: user.displayName || '',
      mailNickname: user.mailNickname || '',
      userPrincipalName: user.userPrincipalName || '',
      password: '',
      department: user.department || '',
      jobTitle: user.jobTitle || '',
      officeLocation: user.officeLocation || '',
      usageLocation: user.usageLocation || '',
      accountEnabled: user.accountEnabled !== false,
      forceChangePasswordNextSignIn: true,
    });
    setShowUserDialog(true);
  };

  const submitUser = async () => {
    if (!selectedAccountId) return;
    setSubmittingUser(true);
    try {
      if (editingUser) {
        await requestJSON(`/api/m365/accounts/${selectedAccountId}/users/${editingUser.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            displayName: userForm.displayName,
            department: userForm.department,
            jobTitle: userForm.jobTitle,
            officeLocation: userForm.officeLocation,
            usageLocation: userForm.usageLocation,
            accountEnabled: userForm.accountEnabled,
          }),
        });
        toast.success('用户已更新');
      } else {
        await requestJSON(`/api/m365/accounts/${selectedAccountId}/users`, {
          method: 'POST',
          body: JSON.stringify(userForm),
        });
        toast.success('用户已创建');
      }
      setShowUserDialog(false);
      await loadUsers();
    } catch (error) {
      toast.error(error.message || '保存用户失败');
    } finally {
      setSubmittingUser(false);
    }
  };

  const deleteUser = async (user) => {
    const confirmed = await dialog.deleteResource({
      resourceType: '用户',
      resourceName: user.userPrincipalName || user.displayName,
      message: `删除用户“${user.displayName || user.userPrincipalName}”将调用 Microsoft Graph 删除该用户。`,
    });
    if (!confirmed) return;
    try {
      await requestJSON(`/api/m365/accounts/${selectedAccountId}/users/${user.id}`, { method: 'DELETE' });
      toast.success('用户已删除');
      if (selectedUserId === user.id) {
        setSelectedUserId('');
        setSelectedUserDetails(null);
      }
      await loadUsers();
    } catch (error) {
      toast.error(error.message || '删除用户失败');
    }
  };

  const assignLicense = async () => {
    if (!selectedAccountId || !selectedUserId || !selectedSkuId) {
      toast.warning('请选择用户和 SKU');
      return;
    }
    setAssigningLicense(true);
    try {
      await requestJSON(`/api/m365/accounts/${selectedAccountId}/users/${selectedUserId}/assign-license`, {
        method: 'POST',
        body: JSON.stringify({ addLicenses: [{ skuId: selectedSkuId }], removeLicenses: [] }),
      });
      toast.success('许可证已分配');
      await loadUserLicenseDetails(selectedUserId);
      await loadSkus();
    } catch (error) {
      toast.error(error.message || '分配许可证失败');
    } finally {
      setAssigningLicense(false);
    }
  };

  const removeLicense = async (skuId) => {
    if (!selectedAccountId || !selectedUserId || !skuId) return;
    setAssigningLicense(true);
    try {
      await requestJSON(`/api/m365/accounts/${selectedAccountId}/users/${selectedUserId}/assign-license`, {
        method: 'POST',
        body: JSON.stringify({ addLicenses: [], removeLicenses: [skuId] }),
      });
      toast.success('许可证已回收');
      await loadUserLicenseDetails(selectedUserId);
      await loadSkus();
    } catch (error) {
      toast.error(error.message || '回收许可证失败');
    } finally {
      setAssigningLicense(false);
    }
  };

  const submitGroup = async () => {
    if (!selectedAccountId || !groupForm.displayName || !groupForm.mailNickname) {
      toast.warning('请填写组名称和别名');
      return;
    }
    setSubmittingGroup(true);
    try {
      await requestJSON(`/api/m365/accounts/${selectedAccountId}/groups`, {
        method: 'POST',
        body: JSON.stringify(groupForm),
      });
      toast.success('组已创建');
      setShowGroupDialog(false);
      setGroupForm(defaultGroupForm);
      await loadGroups();
    } catch (error) {
      toast.error(error.message || '创建组失败');
    } finally {
      setSubmittingGroup(false);
    }
  };

  const addGroupMember = async () => {
    if (!selectedAccountId || !selectedGroupId || !memberInput.trim()) {
      toast.warning('请输入成员 ID');
      return;
    }
    try {
      await requestJSON(`/api/m365/accounts/${selectedAccountId}/groups/${selectedGroupId}/members/${encodeURIComponent(memberInput.trim())}`, {
        method: 'POST',
      });
      toast.success('组成员已添加');
      setMemberInput('');
      await loadGroupMembers();
    } catch (error) {
      toast.error(error.message || '添加组成员失败');
    }
  };

  const removeGroupMember = async (member) => {
    const confirmed = await dialog.deleteResource({
      resourceType: '组成员',
      resourceName: member.userPrincipalName || member.displayName,
      message: `确定将成员“${member.displayName || member.userPrincipalName}”从组中移除吗？`,
      confirmText: '移除',
    });
    if (!confirmed) return;
    try {
      await requestJSON(`/api/m365/accounts/${selectedAccountId}/groups/${selectedGroupId}/members/${member.id}`, {
        method: 'DELETE',
      });
      toast.success('成员已移除');
      await loadGroupMembers();
    } catch (error) {
      toast.error(error.message || '移除成员失败');
    }
  };

  const assignGroupLicense = async () => {
    if (!selectedAccountId || !selectedGroupId || !groupLicenseSkuId) {
      toast.warning('请选择组和 SKU');
      return;
    }
    setAssigningGroupLicense(true);
    try {
      await requestJSON(`/api/m365/accounts/${selectedAccountId}/groups/${selectedGroupId}/assign-license`, {
        method: 'POST',
        body: JSON.stringify({ addLicenses: [{ skuId: groupLicenseSkuId }], removeLicenses: [] }),
      });
      toast.success('组许可证已分配');
    } catch (error) {
      toast.error(error.message || '组许可证分配失败');
    } finally {
      setAssigningGroupLicense(false);
    }
  };

  const loadQuota = async (userId) => {
    if (!selectedAccountId || !userId) return;
    setQuotaLoadingId(userId);
    try {
      const data = await requestJSON(`/api/m365/accounts/${selectedAccountId}/reports/onedrive/users/${encodeURIComponent(userId)}/quota`);
      setQuotaDetail(data);
    } catch (error) {
      toast.error(error.message || '加载 OneDrive 配额失败');
    } finally {
      setQuotaLoadingId('');
    }
  };

  const renderToolbarSelector = activeTab !== 'tenants' ? (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-kumo-subtle">租户</span>
      <Select
        aria-label="Microsoft 365 租户"
        size="sm"
        value={selectedAccountId}
        onValueChange={setSelectedAccountId}
        items={accountSelectItems}
      />
    </div>
  ) : null;

  const renderTenants = () => (
    <SectionCard
      title="租户管理"
      description="管理多个 Microsoft 365 / Entra 租户的应用凭据与连通性。"
      icon={<Cloud className="h-4 w-4" />}
      action={(
        <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreateAccount}>
          新增租户
        </Button>
      )}
    >
      {loadingAccounts ? (
        <div className="space-y-3">
          <SkeletonLine className="h-10 w-full" />
          <SkeletonLine className="h-10 w-full" />
          <SkeletonLine className="h-10 w-full" />
        </div>
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={Cloud}
          title="还没有租户"
          description="先添加 tenant_id、client_id 和 client_secret，后续功能都会基于租户展开。"
          action={<Button size="sm" variant="primary" onClick={openCreateAccount}>添加租户</Button>}
        />
      ) : (
        <div className="overflow-x-auto">
          <Table layout="fixed">
            <Table.Header>
              <Table.Row>
                <Table.Head>名称</Table.Head>
                <Table.Head>租户 ID</Table.Head>
                <Table.Head>客户端 ID</Table.Head>
                <Table.Head>默认域</Table.Head>
                <Table.Head>状态</Table.Head>
                <Table.Head className="text-right">操作</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {accounts.map((account) => (
                <Table.Row key={account.id}>
                  <Table.Cell>
                    <div className="font-medium text-kumo-strong">{account.name}</div>
                    <div className="text-xs text-kumo-subtle">{account.organization || '未校验组织'}</div>
                  </Table.Cell>
                  <Table.Cell className="text-xs text-kumo-subtle">{account.tenantId}</Table.Cell>
                  <Table.Cell className="text-xs text-kumo-subtle">{account.clientId}</Table.Cell>
                  <Table.Cell>{account.defaultDomain || '-'}</Table.Cell>
                  <Table.Cell>
                    <StatusBadge tone={account.lastVerifiedErr ? 'danger' : 'success'}>
                      {account.lastVerifiedErr ? '待修复' : '已连通'}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        shape="square"
                        title="校验"
                        aria-label="校验"
                        icon={<RefreshCw className={`h-3.5 w-3.5 ${verifyingAccountId === String(account.id) ? 'animate-spin' : ''}`} />}
                        onClick={() => verifyAccount(account)}
                      />
                      <Button size="sm" variant="secondary" onClick={() => openEditAccount(account)}>编辑</Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        shape="square"
                        title="删除"
                        aria-label="删除"
                        icon={<Trash className="h-3.5 w-3.5" />}
                        onClick={() => deleteAccount(account)}
                      />
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </SectionCard>
  );

  const renderUsers = () => (
    <SectionCard
      title="用户管理"
      description="查看、创建、编辑并删除租户中的工作账号。"
      icon={<Users className="h-4 w-4" />}
      action={(
        <div className="flex items-center gap-2">
          <Input
            aria-label="搜索用户"
            size="sm"
            value={userSearch}
            onChange={(event) => setUserSearch(event.target.value)}
            placeholder="搜索显示名或 UPN"
          />
          <Button size="sm" variant="secondary" shape="square" icon={<Search className="h-3.5 w-3.5" />} onClick={loadUsers} aria-label="搜索" />
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreateUser}>新增用户</Button>
        </div>
      )}
    >
      {!selectedAccountId ? (
        <EmptyState icon={Users} title="请先选择租户" description="用户管理依赖租户凭据与 Graph 连接。" />
      ) : usersLoading ? (
        <div className="space-y-3">
          <SkeletonLine className="h-10 w-full" />
          <SkeletonLine className="h-10 w-full" />
          <SkeletonLine className="h-10 w-full" />
        </div>
      ) : users.length === 0 ? (
        <EmptyState icon={User} title="暂无用户" description="当前筛选条件下没有可展示的用户。" />
      ) : (
        <div className="overflow-x-auto">
          <Table layout="fixed">
            <Table.Header>
              <Table.Row>
                <Table.Head>用户</Table.Head>
                <Table.Head>邮箱</Table.Head>
                <Table.Head>部门</Table.Head>
                <Table.Head>位置</Table.Head>
                <Table.Head>状态</Table.Head>
                <Table.Head className="text-right">操作</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {users.map((user) => (
                <Table.Row key={user.id}>
                  <Table.Cell>
                    <div className="font-medium text-kumo-strong">{user.displayName || '-'}</div>
                    <div className="text-xs text-kumo-subtle">{user.userPrincipalName || '-'}</div>
                  </Table.Cell>
                  <Table.Cell>{user.mail || '-'}</Table.Cell>
                  <Table.Cell>{user.department || '-'}</Table.Cell>
                  <Table.Cell>{user.officeLocation || user.usageLocation || '-'}</Table.Cell>
                  <Table.Cell>
                    <StatusBadge tone={user.accountEnabled === false ? 'danger' : 'success'}>
                      {user.accountEnabled === false ? '禁用' : '启用'}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => loadUserDetails(user.id)}>详情</Button>
                      <Button size="sm" variant="secondary" onClick={() => openEditUser(user)}>编辑</Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        shape="square"
                        title="删除"
                        aria-label="删除"
                        icon={<Trash className="h-3.5 w-3.5" />}
                        onClick={() => deleteUser(user)}
                      />
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </SectionCard>
  );

  const renderLicenses = () => (
    <PageStack>
      <SectionCard
        title="SKU 库存"
        description="查看租户可分配的许可证 SKU 及其消耗情况。"
        icon={<Database className="h-4 w-4" />}
        action={(
          <Button size="sm" variant="secondary" icon={<RefreshCw className={`h-3.5 w-3.5 ${skuLoading ? 'animate-spin' : ''}`} />} onClick={loadSkus}>
            刷新
          </Button>
        )}
      >
        {!selectedAccountId ? (
          <EmptyState icon={Database} title="请先选择租户" description="许可证列表依赖租户范围。" />
        ) : skuLoading ? (
          <Loader />
        ) : (
          <div className="overflow-x-auto">
            <Table layout="fixed">
              <Table.Header>
                <Table.Row>
                  <Table.Head>SKU</Table.Head>
                  <Table.Head>已用</Table.Head>
                  <Table.Head>预付总量</Table.Head>
                  <Table.Head>警告量</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {skus.map((sku) => (
                  <Table.Row key={sku.skuId}>
                    <Table.Cell>{sku.skuPartNumber || sku.skuId}</Table.Cell>
                    <Table.Cell>{sku.consumedUnits ?? 0}</Table.Cell>
                    <Table.Cell>{sku.prepaidUnits?.enabled ?? 0}</Table.Cell>
                    <Table.Cell>{sku.prepaidUnits?.warning ?? 0}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="用户许可证"
        description="给当前选中用户分配或回收直绑许可证。"
        icon={<User className="h-4 w-4" />}
        action={(
          <div className="flex items-center gap-2">
            <Select
              aria-label="选择用户"
              size="sm"
              value={selectedUserId}
              onValueChange={setSelectedUserId}
              items={users.map((user) => ({ value: user.id, label: user.displayName || user.userPrincipalName || user.id }))}
            />
            <Select
              aria-label="选择 SKU"
              size="sm"
              value={selectedSkuId}
              onValueChange={setSelectedSkuId}
              items={skuItems}
            />
            <Button size="sm" variant="primary" onClick={assignLicense} disabled={assigningLicense}>
              分配
            </Button>
          </div>
        )}
      >
        {!selectedUserId ? (
          <EmptyState icon={User} title="请选择用户" description="先在右上角选择要管理许可证的用户。" />
        ) : selectedUserLicenses.length === 0 ? (
          <EmptyState icon={Database} title="暂无直绑许可证" description="该用户当前没有直绑许可证，或尚未加载详情。" card={false} />
        ) : (
          <div className="overflow-x-auto">
            <Table layout="fixed">
              <Table.Header>
                <Table.Row>
                  <Table.Head>SKU</Table.Head>
                  <Table.Head>服务计划数</Table.Head>
                  <Table.Head className="text-right">操作</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {selectedUserLicenses.map((license) => (
                  <Table.Row key={license.skuId}>
                    <Table.Cell>{license.skuPartNumber || license.skuId}</Table.Cell>
                    <Table.Cell>{Array.isArray(license.servicePlans) ? license.servicePlans.length : 0}</Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end">
                        <Button size="sm" variant="destructive" onClick={() => removeLicense(license.skuId)} disabled={assigningLicense}>
                          回收
                        </Button>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </SectionCard>
    </PageStack>
  );

  const renderGroups = () => (
    <PageStack>
      <SectionCard
        title="组管理"
        description="创建组、查看成员，并为组分配许可证。"
        icon={<Folder className="h-4 w-4" />}
        action={(
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" icon={<RefreshCw className={`h-3.5 w-3.5 ${groupsLoading ? 'animate-spin' : ''}`} />} onClick={loadGroups}>
              刷新
            </Button>
            <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowGroupDialog(true)}>
              新建组
            </Button>
          </div>
        )}
      >
        {!selectedAccountId ? (
          <EmptyState icon={Folder} title="请先选择租户" description="组管理依赖租户上下文。" />
        ) : groupsLoading ? (
          <Loader />
        ) : groups.length === 0 ? (
          <EmptyState icon={Folder} title="暂无组" description="可以先创建安全组或 Microsoft 365 组。" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <AppCard padding="none" className="overflow-hidden">
              <Table layout="fixed">
                <Table.Header>
                  <Table.Row>
                    <Table.Head>组</Table.Head>
                    <Table.Head>邮件</Table.Head>
                    <Table.Head>类型</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {groups.map((group) => (
                    <Table.Row
                      key={group.id}
                      className={String(group.id) === String(selectedGroupId) ? 'bg-kumo-brand/5' : ''}
                      onClick={() => setSelectedGroupId(String(group.id))}
                    >
                      <Table.Cell>
                        <div className="font-medium text-kumo-strong">{group.displayName || '-'}</div>
                        <div className="text-xs text-kumo-subtle">{group.id}</div>
                      </Table.Cell>
                      <Table.Cell>{group.mail || '-'}</Table.Cell>
                      <Table.Cell>{group.securityEnabled ? '安全组' : '协作组'}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </AppCard>

            <SectionCard
              title={selectedGroup ? selectedGroup.displayName : '组成员'}
              description="输入成员对象 ID 即可添加；移除成员会实时调用 Graph。"
              icon={<Users className="h-4 w-4" />}
              bodyPadding="sm"
              action={(
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="成员对象 ID"
                    size="sm"
                    value={memberInput}
                    onChange={(event) => setMemberInput(event.target.value)}
                    placeholder="成员对象 ID"
                  />
                  <Button size="sm" variant="secondary" onClick={addGroupMember}>添加成员</Button>
                </div>
              )}
            >
              {!selectedGroup ? (
                <EmptyState icon={Users} title="请选择一个组" description="选中左侧组后即可查看并管理成员。" card={false} />
              ) : groupMembersLoading ? (
                <Loader />
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Select
                      aria-label="组许可证 SKU"
                      size="sm"
                      value={groupLicenseSkuId}
                      onValueChange={setGroupLicenseSkuId}
                      items={skuItems}
                    />
                    <Button size="sm" variant="secondary" onClick={assignGroupLicense} disabled={assigningGroupLicense}>
                      分配组许可证
                    </Button>
                  </div>
                  <div className="overflow-x-auto">
                    <Table layout="fixed">
                      <Table.Header>
                        <Table.Row>
                          <Table.Head>成员</Table.Head>
                          <Table.Head>邮箱</Table.Head>
                          <Table.Head className="text-right">操作</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {groupMembers.map((member) => (
                          <Table.Row key={member.id}>
                            <Table.Cell>
                              <div className="font-medium text-kumo-strong">{member.displayName || '-'}</div>
                              <div className="text-xs text-kumo-subtle">{member.id}</div>
                            </Table.Cell>
                            <Table.Cell>{member.userPrincipalName || member.mail || '-'}</Table.Cell>
                            <Table.Cell>
                              <div className="flex justify-end">
                                <Button size="sm" variant="destructive" onClick={() => removeGroupMember(member)}>
                                  移除
                                </Button>
                              </div>
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table>
                  </div>
                </div>
              )}
            </SectionCard>
          </div>
        )}
      </SectionCard>
    </PageStack>
  );

  const renderReports = () => (
    <PageStack>
      <SectionCard
        title="使用情况"
        description="查看 Office、M365 Apps、OneDrive 和邮箱维度的用户使用报表。"
        icon={<Activity className="h-4 w-4" />}
        action={(
          <div className="flex items-center gap-2">
            <Select aria-label="报表周期" size="sm" value={reportPeriod} onValueChange={setReportPeriod} items={REPORT_PERIODS} />
            <Button size="sm" variant="secondary" icon={<RefreshCw className={`h-3.5 w-3.5 ${reportsLoading ? 'animate-spin' : ''}`} />} onClick={() => loadReports(true)}>
              刷新
            </Button>
          </div>
        )}
      >
        {!selectedAccountId ? (
          <EmptyState icon={Activity} title="请先选择租户" description="报表依赖租户与 Reports.Read.All 权限。" />
        ) : (
          <div className="space-y-4">
            <Tabs {...MODULE_TABS_PROPS} value={reportType} onValueChange={setReportType} tabs={REPORT_TABS} />
            <div className="grid gap-4 md:grid-cols-3">
              <AppCard>
                <div className="text-xs text-kumo-subtle">行数</div>
                <div className="mt-1 text-xl font-semibold text-kumo-strong">{reportData.summary?.count ?? 0}</div>
              </AppCard>
              <AppCard>
                <div className="text-xs text-kumo-subtle">报表周期</div>
                <div className="mt-1 text-xl font-semibold text-kumo-strong">{reportData.summary?.period || reportPeriod}</div>
              </AppCard>
              <AppCard>
                <div className="text-xs text-kumo-subtle">缓存时间</div>
                <div className="mt-1 text-sm font-medium text-kumo-strong">{reportData.cachedAt ? formatDateTime(reportData.cachedAt) : '-'}</div>
              </AppCard>
            </div>
            {reportsLoading ? (
              <Loader />
            ) : reportData.rows.length === 0 ? (
              <EmptyState icon={Activity} title="暂无报表数据" description="可能是租户暂无活跃数据，或者 Graph 权限尚未完整授权。" />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                <AppCard padding="none" className="overflow-hidden">
                  <div className="overflow-x-auto">
                    <Table layout="fixed">
                      <Table.Header>
                        <Table.Row>
                          {Object.keys(reportData.rows[0] || {}).slice(0, 5).map((column) => (
                            <Table.Head key={column}>{column}</Table.Head>
                          ))}
                          {reportType === 'onedrive-usage' && <Table.Head className="text-right">配额</Table.Head>}
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {reportData.rows.map((row, index) => {
                          const columns = Object.keys(row).slice(0, 5);
                          const userId = row['Owner Principal Name'] || row['User Principal Name'] || row['用户名'];
                          return (
                            <Table.Row key={`${userId || 'row'}-${index}`}>
                              {columns.map((column) => (
                                <Table.Cell key={column}>{row[column] || '-'}</Table.Cell>
                              ))}
                              {reportType === 'onedrive-usage' && (
                                <Table.Cell>
                                  <div className="flex justify-end">
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      onClick={() => loadQuota(userId)}
                                      disabled={!userId || quotaLoadingId === userId}
                                    >
                                      {quotaLoadingId === userId ? '加载中' : '查看'}
                                    </Button>
                                  </div>
                                </Table.Cell>
                              )}
                            </Table.Row>
                          );
                        })}
                      </Table.Body>
                    </Table>
                  </div>
                </AppCard>

                <SectionCard
                  title="OneDrive 配额"
                  description="仅在 OneDrive 报表中提供实时空间使用率。"
                  icon={<Folder className="h-4 w-4" />}
                  bodyPadding="sm"
                >
                  {!quotaDetail ? (
                    <EmptyState icon={Folder} title="选择一行 OneDrive 用户" description="点击左侧“查看”后，这里会展示总量、已用、剩余和使用率。" card={false} />
                  ) : (
                    <div className="space-y-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-kumo-subtle">总空间</span>
                        <span className="font-medium text-kumo-strong">{formatFileSize(quotaDetail.total || 0)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-kumo-subtle">已用空间</span>
                        <span className="font-medium text-kumo-strong">{formatFileSize(quotaDetail.used || 0)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-kumo-subtle">剩余空间</span>
                        <span className="font-medium text-kumo-strong">{formatFileSize(quotaDetail.remaining || 0)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-kumo-subtle">使用率</span>
                        <StatusBadge tone={(quotaDetail.usagePct || 0) >= 80 ? 'warning' : 'info'}>
                          {Number(quotaDetail.usagePct || 0).toFixed(2)}%
                        </StatusBadge>
                      </div>
                    </div>
                  )}
                </SectionCard>
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </PageStack>
  );

  return (
    <PageStack>
      <PageToolbar>
        <div className="min-w-0">
          <Tabs
            {...MODULE_TABS_PROPS}
            value={activeTab}
            onValueChange={setActiveTab}
            tabs={[
              { value: 'tenants', label: <span className="inline-flex items-center gap-1.5"><Cloud className="h-4 w-4" />租户</span> },
              { value: 'users', label: <span className="inline-flex items-center gap-1.5"><Users className="h-4 w-4" />用户</span> },
              { value: 'licenses', label: <span className="inline-flex items-center gap-1.5"><Database className="h-4 w-4" />许可证</span> },
              { value: 'groups', label: <span className="inline-flex items-center gap-1.5"><Folder className="h-4 w-4" />组</span> },
              { value: 'reports', label: <span className="inline-flex items-center gap-1.5"><Activity className="h-4 w-4" />使用情况</span> },
            ]}
          />
        </div>
        {renderToolbarSelector}
      </PageToolbar>

      {activeTab === 'tenants' && renderTenants()}
      {activeTab === 'users' && renderUsers()}
      {activeTab === 'licenses' && renderLicenses()}
      {activeTab === 'groups' && renderGroups()}
      {activeTab === 'reports' && renderReports()}

      <Dialog.Root open={showAccountDialog} onOpenChange={setShowAccountDialog}>
        <Dialog size="sm" className="p-5">
          <div className="space-y-4">
            <Dialog.Title>{editingAccount ? '编辑租户' : '新增租户'}</Dialog.Title>
            <div className="grid gap-3">
              <Input size="sm" aria-label="名称" value={accountForm.name} onChange={(event) => setAccountForm((current) => ({ ...current, name: event.target.value }))} placeholder="显示名称" />
              <Input size="sm" aria-label="租户 ID" value={accountForm.tenantId} onChange={(event) => setAccountForm((current) => ({ ...current, tenantId: event.target.value }))} placeholder="tenant_id" />
              <Input size="sm" aria-label="客户端 ID" value={accountForm.clientId} onChange={(event) => setAccountForm((current) => ({ ...current, clientId: event.target.value }))} placeholder="client_id" />
              <Input size="sm" aria-label="客户端密钥" value={accountForm.clientSecret} onChange={(event) => setAccountForm((current) => ({ ...current, clientSecret: event.target.value }))} placeholder={editingAccount ? '留空则保持原密钥' : 'client_secret'} />
              <Textarea aria-label="描述" value={accountForm.description} onChange={(event) => setAccountForm((current) => ({ ...current, description: event.target.value }))} placeholder="备注或租户说明" />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setShowAccountDialog(false)}>取消</Button>
              <Button size="sm" variant="primary" onClick={submitAccount} disabled={submittingAccount}>
                {submittingAccount ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={showUserDialog} onOpenChange={setShowUserDialog}>
        <Dialog size="sm" className="p-5">
          <div className="space-y-4">
            <Dialog.Title>{editingUser ? '编辑用户' : '新增用户'}</Dialog.Title>
            <div className="grid gap-3">
              <Input size="sm" aria-label="显示名称" value={userForm.displayName} onChange={(event) => setUserForm((current) => ({ ...current, displayName: event.target.value }))} placeholder="显示名称" />
              {!editingUser && <Input size="sm" aria-label="邮箱别名" value={userForm.mailNickname} onChange={(event) => setUserForm((current) => ({ ...current, mailNickname: event.target.value }))} placeholder="mailNickname" />}
              {!editingUser && <Input size="sm" aria-label="用户主体名" value={userForm.userPrincipalName} onChange={(event) => setUserForm((current) => ({ ...current, userPrincipalName: event.target.value }))} placeholder="user@domain.com" />}
              {!editingUser && <Input size="sm" aria-label="初始密码" value={userForm.password} onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))} placeholder="初始密码" />}
              <Input size="sm" aria-label="部门" value={userForm.department} onChange={(event) => setUserForm((current) => ({ ...current, department: event.target.value }))} placeholder="部门" />
              <Input size="sm" aria-label="职位" value={userForm.jobTitle} onChange={(event) => setUserForm((current) => ({ ...current, jobTitle: event.target.value }))} placeholder="职位" />
              <Input size="sm" aria-label="办公地点" value={userForm.officeLocation} onChange={(event) => setUserForm((current) => ({ ...current, officeLocation: event.target.value }))} placeholder="办公地点" />
              <Input size="sm" aria-label="使用地区" value={userForm.usageLocation} onChange={(event) => setUserForm((current) => ({ ...current, usageLocation: event.target.value }))} placeholder="CN / US / HK" />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setShowUserDialog(false)}>取消</Button>
              <Button size="sm" variant="primary" onClick={submitUser} disabled={submittingUser}>
                {submittingUser ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={showGroupDialog} onOpenChange={setShowGroupDialog}>
        <Dialog size="sm" className="p-5">
          <div className="space-y-4">
            <Dialog.Title>新建组</Dialog.Title>
            <div className="grid gap-3">
              <Input size="sm" aria-label="组名称" value={groupForm.displayName} onChange={(event) => setGroupForm((current) => ({ ...current, displayName: event.target.value }))} placeholder="组名称" />
              <Input size="sm" aria-label="邮件别名" value={groupForm.mailNickname} onChange={(event) => setGroupForm((current) => ({ ...current, mailNickname: event.target.value }))} placeholder="mailNickname" />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setShowGroupDialog(false)}>取消</Button>
              <Button size="sm" variant="primary" onClick={submitGroup} disabled={submittingGroup}>
                {submittingGroup ? '创建中...' : '创建'}
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={showUserDetails} onOpenChange={setShowUserDetails}>
        <Dialog size="sm" className="p-5">
          <div className="space-y-4">
            <Dialog.Title>用户详情</Dialog.Title>
            {!selectedUserDetails ? (
              <Loader />
            ) : (
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between"><span className="text-kumo-subtle">显示名称</span><span className="font-medium text-kumo-strong">{selectedUserDetails.displayName || '-'}</span></div>
                <div className="flex items-center justify-between"><span className="text-kumo-subtle">UPN</span><span className="font-medium text-kumo-strong">{selectedUserDetails.userPrincipalName || '-'}</span></div>
                <div className="flex items-center justify-between"><span className="text-kumo-subtle">部门</span><span className="font-medium text-kumo-strong">{selectedUserDetails.department || '-'}</span></div>
                <div className="flex items-center justify-between"><span className="text-kumo-subtle">职位</span><span className="font-medium text-kumo-strong">{selectedUserDetails.jobTitle || '-'}</span></div>
                <div className="flex items-center justify-between"><span className="text-kumo-subtle">创建时间</span><span className="font-medium text-kumo-strong">{selectedUserDetails.createdDateTime ? formatDateTime(selectedUserDetails.createdDateTime) : '-'}</span></div>
                <div className="flex items-center justify-between"><span className="text-kumo-subtle">许可证数</span><span className="font-medium text-kumo-strong">{selectedUserLicenses.length}</span></div>
              </div>
            )}
          </div>
        </Dialog>
      </Dialog.Root>
    </PageStack>
  );
}

export default M365Page;
