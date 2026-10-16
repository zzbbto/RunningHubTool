/**
 * RunningHub 插件 — background service worker
 *
 * 职责：
 * 1. 用 chrome.cookies 读取两站（.cn / .ai）的 Rh-Accesstoken
 * 2. 用扩展特权（host_permissions）跨站 fetch 调用接口，
 *    供 content script 通过 chrome.runtime.sendMessage 请求执行。
 *
 * 消息协议：
 *   { action: 'getTokens' }                         → 返回两站登录状态
 *   { action: 'api', site, method, path, body }     → 调某站接口
 *     site: 'cn' | 'ai'
 *     path: 相对路径如 '/uc/ai-migration/summary/workflows'
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== 'object') throw new Error('bad message');
    switch (msg.action) {
      case 'getTokens':
        return await getLoginState();
      case 'api':
        return await apiCall(msg.site, msg.method, msg.path, msg.body, msg.cookieDomain, msg.token);
      default:
        throw new Error('unknown action: ' + msg.action);
    }
  })()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // 保持消息通道，支持异步
});

const SITES = {
  cn: { origin: 'https://www.runninghub.cn', domain: 'runninghub.cn' },
  ai: { origin: 'https://www.runninghub.ai', domain: 'runninghub.ai' },
};

async function getCookieToken(domain) {
  // 尝试多种 domain 格式：无点 / 带点 / 带 www
  const variants = [domain, '.' + domain, 'www.' + domain.replace(/^\./, '')];
  for (const d of variants) {
    try {
      const cookies = await chrome.cookies.getAll({ domain: d });
      const tok = cookies.find((c) => c.name === 'Rh-Accesstoken');
      if (tok && tok.value) return tok.value;
    } catch (e) { /* 尝试下一个 */ }
  }
  // 兜底：获取该站所有 cookie 找 token
  try {
    const all = await chrome.cookies.getAll({});
    const match = all.find((c) => c.name === 'Rh-Accesstoken' && c.domain.indexOf(domain.replace(/^\./, '')) > -1);
    if (match && match.value) return match.value;
  } catch (e) { /* 忽略 */ }
  return '';
}

async function getLoginState() {
  const cnTok = await getCookieToken(SITES.cn.domain);
  const aiTok = await getCookieToken(SITES.ai.domain);
  let cnCount = 0, aiCount = 0, cookieErr = '';
  try {
    const all = await chrome.cookies.getAll({});
    cnCount = all.filter((c) => c.domain.indexOf('runninghub.cn') > -1).length;
    aiCount = all.filter((c) => c.domain.indexOf('runninghub.ai') > -1).length;
  } catch (e) {
    cookieErr = String((e && e.message) || e);
  }
  return {
    cn: { loggedIn: !!cnTok, tokenPrefix: cnTok.slice(0, 20), cookieCount: cnCount },
    ai: { loggedIn: !!aiTok, tokenPrefix: aiTok.slice(0, 20), cookieCount: aiCount },
    cookieErr,
  };
}

/** 调某站接口（扩展特权，不受 CORS 限制）
 *  msg.token: content script 传入的页面 token（当前站）；没有则用 cookies 读
 */
async function apiCall(site, method, path, body, cookieDomain, token) {
  const cfg = SITES[site];
  if (!cfg) throw new Error('unknown site: ' + site);
  const tk = token || await getCookieToken(cookieDomain || cfg.domain);
  const headers = { 'Content-Type': 'application/json' };
  if (tk) headers['Authorization'] = 'Bearer ' + tk;
  const resp = await fetch(cfg.origin + path, {
    method: method || 'POST',
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 忽略 */ }
  return { httpStatus: resp.status, json, raw: text.slice(0, 2000), usedToken: !!tk };
}
