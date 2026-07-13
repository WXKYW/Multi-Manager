import React, { useState } from 'react';
import { Banner } from '@cloudflare/kumo/components/banner';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import useStore from '../store.js';
import { SectionCard } from '../components/ui/AppPrimitives.jsx';
import {
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  Key,
  LogIn,
  Rocket,
  Shield,
} from '../components/Icons.jsx';

const AUTH_FEATURES = [
  '统一管理入口',
  '自动校验',
  '多目标支持',
];

function AuthShell({ mode, title, description, children }) {
  const modeLabel = mode === 'setup' ? '初始化' : mode === '2fa' ? '二次验证' : '安全登录';

  return (
    <main className="relative flex min-h-dvh w-screen overflow-hidden bg-kumo-canvas text-kumo-default">
      <section className="hidden w-[380px] shrink-0 flex-col justify-between border-r border-kumo-line bg-kumo-base px-8 py-7 lg:flex">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-kumo-line bg-kumo-recessed">
            <img src="/logo.svg" alt="" className="size-5 object-contain" />
          </span>
          <div className="min-w-0">
            <div className="text-lg font-semibold text-kumo-strong">API Monitor</div>
            {/* <div className="text-[11px] text-kumo-subtle">监控控制台</div> */}
          </div>
        </div>

        <div className="space-y-4">
          {/* <div className="inline-flex h-6.5 items-center rounded-md border border-kumo-line bg-kumo-recessed px-2 text-xs font-medium text-kumo-subtle">
            {modeLabel}
          </div> */}
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold leading-snug text-kumo-strong">请登录</h1>
            <p className="max-w-[280px] text-sm leading-relaxed text-kumo-subtle">
              管理主机、DNS、PaaS......
            </p>
          </div>
        </div>

        <div className="space-y-2 border-t border-kumo-line pt-4">
          {AUTH_FEATURES.map((item) => (
            <div key={item} className="flex items-center gap-2 text-xs text-kumo-subtle">
              <span className="size-1.5 rounded-full bg-kumo-brand" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="relative isolate flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-kumo-recessed/30 px-4 py-8 sm:px-6">
        <div aria-hidden="true" className="auth-login-backdrop pointer-events-none absolute inset-0" />

        <div className="relative z-10 w-full max-w-[400px]">
          <div className="mb-5 flex items-center justify-start gap-3 lg:hidden">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-kumo-line bg-kumo-base">
              <img src="/logo.svg" alt="" className="size-6 object-contain" />
            </span>
            <div className="min-w-0">
              <div className="text-base font-semibold leading-tight text-kumo-strong">API Monitor</div>
              <div className="text-xs leading-tight text-kumo-subtle">{modeLabel}</div>
            </div>
          </div>

          <SectionCard
            title={title}
            description={description}
            icon={mode === 'setup' ? <Rocket className="size-4 text-kumo-brand" /> : <Shield className="size-4 text-kumo-brand" />}
            meta={<span className="text-[11px] font-medium text-kumo-subtle">{modeLabel}</span>}
            className="w-full"
            bodyPadding="lg"
          >
            {children}
          </SectionCard>
        </div>
      </section>
    </main>
  );
}

function AuthErrorBanner({ message }) {
  if (!message) return null;

  return (
    <Banner
      variant="error"
      icon={<AlertTriangle className="size-4" />}
      title="验证失败"
      description={message}
      className="rounded-md px-3 py-2 text-xs"
    />
  );
}

function AuthPage() {
  const {
    isDemoMode,
    loginRequire2FA,
    loginError,
    loginLoading,
    verifyPassword,
    loginPassword,
    setLoginPassword,
    loginTotpToken,
    setLoginTotpToken,
    cancelLogin2FA,
    showSetPasswordModal,
  } = useStore();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupError, setSetupError] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);

  const handle2FAInput = (event) => {
    const value = event.target.value.replace(/\D/g, '').slice(0, 6);
    setLoginTotpToken(value);
    if (value.length === 6) {
      verifyPassword(true);
    }
  };

  const handleSetupPassword = async (event) => {
    event.preventDefault();
    setSetupError('');

    if (!newPassword || newPassword.length < 6) {
      setSetupError('密码长度至少 6 位。');
      return;
    }

    if (newPassword !== confirmPassword) {
      setSetupError('两次输入的密码不一致。');
      return;
    }

    setSetupLoading(true);
    try {
      const response = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });
      const result = await response.json();

      if (!result.success) {
        setSetupError(result.error || '设置密码失败。');
        return;
      }

      setLoginPassword(newPassword);
      await verifyPassword(false);
    } catch (error) {
      setSetupError('设置失败，请检查网络连接。');
    } finally {
      setSetupLoading(false);
    }
  };

  const handleLogin = (event) => {
    event.preventDefault();
    verifyPassword();
  };

  if (showSetPasswordModal) {
    return (
      <AuthShell
        mode="setup"
        title="设置管理员密码"
        description="首次使用前，请为控制台创建一个管理员密码。"
      >
        <form onSubmit={handleSetupPassword} className="space-y-4">
          <Input
            size="base"
            type="password"
            label="新密码"
            description="至少 6 位，建议使用更长的短语。"
            placeholder="设置管理员密码"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            spellCheck={false}
            className="w-full"
            autoFocus
          />

          <Input
            size="base"
            type="password"
            label="确认密码"
            placeholder="再次输入密码"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            spellCheck={false}
            className="w-full"
          />

          <AuthErrorBanner message={setupError} />

          <Button
            type="submit"
            variant="primary"
            size="base"
            loading={setupLoading}
            icon={!setupLoading ? <ArrowRight className="size-3.5" /> : undefined}
            className="w-full justify-center"
          >
            开始使用
          </Button>
        </form>
      </AuthShell>
    );
  }

  const title = isDemoMode ? '演示模式' : loginRequire2FA ? '输入二次验证码' : '欢迎回来';
  const description = isDemoMode
    ? '当前环境无需密码，确认后可直接进入控制台。'
    : loginRequire2FA
      ? '请输入 Authenticator App 中显示的 6 位动态验证码。'
      : '输入管理员密码以访问面板';

  return (
    <AuthShell
      mode={loginRequire2FA ? '2fa' : 'login'}
      title={title}
      description={description}
    >
      <form onSubmit={handleLogin} className="space-y-4">
        {isDemoMode && (
          <Banner
            variant="secondary"
            icon={<Shield className="size-4" />}
            title="演示环境"
            description="不会保存真实凭据，适合快速预览功能。"
            className="rounded-md px-3 py-2 text-xs"
          />
        )}

        {!isDemoMode && !loginRequire2FA && (
          <Input
            size="base"
            type="password"
            aria-label="管理员密码"
            placeholder="请输入管理员密码"
            value={loginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            spellCheck={false}
            className="w-full"
            autoFocus
          />
        )}

        {loginRequire2FA && (
          <Input
            size="base"
            type="text"
            inputMode="numeric"
            label="双因素验证码"
            description="填满 6 位后会自动验证，也可以按 Enter 提交。"
            maxLength={6}
            placeholder="000000"
            value={loginTotpToken}
            onChange={handle2FAInput}
            autoComplete="one-time-code"
            className="w-full text-center font-mono tracking-widest"
            autoFocus
          />
        )}

        <AuthErrorBanner message={loginError} />

        {!loginRequire2FA ? (
          <Button
            type="submit"
            variant="primary"
            size="base"
            loading={loginLoading}
            icon={!loginLoading ? <LogIn className="size-3.5" /> : undefined}
            className="w-full justify-center"
          >
            {isDemoMode ? '进入演示模式' : '立即进入'}
          </Button>
        ) : (
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
            <Button
              type="button"
              onClick={cancelLogin2FA}
              variant="secondary"
              size="base"
              shape="square"
              icon={<ChevronLeft className="size-3.5" />}
              aria-label="返回修改密码"
              title="返回修改密码"
            />
            <Button
              type="submit"
              variant="primary"
              size="base"
              loading={loginLoading}
              icon={!loginLoading ? <Key className="size-3.5" /> : undefined}
              className="justify-center"
            >
              验证并进入
            </Button>
          </div>
        )}
{/* 
        <div className="flex items-center justify-between border-t border-kumo-line pt-3 text-[11px] text-kumo-subtle">
          <span>会话状态</span>
          <span className="font-medium text-kumo-success">受保护</span>
        </div> */}
      </form>
    </AuthShell>
  );
}

export default AuthPage;
