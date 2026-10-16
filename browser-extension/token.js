/**
 * RunningHub 插件 — token 记录（注入所有 runninghub 页面）
 * 读取当前页 localStorage 的 Rh-Accesstoken，存入 chrome.storage.local（rht_tokens），
 * 供 migrate.js 跨站调用使用（另一站的 token）。
 */
(() => {
  if (window.__rhtTokenLoaded) return;
  window.__rhtTokenLoaded = true;

  const HOST = window.location.hostname || '';
  const site = HOST.indexOf('runninghub.cn') > -1 ? 'cn' : HOST.indexOf('runninghub.ai') > -1 ? 'ai' : '';

  function capture() {
    if (!site) return;
    try {
      const t = localStorage.getItem('Rh-Accesstoken') || '';
      if (!t) return;
      chrome.storage.local.get('rht_tokens', (d) => {
        const cur = (d && d.rht_tokens) || {};
        if (cur[site] !== t) {
          cur[site] = t;
          chrome.storage.local.set({ rht_tokens: cur });
        }
      });
    } catch (e) { /* 忽略 */ }
  }

  // 页面加载后 + 定期重试（SPA 登录态变化）
  capture();
  setTimeout(capture, 1500);
  setTimeout(capture, 4000);
  // SPA 路由变化时也尝试
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => capture()).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
