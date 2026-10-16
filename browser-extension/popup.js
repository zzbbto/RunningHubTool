/* RunningHub 复制/粘贴参数 — popup 逻辑 */
(() => {
  const goCn = document.getElementById('goCn');
  const goAi = document.getElementById('goAi');
  const showLast = document.getElementById('showLast');
  const status = document.getElementById('status');

  const setStatus = (text, kind) => {
    status.style.display = 'block';
    status.textContent = text;
    status.className = 'status' + (kind ? ' ' + kind : '');
  };

  goCn.addEventListener('click', () => chrome.tabs.create({ url: 'https://www.runninghub.cn' }));
  goAi.addEventListener('click', () => chrome.tabs.create({ url: 'https://www.runninghub.ai' }));

  // 查看上次复制的参数：优先从剪贴板读，其次从当前 RunningHub 页面 localStorage 读
  showLast.addEventListener('click', async () => {
    try {
      let data = null;
      // 1) 剪贴板（同标签页内复制/导航最可靠）
      try {
        const text = await navigator.clipboard.readText();
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.nodes) && parsed.nodes.length && parsed.srcId) data = parsed;
      } catch (e) {
        /* 剪贴板不可用 */
      }
      // 2) 兜底：当前打开的 RunningHub 页面 localStorage
      if (!data) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = tab && tab.url ? tab.url : '';
        if (!/runninghub\.(cn|ai)/.test(url)) {
          setStatus('还没有复制过参数（剪贴板为空，且未打开 RunningHub 页面）。\n先在来源应用页面点「① 复制本页参数」。');
          return;
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            try {
              const raw = localStorage.getItem('rht_copied_params');
              return raw ? JSON.parse(raw) : null;
            } catch (e) {
              return null;
            }
          },
        });
        data = results && results[0] && results[0].result;
      }
      if (!data || !data.nodes || !data.nodes.length) {
        setStatus('还没有复制过参数。先在来源应用页面点「① 复制本页参数」。');
        return;
      }
      const t = new Date(data.time);
      const fileN = data.nodes.filter((n) => /^(IMAGE|AUDIO|VIDEO|FILE|ZIP|OUTPUT)/.test(n.fieldType || '')).length;
      setStatus(
        '来源应用：' + data.srcId + '（' + (data.srcHost || '') + '）\n' +
        '复制时间：' + t.toLocaleString() + '\n' +
        '节点数：' + data.nodes.length + '（其中文件类 ' + fileN + ' 个）\n\n' +
        data.nodes.map((n) => (n.nodeName || n.fieldName || '节点') + ' #' + n.nodeId).join('\n'),
        'ok'
      );
    } catch (e) {
      setStatus('读取失败：' + String((e && e.message) || e), 'error');
    }
  });
})();
