(function () {
  let themeMode = 'auto';
  let fallbackShown = false;

  try {
    const savedMode = localStorage.getItem('app_theme_mode');
    const legacyTheme = localStorage.getItem('app_theme');
    themeMode = savedMode || legacyTheme || 'auto';
  } catch (_error) {
    themeMode = 'auto';
  }

  function prefersDark() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.classList.toggle('light', !dark);
    document.documentElement.dataset.mode = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = 'kumo';
    document.documentElement.dataset.themeMode = themeMode;
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';

    const loader = document.getElementById('app-loading');
    if (loader) {
      loader.style.background = 'var(--app-loading-bg)';
    }
  }

  function showBootFallback(reason) {
    if (fallbackShown || window.__API_MONITOR_BOOTED) {
      return;
    }
    const loader = document.getElementById('app-loading');
    if (!loader) {
      return;
    }
    fallbackShown = true;
    loader.style.opacity = '1';
    loader.style.display = 'flex';
    const detail = String(reason || '应用未能在预期时间内完成挂载').replace(
      /[&<>"']/g,
      function (char) {
        return {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }[char];
      }
    );
    loader.innerHTML = [
      '<div style="width:min(420px,calc(100vw - 32px));border:1px solid rgba(120,113,108,.25);border-radius:8px;background:var(--app-loading-bg);box-shadow:0 20px 50px rgba(0,0,0,.14);padding:18px;text-align:left">',
      '<div style="font-size:13px;font-weight:800;color:var(--app-loading-fg);margin-bottom:8px">页面启动失败</div>',
      '<div style="font-size:12px;line-height:1.7;color:rgba(120,113,108,.95);margin-bottom:14px">前端资源可能已更新或浏览器仍在使用旧缓存。请重新加载页面，必要时清理缓存后再试。</div>',
      '<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;color:rgba(120,113,108,.9);background:rgba(120,113,108,.08);border-radius:6px;padding:8px;margin-bottom:14px;word-break:break-all">',
      detail,
      '</div>',
      '<button type="button" id="app-reload-button" style="height:32px;border:0;border-radius:6px;background:#dc7d40;color:white;font-size:12px;font-weight:700;padding:0 12px;cursor:pointer">重新加载</button>',
      '</div>',
    ].join('');
    const button = document.getElementById('app-reload-button');
    if (button) {
      button.addEventListener('click', function () {
        const url = new URL(window.location.href);
        url.searchParams.set('_reload', String(Date.now()));
        window.location.replace(url.toString());
      });
    }
  }

  const dark = themeMode === 'dark' || (themeMode !== 'light' && prefersDark());
  applyTheme(dark);

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (event) {
      if (themeMode === 'auto') {
        applyTheme(event.matches);
      }
    });
  }

  window.__API_MONITOR_SHOW_BOOT_ERROR = showBootFallback;
  window.addEventListener(
    'error',
    function (event) {
      const target = event.target;
      const source = target && (target.src || target.href);
      if (!source) {
        return;
      }
      if (String(source).indexOf('/assets/') !== -1 || String(source).indexOf('/js/main.jsx') !== -1) {
        showBootFallback('资源加载失败：' + source);
      }
    },
    true
  );
  window.addEventListener('unhandledrejection', function (event) {
    const message = event.reason && (event.reason.message || String(event.reason));
    if (/chunk|import|module|failed|loading/i.test(message || '')) {
      showBootFallback(message);
    }
  });
  window.setTimeout(function () {
    const root = document.getElementById('root');
    if (!window.__API_MONITOR_BOOTED && (!root || !root.childElementCount)) {
      showBootFallback('应用未能在 10 秒内完成挂载');
    }
  }, 10000);
})();
