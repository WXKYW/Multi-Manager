/**
 * API Monitor 2FA - Content Script
 */

let serverUrl = '';
let responseServerUrl = '';

function isContextValid() { return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id; }

function is2FAInput(input) {
    if (input.type !== 'text' && input.type !== 'tel' && input.type !== 'number' && input.type !== 'password') return false;
    const hints = ['otp', '2fa', 'totp', 'code', 'verification', 'authenticator', 'token', 'mfa', '验证码', '验证'];
    const attrs = [input.name, input.id, input.placeholder, input.autocomplete, input.getAttribute('aria-label'), input.className].filter(Boolean).map(s => s.toLowerCase());
    return hints.some(h => attrs.some(a => a.includes(h))) || (parseInt(input.maxLength) >= 4 && parseInt(input.maxLength) <= 8);
}

function formatCode(code) {
    if (!code) return '------';
    return code.length === 6 ? code.substring(0, 3) + ' ' + code.substring(3) : code;
}

function safeSendMessage(message, callback) {
    if (!isContextValid()) return;
    try {
        chrome.runtime.sendMessage(message, (r) => {
            if (chrome.runtime.lastError && chrome.runtime.lastError.message.includes('context invalidated')) return;
            if (callback) callback(r);
        });
    } catch (e) { }
}

function createFillButton(input) {
    const btn = document.createElement('button');
    btn.className = 'api-monitor-2fa-btn'; btn.innerHTML = '🔐';
    btn.title = '一键填充 2FA 验证码'; btn.type = 'button';
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showCodePicker(input); });
    return btn;
}

async function showCodePicker(input) {
    if (!isContextValid()) { alert('扩展已更新，请刷新页面'); return; }
    document.querySelectorAll('.api-monitor-2fa-picker').forEach(el => el.remove());
    const picker = document.createElement('div');
    picker.className = 'api-monitor-2fa-picker';
    picker.innerHTML = '<div class="loading">正在加载验证码...</div>';

    const rect = input.getBoundingClientRect();
    picker.style.top = `${rect.bottom + window.scrollY + 6}px`;
    picker.style.left = `${rect.left + window.scrollX}px`;
    picker.style.width = `${rect.width}px`;
    picker.style.minWidth = '220px';
    document.body.appendChild(picker);

    safeSendMessage({ type: 'GET_ACCOUNTS', domain: window.location.hostname }, (response) => {
        if (!response || !response.success) { picker.innerHTML = `<div class="error">${response?.error || '获取失败'}</div>`; return; }
        const accounts = response.matched?.length > 0 ? response.matched : response.data;
        if (!accounts || accounts.length === 0) { picker.innerHTML = '<div class="empty">📭 暂无账号</div>'; return; }
        renderPickerList(picker, accounts, input);
    });

    const closeHandler = (e) => { if (!picker.contains(e.target) && e.target !== input) { picker.remove(); document.removeEventListener('mousedown', closeHandler); } };
    setTimeout(() => document.addEventListener('mousedown', closeHandler), 10);
}

function renderPickerList(picker, accounts, input) {
    picker.innerHTML = accounts.map(acc => {
        return `
      <div class="account-item no-icon" data-code="${acc.currentCode || ''}">
        <div class="api-monitor-2fa-info" style="padding-left: 8px;">
          <div class="api-monitor-2fa-issuer" style="font-weight: 600;">${acc.issuer || '未知'}</div>
          <div class="api-monitor-2fa-account">${acc.account || ''}</div>
        </div>
        <div class="api-monitor-2fa-code-wrapper">
          <div class="api-monitor-2fa-code">${formatCode(acc.currentCode)}</div>
          <div class="api-monitor-2fa-progress-container"><div class="api-monitor-2fa-progress-bar" id="prog-${acc.id}"></div></div>
        </div>
      </div>`;
    }).join('');

    picker.querySelectorAll('.account-item').forEach(item => {
        item.addEventListener('click', () => {
            if (item.dataset.code) {
                input.value = item.dataset.code;
                input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); input.focus();
            }
            picker.remove();
        });
    });
    updateProgress(accounts);
}

let progressTimer;
function updateProgress(accounts) {
    if (progressTimer) clearInterval(progressTimer);
    const tick = () => {
        const rem = 30 - (Math.floor(Date.now() / 1000) % 30);
        accounts.forEach(acc => {
            const bar = document.getElementById(`prog-${acc.id}`);
            if (bar) { bar.style.width = `${(rem / 30) * 100}%`; bar.classList.toggle('low', rem <= 5); }
        });
    };
    tick(); progressTimer = setInterval(tick, 1000);
}

safeSendMessage({ type: 'GET_CONFIG' }, (config) => {
    if (config && config.serverUrl) responseServerUrl = config.serverUrl.endsWith('/') ? config.serverUrl.slice(0, -1) : config.serverUrl;
});

function scanInputs() {
    if (!isContextValid()) return;
    document.querySelectorAll('input').forEach(input => {
        if (input.dataset.apiMonitor2fa) return;
        if (is2FAInput(input)) {
            input.dataset.apiMonitor2fa = 'true';
            const wrapper = document.createElement('div'); wrapper.className = 'api-monitor-2fa-wrapper';
            input.parentNode.insertBefore(wrapper, input); wrapper.appendChild(input); wrapper.appendChild(createFillButton(input));
        }
    });
}

const observer = new MutationObserver(() => isContextValid() ? scanInputs() : observer.disconnect());
scanInputs(); if (isContextValid()) observer.observe(document.body, { childList: true, subtree: true });
