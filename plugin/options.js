/**
 * API Monitor 2FA - 设置页面逻辑
 */

const form = document.getElementById('settingsForm');
const serverUrlInput = document.getElementById('serverUrl');
const tokenInput = document.getElementById('token');
const showFillButtonInput = document.getElementById('showFillButton');
const messageEl = document.getElementById('message');

// 加载已保存的设置
chrome.storage.local.get(['serverUrl', 'token', 'showFillButton', 'masterEnabled'], (result) => {
  if (result.serverUrl) {
    serverUrlInput.value = result.serverUrl;
  }
  if (result.token) {
    tokenInput.value = result.token;
  }
  showFillButtonInput.checked = result.showFillButton !== false;
  // masterEnabled 在设置页不可见，但我们需要保留它
  window._masterEnabled = result.masterEnabled !== false;
});

// 显示消息
function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = 'message ' + type;
  messageEl.style.display = 'block';

  setTimeout(() => {
    messageEl.style.display = 'none';
  }, 3000);
}

// 保存设置
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const serverUrl = serverUrlInput.value.trim().replace(/\/$/, ''); // 移除末尾斜杠
  let token = tokenInput.value.trim();
  const showFillButton = showFillButtonInput.checked;

  if (!serverUrl) {
    showMessage('请输入服务器地址', 'error');
    return;
  }

  let parsedServerUrl;
  try {
    parsedServerUrl = new URL(serverUrl);
  } catch {
    showMessage('服务器地址格式无效', 'error');
    return;
  }
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsedServerUrl.hostname);
  if (parsedServerUrl.protocol !== 'https:' && !isLoopback) {
    showMessage('非本机服务器必须使用 HTTPS', 'error');
    return;
  }
  if (!token.startsWith('akp_') && !token.startsWith('pair_')) {
    showMessage('请输入 pair_ 配对码或 akp_ 插件 API Key', 'error');
    return;
  }

  // 测试连接
  try {
    if (token.startsWith('pair_')) {
      const pairingResponse = await fetch(`${serverUrl}/api/auth/plugin-pairings/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: token })
      });
      const pairingResult = await pairingResponse.json().catch(() => ({}));
      token = pairingResult.data?.token || pairingResult.token || '';
      if (!pairingResponse.ok || !token.startsWith('akp_')) {
        showMessage(pairingResult.error || '配对码无效、已使用或已过期', 'error');
        return;
      }
    }
    const response = await fetch(`${serverUrl}/api/totp/accounts`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      showMessage('连接失败: ' + response.status, 'error');
      return;
    }

    const data = await response.json();
    if (!data.success) {
      showMessage('认证失败，请先登录主程序并检查 API Key', 'error');
      return;
    }

    // 保存配置
    chrome.storage.local.set({ serverUrl, token, showFillButton }, () => {
      showMessage('设置已保存', 'success');
      setTimeout(() => {
        window.close();
      }, 1000);
    });

  } catch (error) {
    showMessage('网络错误: ' + error.message, 'error');
  }
});
