const express = require('express');
const router = express.Router();
const storage = require('./storage');
const axios = require('axios');

console.log('🚀 Fly.io Router Loaded');

const FLY_API_URL = 'https://api.fly.io/graphql';
const FLY_MACHINES_URL = 'https://api.machines.dev/v1';

// Helper to make Fly.io GraphQL requests
async function flyRequest(query, variables, token) {
  try {
    const response = await axios.post(FLY_API_URL, {
      query,
      variables
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'API-Monitor/1.0'
      },
      timeout: 15000 // 15s timeout
    });

    if (response.data.errors) {
      console.error('[Fly.io] GraphQL Query Errors:', JSON.stringify(response.data.errors, null, 2));
    }

    return response.data;
  } catch (error) {
    if (error.response) {
      console.error('[Fly.io] API HTTP Error:', error.response.status, JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('[Fly.io] API Network Error:', error.message);
    }
    throw error;
  }
}

// Helper to make Fly.io Machines API requests (REST)
async function machineRequest(method, path, token, data = null) {
  try {
    const response = await axios({
      method,
      url: `${FLY_MACHINES_URL}${path}`,
      data,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'API-Monitor/1.0'
      },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error(`[Fly.io] Machines API Error [${path}]:`, error.response ? error.response.status : error.message);
    throw error;
  }
}

// 获取所有账号
router.get('/fly/accounts', async (req, res) => {
  try {
    const accounts = await storage.getAccounts();
    // 隐藏 token
    const safeAccounts = accounts.map(acc => {
      const { api_token, ...rest } = acc;
      return { ...rest, has_token: !!api_token };
    });
    res.json({ success: true, data: safeAccounts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 导出所有账号 (包含 Token)
router.get('/fly/accounts/export', async (req, res) => {
  try {
    const accounts = await storage.getAccounts();
    res.json({ success: true, accounts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 添加账号
router.post('/fly/accounts', async (req, res) => {
  try {
    const { name, api_token } = req.body;
    if (!name || !api_token) {
      return res.status(400).json({ success: false, error: '名称和 API Token 必填' });
    }

    // 验证 Token 有效性并获取用户信息
    const query = `
      query {
        viewer {
          email
        }
        organizations {
          nodes {
            id
            slug
            name
          }
        }
      }
    `;

    let email = '';
    let defaultOrg = '';

    try {
      const result = await flyRequest(query, {}, api_token);
      if (result.errors) {
        throw new Error(result.errors[0].message);
      }
      email = result.data.viewer.email;
      // 默认取第一个组织
      if (result.data.organizations.nodes.length > 0) {
        defaultOrg = result.data.organizations.nodes[0].id;
      }
    } catch (e) {
      return res.status(400).json({ success: false, error: '无效的 API Token: ' + e.message });
    }

    const account = await storage.addAccount({
      name,
      api_token,
      email,
      organization_id: defaultOrg
    });

    res.json({ success: true, data: account });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除账号
router.delete('/fly/accounts/:id', async (req, res) => {
  try {
    await storage.deleteAccount(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 代理获取 Apps 列表 (Dashboard 数据)
router.get('/fly/proxy/apps', async (req, res) => {
  try {
    const accounts = await storage.getAccounts();
    const results = [];

    // 并行获取所有账号的数据
    await Promise.all(accounts.map(async (account) => {
      const query = `
        query {
          apps {
            nodes {
              id
              name
              status
              deployed
              hostname
              appUrl
              organization {
                slug
              }
              currentRelease {
                createdAt
                status
              }
              machines {
                nodes {
                  id
                  region
                  state
                }
              }
              certificates {
                nodes {
                  hostname
                  clientStatus
                }
              }
              ipAddresses {
                nodes {
                  address
                  type
                }
              }
            }
          }
        }
      `;

      try {
        const result = await flyRequest(query, {}, account.api_token);
        if (result.data && result.data.apps) {
          results.push({
            accountId: account.id,
            accountName: account.name,
            apps: result.data.apps.nodes
          });
        }
      } catch (e) {
        console.error(`Fetch Fly.io data failed for ${account.name}:`, e.message);
        results.push({
          accountId: account.id,
          accountName: account.name,
          error: e.message,
          apps: []
        });
      }
    }));

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 重启应用
router.post('/fly/apps/:appName/restart', async (req, res) => {
  try {
    const { appName } = req.params;
    const { accountId, appId } = req.body;
    
    const targetName = appName; 
    console.log(`[Fly.io] Restarting app: ${targetName} for account: ${accountId}`);
    
    const account = await storage.getAccount(accountId);
    if (!account) return res.status(404).json({ success: false, error: '账号不存在' });

    try {
        // 1. 优先尝试 Machines API (V2 应用)
        const machines = await machineRequest('GET', `/apps/${targetName}/machines`, account.api_token);
        
        if (Array.isArray(machines) && machines.length > 0) {
            console.log(`[Fly.io] Restarting ${machines.length} machines via REST API...`);
            const restartPromises = machines.map(m => 
                machineRequest('POST', `/apps/${targetName}/machines/${m.id}/restart`, account.api_token)
                    .catch(err => ({ error: true, id: m.id, message: err.message }))
            );
            const results = await Promise.all(restartPromises);
            const failedCount = results.filter(r => r.error).length;
            return res.json({ success: failedCount < machines.length, mode: 'machines', results });
        }

        // 2. 如果没有 Machines，尝试 GraphQL (V1 应用)
        console.log(`[Fly.io] No machines found, falling back to GraphQL restartApp`);
        const mutation = `mutation($appId: ID!) { restartApp(input: { appId: $appId }) { app { name } } }`;
        const result = await flyRequest(mutation, { appId: targetName }, account.api_token);
        if (result.errors) throw new Error(result.errors[0].message);
        
        res.json({ success: true, mode: 'graphql', data: result.data.restartApp });
    } catch (apiError) {
        const status = apiError.response ? apiError.response.status : 500;
        res.status(status).json({ success: false, error: apiError.message });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 重新部署应用 (对于 V2 应用，重启所有机器通常等同于重新加载)
router.post('/fly/apps/:appName/redeploy', async (req, res) => {
  try {
    const { appName } = req.params;
    const { accountId } = req.body;
    
    const account = await storage.getAccount(accountId);
    if (!account) return res.status(404).json({ success: false, error: '账号不存在' });

    console.log(`[Fly.io] Triggering redeploy for ${appName}...`);

    let graphqlError = null;
    try {
        // 1. 首先尝试 GraphQL 方式
        const mutation = `
          mutation($appId: ID!) {
            restartApp(input: { appId: $appId }) {
              app { name }
            }
          }
        `;
        const result = await flyRequest(mutation, { appId: appName }, account.api_token);
        
        if (!result.errors) {
            return res.json({ success: true, mode: 'graphql', data: result.data.restartApp });
        }
        graphqlError = result.errors[0].message;
    } catch (e) {
        graphqlError = e.message;
    }

    // 2. 如果 GraphQL 失败 (报错或抛出 500)，强制回退到 Machines 重启
    console.warn(`[Fly.io] GraphQL Redeploy failed (${graphqlError}), performing machine-based fallback for ${appName}...`);
    
    try {
        const machines = await machineRequest('GET', `/apps/${appName}/machines`, account.api_token);
        if (Array.isArray(machines) && machines.length > 0) {
            console.log(`[Fly.io] Falling back to restarting ${machines.length} machines...`);
            const results = await Promise.all(machines.map(m => 
                machineRequest('POST', `/apps/${appName}/machines/${m.id}/restart`, account.api_token)
                    .catch(err => ({ error: true, id: m.id, message: err.message }))
            ));
            return res.json({ 
                success: true, 
                mode: 'machines-fallback', 
                message: 'GraphQL 接口异常，已自动通过 Machines API 完成重启',
                details: results 
            });
        }
        throw new Error(graphqlError || '应用无可用实例且 GraphQL 接口异常');
    } catch (apiError) {
        console.error(`[Fly.io] All redeploy methods failed for ${appName}:`, apiError.message);
        res.status(500).json({ success: false, error: '部署操作失败: ' + apiError.message });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取实例 (Machines) 详情
router.get('/fly/apps/:appName/machines', async (req, res) => {
  try {
    const { appName } = req.params;
    const { accountId } = req.query;

    const account = await storage.getAccount(accountId);
    if (!account) return res.status(404).json({ success: false, error: '账号不存在' });

    try {
      // 使用更快的 Machines API
      const machines = await machineRequest('GET', `/apps/${appName}/machines`, account.api_token);
      res.json({ success: true, data: machines });
    } catch (e) {
      // 回退到 GraphQL
      const query = `
          query($appName: String) {
            app(name: $appName) {
              machines {
                nodes {
                  id
                  name
                  region
                  state
                  createdAt
                  updatedAt
                }
              }
            }
          }
        `;

      const result = await flyRequest(query, { appName }, account.api_token);
      if (result.errors) throw new Error(result.errors[0].message);
      res.json({ success: true, data: result.data.app.machines.nodes });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取应用事件 (汇总所有 Machines 的事件)
router.get('/fly/apps/:appName/events', async (req, res) => {
  try {
    const { appName } = req.params;
    const { accountId } = req.query;

    const account = await storage.getAccount(accountId);
    if (!account) return res.status(404).json({ success: false, error: '账号不存在' });

    // 1. 获取所有 Machines
    const machines = await machineRequest('GET', `/apps/${appName}/machines`, account.api_token);

    // 2. 并行获取每个 Machine 的事件
    const eventPromises = machines.map(async (m) => {
      try {
        // Note: In some versions of Machines API, events are in the machine object already, 
        // but we can also fetch them specifically if needed or use the ones from the list.
        // For now, let's use the events field if it exists, or fetch metadata.
        return (m.events || []).map(e => ({
          id: m.id,
          region: m.region,
          type: e.type,
          status: e.status,
          timestamp: e.timestamp,
          message: `${e.type}: ${e.status} (Instance: ${m.id.substring(0, 8)})`
        }));
      } catch (e) {
        return [];
      }
    });

    const eventGroups = await Promise.all(eventPromises);
    const allEvents = eventGroups.flat().sort((a, b) => b.timestamp - a.timestamp);

    res.json({ success: true, data: allEvents });
  } catch (error) {
    console.error('[Fly.io] Events Fetch Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取自定义域名 (Certificates)
router.get('/fly/apps/:appName/certificates', async (req, res) => {
  try {
    const { appName } = req.params;
    const { accountId } = req.query;

    const account = await storage.getAccount(accountId);
    if (!account) return res.status(404).json({ success: false, error: '账号不存在' });

    const query = `
      query($appName: String) {
        app(name: $appName) {
          certificates {
            nodes {
              hostname
              clientStatus
              createdAt
            }
          }
        }
      }
    `;

    const result = await flyRequest(query, { appName }, account.api_token);
    if (result.errors) {
      throw new Error(result.errors[0].message);
    }

    res.json({ success: true, data: result.data.app.certificates.nodes });
  } catch (error) {
    console.error('[Fly.io] Certificates Fetch Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取应用配置 (App Config)
router.get('/fly/apps/:appName/config', async (req, res) => {
  // ...
});

// 重命名应用
router.post('/fly/apps/:appName/rename', async (req, res) => {
  try {
    const { appName } = req.params;
    const { accountId, newName } = req.body;
    
    const account = await storage.getAccount(accountId);
    if (!account) return res.status(404).json({ success: false, error: '账号不存在' });

    const mutation = `
      mutation($appId: ID!, $newName: String!) {
        renameApp(input: { appId: $appId, newName: $newName }) {
          app {
            name
          }
        }
      }
    `;

    const result = await flyRequest(mutation, { appId: appName, newName }, account.api_token);
    if (result.errors) throw new Error(result.errors[0].message);

    res.json({ success: true, data: result.data.renameApp });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除应用
router.delete('/fly/apps/:appName', async (req, res) => {
  try {
    const { appName } = req.params;
    const { accountId } = req.body;
    
    const account = await storage.getAccount(accountId);
    if (!account) return res.status(404).json({ success: false, error: '账号不存在' });

    const mutation = `
      mutation($appId: ID!) {
        deleteApp(input: { appId: $appId }) {
          organization {
            slug
          }
        }
      }
    `;

    const result = await flyRequest(mutation, { appId: appName }, account.api_token);
    if (result.errors) throw new Error(result.errors[0].message);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 创建应用
router.post('/fly/apps', async (req, res) => {
  try {
    const { accountId, name, orgId } = req.body;
    
    const account = await storage.getAccount(accountId);
    if (!account) return res.status(404).json({ success: false, error: '账号不存在' });

    // 如果没传 orgId，尝试使用账号默认的
    const targetOrgId = orgId || account.organization_id;

    const mutation = `
      mutation($name: String, $organizationId: ID!) {
        createApp(input: { name: $name, organizationId: $organizationId, machines: true }) {
          app {
            id
            name
            status
          }
        }
      }
    `;

    const result = await flyRequest(mutation, { name, organizationId: targetOrgId }, account.api_token);
    if (result.errors) throw new Error(result.errors[0].message);

    res.json({ success: true, data: result.data.createApp.app });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
