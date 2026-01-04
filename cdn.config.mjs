/**
 * CDN 配置文件 (ESM)
 */

// CDN 提供商配置
export const cdnProviders = {
  jsdelivr: {
    name: 'jsDelivr',
    baseUrl: 'https://cdn.jsdelivr.net/npm',
    format: (pkg, version, file) => `https://cdn.jsdelivr.net/npm/${pkg}@${version}${file}`,
  },
  npmmirror: {
    name: 'npmmirror',
    baseUrl: 'https://registry.npmmirror.com',
    format: (pkg, version, file) => `https://registry.npmmirror.com/${pkg}/${version}/files${file}`,
  },
  unpkg: {
    name: 'unpkg',
    baseUrl: 'https://unpkg.com',
    format: (pkg, version, file) => `https://unpkg.com/${pkg}@${version}${file}`,
  },
  bootcdn: {
    name: 'BootCDN',
    baseUrl: 'https://cdn.bootcdn.net/ajax/libs',
    format: (pkg, version, file) => {
      const pkgMap = {
        vue: `https://cdn.bootcdn.net/ajax/libs/vue/${version}/vue.global.prod.min.js`,
        '@fortawesome/fontawesome-free': `https://cdn.bootcdn.net/ajax/libs/font-awesome/${version}/css/all.min.css`,
      };
      return (
        pkgMap[pkg] ||
        `https://cdn.bootcdn.net/ajax/libs/${pkg.replace('@', '').replace('/', '-')}/${version}${file}`
      );
    },
  },
};

// 需要通过 CDN 加载的依赖及其版本
export const cdnDependencies = {
  vue: {
    version: '3.5.26',
    file: '/dist/vue.global.prod.js',
    global: 'Vue',
    css: false,
  },
  'vue-demi': {
    version: '0.14.10',
    file: '/lib/index.iife.js',
    global: 'VueDemi',
    css: false,
  },
  pinia: {
    version: '2.3.0',
    file: '/dist/pinia.iife.prod.js',
    global: 'Pinia',
    css: false,
  },
  axios: {
    version: '1.7.9',
    file: '/dist/axios.min.js',
    global: 'axios',
    css: false,
  },
  'chart.js': {
    version: '4.5.1',
    file: '/dist/chart.umd.js',
    global: 'Chart',
    css: false,
  },
  marked: {
    version: '15.0.4',
    file: '/lib/marked.umd.js',
    global: 'marked',
    css: false,
  },
  dompurify: {
    version: '3.2.3',
    file: '/dist/purify.min.js',
    global: 'DOMPurify',
    css: false,
  },
  '@fortawesome/fontawesome-free': {
    version: '7.1.0',
    file: '/css/all.min.css',
    global: null,
    css: true,
  },
  'simple-icons-font': {
    version: '14.15.0',
    file: '/font/simple-icons.min.css',
    global: null,
    css: true,
  },
  jsqr: {
    version: '1.4.0',
    file: '/dist/jsQR.js',
    global: 'jsQR',
    css: false,
  },
  'html5-qrcode': {
    version: '2.3.8',
    file: '/html5-qrcode.min.js',
    global: 'Html5Qrcode',
    css: false,
  },
  katex: {
    version: '0.16.21',
    file: '/dist/katex.min.js',
    global: 'katex',
    css: '/dist/katex.min.css',
  },
};

export function getCdnUrl(provider, pkg, type = 'js') {
  const cdn = cdnProviders[provider] || cdnProviders.jsdelivr;
  const dep = cdnDependencies[pkg];

  if (!dep) return null;

  if (type === 'css') {
    if (!dep.css) return null;
    const cssFile = typeof dep.css === 'string' ? dep.css : dep.file;

    if (pkg === 'simple-icons-font' && provider === 'npmmirror') {
      const fallbackCdn = cdnProviders.unpkg;
      return fallbackCdn.format(pkg, dep.version, cssFile);
    }

    return cdn.format(pkg, dep.version, cssFile);
  }

  if (!dep.global) return null;
  return cdn.format(pkg, dep.version, dep.file);
}

export function getAllCdnUrls(provider) {
  const result = { js: [], css: [] };

  for (const [pkg, dep] of Object.entries(cdnDependencies)) {
    if (dep.global) {
      const jsUrl = getCdnUrl(provider, pkg, 'js');
      if (jsUrl) result.js.push({ url: jsUrl, global: dep.global, pkg });
    }
    if (dep.css) {
      const cssUrl = getCdnUrl(provider, pkg, 'css');
      if (cssUrl) result.css.push(cssUrl);
    }
  }

  return result;
}

export function getExternals() {
  return Object.keys(cdnDependencies).filter(pkg => cdnDependencies[pkg].global);
}

export function getGlobals() {
  const globals = {};
  for (const [pkg, dep] of Object.entries(cdnDependencies)) {
    if (dep.global) {
      globals[pkg] = dep.global;
    }
  }
  return globals;
}
