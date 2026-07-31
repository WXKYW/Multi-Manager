export const getSiteBrandUrl = (siteBrandIconId = '') => {
  const value = String(siteBrandIconId || 'default').trim() || 'default';
  return `/logo.svg?v=${encodeURIComponent(value)}`;
};

export const getDefaultSiteBrandPreviewUrl = () => '/logo-default.svg?v=default';

const ensureLink = (selector, rel) => {
  let node = document.head.querySelector(selector);
  if (!node) {
    node = document.createElement('link');
    node.rel = rel;
    document.head.appendChild(node);
  }
  return node;
};

export const applySiteBrandFaviconHref = (href) => {
  if (typeof document === 'undefined') return;
  ensureLink('link[rel="icon"]', 'icon').href = href;
  ensureLink('link[rel="shortcut icon"]', 'shortcut icon').href = href;
};

export const applySiteBrandFavicon = (siteBrandIconId = '') => {
  applySiteBrandFaviconHref(getSiteBrandUrl(siteBrandIconId));
};
