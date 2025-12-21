/**
 * Cloudflare DNS 管理 - API 路由
 */

const express = require('express');
const router = express.Router();
const storage = require('./storage');
const cfApi = require('./cloudflare-api');
const { createLogger } = require('../../src/utils/logger');

const logger = createLogger('CF-DNS');

// ==================== 账号管理 ====================

/**
 * 获取所有账号（隐藏 API Token�?
 */
router.get('/accounts', (req, res) => {
  try {
    const accounts = storage.getAccounts();
    // 隐藏敏感信息
    const safeAccounts = accounts.map(a => ({
      id: a.id,
      name: a.name,
      email: a.email,
      createdAt: a.createdAt,
      lastUsed: a.lastUsed,
      hasToken: !!a.apiToken
    }));
    res.json(safeAccounts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 导出所有账号（包含 API Token，用于备份）
 */
router.get('/accounts/export', (req, res) => {
  try {
    const accounts = storage.getAccounts();
    // 返回完整信息用于导出
    const exportAccounts = accounts.map(a => ({
      name: a.name,
      email: a.email,
      apiToken: a.apiToken
    }));
    res.json({
      success: true,
      accounts: exportAccounts
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 添加账号
 */
router.post('/accounts', async (req, res) => {
  try {
    const { name, apiToken, email, skipVerify } = req.body;

    if (!name || !apiToken) {
      return res.status(400).json({ error: '名称�?API Token 必填' });
    }

    // 验证 Token（除非明确跳过验证，用于数据导入�?
    if (!skipVerify) {
      // 根据是否�?email 选择验证方式
      const auth = email
        ? { email, key: apiToken }  // Global API Key
        : apiToken;  // API Token

      const verification = await cfApi.verifyToken(auth);
      if (!verification.valid) {
        return res.status(400).json({ error: `Token 无效: ${verification.error}` });
      }
    }

    const account = storage.addAccount({ name, apiToken, email });
    res.json({
      success: true,
      account: {
        id: account.id,
        name: account.name,
        email: account.email,
        createdAt: account.createdAt
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 更新账号
 */
router.put('/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, apiToken, email } = req.body;

    // 如果更新 Token，先验证
    if (apiToken) {
      // 根据是否�?email 选择验证方式
      const auth = email
        ? { email, key: apiToken }  // Global API Key
        : apiToken;  // API Token

      const verification = await cfApi.verifyToken(auth);
      if (!verification.valid) {
        return res.status(400).json({ error: `Token 无效: ${verification.error}` });
      }
    }

    const updated = storage.updateAccount(id, { name, apiToken, email });
    if (!updated) {
      return res.status(404).json({ error: '账号不存�? });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除账号
 */
router.delete('/accounts/:id', (req, res) => {
  try {
    const { id } = req.params;
    const deleted = storage.deleteAccount(id);
    if (!deleted) {
      return res.status(404).json({ error: '账号不存�? });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 验证账号 Token
 */
router.post('/accounts/:id/verify', async (req, res) => {
  try {
    const { id } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    // 根据账号配置选择认证方式
    const auth = account.email
      ? { email: account.email, key: account.apiToken }  // Global API Key
      : account.apiToken;  // API Token

    const verification = await cfApi.verifyToken(auth);
    res.json(verification);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 获取账号�?API Token（用于显示）
 */
router.get('/accounts/:id/token', (req, res) => {
  try {
    const { id } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    res.json({
      success: true,
      apiToken: account.apiToken
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Zone 管理 ====================

/**
 * 获取账号下的所有域�?
 */
router.get('/accounts/:id/zones', async (req, res) => {
  try {
    const { id } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(id);

    // 根据账号配置选择认证方式
    const auth = account.email
      ? { email: account.email, key: account.apiToken }
      : account.apiToken;

    const { zones, resultInfo } = await cfApi.listZones(auth);

    res.json({
      zones: zones.map(z => ({
        id: z.id,
        name: z.name,
        status: z.status,
        paused: z.paused,
        type: z.type,
        nameServers: z.name_servers,
        createdOn: z.created_on,
        modifiedOn: z.modified_on
      })),
      pagination: resultInfo
    });
  } catch (e) {
    logger.error(`获取域名列表失败 (ID: ${req.params.id}):`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 创建域名 (添加�?Zone)
 */
router.post('/accounts/:id/zones', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, jumpStart } = req.body;

    if (!name) {
      return res.status(400).json({ error: '域名不能为空' });
    }

    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(id);

    // 获取 Cloudflare Account ID
    const cfAccountId = await cfApi.getAccountId(account.apiToken);

    // 创建新域�?
    const zone = await cfApi.createZone(account.apiToken, name, {
      account: { id: cfAccountId },
      jump_start: jumpStart !== undefined ? jumpStart : false
    });

    logger.info(`域名创建成功: ${name} (Zone ID: ${zone.id})`);

    res.json({
      success: true,
      zone: {
        id: zone.id,
        name: zone.name,
        status: zone.status,
        nameServers: zone.name_servers,
        createdOn: zone.created_on
      }
    });
  } catch (e) {
    logger.error(`创建域名失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除域名 (删除 Zone)
 */
router.delete('/accounts/:accountId/zones/:zoneId', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);
    const result = await cfApi.deleteZone(account.apiToken, zoneId);

    logger.info(`域名删除成功: Zone ID ${zoneId}`);

    res.json({
      success: true,
      result
    });
  } catch (e) {
    logger.error(`删除域名失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== DNS 记录管理 ====================

/**
 * 获取域名�?DNS 记录
 */
router.get('/accounts/:accountId/zones/:zoneId/records', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;
    const { type, name, page } = req.query;

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);

    // 根据账号配置选择认证方式
    const auth = account.email
      ? { email: account.email, key: account.apiToken }
      : account.apiToken;

    const { records, resultInfo } = await cfApi.listDnsRecords(
      auth,
      zoneId,
      { type, name, page }
    );

    res.json({
      records: records.map(r => ({
        id: r.id,
        type: r.type,
        name: r.name,
        content: r.content,
        proxied: r.proxied,
        ttl: r.ttl,
        priority: r.priority,
        createdOn: r.created_on,
        modifiedOn: r.modified_on
      })),
      pagination: resultInfo
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 创建 DNS 记录
 */
router.post('/accounts/:accountId/zones/:zoneId/records', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;
    const { type, name, content, ttl, proxied, priority } = req.body;

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    // 验证记录
    const validation = cfApi.validateDnsRecord({ type, name, content, priority });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.errors.join(', ') });
    }

    storage.touchAccount(accountId);
    const record = await cfApi.createDnsRecord(
      account.apiToken,
      zoneId,
      { type, name, content, ttl, proxied, priority }
    );

    res.json({
      success: true,
      record: {
        id: record.id,
        type: record.type,
        name: record.name,
        content: record.content,
        proxied: record.proxied,
        ttl: record.ttl
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 更新 DNS 记录
 */
router.put('/accounts/:accountId/zones/:zoneId/records/:recordId', async (req, res) => {
  try {
    const { accountId, zoneId, recordId } = req.params;
    const { type, name, content, ttl, proxied, priority } = req.body;

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);
    const record = await cfApi.updateDnsRecord(
      account.apiToken,
      zoneId,
      recordId,
      { type, name, content, ttl, proxied, priority }
    );

    res.json({
      success: true,
      record: {
        id: record.id,
        type: record.type,
        name: record.name,
        content: record.content,
        proxied: record.proxied,
        ttl: record.ttl
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除 DNS 记录
 */
router.delete('/accounts/:accountId/zones/:zoneId/records/:recordId', async (req, res) => {
  try {
    const { accountId, zoneId, recordId } = req.params;

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);
    await cfApi.deleteDnsRecord(account.apiToken, zoneId, recordId);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 快速切�?DNS 记录内容
 */
router.post('/accounts/:accountId/zones/:zoneId/switch', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;
    const { type, name, newContent } = req.body;

    if (!type || !name || !newContent) {
      return res.status(400).json({ error: 'type, name, newContent 必填' });
    }

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);
    const updated = await cfApi.switchDnsContent(
      account.apiToken,
      zoneId,
      type,
      name,
      newContent
    );

    res.json({
      success: true,
      updated: updated.length,
      records: updated.map(r => ({
        id: r.id,
        name: r.name,
        content: r.content
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 批量创建 DNS 记录
 */
router.post('/accounts/:accountId/zones/:zoneId/batch', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;
    const { records } = req.body;

    if (!records || !Array.isArray(records)) {
      return res.status(400).json({ error: '需要提�?records 数组' });
    }

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);
    const { results, errors } = await cfApi.batchCreateDnsRecords(
      account.apiToken,
      zoneId,
      records
    );

    res.json({
      success: errors.length === 0,
      created: results.length,
      failed: errors.length,
      results,
      errors
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 缓存管理 ====================

/**
 * 清除域名的所有缓�?
 */
router.post('/accounts/:accountId/zones/:zoneId/purge', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;
    const { purge_everything } = req.body;

    logger.info(`收到清除缓存请求 - Account: ${accountId}, Zone: ${zoneId}, Body:`, req.body);

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);

    // 根据账号配置选择认证方式
    const auth = account.email
      ? { email: account.email, key: account.apiToken }  // Global API Key
      : account.apiToken;  // API Token

    logger.info(`使用认证方式: ${account.email ? 'Global API Key' : 'API Token'}`);

    // 调用 Cloudflare API 清除缓存
    logger.info(`调用 Cloudflare API 清除缓存...`);
    const result = await cfApi.purgeCache(auth, zoneId, { purge_everything });

    logger.info(`缓存已清除成�?(Zone: ${zoneId})`);

    res.json({
      success: true,
      message: '缓存已清�?,
      result
    });
  } catch (e) {
    logger.error(`清除缓存失败:`, e.message, e.stack);
    res.status(500).json({ error: e.message, details: e.stack });
  }
});

// ==================== SSL/TLS 管理 ====================

/**
 * 获取域名的SSL/TLS信息
 */
router.get('/accounts/:accountId/zones/:zoneId/ssl', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);

    // 认证方式选择
    const auth = account.email
      ? { email: account.email, key: account.apiToken }
      : account.apiToken;

    // 并行获取多个SSL相关信息
    const [settings, certificates, verification] = await Promise.all([
      cfApi.getSslSettings(auth, zoneId),
      cfApi.getSslCertificates(auth, zoneId),
      cfApi.getSslVerification(auth, zoneId)
    ]);

    logger.info(`获取SSL信息成功 (Zone: ${zoneId})`);

    res.json({
      success: true,
      ssl: {
        mode: settings.value,
        modifiedOn: settings.modified_on,
        editable: settings.editable,
        certificates: certificates.map(cert => ({
          id: cert.id,
          type: cert.type,
          hosts: cert.hosts,
          status: cert.status,
          validityDays: cert.validity_days,
          certificateAuthority: cert.certificate_authority,
          primary: cert.primary
        })),
        verification: verification
      }
    });
  } catch (e) {
    logger.error(`获取SSL信息失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 修改域名的SSL模式
 */
router.patch('/accounts/:accountId/zones/:zoneId/ssl', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;
    const { mode } = req.body;

    if (!mode || !['off', 'flexible', 'full', 'strict'].includes(mode)) {
      return res.status(400).json({ error: '无效的SSL模式' });
    }

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);

    const auth = account.email
      ? { email: account.email, key: account.apiToken }
      : account.apiToken;

    const result = await cfApi.updateSslMode(auth, zoneId, mode);

    logger.info(`SSL模式已更�?(Zone: ${zoneId}, Mode: ${mode})`);

    res.json({
      success: true,
      ssl: {
        mode: result.value,
        modifiedOn: result.modified_on
      }
    });
  } catch (e) {
    logger.error(`更新SSL模式失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== Analytics 分析 ====================

/**
 * 获取域名的Analytics数据
 */
router.get('/accounts/:accountId/zones/:zoneId/analytics', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;
    const { timeRange = '24h' } = req.query;

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);

    const auth = account.email
      ? { email: account.email, key: account.apiToken }
      : account.apiToken;

    const analytics = await cfApi.getSimpleAnalytics(auth, zoneId, timeRange);

    logger.info(`获取Analytics成功 (Zone: ${zoneId}, Range: ${timeRange})`);

    res.json({
      success: true,
      analytics,
      timeRange
    });
  } catch (e) {
    logger.error(`获取Analytics失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== DNS 模板管理 ====================

/**
 * 获取所有模�?
 */
router.get('/templates', (req, res) => {
  try {
    const templates = storage.getTemplates();
    res.json(templates);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 添加模板
 */
router.post('/templates', (req, res) => {
  try {
    const { name, type, content, proxied, ttl, priority, description } = req.body;

    if (!name || !type || !content) {
      return res.status(400).json({ error: '名称、类型、内容必�? });
    }

    const template = storage.addTemplate({
      name, type, content, proxied, ttl, priority, description
    });

    res.json({ success: true, template });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 更新模板
 */
router.put('/templates/:id', (req, res) => {
  try {
    const { id } = req.params;
    const updated = storage.updateTemplate(id, req.body);

    if (!updated) {
      return res.status(404).json({ error: '模板不存�? });
    }

    res.json({ success: true, template: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除模板
 */
router.delete('/templates/:id', (req, res) => {
  try {
    const { id } = req.params;
    const deleted = storage.deleteTemplate(id);

    if (!deleted) {
      return res.status(404).json({ error: '模板不存�? });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 应用模板到域�?
 */
router.post('/templates/:templateId/apply', async (req, res) => {
  try {
    const { templateId } = req.params;
    const { accountId, zoneId, recordName } = req.body;

    if (!accountId || !zoneId || !recordName) {
      return res.status(400).json({ error: 'accountId, zoneId, recordName 必填' });
    }

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const templates = storage.getTemplates();
    const template = templates.find(t => t.id === templateId);
    if (!template) {
      return res.status(404).json({ error: '模板不存�? });
    }

    storage.touchAccount(accountId);
    const record = await cfApi.createDnsRecord(
      account.apiToken,
      zoneId,
      {
        type: template.type,
        name: recordName,
        content: template.content,
        ttl: template.ttl,
        proxied: template.proxied,
        priority: template.priority
      }
    );

    res.json({
      success: true,
      record: {
        id: record.id,
        type: record.type,
        name: record.name,
        content: record.content
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 实用功能 ====================

/**
 * 获取支持的记录类�?
 */
router.get('/record-types', (req, res) => {
  res.json(cfApi.getSupportedRecordTypes());
});

/**
 * 导出账号（包含完整数据，用于备份�?
 */
router.get('/export/accounts', (req, res) => {
  try {
    const accounts = storage.getAccounts();
    res.json(accounts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 批量导入账号（直接覆盖数据库�?
 */
router.post('/import/accounts', (req, res) => {
  try {
    const { accounts, overwrite } = req.body;

    if (!accounts || !Array.isArray(accounts)) {
      return res.status(400).json({ error: '需要提�?accounts 数组' });
    }

    if (overwrite) {
      // 直接覆盖所有账�?
      storage.saveAccounts(accounts);
    } else {
      // 追加账号
      accounts.forEach(account => {
        storage.addAccount(account);
      });
    }

    res.json({ success: true, count: accounts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 批量导入模板（直接覆盖数据库�?
 */
router.post('/import/templates', (req, res) => {
  try {
    const { templates, overwrite } = req.body;

    if (!templates || !Array.isArray(templates)) {
      return res.status(400).json({ error: '需要提�?templates 数组' });
    }

    if (overwrite) {
      // 直接覆盖所有模�?
      storage.saveTemplates(templates);
    } else {
      // 追加模板
      templates.forEach(template => {
        storage.addTemplate(template);
      });
    }

    res.json({ success: true, count: templates.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Workers 管理 ====================

/**
 * 获取账号�?Cloudflare Account ID
 */
router.get('/accounts/:id/cf-account-id', async (req, res) => {
  try {
    const { id } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    res.json({ success: true, cfAccountId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 获取账号下的所�?Workers
 */
router.get('/accounts/:id/workers', async (req, res) => {
  try {
    const { id } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(id);

    // 先获�?CF Account ID
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    const workers = await cfApi.listWorkers(account.apiToken, cfAccountId);
    logger.info(`获取�?${workers.length} �?Workers (Account: ${cfAccountId})`);

    // 获取子域名信�?
    const subdomain = await cfApi.getWorkersSubdomain(account.apiToken, cfAccountId);

    res.json({
      workers: workers.map(w => ({
        id: w.id,
        name: w.id, // Worker �?id 就是名称
        createdOn: w.created_on,
        modifiedOn: w.modified_on,
        etag: w.etag
      })),
      subdomain: subdomain?.subdomain || null,
      cfAccountId
    });
  } catch (e) {
    logger.error(`获取 Workers 列表失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 获取 Worker 脚本内容
 */
router.get('/accounts/:id/workers/:scriptName', async (req, res) => {
  try {
    const { id, scriptName } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    const worker = await cfApi.getWorkerScript(account.apiToken, cfAccountId, scriptName);

    res.json({
      success: true,
      worker: {
        name: worker.name,
        script: worker.script,
        meta: worker.meta
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 创建或更�?Worker 脚本
 */
router.put('/accounts/:id/workers/:scriptName', async (req, res) => {
  try {
    const { id, scriptName } = req.params;
    const { script, bindings, compatibility_date } = req.body;

    logger.info(`保存 Worker: ${scriptName}, 脚本长度: ${script?.length || 0}`);

    if (!script) {
      return res.status(400).json({ error: '脚本内容不能为空' });
    }

    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(id);
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    logger.info(`CF Account ID: ${cfAccountId}`);

    const result = await cfApi.putWorkerScript(
      account.apiToken,
      cfAccountId,
      scriptName,
      script,
      { bindings, compatibility_date }
    );

    res.json({
      success: true,
      worker: result
    });
  } catch (e) {
    logger.error(`保存 Worker 失败:`, e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除 Worker 脚本
 */
router.delete('/accounts/:id/workers/:scriptName', async (req, res) => {
  try {
    const { id, scriptName } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(id);
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    await cfApi.deleteWorkerScript(account.apiToken, cfAccountId, scriptName);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 启用/禁用 Worker (子域访问)
 */
router.post('/accounts/:id/workers/:scriptName/toggle', async (req, res) => {
  try {
    const { id, scriptName } = req.params;
    const { enabled } = req.body;

    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(id);
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    const result = await cfApi.setWorkerEnabled(account.apiToken, cfAccountId, scriptName, enabled);

    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 获取域名�?Worker 路由
 */
router.get('/accounts/:accountId/zones/:zoneId/workers/routes', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;
    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);
    const routes = await cfApi.listWorkerRoutes(account.apiToken, zoneId);

    res.json({
      routes: routes.map(r => ({
        id: r.id,
        pattern: r.pattern,
        script: r.script
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 创建 Worker 路由
 */
router.post('/accounts/:accountId/zones/:zoneId/workers/routes', async (req, res) => {
  try {
    const { accountId, zoneId } = req.params;
    const { pattern, script } = req.body;

    if (!pattern || !script) {
      return res.status(400).json({ error: 'pattern �?script 必填' });
    }

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);
    const route = await cfApi.createWorkerRoute(account.apiToken, zoneId, pattern, script);

    res.json({
      success: true,
      route: {
        id: route.id,
        pattern: route.pattern,
        script: route.script
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 更新 Worker 路由
 */
router.put('/accounts/:accountId/zones/:zoneId/workers/routes/:routeId', async (req, res) => {
  try {
    const { accountId, zoneId, routeId } = req.params;
    const { pattern, script } = req.body;

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);
    const route = await cfApi.updateWorkerRoute(account.apiToken, zoneId, routeId, pattern, script);

    res.json({
      success: true,
      route: {
        id: route.id,
        pattern: route.pattern,
        script: route.script
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除 Worker 路由
 */
router.delete('/accounts/:accountId/zones/:zoneId/workers/routes/:routeId', async (req, res) => {
  try {
    const { accountId, zoneId, routeId } = req.params;
    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(accountId);
    await cfApi.deleteWorkerRoute(account.apiToken, zoneId, routeId);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 获取 Worker 统计信息
 */
router.get('/accounts/:id/workers/:scriptName/analytics', async (req, res) => {
  try {
    const { id, scriptName } = req.params;
    const { since } = req.query;

    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    const analytics = await cfApi.getWorkerAnalytics(account.apiToken, cfAccountId, scriptName, since);

    res.json({ success: true, analytics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Workers 自定义域名管�?====================

/**
 * 获取 Worker 的自定义域名列表
 */
router.get('/accounts/:id/workers/:scriptName/domains', async (req, res) => {
  try {
    const { id, scriptName } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    const domains = await cfApi.listWorkerDomains(account.apiToken, cfAccountId, scriptName);

    res.json({
      success: true,
      domains: domains.map(d => ({
        id: d.id,
        hostname: d.hostname,
        service: d.service,
        environment: d.environment,
        zoneId: d.zone_id,
        zoneName: d.zone_name
      }))
    });
  } catch (e) {
    logger.error(`获取 Worker 域名失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 添加 Worker 自定义域�?
 */
router.post('/accounts/:id/workers/:scriptName/domains', async (req, res) => {
  try {
    const { id, scriptName } = req.params;
    const { hostname, environment } = req.body;

    if (!hostname) {
      return res.status(400).json({ error: '请输入域�? });
    }

    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(id);
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    const result = await cfApi.addWorkerDomain(account.apiToken, cfAccountId, scriptName, hostname, environment || 'production');

    res.json({ success: true, domain: result });
  } catch (e) {
    logger.error(`添加 Worker 域名失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除 Worker 自定义域�?
 */
router.delete('/accounts/:id/workers/:scriptName/domains/:domainId', async (req, res) => {
  try {
    const { id, scriptName, domainId } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(id);
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    await cfApi.deleteWorkerDomain(account.apiToken, cfAccountId, domainId);

    res.json({ success: true });
  } catch (e) {
    logger.error(`删除 Worker 域名失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== Pages 管理路由 ====================


/**
 * 获取 Pages 项目列表
 */
router.get('/accounts/:id/pages', async (req, res) => {
  try {
    const { id } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    storage.touchAccount(id);
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    const projects = await cfApi.listPagesProjects(account.apiToken, cfAccountId);

    logger.info(`获取�?${projects.length} �?Pages 项目 (Account: ${cfAccountId})`);

    res.json({
      projects: projects.map(p => ({
        name: p.name,
        subdomain: p.subdomain,
        domains: p.domains || [],
        createdOn: p.created_on,
        productionBranch: p.production_branch,
        latestDeployment: p.latest_deployment ? {
          id: p.latest_deployment.id,
          url: p.latest_deployment.url,
          status: p.latest_deployment.latest_stage?.status || 'unknown',
          createdOn: p.latest_deployment.created_on
        } : null
      })),
      cfAccountId
    });
  } catch (e) {
    logger.error(`获取 Pages 项目失败:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 获取 Pages 项目的部署列�?
 */
router.get('/accounts/:id/pages/:projectName/deployments', async (req, res) => {
  try {
    const { id, projectName } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    const deployments = await cfApi.listPagesDeployments(account.apiToken, cfAccountId, projectName);

    res.json({
      success: true,
      deployments: (deployments || []).map(d => {
        // 防御性处理：防止 d 为空或字段缺�?
        if (!d) return null;
        return {
          id: d.id,
          url: d.url,
          environment: d.environment,
          status: (d.latest_stage && d.latest_stage.status) ? d.latest_stage.status : 'unknown',
          createdOn: d.created_on,
          source: d.source,
          buildConfig: d.build_config
        };
      }).filter(d => d !== null) // 过滤掉无效项
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除 Pages 部署
 */
router.delete('/accounts/:id/pages/:projectName/deployments/:deploymentId', async (req, res) => {
  try {
    const { id, projectName, deploymentId } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    await cfApi.deletePagesDeployment(account.apiToken, cfAccountId, projectName, deploymentId);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 获取 Pages 项目的自定义域名
 */
router.get('/accounts/:id/pages/:projectName/domains', async (req, res) => {
  try {
    const { id, projectName } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    const domains = await cfApi.listPagesDomains(account.apiToken, cfAccountId, projectName);

    res.json({
      success: true,
      domains: domains.map(d => ({
        id: d.id,
        name: d.name,
        status: d.status,
        validationStatus: d.validation_data?.status || null,
        createdOn: d.created_on
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 添加 Pages 自定义域�?
 */
router.post('/accounts/:id/pages/:projectName/domains', async (req, res) => {
  try {
    const { id, projectName } = req.params;
    const { domain } = req.body;

    if (!domain) {
      return res.status(400).json({ error: '请输入域�? });
    }

    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    const result = await cfApi.addPagesDomain(account.apiToken, cfAccountId, projectName, domain);

    res.json({ success: true, domain: result.result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除 Pages 自定义域�?
 */
router.delete('/accounts/:id/pages/:projectName/domains/:domain', async (req, res) => {
  try {
    const { id, projectName, domain } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    await cfApi.deletePagesDomain(account.apiToken, cfAccountId, projectName, domain);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 删除 Pages 项目
 */
router.delete('/accounts/:id/pages/:projectName', async (req, res) => {
  try {
    const { id, projectName } = req.params;
    const account = storage.getAccountById(id);
    if (!account) {
      return res.status(404).json({ error: '账号不存�? });
    }

    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    await cfApi.deletePagesProject(account.apiToken, cfAccountId, projectName);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== R2 �洢���� ====================

/**
 * ��ȡ R2 �洢Ͱ�б�
 */
router.get('/accounts/:accountId/r2/buckets', async (req, res) => {
  try {
    const { accountId } = req.params;
    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '�˺Ų�����' });
    }

    const auth = account.email ? { email: account.email, key: account.apiToken } : account.apiToken;
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    
    const buckets = await cfApi.listR2Buckets(auth, cfAccountId);
    res.json({ success: true, buckets });
  } catch (e) {
    logger.error(��ȡ R2 �洢Ͱʧ��:, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * ���� R2 �洢Ͱ
 */
router.post('/accounts/:accountId/r2/buckets', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { name, location } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Ͱ���Ʊ���' });
    }

    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '�˺Ų�����' });
    }

    const auth = account.email ? { email: account.email, key: account.apiToken } : account.apiToken;
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    
    const bucket = await cfApi.createR2Bucket(auth, cfAccountId, name, location);
    res.json({ success: true, bucket });
  } catch (e) {
    logger.error(���� R2 �洢Ͱʧ��:, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * ɾ�� R2 �洢Ͱ
 */
router.delete('/accounts/:accountId/r2/buckets/:bucketName', async (req, res) => {
  try {
    const { accountId, bucketName } = req.params;
    
    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '�˺Ų�����' });
    }

    const auth = account.email ? { email: account.email, key: account.apiToken } : account.apiToken;
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    
    await cfApi.deleteR2Bucket(auth, cfAccountId, bucketName);
    res.json({ success: true });
  } catch (e) {
    logger.error(ɾ�� R2 �洢Ͱʧ��:, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * �г� R2 ����
 */
router.get('/accounts/:accountId/r2/buckets/:bucketName/objects', async (req, res) => {
  try {
    const { accountId, bucketName } = req.params;
    const { prefix, cursor, limit, delimiter } = req.query;
    
    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '�˺Ų�����' });
    }

    const auth = account.email ? { email: account.email, key: account.apiToken } : account.apiToken;
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    
    const result = await cfApi.listR2Objects(auth, cfAccountId, bucketName, {
      prefix, cursor, limit, delimiter
    });
    
    res.json({ success: true, ...result });
  } catch (e) {
    logger.error(�г� R2 ����ʧ��:, e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * ɾ�� R2 ����
 */
router.delete('/accounts/:accountId/r2/buckets/:bucketName/objects/:objectKey', async (req, res) => {
  try {
    const { accountId, bucketName, objectKey } = req.params;
    
    const account = storage.getAccountById(accountId);
    if (!account) {
      return res.status(404).json({ error: '�˺Ų�����' });
    }

    const auth = account.email ? { email: account.email, key: account.apiToken } : account.apiToken;
    const cfAccountId = await cfApi.getAccountId(account.apiToken);
    
    await cfApi.deleteR2Object(auth, cfAccountId, bucketName, objectKey);
    res.json({ success: true });
  } catch (e) {
    logger.error(ɾ�� R2 ����ʧ��:, e.message);
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;
