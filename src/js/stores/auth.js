/**
 * 认证相关状态存储
 */

import { defineStore } from 'pinia';
import { toast } from '../modules/toast.js';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    isAuthenticated: false,
    isCheckingAuth: true,
    showLoginModal: false,
    showSetPasswordModal: false,
    loginError: '',
    loginPassword: '',
    loginLoading: false, // 登录按钮加载状态
    loginRequire2FA: false, // 是否需要 2FA 验证
    loginTotpToken: '', // 2FA 验证码输入
    setPassword: '',
    setPasswordConfirm: '',
    setPasswordError: '',
    isDemoMode: false,
  }),

  getters: {
    authHeaders: state => ({
      'Content-Type': 'application/json',
      'x-admin-password': state.loginPassword,
    }),
  },

  actions: {
    // 处理 2FA 输入（满 6 位自动触发验证）
    handleTotpInput() {
      if (this.loginTotpToken.length === 6) {
        this.verifyPassword(true); // 使用静默模式，减少 UI 干扰
      }
    },

    // 验证密码（登录）
    // @param {boolean} silent - 静默模式，不显示成功 toast（用于自动验证）
    async verifyPassword(silent = false) {
      this.loginError = '';
      this.loginLoading = true;
      try {
        // 构建请求体
        const requestBody = { password: this.loginPassword };
        // 如果处于 2FA 阶段，带上验证码
        if (this.loginRequire2FA && this.loginTotpToken) {
          requestBody.totpToken = this.loginTotpToken;
        }

        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          credentials: 'include',
        });

        const result = await response.json();

        // 处理 429 限流错误
        if (response.status === 429) {
          const errorMsg = result.error || '登录尝试过于频繁，请稍后再试';
          this.loginError = errorMsg;
          toast.warning(errorMsg, { duration: 5000 });
          return false;
        }

        // 处理需要 2FA 的情况
        if (result.require2FA && !result.success) {
          this.loginRequire2FA = true;
          this.loginTotpToken = '';
          if (result.error) {
            this.loginError = result.error;
          }
          return false;
        }

        if (result.success) {
          this.isAuthenticated = true;
          this.showLoginModal = false;
          this.loginRequire2FA = false;
          this.loginTotpToken = '';

          // 保存密码和时间戳
          localStorage.setItem('admin_password', this.loginPassword);
          localStorage.setItem('password_time', Date.now().toString());

          // 仅在非静默模式下显示成功提示
          if (!silent) {
            toast.success('登录成功，欢迎回来！');
          }
          return true;
        } else {
          this.loginError = result.error || '密码错误，请重试';
          if (!silent) {
            toast.error(this.loginError);
          }
          return false;
        }
      } catch (error) {
        this.loginError = '验证失败: ' + error.message;
        toast.error(this.loginError);
        return false;
      } finally {
        this.loginLoading = false;
      }
    },

    // 取消 2FA 验证，返回密码输入
    cancelLogin2FA() {
      this.loginRequire2FA = false;
      this.loginTotpToken = '';
      this.loginError = '';
    },

    // 检查认证状态
    async checkAuth() {
      this.isCheckingAuth = true;
      try {
        // 1. 优先检查当前 Session 是否已认证（最轻量级，支持无感刷新）
        const sessionRes = await fetch('/api/session');
        const { authenticated } = await sessionRes.json();
        if (authenticated) {
          this.isAuthenticated = true;
          this.showLoginModal = false;
          this.isCheckingAuth = false;
          return true;
        }

        // 2. 如果 Session 不存在，再检查基本配置并尝试自动登录
        const res = await fetch('/api/check-password');
        const { hasPassword, isDemoMode } = await res.json();
        this.isDemoMode = isDemoMode;

        if (isDemoMode) {
          const savedTime = localStorage.getItem('password_time');
          const now = Date.now();
          const isValidSession = savedTime && now - parseInt(savedTime) < 4 * 24 * 60 * 60 * 1000;

          if (!isValidSession) {
            this.loginPassword = '';
            return await this.verifyPassword();
          } else {
            this.isAuthenticated = true;
            this.showLoginModal = false;
            return true;
          }
        }

        if (!hasPassword) {
          this.showSetPasswordModal = true;
          this.isAuthenticated = false;
          return false;
        }

        const savedPassword = localStorage.getItem('admin_password');
        const savedTime = localStorage.getItem('password_time');

        if (savedPassword && savedTime) {
          const now = Date.now();
          if (now - parseInt(savedTime) < 4 * 24 * 60 * 60 * 1000) {
            this.loginPassword = savedPassword;
            await this.verifyPassword(true); // 静默模式，不显示 toast
            if (!this.isAuthenticated) {
              this.showLoginModal = true;
            }
            return this.isAuthenticated;
          }
        }

        this.showLoginModal = true;
        return false;
      } catch (e) {
        console.error('Auth check error:', e);
        this.showLoginModal = true;
        return false;
      } finally {
        this.isCheckingAuth = false;
      }
    },

    logout() {
      this.isAuthenticated = false;
      this.loginPassword = '';
      localStorage.removeItem('admin_password');
      localStorage.removeItem('password_time');
    },
  },
});
