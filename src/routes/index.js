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

  // 3. Agent 公开接口 (不需要认证，必须在 /api/server 模块之前挂载)
  const agentPublicRouter = express.Router();
  const agentService = require('../../modules/server-management/agent-service');
  const { serverStorage } = require('../../modules/server-management/storage');

  // Agent 数据推送 (由远程 Agent 调用)
  agentPublicRouter.post('/push', (req, res) => {
    try {
      const serverId = req.headers['x-server-id'];
      const agentKey = req.headers['x-agent-key'];

      if (!serverId) {
        return res.status(400).json({ success: false, error: '缺少 Server ID' });
      }

      if (!agentService.verifyAgent(serverId, agentKey)) {
        return res.status(401).json({ success: false, error: '无效的 Agent 密钥' });
      }

      const metrics = agentService.processMetrics(serverId, req.body);
      serverStorage.updateStatus(serverId, { status: 'online' });

      logger.info(`[Agent Push] 收到来自服务器 ${serverId} 的指标数据`);
      res.json({ success: true, received: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 支持 GET 请求以供健康检查和调试
  agentPublicRouter.get('/push', (req, res) => {
    res.json({
      success: true,
      message: 'Agent 推送接口运行中',
      method: 'POST',
      tip: '请使用 POST 请求并携带正确的 Header (X-Server-ID, X-Agent-Key) 推送指标数据'
    });
  });

  // Agent 路由根路径说明
  agentPublicRouter.get('/', (req, res) => {
    res.json({
      success: true,
      message: 'API Monitor Agent 公开接口',
      endpoints: [
        { path: '/push', method: 'POST', description: '数据推送' },
        { path: '/install/:serverId', method: 'GET', description: '安装脚本下载' }
      ]
    });
  });

  // Agent 安装脚本下载 (由远程服务器通过 curl 调用)
  agentPublicRouter.get('/install/:serverId', (req, res) => {
    try {
      const { serverId } = req.params;
      const server = serverStorage.getById(serverId);

      if (!server) {
        return res.status(404).send('# Error: Server not found');
      }

      const protocol = req.protocol;
      const host = req.get('host');
      const serverUrl = `${protocol}://${host}`;

      const script = agentService.generateInstallScript(serverId, serverUrl);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(script);
    } catch (error) {
      res.status(500).send(`# Error: ${error.message}`);
    }
  });

  // --- 以下为需要认证的 Agent 管理接口 ---

  // 获取 Agent 安装命令 (前端弹窗使用)
  agentPublicRouter.get('/command/:serverId', requireAuth, (req, res) => {
    try {
      const { serverId } = req.params;
      const server = serverStorage.getById(serverId);
      if (!server) return res.status(404).json({ success: false, error: '主机不存在' });

      const protocol = req.protocol;
      const host = req.get('host');
      const serverUrl = `${protocol}://${host}`;
      const installUrl = `${serverUrl}/api/server/agent/install/${serverId}`;

      res.json({
        success: true,
        data: {
          serverId,
          serverName: server.name,
          installCommand: `curl -fsSL ${installUrl} | sudo bash`,
          apiUrl: `${serverUrl}/api/server/agent/push`,
          agentKey: agentService.getAgentKey(serverId)
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 重新生成全局 Agent 密钥
  agentPublicRouter.post('/regenerate-key', requireAuth, (req, res) => {
    try {
      const newKey = agentService.regenerateGlobalKey();
      res.json({ success: true, key: newKey });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 自动安装 Agent (通过 SSH)
  agentPublicRouter.post('/auto-install/:serverId', requireAuth, async (req, res) => {
    try {
      const { serverId } = req.params;
      const server = serverStorage.getById(serverId);
      const sshService = require('../../modules/server-management/ssh-service');

      if (!server) return res.status(404).json({ success: false, error: '主机不存在' });

      const protocol = req.protocol;
      const host = req.get('host');
      const serverUrl = `${protocol}://${host}`;
      const script = agentService.generateInstallScript(serverId, serverUrl);

      const result = await sshService.executeCommand(serverId, server, `cat << 'EOF' > /tmp/agent_install.sh\n${script}\nEOF\nsudo bash /tmp/agent_install.sh`);

      if (result.success) {
        serverStorage.updateStatus(serverId, { status: 'online' });
        res.json({ success: true, message: 'Agent 安装命令已执行', output: result.stdout });
      } else {
        res.status(500).json({ success: false, error: '安装执行失败', details: result.stderr || result.error });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 卸载 Agent (通过 SSH)
  agentPublicRouter.post('/uninstall/:serverId', requireAuth, async (req, res) => {
    try {
      const { serverId } = req.params;
      const server = serverStorage.getById(serverId);
      const sshService = require('../../modules/server-management/ssh-service');

      if (!server) return res.status(404).json({ success: false, error: '主机不存在' });

      const script = agentService.generateUninstallScript();
      const result = await sshService.executeCommand(serverId, server, `cat << 'EOF' > /tmp/agent_uninstall.sh\n${script}\nEOF\nsudo bash /tmp/agent_uninstall.sh`);

      if (result.success) {
        res.json({ success: true, message: 'Agent 卸载命令已执行' });
      } else {
        res.status(500).json({ success: false, error: '卸载执行失败', details: result.stderr || result.error });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.use('/api/server/agent', agentPublicRouter);
  logger.info('Agent 公开接口已挂载 -> /api/server/agent');

  // 4. 动态加载功能模块路由
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

  // 5. 核心认证路由兼容旧版 (放在最后作为兜底，防止拦截模块路由)
  app.use('/api', authRouter);
}

module.exports = {
  registerRoutes
};