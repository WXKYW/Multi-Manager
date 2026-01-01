/**
 * PWA Manifest 动态生成路由
 * 根据模块返回对应的 manifest.json
 */

const express = require('express');
const router = express.Router();

// 模块配置（与前端保持同步）
const MODULE_PWA_CONFIG = {
  dashboard: {
    name: 'API Monitor',
    shortName: 'Monitor',
    icon: 'default-512.png',
    themeColor: '#6366F1',
    backgroundColor: '#0d1117',
  },
  music: {
    name: 'Music Player',
    shortName: 'Music',
    icon: 'music-512.png',
    themeColor: '#8B5CF6',
    backgroundColor: '#0d1117',
  },
  server: {
    name: 'Server Monitor',
    shortName: 'Hosts',
    icon: 'server-512.png',
    themeColor: '#06B6D4',
    backgroundColor: '#0d1117',
  },
  totp: {
    name: '2FA Authenticator',
    shortName: '2FA',
    icon: 'totp-512.png',
    themeColor: '#10B981',
    backgroundColor: '#0d1117',
  },
};

// 默认配置
const DEFAULT_CONFIG = {
  name: 'API Monitor',
  shortName: 'Monitor',
  icon: 'default-512.png',
  themeColor: '#6366F1',
  backgroundColor: '#0d1117',
};

/**
 * 通用 manifest（用于主页）
 * 必须放在动态路由之前，防止匹配到 :module
 */
router.get('/manifest.json', (req, res) => {
  console.log('[PWA] 收到通用 manifest 请求');
  const manifest = {
    name: 'API Monitor',
    short_name: 'Monitor',
    description: 'API Monitor - 多功能监控面板',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    theme_color: '#6366F1',
    background_color: '#0d1117',
    icons: [
      {
        src: '/logo.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/pwa/icons/default-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa/icons/default-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
    categories: ['utilities', 'productivity'],
    lang: 'zh-CN',
  };

  res.setHeader('Content-Type', 'application/manifest+json');
  res.json(manifest);
});

/**
 * 动态生成 manifest.json
 * GET /pwa/:module/manifest.json
 */
router.get('/:module/manifest.json', (req, res) => {
  const { module } = req.params;
  console.log(`[PWA] 收到模块 manifest 请求: ${module}`);

  // 如果请求的是 /pwa/manifest.json 但没有匹配到上面的路由（不应该发生），兜底返回通用
  if (module === 'manifest.json') {
    return res.redirect('/pwa/manifest.json');
  }

  const config = MODULE_PWA_CONFIG[module] || DEFAULT_CONFIG;

  const manifest = {
    name: config.name,
    short_name: config.shortName,
    description: `${config.name} - API Monitor 单页应用`,
    start_url: `/s/${module}`,
    scope: `/s/${module}`,
    display: 'standalone',
    orientation: 'any',
    theme_color: config.themeColor,
    background_color: config.backgroundColor,
    icons: [
      {
        src: `/pwa/icons/${config.icon.replace('-512', '-192')}`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `/pwa/icons/${config.icon}`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
    categories: ['utilities', 'productivity'],
    lang: 'zh-CN',
  };

  res.setHeader('Content-Type', 'application/manifest+json');
  res.json(manifest);
});

module.exports = router;
