import { toast } from './toast.js';

const THEME_META_SELECTOR = 'meta[name="theme-color"]';
const LIGHT_TITLEBAR = '#f8f7f4';
const DARK_TITLEBAR = '#050505';

let updateToastId = null;
let refreshingForUpdate = false;

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true ||
  document.referrer.startsWith('android-app://');

const upsertThemeMeta = (name, media) => {
  const selector = media
    ? `${THEME_META_SELECTOR}[media="${media}"]`
    : `${THEME_META_SELECTOR}:not([media])`;
  let meta = document.head.querySelector(selector);

  if (!meta) {
    meta = document.createElement('meta');
    meta.name = name;
    if (media) meta.media = media;
    document.head.appendChild(meta);
  }

  return meta;
};

const applyTitlebarColor = () => {
  const mode = document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light';
  const fallbackColor = mode === 'dark' ? DARK_TITLEBAR : LIGHT_TITLEBAR;
  const topbar = document.querySelector('.app-main-topbar');
  const color = topbar ? getComputedStyle(topbar).backgroundColor : fallbackColor;

  upsertThemeMeta('theme-color').content = color;
  upsertThemeMeta('theme-color', '(prefers-color-scheme: light)').content = color;
  upsertThemeMeta('theme-color', '(prefers-color-scheme: dark)').content = color;

  if ('windowControlsOverlay' in navigator) {
    document.documentElement.style.setProperty('--app-titlebar-area-x', 'env(titlebar-area-x, 0px)');
    document.documentElement.style.setProperty('--app-titlebar-area-y', 'env(titlebar-area-y, 0px)');
    document.documentElement.style.setProperty('--app-titlebar-area-width', 'env(titlebar-area-width, 100vw)');
    document.documentElement.style.setProperty('--app-titlebar-area-height', 'env(titlebar-area-height, 0px)');
  }

  document.documentElement.dataset.displayMode = isStandalone() ? 'standalone' : 'browser';
};

const watchTitlebarColor = () => {
  applyTitlebarColor();
  window.requestAnimationFrame(applyTitlebarColor);

  const themeObserver = new MutationObserver(applyTitlebarColor);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-mode', 'data-theme-mode'],
  });

  if (!document.querySelector('.app-main-topbar')) {
    const topbarObserver = new MutationObserver(() => {
      if (!document.querySelector('.app-main-topbar')) return;
      applyTitlebarColor();
      topbarObserver.disconnect();
    });
    topbarObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.matchMedia?.('(display-mode: standalone)').addEventListener('change', applyTitlebarColor);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', applyTitlebarColor);

  if ('windowControlsOverlay' in navigator) {
    navigator.windowControlsOverlay.addEventListener('geometrychange', applyTitlebarColor);
  }
};

const reloadForUpdate = () => {
  if (refreshingForUpdate) return;
  refreshingForUpdate = true;

  window.location.reload();
};

const showUpdateAvailableToast = (registration) => {
  const waitingWorker = registration?.waiting;
  if (!waitingWorker || updateToastId) return;

  updateToastId = toast.show({
    type: 'info',
    isManual: true,
    title: '发现新版本',
    description: '应用已在后台完成更新，刷新后即可使用新版。',
    duration: 0,
    actions: [
      {
        children: '立即更新',
        size: 'sm',
        onClick: () => {
          toast.remove(updateToastId);
          updateToastId = null;
          waitingWorker.postMessage({ type: 'SKIP_WAITING' });
        },
      },
      {
        children: '稍后',
        size: 'sm',
        variant: 'secondary',
        onClick: () => {
          toast.remove(updateToastId);
          updateToastId = null;
        },
      },
    ],
  });
};

const watchServiceWorkerUpdates = (registration) => {
  if (registration.waiting && navigator.serviceWorker.controller) {
    showUpdateAvailableToast(registration);
  }

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;

    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        showUpdateAvailableToast(registration);
      }
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      registration.update().catch(() => {});
    }
  });
};

const registerServiceWorker = () => {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext && window.location.hostname !== 'localhost') return;

  navigator.serviceWorker.addEventListener('controllerchange', reloadForUpdate);

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        watchServiceWorkerUpdates(registration);
      })
      .catch((error) => {
        console.warn('PWA service worker registration failed:', error);
      });
  });
};

export const setupPwa = () => {
  document.documentElement.dataset.pwaReady = 'true';
  watchTitlebarColor();
  registerServiceWorker();
};
