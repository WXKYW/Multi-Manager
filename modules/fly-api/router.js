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

    const targetName = appName; // Machines API works best with app name

    console.log(`[Fly.io] Restarting app via Machines API: ${targetName} for account: ${accountId}`);

    const account = await storage.getAccount(accountId);
    if (!account) {
      return res.status(404).json({ success: false, error: '账号不存在' });
    }

    if (!account.api_token) {
      return res.status(400).json({ success: false, error: '账号未配置 API Token' });
    }

    try {
      // 1. 获取该应用的所有 Machines
      const machines = await machineRequest('GET', `/apps/${targetName}/machines`, account.api_token);

      if (!Array.isArray(machines) || machines.length === 0) {
        console.log(`[Fly.io] No machines found for ${targetName}, falling back to GraphQL restartApp`);

        // 回退到 GraphQL 方式 (V1 应用或特殊情况)
        const mutation = `mutation($appId: ID!) { restartApp(input: { appId: $appId }) { app { name } } }`;
        const result = await flyRequest(mutation, { appId: targetName }, account.api_token);
        if (result.errors) throw new Error(result.errors[0].message);

        return res.json({ success: true, mode: 'graphql', data: result.data.restartApp });
      }

      // 2. 逐个重启 Machines
      console.log(`[Fly.io] Found ${machines.length} machines. Triggering restarts...`);
      const restartPromises = machines.map(m =>
        machineRequest('POST', `/apps/${targetName}/machines/${m.id}/restart`, account.api_token)
          .catch(err => ({ error: true, id: m.id, message: err.message }))
      );

      const results = await Promise.all(restartPromises);
      const failedCount = results.filter(r => r.error).length;

      res.json({
        success: failedCount < machines.length,
        mode: 'machines',
        total: machines.length,
        failed: failedCount,
        results: results
      });

    } catch (apiError) {
      const status = apiError.response ? apiError.response.status : 500;
      const msg = apiError.response ? (apiError.response.data?.error || apiError.message) : apiError.message;
      res.status(status).json({ success: false, error: msg });
    }
  } catch (error) {
    console.error('[Fly.io] Restart Route Exception:', error);
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

module.exports = router;
