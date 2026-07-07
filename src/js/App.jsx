import React, { lazy, Suspense, useEffect, useState } from 'react';
import useStore, { applyThemeMode } from './store.js';
import AuthPage from './pages/AuthPage.jsx';
import MainLayout from './components/MainLayout.jsx';

const PublicSharePage = lazy(() => import('./pages/PublicSharePage.jsx'));
const PublicStatusPage = lazy(() => import('./pages/PublicStatusPage.jsx'));
const PublicServerStatusPage = lazy(() => import('./pages/PublicServerStatusPage.jsx'));
const VoidRoomPage = lazy(() => import('./pages/VoidRoomPage.jsx'));

const isLocalHost = (host) => /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host || '');

const isDockerMockPreviewRoute = () => (
  typeof window !== 'undefined'
  && import.meta.env?.DEV
  && isLocalHost(window.location.host)
  && new URLSearchParams(window.location.search).has('mockDocker')
);

const getPublicStatusRouteMode = () => {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (/^\/(?:status|u)\/[^/]+$/.test(path)) return 'slug';
  if (/^\/(?:servers|s)\/[^/]+$/.test(path)) return 'server-slug';
  if (path === '/' && !isLocalHost(window.location.host)) return 'domain';
  return false;
};

const getPublicFileboxRouteMode = () => {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (/^\/share\/[^/]+$/.test(path)) return 'share';
  if (/^\/void\/[^/]+$/.test(path)) return 'void';
  return false;
};

function App() {
  const { isAuthenticated, checkAuth, isCheckingAuth, themeMode } = useStore();
  const [domainStatusRoute, setDomainStatusRoute] = useState(null);
  const publicStatusRouteMode = getPublicStatusRouteMode();
  const publicFileboxRouteMode = getPublicFileboxRouteMode();
  const dockerMockPreview = isDockerMockPreviewRoute();

  // 挂载时自动运行初始身份校验
  useEffect(() => {
    if (dockerMockPreview) {
      useStore.setState({
        isAuthenticated: true,
        isCheckingAuth: false,
        showLoginModal: false,
        showSetPasswordModal: false,
        userSettingsLoaded: true,
      });
      return;
    }
    checkAuth();
  }, [checkAuth, dockerMockPreview]);

  // 同步主题至 html class
  useEffect(() => {
    applyThemeMode(themeMode);
  }, [themeMode]);

  // 监听系统主题变化（仅在用户未锁定自定义主题时生效）
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      const currentMode = useStore.getState().themeMode;
      if (currentMode !== 'auto') return;

      const newTheme = e.matches ? 'dark' : 'light';
      applyThemeMode('auto');
      useStore.setState({ theme: newTheme });
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
    } else {
      mediaQuery.addListener(handleChange);
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleChange);
      } else {
        mediaQuery.removeListener(handleChange);
      }
    };
  }, []);

  if (window.location.pathname === '/filebox' && new URLSearchParams(window.location.search).has('void')) {
    const room = new URLSearchParams(window.location.search).get('void');
    window.location.replace(`/void/${encodeURIComponent(room || '')}`);
    return null;
  }

  if (publicFileboxRouteMode === 'share') {
    return <Suspense fallback={null}><PublicSharePage /></Suspense>;
  }

  if (publicFileboxRouteMode === 'void') {
    return <Suspense fallback={null}><VoidRoomPage /></Suspense>;
  }

  if (publicStatusRouteMode === 'server-slug') {
    return <Suspense fallback={null}><PublicServerStatusPage /></Suspense>;
  }

  if (publicStatusRouteMode === 'slug') {
    return (
      <Suspense fallback={null}>
        <PublicStatusPage />
      </Suspense>
    );
  }

  if (isCheckingAuth) {
    return null;
  }

  if (isAuthenticated || dockerMockPreview) {
    return <MainLayout />;
  }

  if (publicStatusRouteMode === 'domain') {
    return (
      <DomainPublicStatusResolver
        route={domainStatusRoute}
        onRouteChange={setDomainStatusRoute}
      />
    );
  }

  return <AuthPage />;
}

function DomainPublicStatusResolver({ route, onRouteChange }) {
  useEffect(() => {
    let cancelled = false;

    const resolve = async () => {
      onRouteChange(null);
      const domain = window.location.host;
      const uptimeUrl = `/api/uptime/public/status-page-by-domain?domain=${encodeURIComponent(domain)}`;
      const serverUrl = `/api/server/public/status-page-by-domain?domain=${encodeURIComponent(domain)}`;

      try {
        const uptimeResponse = await fetch(uptimeUrl, { cache: 'no-store' });
        if (!cancelled && uptimeResponse.ok) {
          onRouteChange('uptime');
          return;
        }
      } catch {
        // Fall through to server status page probing.
      }

      try {
        const serverResponse = await fetch(serverUrl, { cache: 'no-store' });
        if (!cancelled && serverResponse.ok) {
          onRouteChange('server');
          return;
        }
      } catch {
        // Fall through to login.
      }

      if (!cancelled) onRouteChange('none');
    };

    resolve();
    return () => {
      cancelled = true;
    };
  }, [onRouteChange]);

  if (route === 'uptime') {
    return (
      <Suspense fallback={null}>
        <PublicStatusPage domainOnly />
      </Suspense>
    );
  }

  if (route === 'server') {
    return (
      <Suspense fallback={null}>
        <PublicServerStatusPage domainOnly />
      </Suspense>
    );
  }

  if (route === null) {
    return null;
  }

  return <AuthPage />;
}

export default App;
