/**
 * Cookie 处理工具
 * 用于解析、合并和格式化 HTTP Cookie
 */

/**
 * HTTP Cookie 属性列表（需要过滤掉）
 */
const HTTP_COOKIE_ATTRS = [
  'max-age',
  'expires',
  'path',
  'domain',
  'secure',
  'httponly',
  'samesite',
];

/**
 * 登录相关的 Cookie 键名
 */
const LOGIN_COOKIE_KEYS = ['MUSIC_U', 'MUSIC_R_U', 'MUSIC_A', 'MUSIC_A_T', '__csrf'];

/**
 * 从 Set-Cookie 数组中提取 key=value 部分
 * @param {string[]} setCookieArray - Set-Cookie 头数组
 * @returns {string[]} 提取的 key=value 数组
 *
 * @example
 * extractCookieParts(['MUSIC_U=xxx; Path=/; Max-Age=123'])
 * // => ['MUSIC_U=xxx']
 */
function extractCookieParts(setCookieArray) {
  if (!Array.isArray(setCookieArray)) return [];

  return setCookieArray
    .map(c => {
      const match = String(c).match(/^([^;]+)/);
      if (!match) return '';
      const part = match[1].trim();
      const [key] = part.split('=');
      // 过滤 HTTP 属性
      if (key && !HTTP_COOKIE_ATTRS.includes(key.toLowerCase())) {
        return part;
      }
      return '';
    })
    .filter(Boolean);
}

/**
 * 解析 Cookie 字符串为对象
 * @param {string} cookieString - Cookie 字符串 (key1=val1; key2=val2)
 * @returns {Object.<string, string>} Cookie 对象
 *
 * @example
 * parseCookieString('MUSIC_U=abc; NMTID=xyz')
 * // => { MUSIC_U: 'abc', NMTID: 'xyz' }
 */
function parseCookieString(cookieString) {
  const cookies = {};
  if (!cookieString) return cookies;

  cookieString.split(';').forEach(part => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const [key, ...valueParts] = trimmed.split('=');
    if (key && !HTTP_COOKIE_ATTRS.includes(key.toLowerCase())) {
      cookies[key.trim()] = valueParts.join('=');
    }
  });

  return cookies;
}

/**
 * 将 Cookie 对象序列化为字符串
 * @param {Object.<string, string>} cookieObj - Cookie 对象
 * @returns {string} Cookie 字符串
 *
 * @example
 * serializeCookies({ MUSIC_U: 'abc', NMTID: 'xyz' })
 * // => 'MUSIC_U=abc; NMTID=xyz'
 */
function serializeCookies(cookieObj) {
  return Object.entries(cookieObj)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * 合并新 Cookie 到现有 Cookie
 * - 如果现有 Cookie 包含登录态，只更新登录相关的 Cookie
 * - 否则接受所有新 Cookie
 *
 * @param {string} existingCookie - 现有 Cookie 字符串
 * @param {string[]} newCookieArray - 新的 Set-Cookie 头数组
 * @returns {string} 合并后的 Cookie 字符串
 */
function mergeCookies(existingCookie, newCookieArray) {
  const existingCookies = parseCookieString(existingCookie);
  const newParts = extractCookieParts(newCookieArray);

  if (newParts.length === 0) {
    return existingCookie;
  }

  // 检查现有 Cookie 是否包含登录态
  const hasExistingLogin = !!existingCookies['MUSIC_U'] || !!existingCookies['MUSIC_R_U'];

  newParts.forEach(part => {
    const [key, ...valueParts] = part.split('=');
    if (!key) return;

    const keyTrimmed = key.trim();

    if (hasExistingLogin) {
      // 已有登录态：只接受登录相关的 Cookie 更新
      if (LOGIN_COOKIE_KEYS.includes(keyTrimmed)) {
        existingCookies[keyTrimmed] = valueParts.join('=');
      }
    } else {
      // 没有登录态：接受所有 Cookie
      existingCookies[keyTrimmed] = valueParts.join('=');
    }
  });

  return serializeCookies(existingCookies);
}

/**
 * 检查 Cookie 字符串是否包含有效登录态
 * @param {string} cookieString - Cookie 字符串
 * @returns {boolean}
 */
function hasValidLoginCookie(cookieString) {
  return !!(cookieString && cookieString.includes('MUSIC_U='));
}

module.exports = {
  HTTP_COOKIE_ATTRS,
  LOGIN_COOKIE_KEYS,
  extractCookieParts,
  parseCookieString,
  serializeCookies,
  mergeCookies,
  hasValidLoginCookie,
};
