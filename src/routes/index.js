/**
 * 路由汇总
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');

// 导入各个路由模块
const authRouter = require('./auth');
const healthRouter = require('./health');
const settingsRouter = require('./settings');
const logService = require('../services/log-service');

// 导入聚合的 v1 路由
const v1Router = require('./v1');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Router');

/**
 * 注册所有路由
 */
function registerRoutes(app) {
  const fs = require('fs');
  const path = require('path');

  // 健康检查（不需要认证）
  app.use('/health', healthRouter);

  // 系统设置路由（需要认证）
  app.use('/api/settings', requireAuth, settingsRouter);

  // 系统日志路由
  app.use('/api/logs', logService.router);

  // 挂载聚合的 OpenAI 兼容接口
  app.use('/v1', v1Router);

  // 动态加载模块路由
  const modulesDir = path.join(__dirname, '../../modules');

  // 模块路由映射配置
  const moduleRouteMap = {
    'zeabur-api': '/api/zeabur',
    'koyeb-api': '/api/koyeb',
    'cloudflare-dns': '/api/cf-dns',
    'fly-api': '/api/fly',
    'openai-api': '/api/openai',
    'openlist-api': '/api/openlist',
    'server-management': '/api/server',
    'antigravity-api': '/api/antigravity',
    'gemini-cli-api': '/api/gemini-cli-api'
  };

  if (fs.existsSync(modulesDir)) {
    const modules = fs.readdirSync(modulesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('_'))
      .map(dirent => dirent.name);

    modules.forEach(moduleName => {
      const routerPath = path.join(modulesDir, moduleName, 'router.js');

      if (fs.existsSync(routerPath)) {
        try {
          const moduleRouter = require(routerPath);
          // 强制从映射表获取路径
          const routePath = moduleRouteMap[moduleName] || `/api/${moduleName}`;
          
          console.log(`[Router] 正在挂载模块: ${moduleName} -> ${routePath}`);

          if (moduleName === 'antigravity-api' || moduleName === 'gemini-cli-api') {
            app.use(routePath, moduleRouter);
          } else {
            app.use(routePath, requireAuth, moduleRouter);
          }
          logger.success(`模块已挂载 -> ${moduleName} [${routePath}]`);
        } catch (e) {
          logger.error(`模块加载失败: ${moduleName}`, e);
        }
      }
    });
  }

  // 认证相关路由 (放在最后作为兜底)
  app.use('/api', authRouter);
}

module.exports = {
  registerRoutes
};