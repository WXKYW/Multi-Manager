import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Activity, Server } from '../components/Icons.jsx';

export const PUBLIC_PAGE_ICON_CONFIG_KEY = 'publicIconId';

const DEFAULT_ICON_COLOR = '#f48120';
const GITHUB_ICON_VIEWBOX = '0 0 1230 1200';
const GITHUB_ICON_PATH = 'M615 1200Q490 1200 376 1152Q265 1105 180.0 1020.0Q95 935 48 824Q0 710 0 585Q0 451 55 331Q108 214 203.5 128.0Q299 42 421 1Q442 -3 453 8Q463 16 463 31L462 135Q414 125 375 130Q341 134 315 148Q294 160 278 178Q267 191 260 206L255 218Q245 242 232 262Q222 277 210 289Q201 298 193 304L186 308Q167 321 163.5 329.0Q160 337 168 341Q173 344 182 345H191Q229 342 261 312Q277 297 285 282Q321 220 382 215Q421 211 464 231Q468 259 479 281Q489 300 503 313Q423 322 370 346Q301 377 265 437Q223 506 223 617Q223 713 286 782Q276 805 274 837Q270 890 291 945L301 946Q315 947 332 943Q356 938 385 925Q420 909 461 882Q534 902 614.5 902.0Q695 902 768 882Q789 896 808.0 907.0Q827 918 843.0 925.0Q859 932 872.0 936.5Q885 941 895.5 943.0Q906 945 913.5 945.5Q921 946 927 946L934 945Q937 945 937 945Q958 890 954 837Q952 806 943 782Q1006 713 1006 617Q1006 506 964 437Q927 377 859 346Q805 322 725 313Q743 298 754 271Q767 240 767 200L766 31Q766 17 775 8Q787 -2 808 2Q931 42 1027.0 128.0Q1123 214 1176 331Q1230 451 1230 585Q1230 710 1182 824Q1135 935 1050.0 1020.0Q965 1105 855 1152Q740 1200 615 1200Z';

const svgToDataUrl = (markup) => `data:image/svg+xml,${encodeURIComponent(markup)}`;

const GitHubGlyphIcon = ({ className = '', ...props }) => (
  React.createElement(
    'svg',
    {
      ...props,
      viewBox: GITHUB_ICON_VIEWBOX,
      fill: 'currentColor',
      className,
      'aria-hidden': props['aria-label'] ? undefined : true,
      focusable: 'false',
    },
    React.createElement('path', { d: GITHUB_ICON_PATH }),
  )
);

const GITHUB_FAVICON_HREF = svgToDataUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${GITHUB_ICON_VIEWBOX}" fill="${DEFAULT_ICON_COLOR}"><path d="${GITHUB_ICON_PATH}"/></svg>`,
);

const DEFAULT_ICON_DEFS = {
  uptime: {
    renderIcon: (props = {}) => React.createElement(Activity, props),
    faviconHref: svgToDataUrl(renderToStaticMarkup(React.createElement(Activity, { size: 64, color: DEFAULT_ICON_COLOR }))),
  },
  server: {
    renderIcon: (props = {}) => React.createElement(Server, props),
    faviconHref: svgToDataUrl(renderToStaticMarkup(React.createElement(Server, { size: 64, color: DEFAULT_ICON_COLOR }))),
  },
  github: {
    renderIcon: (props = {}) => React.createElement(GitHubGlyphIcon, props),
    faviconHref: GITHUB_FAVICON_HREF,
  },
};

const ensureLink = (selector, rel) => {
  let node = document.head.querySelector(selector);
  if (!node) {
    node = document.createElement('link');
    node.rel = rel;
    document.head.appendChild(node);
  }
  return node;
};

const normalizeIconId = (value) => String(value || '').trim();

export const getPublicPageUploadedIconUrl = (iconId = '') => {
  const normalized = normalizeIconId(iconId);
  return normalized ? `/site-brand-icons/${encodeURIComponent(normalized)}` : '';
};

export const getPublicPageIconId = (config = {}) => normalizeIconId(config?.[PUBLIC_PAGE_ICON_CONFIG_KEY]);

export const withPublicPageIconId = (config = {}, iconId = '') => {
  const nextConfig = config && typeof config === 'object' ? { ...config } : {};
  const normalized = normalizeIconId(iconId);
  if (normalized) nextConfig[PUBLIC_PAGE_ICON_CONFIG_KEY] = normalized;
  else delete nextConfig[PUBLIC_PAGE_ICON_CONFIG_KEY];
  return nextConfig;
};

export const renderPublicPageDefaultIcon = (pageKind, props = {}) => {
  const definition = DEFAULT_ICON_DEFS[pageKind] || DEFAULT_ICON_DEFS.uptime;
  return definition.renderIcon(props);
};

export const getPublicPageFaviconHref = (pageKind, config = {}) => {
  const iconHref = getPublicPageUploadedIconUrl(getPublicPageIconId(config));
  if (iconHref) return iconHref;
  return (DEFAULT_ICON_DEFS[pageKind] || DEFAULT_ICON_DEFS.uptime).faviconHref;
};

export const swapPublicPageFavicon = (href) => {
  if (typeof document === 'undefined' || !href) return () => {};
  const iconLink = ensureLink('link[rel="icon"]', 'icon');
  const shortcutLink = ensureLink('link[rel="shortcut icon"]', 'shortcut icon');
  const previousIconHref = iconLink.getAttribute('href') || '';
  const previousShortcutHref = shortcutLink.getAttribute('href') || '';
  iconLink.href = href;
  shortcutLink.href = href;
  return () => {
    if (previousIconHref) iconLink.href = previousIconHref;
    else iconLink.removeAttribute('href');
    if (previousShortcutHref) shortcutLink.href = previousShortcutHref;
    else shortcutLink.removeAttribute('href');
  };
};

export const listPublicPageIcons = async () => {
  const response = await fetch('/api/settings/site-brand/icons', { cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) {
    throw new Error(result.error || '加载图标失败');
  }
  const items = Array.isArray(result.data) ? result.data : [];
  return items.map((item) => ({
    ...item,
    publicUrl: getPublicPageUploadedIconUrl(item.id),
  }));
};

export const uploadPublicPageIcon = async (file) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('name', file.name);
  const response = await fetch('/api/settings/site-brand/icons', {
    method: 'POST',
    body: formData,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) {
    throw new Error(result.error || '上传图标失败');
  }
  const item = result.data || result;
  return {
    ...item,
    publicUrl: getPublicPageUploadedIconUrl(item.id),
  };
};

export const deletePublicPageIcon = async (iconId) => {
  const normalized = normalizeIconId(iconId);
  if (!normalized) return;
  const response = await fetch(`/api/settings/site-brand/icons/${encodeURIComponent(normalized)}`, {
    method: 'DELETE',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) {
    throw new Error(result.error || '删除图标失败');
  }
};
