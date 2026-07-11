import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { Select } from '@cloudflare/kumo/components/select';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Check, ExternalLink, Globe, Shield, User } from '../components/Icons.jsx';
import { SectionCard } from '../components/ui/AppPrimitives.jsx';

const MICROSOFT_LOGIN_URL = 'https://login.microsoftonline.com/';

function getRegisterCode() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get('code') || '').trim();
}

function formatDateTime(value) {
  if (!value) return '长期有效';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '长期有效';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseResponse(response) {
  return response.json().catch(() => ({})).then((payload) => {
    if (!response.ok || payload.success === false) {
      throw new Error(payload.error || '请求失败');
    }
    return payload.data ?? payload;
  });
}

function PublicM365RegisterPage() {
  const code = useMemo(getRegisterCode, []);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);
  const [invite, setInvite] = useState(null);
  const [form, setForm] = useState({
    displayName: '',
    mailNickname: '',
    password: '',
    accountId: '',
    domain: '',
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!code) {
        setLoading(false);
        setError('注册链接缺少邀请码');
        return;
      }
      setLoading(true);
      setError('');
      try {
        const data = await fetch(`/api/m365/public/register?code=${encodeURIComponent(code)}`, {
          cache: 'no-store',
        }).then(parseResponse);
        if (cancelled) return;
        const inviteData = data?.invite || null;
        setInvite(inviteData);
        const firstTarget = Array.isArray(inviteData?.targets) ? inviteData.targets[0] : null;
        setForm((current) => ({
          ...current,
          accountId: inviteData?.targetCount === 1 && firstTarget?.accountId ? String(firstTarget.accountId) : '',
          domain: inviteData?.targetCount === 1 && firstTarget?.domain ? String(firstTarget.domain) : '',
        }));
      } catch (err) {
        if (!cancelled) {
          setError(err.message || '公开注册信息加载失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const targetItems = useMemo(() => {
    const targets = Array.isArray(invite?.targets) ? invite.targets : [];
    const domainCount = targets.reduce((acc, item) => {
      const key = String(item?.domain || '').trim().toLowerCase();
      if (!key) return acc;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return targets.map((target) => {
      const domain = String(target?.domain || '').trim();
      const duplicatedDomain = (domainCount[domain.toLowerCase()] || 0) > 1;
      return {
        value: `${target.accountId}::${target.domain}`,
        label: duplicatedDomain ? `@${domain} · ${target.accountName}` : `@${domain}`,
      };
    });
  }, [invite]);

  const selectedTargetValue = form.accountId && form.domain
    ? `${form.accountId}::${form.domain}`
    : '';

  const requiresTargetSelection = Number(invite?.targetCount || 0) > 1;

  const submit = async () => {
    if (!form.mailNickname.trim() || !form.password.trim()) {
      setError('请填写登录前缀和密码');
      return;
    }
    if (requiresTargetSelection && (!form.accountId || !form.domain)) {
      setError('请先选择注册域名');
      return;
    }
    setSubmitting(true);
    setError('');
    setSuccess(null);
    try {
      const payload = {
        code,
        displayName: form.displayName.trim(),
        mailNickname: form.mailNickname.trim(),
        password: form.password,
      };
      if (form.accountId) payload.accountId = Number(form.accountId);
      if (form.domain) payload.domain = form.domain;
      const result = await fetch('/api/m365/public/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(parseResponse);
      setSuccess(result);
    } catch (err) {
      setError(err.message || '注册失败');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-kumo-canvas p-4 text-kumo-default sm:p-6">
        <div className="mx-auto max-w-3xl">
          <SectionCard title="Microsoft 365 注册中" icon={<Globe className="h-4 w-4 text-kumo-brand" />}>
            <div className="py-10 text-center text-sm text-kumo-subtle">正在加载注册链接信息…</div>
          </SectionCard>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-kumo-canvas p-4 text-kumo-default sm:p-6">
        <div className="mx-auto max-w-3xl">
          <SectionCard title="账号创建成功" icon={<Check className="h-4 w-4 text-kumo-success" />}>
            <div className="grid gap-4">
              <div className="rounded-md border border-kumo-success/30 bg-kumo-success/10 p-4 text-sm text-kumo-success">
                账号已创建成功，请使用下方登录账号登录。
              </div>
              <div className="grid gap-2 rounded-md border border-kumo-line bg-kumo-recessed/30 p-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-kumo-subtle">登录账号</span>
                  <span className="font-semibold text-kumo-strong">{success.userPrincipalName}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-kumo-subtle">所属域名</span>
                  <span className="font-semibold text-kumo-strong">{success.domain}</span>
                </div>
                {success.warning ? (
                  <div className="rounded-md border border-kumo-warning/30 bg-kumo-warning/10 p-3 text-kumo-warning">
                    {success.warning}
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<ExternalLink className="h-4 w-4" />}
                    onClick={() => window.open(MICROSOFT_LOGIN_URL, '_blank', 'noopener,noreferrer')}
                  >
                    前往微软登录
                  </Button>
                </div>
              </div>
            </div>
          </SectionCard>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-kumo-canvas p-4 text-kumo-default sm:p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3 border-b border-kumo-line pb-3">
          <div className="min-w-0">
            <div className="text-base font-bold text-kumo-strong">Microsoft 365 公开注册</div>
            <div className="mt-1 font-mono text-xs text-kumo-subtle">{code || '-'}</div>
          </div>
          <Badge variant={invite?.used ? 'error' : invite?.available ? 'success' : 'warning'}>
            {invite?.used ? '已使用' : invite?.available ? '可用' : '不可用'}
          </Badge>
        </div>

        <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <SectionCard
            className="h-full"
            bodyClassName="flex min-h-0 flex-1 flex-col"
            title={invite?.publicPageName || '注册链接'}
            description="填写前缀和密码后即可创建账号。"
            icon={<User className="h-4 w-4 text-kumo-brand" />}
          >
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              <Input
                size="sm"
                aria-label="显示名称"
                value={form.displayName}
                onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
                placeholder="显示名称，可留空"
              />
              <Input
                size="sm"
                aria-label="登录前缀"
                value={form.mailNickname}
                onChange={(event) => setForm((current) => ({ ...current, mailNickname: event.target.value }))}
                placeholder="登录前缀，例如 zhangsan"
              />
              <Input
                size="sm"
                type="password"
                aria-label="初始密码"
                value={form.password}
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="设置初始密码"
              />
              {requiresTargetSelection ? (
                <div className="grid gap-2">
                  <div className="text-xs text-kumo-subtle">注册域名</div>
                  <Select
                    aria-label="注册域名"
                    size="sm"
                    value={selectedTargetValue}
                    onValueChange={(value) => {
                      const [accountId, domain] = String(value || '').split('::');
                      setForm((current) => ({
                        ...current,
                        accountId: accountId || '',
                        domain: domain || '',
                      }));
                    }}
                    items={targetItems}
                  />
                  <div className="text-[11px] text-kumo-subtle">可在允许范围内自行选择要注册到哪个域名。</div>
                </div>
              ) : (
                <div className="rounded-md border border-kumo-line bg-kumo-recessed/30 px-3 py-2 text-sm text-kumo-subtle">
                  注册域名：<span className="font-semibold text-kumo-strong">@{form.domain || invite?.domain || '-'}</span>
                </div>
              )}

              <div className="rounded-md border border-kumo-line bg-kumo-recessed/20 p-3 text-sm text-kumo-subtle">
                创建成功后会返回完整登录账号，你可以直接用它登录微软。
              </div>

              {error ? (
                <div className="rounded-md border border-kumo-danger/30 bg-kumo-danger/10 p-3 text-sm text-kumo-danger">
                  {error}
                </div>
              ) : null}

              <div className="mt-auto flex justify-end">
                <Button size="sm" variant="primary" onClick={submit} disabled={submitting || invite?.available === false}>
                  {submitting ? '注册中...' : '创建账号'}
                </Button>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            className="h-full"
            bodyClassName="flex min-h-0 flex-1 flex-col"
            title="注册链接信息"
            description="确认允许注册的域名与登录入口。"
            icon={<Shield className="h-4 w-4 text-kumo-brand" />}
          >
            <div className="grid gap-3 text-sm">
              <div className="rounded-md border border-kumo-line bg-kumo-recessed/30 p-3">
                <div className="text-xs text-kumo-subtle">公开页</div>
                <div className="mt-1 font-semibold text-kumo-strong">{invite?.publicPageName || '-'}</div>
              </div>
              <div className="rounded-md border border-kumo-line bg-kumo-recessed/30 p-3">
                <div className="text-xs text-kumo-subtle">允许注册的域名</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  {(invite?.domains || []).map((domain) => (
                    <Badge key={domain} variant="secondary">@{domain}</Badge>
                  ))}
                </div>
              </div>
              <div className="grid gap-2 rounded-md border border-kumo-line bg-kumo-recessed/30 p-3 text-xs sm:grid-cols-2">
                <div>
                  <div className="text-kumo-subtle">状态</div>
                  <div className="mt-1 font-semibold text-kumo-strong">{invite?.available ? '可用' : (invite?.availabilityReason || '不可用')}</div>
                </div>
                <div>
                  <div className="text-kumo-subtle">有效期</div>
                  <div className="mt-1 font-semibold text-kumo-strong">{formatDateTime(invite?.expiresAt)}</div>
                </div>
                <div>
                  <div className="text-kumo-subtle">使用次数</div>
                  <div className="mt-1 font-semibold text-kumo-strong">{invite?.usedCount || 0} / 1</div>
                </div>
                <div>
                  <div className="text-kumo-subtle">注册链接</div>
                  <div className="mt-1 font-semibold text-kumo-strong">{invite?.targetCount > 1 ? '支持自选域名' : '固定域名'}</div>
                </div>
              </div>
              <div className="rounded-md border border-kumo-line bg-kumo-recessed/30 p-3">
                <div className="text-xs text-kumo-subtle">说明</div>
                <div className="mt-1 text-kumo-subtle">
                  一个邀请码只能使用一次。创建成功后，请前往微软登录页，使用新生成的账号和密码登录。
                </div>
              </div>
              <div className="mt-auto rounded-md border border-kumo-line bg-kumo-recessed/30 p-3">
                <div className="text-xs text-kumo-subtle">微软登录入口</div>
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<ExternalLink className="h-4 w-4" />}
                    onClick={() => window.open(MICROSOFT_LOGIN_URL, '_blank', 'noopener,noreferrer')}
                  >
                    打开微软登录页
                  </Button>
                </div>
              </div>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

export default PublicM365RegisterPage;
