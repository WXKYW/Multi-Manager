/**
 * API Monitor 2FA - Popup Logic
 */

const mainEl = document.getElementById('main');
const accountCountEl = document.getElementById('accountCount');
const toastEl = document.getElementById('toast');
let refreshInterval;
let serverUrl = '';

function showToast(message) {
    toastEl.textContent = message || '复制成功';
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2000);
}

async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
        const input = document.createElement('input'); input.value = text;
        document.body.appendChild(input); input.select();
        const success = document.execCommand('copy'); document.body.removeChild(input);
        return success;
    }
}

function formatCode(code) {
    if (!code) return '------';
    return code.length === 6 ? code.substring(0, 3) + ' ' + code.substring(3) : code;
}

function renderAccounts(accounts) {
    accountCountEl.textContent = `(${accounts.length})`;
    if (accounts.length === 0) {
        mainEl.innerHTML = '<div class="empty">📭 暂无 2FA 账号</div>';
        return;
    }

    mainEl.innerHTML = '<div class="account-list">' + accounts.map(acc => {
        return `
      <div class="account-item no-icon" data-id="${acc.id}" data-code="${acc.currentCode || ''}" title="点击复制验证码">
        <div class="account-info">
          <span class="issuer" style="font-weight: 600;">${acc.issuer || '未知服务'}</span>
          <span class="account-name">${acc.account || ''}</span>
        </div>
        <div class="code-container">
          <div class="code">${formatCode(acc.currentCode)}</div>
          <div class="account-progress"><div class="progress-bar" id="progress-${acc.id}"></div></div>
        </div>
      </div>
    `;
    }).join('') + '</div>';

    document.querySelectorAll('.account-item').forEach(item => {
        item.addEventListener('click', async () => {
            const code = item.dataset.code;
            if (code && await copyToClipboard(code)) {
                showToast();
                setTimeout(() => window.close(), 800);
            }
        });
    });
    updateProgressBars();
}

function updateProgressBars() {
    const rem = 30 - (Math.floor(Date.now() / 1000) % 30);
    document.querySelectorAll('.progress-bar').forEach(bar => {
        bar.style.width = `${(rem / 30) * 100}%`;
        bar.classList.toggle('low', rem <= 5);
    });
}

function startTimer() {
    if (refreshInterval) clearInterval(refreshInterval);
    const update = () => {
        updateProgressBars();
        if (30 - (Math.floor(Date.now() / 1000) % 30) === 30) loadAccounts(false);
    };
    update();
    refreshInterval = setInterval(update, 1000);
}

async function loadAccounts(showLoading = true) {
    if (showLoading) mainEl.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在同步数据...</p></div>';
    chrome.runtime.sendMessage({ type: 'GET_ACCOUNTS' }, (response) => {
        if (chrome.runtime.lastError) { mainEl.innerHTML = '<div class="error">无法连接至扩展后台</div>'; return; }
        if (!response || !response.success) {
            mainEl.innerHTML = `<div class="error"><p>${response?.error || '同步失败'}</p><button class="retry-btn" id="goSettings">前往配置</button></div>`;
            document.getElementById('goSettings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
            return;
        }
        renderAccounts(response.data || []);
        if (showLoading) startTimer();
    });
}

chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (config) => {
    if (config && config.serverUrl) serverUrl = config.serverUrl.endsWith('/') ? config.serverUrl.slice(0, -1) : config.serverUrl;
    loadAccounts();
});

document.getElementById('btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
