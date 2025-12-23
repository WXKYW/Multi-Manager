/**
 * 路由汇总
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');

// 导入核心路由模块
const authRouter = require('./auth');
const healthRouter = require('./health');
const settingsRouter = require('./settings');
const logService = require('../services/log-service');
const v1Router = require('./v1');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Router');

/**
 * 注册所有路由
 */
function registerRoutes(app) {
  // 1. 基础系统路由 (无需/需认证)
  app.use('/health', healthRouter);
  app.use('/api/settings', requireAuth, settingsRouter);
  app.use('/api/logs', logService.router);
  app.use('/v1', v1Router);

  // 2. 独立认证路由 (避免干扰 /api/xxxx)
  app.use('/api/auth', authRouter);

  // 3. 动态加载功能模块路由
  const modulesDir = path.join(__dirname, '../../modules');
  
  // 模块路由映射配置 (精准匹配目录名)
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
          const routePath = moduleRouteMap[moduleName] || `/api/${moduleName.replace('-api', '')}`;
          
          // 根据模块特性决定是否应用认证中间件
          if (moduleName === 'antigravity-api' || moduleName === 'gemini-cli-api') {
            app.use(routePath, moduleRouter);
          } else {
            // 模块路由优先挂载
            app.use(routePath, requireAuth, moduleRouter);
          }
          logger.success(`模块已挂载 -> ${moduleName} [${routePath}]`);
        } catch (e) {
          logger.error(`模块加载失败: ${moduleName}`, e.message);
        }
      }
    });
  }

  // 4. 核心认证路由兼容旧版 (放在最后作为兜底，防止拦截模块路由)
  app.use('/api', authRouter); 
}

module.exports = {
  registerRoutes
};