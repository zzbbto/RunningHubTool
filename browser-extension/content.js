/**
 * RunningHub 复制/粘贴应用参数 — content script
 *
 * 交互（已与用户确认）：点两次按钮。
 *  - 在来源应用页面（app 详情/编辑页）点「① 复制本页参数」：读取本页应用的全部节点参数。
 *  - 到发布/编辑页面（新应用）点「② 粘贴到本页」：把参数填到当前页面对应输入框。
 *
 * 安全设计：只读不写 —— 不调用任何 create/publish 接口，发布由用户手动点击完成。
 * 支持域名：www.runninghub.cn 与 www.runninghub.ai。
 */
(() => {
  if (window.__rhtLoaded) return;
  window.__rhtLoaded = true;

  const HOST = window.location.origin;
  const IS_CN = HOST.indexOf('runninghub.cn') > -1;

  /* ---------------- 工具函数 ---------------- */

  function getToken() {
    try {
      return (
        localStorage.getItem('Rh-Accesstoken') ||
        localStorage.getItem('token') ||
        localStorage.getItem('rh_access_token') ||
        ''
      );
    } catch (e) {
      return '';
    }
  }

  /* ---------------- 跨页共享：用页面 localStorage（同源跨页、重载不丢） ---------------- */
  const COPED_KEY = 'rht_copied_params';

  function saveCopied(data) {
    try {
      localStorage.setItem(COPED_KEY, JSON.stringify(data));
    } catch (e) {
      /* 忽略 */
    }
  }

  function loadCopied() {
    try {
      const raw = localStorage.getItem(COPED_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.nodes) && data.nodes.length) return data;
      return null;
    } catch (e) {
      return null;
    }
  }

  function clearCopied() {
    try {
      localStorage.removeItem(COPED_KEY);
    } catch (e) {
      /* 忽略 */
    }
  }

  // 复制参数到系统剪贴板（用 localStorage 兜底）
  async function copyToClipboard(data) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data));
      return true;
    } catch (e) {
      // 剪贴板 API 被拒时，用隐藏 textarea 兜底
      try {
        const ta = document.createElement('textarea');
        ta.value = JSON.stringify(data);
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  // 从系统剪贴板读取参数（读不到时回退 localStorage）
  async function readFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      const data = JSON.parse(text);
      if (data && Array.isArray(data.nodes) && data.nodes.length && data.srcId) return data;
    } catch (e) {
      /* 忽略解析失败 */
    }
    return loadCopied();
  }

  /** 从当前 URL 提取「本页 id」。
   *  RunningHub 有两种 id：
   *  - /publish/:workflowId、/workflow/:id            → 工作流 ID（发布页）
   *  - /ai-detail/:webappId 等 AI 应用界面             → 应用 ID（webappId）
   */
  function currentPageInfo() {
    const p = window.location.pathname;
    let m;
    // 兼容 /zh-cn/ 等多语言前缀
    if ((m = p.match(/^(?:\/[^\/]+)?\/(?:publish|workflow)\/(\d+)/))) {
      return { kind: 'workflow', id: m[1] };
    }
    if ((m = p.match(/^(?:\/[^\/]+)?\/ai-detail\/(\d+)/))) {
      return { kind: 'webapp', id: m[1] };
    }
    if ((m = p.match(/^(?:\/[^\/]+)?\/(?:ai-application|ai-apps)\/(\d+)/))) {
      return { kind: 'webapp', id: m[1] };
    }
    return { kind: '', id: '' };
  }

  /** 深度查找对象里第一个指定 key 的值 */
  function deepFind(obj, key) {
    if (obj === null || typeof obj !== 'object') return undefined;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = deepFind(item, key);
        if (r !== undefined) return r;
      }
      return undefined;
    }
    if (obj[key] !== undefined) return obj[key];
    for (const k of Object.keys(obj)) {
      const r = deepFind(obj[k], key);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  /** 先直接 fetch；如被 CORS 拦截，则注入页面世界脚本发起同源请求（带会话 Cookie）。 */
  function safeFetch(url, opts) {
    return fetch(url, opts)
      .then((r) =>
        r
          .text()
          .then((body) => ({ ok: r.ok, status: r.status, body }))
          .catch(() => ({ ok: false, status: r.status, body: '' }))
      )
      .catch(() =>
        pageWorldFetch(url, opts).then(
          (body) => ({ ok: true, status: 200, body }),
          (err) => ({ ok: false, status: 0, body: String(err) })
        )
      );
  }

  /** 注入 <script> 到页面主世界执行 fetch（跨世界通信用 CustomEvent） */
  function pageWorldFetch(url, opts) {
    return new Promise((resolve, reject) => {
      const id = 'rht' + Math.floor(Math.random() * 1e9);
      const evtName = '__rht_res_' + id;
      const handler = (e) => {
        window.removeEventListener(evtName, handler);
        if (e.detail && e.detail.body) resolve(e.detail.body);
        else reject(new Error('页面脚本无返回'));
      };
      window.addEventListener(evtName, handler);
      const s = document.createElement('script');
      s.textContent =
        '(async()=>{try{const r=await fetch(' +
        JSON.stringify(url) +
        ',' +
        JSON.stringify(opts) +
        ');const b=await r.text();window.dispatchEvent(new CustomEvent(' +
        JSON.stringify(evtName) +
        ',{detail:{body:b}}));}catch(e){window.dispatchEvent(new CustomEvent(' +
        JSON.stringify(evtName) +
        ",{detail:{body:'ERR:'+(e&&e.message||e)}}));}})();";
      s.onerror = () => {
        window.removeEventListener(evtName, handler);
        reject(new Error('脚本注入失败'));
      };
      (document.head || document.documentElement).appendChild(s);
      setTimeout(() => s.remove(), 100);
    });
  }

  /** 读取来源应用的节点参数。
   *  kind='webapp'  → POST /api/webapp/detail  { webappId }
   *  kind='workflow'→ 发布页，工作流参数取自页面表单（见 captureFromForm），
   *                  这里接口层先尝试 workFlow 风格的读取，失败则交给表单抓取。
   */
  async function readSourceApp(id, kind) {
    const token = getToken();
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      credentials: 'include',
      body: JSON.stringify(kind === 'workflow' ? { workflowId: String(id) } : { webappId: String(id) }),
    };
    const res = await safeFetch(HOST + '/api/webapp/detail', opts);
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      /* 忽略 */
    }
    return { httpStatus: res.status, json };
  }

  function normalizeNodes(list) {
    return (Array.isArray(list) ? list : []).map((n) => {
      const nodeId = n && n.nodeId != null ? String(n.nodeId) : '';
      const fieldName = (n && n.fieldName) || '';
      const fieldType = String((n && n.fieldType) || '').toUpperCase();
      return {
        nodeId,
        nodeName: (n && n.nodeName) || '',
        fieldName,
        // key = nodeId-fieldName（发布页弹窗节点项的 key 就是这么拼的）
        key: fieldName ? nodeId + '-' + fieldName : nodeId,
        fieldValue: (n && n.fieldValue) || '',
        fieldData: (n && n.fieldData) || '',
        fieldType,
        description: (n && n.description) || '',
        isFile: /^(IMAGE|AUDIO|VIDEO|FILE|ZIP|OUTPUT)/.test(fieldType),
      };
    });
  }

  /** 从 detail 响应里提取节点数组。
   *  RunningHub 实际字段是 webapp.nodeInfos（publish 页 fs.value.webapp.nodeInfos），
   *  老的开放 API 叫 nodeInfoList，这里两者都兼容。
   */
  function extractNodeList(json) {
    if (!json || typeof json !== 'object') return null;
    const obj = json.data && typeof json.data === 'object' ? json.data : json;
    const candidates = [
      deepFind(obj, 'nodeInfos'),
      deepFind(obj, 'nodeInfoList'),
      deepFind(obj, 'inputNodes'),
    ];
    for (const c of candidates) {
      if (Array.isArray(c) && c.length && c[0] && c[0].nodeId != null) return c;
    }
    return null;
  }

  function isFileType(t) {
    return /^(IMAGE|AUDIO|VIDEO|FILE|ZIP|OUTPUT)/.test(t || '');
  }

  /* ---------------- DOM 匹配：找到当前页面上每个节点的输入控件 ---------------- */

  const INPUT_SELECTOR =
    'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=file]), ' +
    'textarea, select, [contenteditable="true"], [role="combobox"]';

  // 参数值输入框：排除显示名输入框（.node-item-input 绑定 description，readonly）
  const VALUE_INPUT_SELECTOR =
    'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=file]):not(.node-item-input), ' +
    'textarea, select, [contenteditable="true"], [role="combobox"]';

  const ID_ATTRS = [
    'data-node-id',
    'data-nodeid',
    'data-node',
    'data-key',
    'data-id',
    'data-param',
    'data-field',
    'data-fieldname',
    'data-field-name',
    'data-name',
    'data-nodename',
    'data-node-name',
  ];

  function qsaAll(selectors) {
    const out = [];
    for (const s of selectors) {
      try {
        out.push(...document.querySelectorAll(s));
      } catch (e) {
        /* 无效选择器忽略 */
      }
    }
    return out;
  }

  /**
   * 扫描当前页面，把「节点 id → 输入控件」映射出来。
   * 返回 Map<nodeId, { el, via, name? }>。
   *
   * RunningHub 发布页的节点参数在「选择节点参数」弹窗里（.nodes-model-container），
   * 默认关闭，必须先点开「添加节点参数 / 选择节点参数」按钮弹窗才会渲染节点列表。
   */
  function buildNodeInputMap() {
    const map = new Map();

    // 复合键注册：同一 nodeId 的不同参数（fieldName）各自独立成键，
    // 否则 map.has(key) 会把同一节点的第二个参数（如 [448] 的 megapixels）丢掉 → 粘贴串位。
    const addKey = (key, el, via, name, extra) => {
      if (!el || !key || map.has(key)) return;
      map.set(key, Object.assign({ el, via, name }, extra || {}));
    };

    // 从一个元素向上收集可能含 nodeId 的属性值
    const collectNodeIds = (el, depth) => {
      const found = [];
      let p = el;
      for (let i = 0; p && i <= depth; i++) {
        for (const a of ID_ATTRS) {
          const v = p.getAttribute && p.getAttribute(a);
          if (v && /^\d+$/.test(v)) found.push(v);
        }
        if (p.id && /^\d+$/.test(p.id)) found.push(p.id);
        if (p.name && /^\d+$/.test(p.name)) found.push(p.name);
        p = p.parentElement;
      }
      return found;
    };

    // 从一段文本里提取 `[123]` 形式的 nodeId
    const nodeIdFromText = (txt) => {
      const m = String(txt || '').match(/\[\s*(\d+)\s*\]/);
      return m ? m[1] : '';
    };

    // —— 策略 1：节点弹窗/节点区容器（发布页 .nodes-model-container / .nodes-model-list）——
    const descSel = '.nodes-model-list-item-desc, .node-item-desc, [class*="item-desc"]';
    const nameInputSel = 'input.node-item-input, [class*="node-item"] input[class*="input"]';
    const nodeItemSel =
      '.nodes-model-list-item, .nodes-model-content .node-item, [class*="node-item"], [class*="node-input"], [class*="param-item"]';
    qsaAll(nodeItemSel.split(',')).forEach((item) => {
      const descEl = item.querySelector(descSel);
      const descText = descEl ? descEl.textContent || '' : '';
      const nameInput = item.querySelector(nameInputSel);
      const wholeText = itemTextOf(item);
      // 从容器属性取 nodeId
      let nodeId = collectNodeIds(item, 0)[0] || '';
      if (!nodeId) nodeId = nodeIdFromText(wholeText);
      if (!nodeId) return;

      // 弹窗/主列表每行即一个参数：首行是 `nodeName-fieldName`，次行是 `[nodeId] 当前值`
      const label = parseItemLabel(wholeText);
      const extra = {
        nodeId,
        nodeName: label.nodeName || '',
        fieldName: label.fieldName || '',
        descText,
        nameValue: nameInput ? nameInput.value || '' : '',
        nameOnly: false,
        textValue: valueFromItemText(wholeText),
      };

      const inputs = Array.from(item.querySelectorAll(VALUE_INPUT_SELECTOR));
      if (inputs.length) {
        // 一个节点项可能有多个参数输入框；行内已带字段名时按行取，否则用序号兜底避免互相覆盖
        inputs.forEach((el, i) => {
          const f = label.fieldName || '';
          const e = Object.assign({}, extra, { fieldName: f });
          if (f) addKey(nodeId + '-' + f, el, 'node-item', labelTextOf(item), e);
          if (inputs.length === 1) addKey(nodeId, el, 'node-item', labelTextOf(item), e); // 裸 nodeId 别名（兼容旧数据）
          if (!f) addKey(nodeId + '#' + i, el, 'node-item', labelTextOf(item), e);
        });
      } else if (nameInput) {
        // 项内只有显示名输入框（主列表只读态）：注册它供复制时取显示名，其值不作参数值
        addKey(nodeId, nameInput, 'node-name-input', labelTextOf(item), Object.assign({}, extra, { nameOnly: true }));
      }
    });

    // —— 策略 2：全页 input/textarea/select，按 nodeId 属性 ——
    document.querySelectorAll(VALUE_INPUT_SELECTOR).forEach((el) => {
      const ids = collectNodeIds(el, 2);
      for (const nid of ids) {
        addKey(nid, el, 'attribute', labelTextOf(el), { nodeId: nid });
        break;
      }
    });

    return map;
  }

  /** 在发布页「主列表」里找对应 nodeId 的已添加节点项（.node-item，而非弹窗项）。
   *  主列表项结构：<div class="node-item"> … <div class="node-item-desc">[nodeId] nodeName-fieldName</div>
   */
  /** 打开发布页的「选择节点参数」弹窗（幂等）：点「添加」按钮（.node-add-text）。 */
  function openNodeDialog() {
    if (document.querySelector('.nodes-model-list, .nodes-model-container, .nodes-model')) return;
    const btn = document.querySelector('.node-add-text, [class*="node-add"]');
    if (btn) {
      try {
        btn.click();
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  /** 关闭「选择节点参数」弹窗（点确认/取消或关闭按钮）。 */
  function closeNodeDialog() {
    // 1) 确认/取消按钮
    let btn = document.querySelector('.nodes-model-confirm, .nodes-model-cancel, [class*="nodes-model-close"]');
    if (btn) {
      try {
        btn.click();
        return;
      } catch (e) {
        /* 忽略 */
      }
    }
    // 2) 兜底：按 Esc
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 移除发布页已添加的全部输入节点（覆盖模式时清空重来）。
   *  已添加节点项（.node-item）上有 .node-item-delete / 移除按钮。
   *  返回移除数量。
   */
  /** 移除发布页已添加的全部输入节点（粘贴时先清空再添加）。
   *  已添加节点项（.node-item）上有 .node-item-delete 删除按钮。
   *  返回移除数量。
   */
  function clearExistingNodes() {
    let removed = 0;
    const items = document.querySelectorAll('.node-item, [class*="node-item"]');
    for (const it of items) {
      const cls = String(it.className || '');
      if (cls.indexOf('node-item') === -1 || cls.indexOf('nodes-model') > -1) continue;
      const delBtn = it.querySelector('.node-item-delete, [class*="node-item-delete"], [class*="item-delete"], [class*="delete"]');
      if (delBtn) {
        try {
          delBtn.click();
          removed++;
        } catch (e) {
          /* 忽略 */
        }
      }
    }
    // 弹窗里已添加项的「移除」按钮兜底
    const rmBtns = qsaAll('.nodes-model-list-item-remove, [class*="item-remove"]'.split(','));
    for (const btn of rmBtns) {
      try {
        btn.click();
        removed++;
      } catch (e) {
        /* 忽略 */
      }
    }
    return removed;
  }

  /** 节点项文本（整项，含 `nodeName-fieldName` 与 `[nodeId] 值` 两行，供解析/匹配用）。 */
  function itemTextOf(it) {
    return String(it.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 解析节点项文本。弹窗/主列表的真实排版是两行：
   *   VHS_LoadVideo-force_rate      ← nodeName-fieldName
   *   [21] 0                        ← [nodeId] 当前值
   * 所以不能只认 `[id]` 之后的内容（那样会把 `[21] 0` 当成 nodeName、丢掉 fieldName，
   * 导致同一节点的多个参数同分、取到第一个 —— 实测 21-video 被 force_rate 顶掉）。
   */
  function parseItemLabel(txt) {
    const s = String(txt || '').replace(/\s+/g, ' ').trim();
    const out = { nodeId: '', nodeName: '', fieldName: '' };
    const idm = s.match(/\[\s*(\d+)\s*\]/);
    if (idm) out.nodeId = idm[1];
    // 优先：`nodeName-fieldName`（两段都是标识符，排除 `[21] 0` 这类纯数字/中文描述）
    const nm = s.match(/([A-Za-z_][\w.]*)\s*-\s*([A-Za-z_][\w.]*)/);
    if (nm) {
      out.nodeName = nm[1];
      out.fieldName = nm[2];
      return out;
    }
    // 退化：末尾 `-field`（如 `[448] ResolutionSelector-megapixels`）
    const tm = s.match(/-\s*([A-Za-z_][\w.]*)\s*$/);
    if (tm) out.fieldName = tm[1];
    return out;
  }

  /** 从节点项文本里取「[nodeId] 当前值」中的值（DOM 读不到 value 时的兜底，如只读展示态）。 */
  function valueFromItemText(txt) {
    const m = String(txt || '').match(/\[\s*\d+\s*\]\s*([^\s\[]+)/);
    return m ? m[1] : '';
  }

  /**
   * 来源节点 → 页面节点项 的匹配分（0 = 不匹配）。
   * 唯一性依据：nodeId + nodeName(+ fieldName)。只按 `[nodeId]` 粗匹配会让同一节点的多个参数
   * （如 [448] 的 aspect_ratio / megapixels）互相串位，因此 fieldName / nodeName 命中都加权，取最高分。
   */
  function itemMatchScore(node, it) {
    const txt = itemTextOf(it);
    const p = parseItemLabel(txt);
    const hasId = !!node.nodeId && txt.indexOf('[' + node.nodeId + ']') > -1;
    let score = 0;
    if (hasId) score += 4;
    if (node.nodeName && p.nodeName && p.nodeName === node.nodeName) score += 2;
    if (node.fieldName && p.fieldName && p.fieldName === node.fieldName) score += 4;
    if (node.key && txt.indexOf(node.key) > -1) score += hasId ? 3 : 5; // `448-megapixels` 形式
    if (node.fieldName && !p.fieldName && txt.indexOf(node.fieldName) > -1) score += 1;
    return score;
  }

  /**
   * 该项能否作为匹配目标。唯一性依据是 nodeId（用户确认 nodeId+nodeName 唯一）；
   * fieldName 只做加权、不做硬门槛——实测弹窗项的 desc 文本可能不带字段名后缀，
   * 硬门槛会让 [21] VHS_LoadVideo 这类多参数节点全部 miss。
   */
  function itemHit(node, it) {
    const txt = itemTextOf(it);
    if (node.nodeId) {
      if (txt.indexOf('[' + node.nodeId + ']') > -1) return true;
      return !!(node.key && txt.indexOf(node.key) > -1);
    }
    // 来源没 nodeId（少见）：退化为按 fieldName / nodeName 文本命中
    return !!(node.fieldName && txt.indexOf(node.fieldName) > -1) ||
      !!(node.nodeName && txt.indexOf(node.nodeName) > -1);
  }

  /** 在候选节点项里按匹配分选最可信的一项（分数不超过 minScore 返回 null）。 */
  function pickBestItem(node, items, minScore) {
    let best = null;
    let bestScore = minScore;
    for (const it of items) {
      if (!itemHit(node, it)) continue;
      const s = itemMatchScore(node, it);
      if (s > bestScore) {
        bestScore = s;
        best = it;
      }
    }
    return best;
  }

  /** 找不到时把候选项的真实结构打到 Console（一次性拿到 DOM 真相）。 */
  function logCandidates(node, items) {
    const mine = items.filter((it) => itemTextOf(it).indexOf('[' + node.nodeId + ']') > -1);
    if (!mine.length) return;
    console.warn(
      '[RHT] 节点 ' + node.key + ' 的候选弹窗项（共 ' + mine.length + ' 个），' +
        '来源 fieldName=' + (node.fieldName || '-') + '：'
    );
    mine.forEach((it, i) => {
      const el = it.cloneNode(true);
      el.querySelectorAll && el.querySelectorAll('input,textarea,select').forEach((x) => x.remove());
      console.warn('  #' + i + ' desc="' + itemTextOf(it).slice(0, 80) + '" html=' + el.outerHTML.slice(0, 300));
    });
  }

  /** 在「选择节点参数」弹窗里找对应节点项并点「添加」按钮。
   *  匹配按 nodeId + nodeName + fieldName 复合键取最高分，避免同 nodeId 的多个参数串位。
   */
  function addNodeInDialog(node) {
    const items = qsaAll('.nodes-model-list-item, .nodes-model-content .node-item'.split(','));
    const it = pickBestItem(node, items, 3);
    if (!it) {
      logCandidates(node, items); // 找不到时把候选弹窗项的真实结构打到 Console
      return '';
    }
    const addBtn = it.querySelector('.nodes-model-list-item-add, [class*="-add"], [class*="item-add"]');
    if (addBtn) {
      try {
        addBtn.click();
        return 'added';
      } catch (e) {
        return '';
      }
    }
    return 'exists'; // 已添加（无添加按钮）
  }

  /** 在发布页「主列表」里找对应的已添加节点项（.node-item，非弹窗项）。 */
  function findMainNodeItem(node) {
    const items = [];
    for (const it of document.querySelectorAll('.node-item, [class*="node-item"]')) {
      const cls = String(it.className || '');
      if (cls.indexOf('node-item') === -1) continue;
      if (cls.indexOf('nodes-model') > -1) continue; // 跳过弹窗项
      items.push(it);
    }
    // 1) 复合键匹配（nodeId + nodeName/fieldName）
    const hit = pickBestItem(node, items, 3);
    if (hit) return hit;
    // 2) 兜底：显示名输入框当前值 或 nodeName 文本匹配
    const needles = [node.description, node.nodeName].filter(Boolean);
    for (const it of items) {
      const nameInput = it.querySelector('input.node-item-input, [class*="node-item"] input[class*="input"]');
      if (!nameInput) continue;
      const v = nameInput.value || '';
      if (needles.some((n) => v.indexOf(n) > -1)) return it;
    }
    return null;
  }

  /** 已添加节点在页面「主列表」上实际显示的字段名（页面可能按自身规则选字段）。 */
  function matchedFieldOf(node) {
    const items = [];
    for (const it of document.querySelectorAll('.node-item, [class*="node-item"]')) {
      const cls = String(it.className || '');
      if (cls.indexOf('node-item') === -1 || cls.indexOf('nodes-model') > -1) continue;
      items.push(it);
    }
    const it = pickBestItem(node, items, 3);
    return it ? parseItemLabel(itemTextOf(it)).fieldName : '';
  }

  function labelTextOf(el) {    // 向上找 label / 带标题样式的祖先，取其文本
    let p = el.closest('label');
    if (!p) p = el.closest('[class*="label"], [class*="field-name"], [class*="node-name"], [class*="title"], [class*="item-left"]');
    if (!p) p = el.parentElement;
    if (!p) return '';
    const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length && t.length <= 40 ? t : '';
  }

  // 读取一个输入控件的当前值（诊断用，与 capture 一致）
  function readElValue(el) {
    if (!el) return '';
    if (el instanceof HTMLSelectElement) return el.value;
    if (el.isContentEditable) return el.textContent || '';
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'true' : 'false';
    return el.value || '';
  }


  /** 用节点 nodeName / fieldName 文本匹配 label，兜底策略 */
  function findInputByLabel(node) {
    const labels = qsaAll([
      'label',
      '[class*="label"]',
      '[class*="title"]',
      '[class*="name"]',
      '[class*="field"]',
      'span',
      'div',
    ]);
    const needles = [node.nodeName, node.fieldName].filter(Boolean);
    for (const lab of labels) {
      const text = (lab.textContent || '').trim();
      if (!text || text.length > 60) continue;
      if (needles.some((n) => n && (text === n || text.includes(n)))) {
        let box = lab.closest('[class*="node"], [class*="param"], [class*="input"], [class*="field"], [class*="card"], li, .el-form-item');
        if (!box) box = lab.parentElement;
        const found = box && box.querySelector(INPUT_SELECTOR);
        if (found) return found;
      }
    }
    return null;
  }

  /** 从当前页面表单直接抓取节点参数（不用 API，页面已加载好）。
   *  思路与填充相反：扫描输入控件 → 提取 nodeId 与当前值 → 组装为 nodeInfoList。
   *
   * 重点：只抓「应用节点」，不抓发布设置。识别依据：
   *  - 节点容器 .nodes-model-list-item（发布页真正的应用节点区），项内带 `[nodeId]`。
   *  - 或输入框带 data-node-id 等 nodeId 属性。
   *  - 发布设置项（Standard/Plus/Ultra 等）没有 nodeId，会被排除。
   */
  function captureNodesFromForm() {
    const map = buildNodeInputMap();
    const nodes = [];
    const seenOut = new Set();
    map.forEach((v, key) => {
      // 只接受节点级键：裸 nodeId 或复合键 nodeId-fieldName（跳过别名键如 nodeId#1）
      if (!/^\d+$/.test(key) && !/^\d+-[\w.]+$/.test(key)) return;
      const nodeId = v.nodeId || key.split('-')[0];
      if (!nodeId) return;
      const fieldName = /^\d+-/.test(key) ? key.slice(nodeId.length + 1) : v.fieldName || '';
      const dedupe = nodeId + '-' + fieldName;
      if (seenOut.has(dedupe)) return; // 复合键与裸 nodeId 别名指向同一参数，只取一次
      seenOut.add(dedupe);

      const el = v.el;
      let value = '';
      let fieldType = '';
      if (el instanceof HTMLSelectElement) {
        value = el.value;
      } else if (el.isContentEditable) {
        value = el.textContent || '';
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        value = el.checked ? 'true' : 'false';
      } else {
        value = el.value || '';
      }
      // 从控件/祖先推断类型：文件框 / 图片/音视频上传 → FILE
      if (
        el.type === 'file' ||
        /(image|audio|video|file|upload|zip)/i.test(String(el.className || '') + ' ' + String(el.id || '')) ||
        (el.parentElement && /(image|audio|video|file|upload|zip)/i.test(String(el.parentElement.className || '')))
      ) {
        fieldType = 'FILE';
      }
      // 显示名输入框只提供 description，其值不当参数值；只读展示态读不到值则用行文本里的 `[nodeId] 值` 兜底
      if (v.nameOnly) value = '';
      if (!value) value = v.textValue || '';
      nodes.push({
        nodeId,
        nodeName: v.nodeName || '',
        fieldName,
        key: fieldName ? nodeId + '-' + fieldName : nodeId,
        fieldValue: value,
        fieldType,
        description: v.nameValue || '',
      });
    });
    return nodes;
  }

  /* ---------------- 填值：触发前端框架更新 ---------------- */

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillInput(el, value) {
    if (el instanceof HTMLSelectElement) {
      const opt = Array.from(el.options).find((o) => o.value === value || o.text === value);
      if (opt) {
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    }
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return true;
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      const want = String(value).toLowerCase();
      const checked = want === 'true' || want === '1' || want === 'yes' || want === 'on';
      if (el.checked !== checked) el.click();
      return true;
    }
    setNativeValue(el, value);
    return true;
  }

  /** 尝试填充一个节点；返回 { status: 'filled'|'select-miss'|'no-input'|'file', msg } */
  function applyNode(node, map) {
    if (isFileType(node.fieldType)) {
      return { status: 'file', msg: '文件/图片节点需手动上传' };
    }
    let entry = map.get(node.nodeId);
    let via = entry ? entry.via : '';
    // 没有 nodeId（如文本匹配）时，用 fieldName / nodeName 当 key
    if (!entry && node.fieldName) {
      entry = map.get(node.fieldName);
      via = entry ? entry.via : '';
    }
    if (!entry && node.nodeName) {
      entry = map.get(node.nodeName);
      via = entry ? entry.via : '';
    }
    if (!entry) {
      const el = findInputByLabel(node);
      if (el) entry = { el, via: 'label' };
    }
    if (!entry) {
      return { status: 'no-input', msg: '页面上未找到对应输入框' };
    }
    let el = entry.el;
    // 发布页节点项可能处于“显示模式”：值在 desc 文本里，需要先点节点项/编辑按钮进入可编辑
    const item = el.closest('.nodes-model-list-item, [class*="node-item"]');
    if (item) {
      // 优先点“编辑”切换按钮
      const editBtn = item.querySelector('.node-item-edit, [class*="node-edit"], [class*="item-edit"], [class*="edit-btn"]');
      if (editBtn) {
        try {
          editBtn.click();
        } catch (e) {
          /* 忽略 */
        }
      } else {
        // 没有编辑按钮时，直接点节点项本身打开编辑（列表项 onClick 会进入编辑态）
        try {
          item.click();
        } catch (e) {
          /* 忽略 */
        }
      }
      // 点开后重新取可编辑控件（input/textarea/select/contenteditable）
      const editable = item.querySelector(INPUT_SELECTOR + ', [contenteditable="true"]');
      if (editable) el = editable;
    }
    if (el instanceof HTMLSelectElement) {
      const ok = fillInput(el, node.fieldValue);
      return ok
        ? { status: 'filled', msg: '已填充（下拉，by ' + via + '）' }
        : { status: 'select-miss', msg: '下拉列表里没有该选项值' };
    }
    fillInput(el, node.fieldValue);
    return { status: 'filled', msg: '已填充（by ' + via + '）' };
  }

  /** 检测当前页面的输入节点（自动检测用）。
   *  AI 应用页（webapp）：detail 接口取 nodeInfos（页面输入框无 nodeId 属性，DOM 抓不到）。
   *  发布/工作流页：抓页面表单，抓不到再走接口。
   */
  async function detectNodes(info) {
    let nodes = [];
    if (info.kind === 'webapp') {
      const res = await readSourceApp(info.id, 'webapp');
      if (res && res.json && (res.json.code === 0 || res.json.nodeInfos || res.json.nodes)) {
        const list = extractNodeList(res.json);
        nodes = normalizeNodes(list || []);
      }
    } else {
      nodes = captureNodesFromForm();
      if (!nodes.length) {
        const res = await readSourceApp(info.id, 'workflow');
        if (res && res.json && (res.json.code === 0 || res.json.nodeInfos || res.json.nodes)) {
          const list = extractNodeList(res.json);
          nodes = normalizeNodes(list || []);
        }
      }
    }
    return nodes;
  }

  /** 设置发布页节点项的「显示名」。
   *  用户数据里 description 就是显示名（如「输入=当前镜头-配图」）。
   *  主列表 node-item 结构：<div class="node-item"> → <div class="node-item-content">
   *    → <input class="node-item-input" :value="l.description" readonly>  ← 显示名输入框
   *  readonly 需要先点编辑（.node-item-edit）才能改。
   */
  function setNodeDisplayName(node) {
    if (!node) return false;
    const desired = node.description || node.fieldName || node.nodeName;
    if (!desired) return false;
    const item = findMainNodeItem(node);
    if (!item) return false;
    // 显示名输入框（node-item-input，绑定 description）
    const nameInput = item.querySelector('input.node-item-input, [class*="node-item"] input[class*="input"]');
    if (!nameInput) return false;
    // readonly 时先点该节点项/编辑按钮进入编辑态
    if (nameInput.readOnly) {
      const editBtn = item.querySelector('.node-item-edit, [class*="node-edit"], [class*="item-edit"], [class*="edit-btn"]');
      if (editBtn) {
        try {
          editBtn.click();
        } catch (e) {
          /* 忽略 */
        }
      } else {
        try {
          item.click();
        } catch (e) {
          /* 忽略 */
        }
      }
    }
    if (nameInput.value !== desired) {
      fillInput(nameInput, desired);
      return true;
    }
    return false;
  }

  /* ---------------- 面板 UI（Shadow DOM） ---------------- */

  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'rht-host';
    host.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:-apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;';
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .rht-fab {
          margin-left:auto; width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;
          background:#4f6ef7;color:#fff;font-size:22px;box-shadow:0 4px 14px rgba(79,110,247,.4);
          display:flex;align-items:center;justify-content:center;transition:transform .15s;
        }
        .rht-fab:hover{transform:scale(1.06);}
        .rht-panel {
          display:none; width:390px; max-height:80vh; overflow:auto; margin-bottom:10px;
          background:#fff;border:1px solid #e2e6f0;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);
          padding:14px 16px;color:#24292f;font-size:13px;line-height:1.6;
        }
        .rht-panel.open{display:block;}
        .rht-panel h3{margin:0 0 4px;font-size:15px;}
        .rht-sub{color:#8a94a6;font-size:12px;margin:0 0 10px;}
        .rht-row{margin:8px 0;}
        .rht-row label{display:block;font-size:12px;color:#57606a;margin-bottom:4px;}
        .rht-input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d0d7de;border-radius:8px;font-size:13px;}
        .rht-btn{width:100%;padding:9px 10px;border:none;border-radius:8px;font-size:13px;cursor:pointer;color:#fff;margin-top:4px;}
        .rht-btn.primary{background:#4f6ef7;}
        .rht-btn.success{background:#1a7f37;}
        .rht-btn:disabled{background:#b8c0d8;cursor:not-allowed;}
        .rht-status{margin-top:8px;padding:8px 10px;border-radius:8px;background:#f6f8fa;font-size:12px;white-space:pre-wrap;max-height:200px;overflow:auto;}
        .rht-status.error{background:#ffebe9;color:#cf222e;}
        .rht-status.ok{background:#dafbe1;color:#116329;}
        .rht-node{margin:3px 0;padding:4px 6px;background:#f6f8fa;border-radius:6px;font-size:12px;display:flex;justify-content:space-between;gap:8px;}
        .rht-node .id{color:#8a94a6;font-family:monospace;}
        .rht-node .val{color:#57606a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px;}
        .rht-warn{color:#9a6700;font-size:12px;margin-top:6px;}
        .rht-promo{margin-top:10px;padding:8px 10px;border-radius:8px;background:linear-gradient(135deg,#f3f0ff,#eef2ff);border:1px solid #e4dcff;}
        .rht-promo .t{display:block;font-size:12px;font-weight:700;color:#5b3dc4;margin-bottom:2px;}
        .rht-promo .d{display:block;font-size:11px;line-height:1.55;color:#6b6f76;}
        .rht-promo a{display:inline-block;margin-top:4px;font-size:11px;color:#4f6ef7;text-decoration:none;}
        .rht-promo a:hover{text-decoration:underline;}
      </style>
      <div class="rht-panel" id="panel">
        <h3>📋 复制 / 粘贴应用参数</h3>
        <p class="rht-sub">来源页面点【复制本页参数】→ 到发布页面点【粘贴到本页】。<b>只填充，不自动发布。</b></p>
        <div class="rht-row">
          <label>当前页面应用 ID（自动识别）</label>
          <input class="rht-input" id="currentId" placeholder="未识别到" disabled>
        </div>
        <button class="rht-btn primary" id="copyBtn" style="display:none;">① 复制本页参数</button>
        <button class="rht-btn success" id="pasteBtn" style="display:none;">② 粘贴到本页</button>
        <div id="preview" style="margin-top:10px;"></div>
        <button class="rht-btn" id="debugBtn" style="background:#ffecb3;color:#7a5c00;border:1px solid #e6c36a;margin-top:6px;">🔍 诊断本页节点结构</button>
        <div class="rht-status" id="status" style="display:none;"></div>
        <div class="rht-promo">
          <span class="t">途视——AI 批量视频生成利器</span>
          <span class="d">小说、剧本、参考视频一键转分镜，批量跑 ComfyUI / RunningHub 工作流，生图、生视频、配音到剪映成片全自动。</span>
          <a href="https://space.bilibili.com/199774118" target="_blank" rel="noopener">B 站教程 @zzbbto ↗</a>
        </div>
      </div>
      <button class="rht-fab" id="fab" title="RunningHub 复制/粘贴应用参数">📋</button>
    `;

    const panel = root.getElementById('panel');
    const fab = root.getElementById('fab');
    const currentIdInput = root.getElementById('currentId');
    const copyBtn = root.getElementById('copyBtn');
    const pasteBtn = root.getElementById('pasteBtn');
    const debugBtn = root.getElementById('debugBtn');
    const preview = root.getElementById('preview');
    const status = root.getElementById('status');

    let copied = null; // { srcId, srcHost, time, nodes }

    const setStatus = (text, kind) => {
      status.style.display = 'block';
      status.textContent = text;
      status.className = 'rht-status' + (kind ? ' ' + kind : '');
    };
    const hideStatus = () => (status.style.display = 'none');

    const pageInfo = currentPageInfo();
    const currentId = pageInfo.id;
    currentIdInput.value = currentId || '未识别到';

    // 按页面类型显示对应按钮：
    //  - AI 应用界面（webapp，来源页）只显示复制
    //  - 发布/编辑页（workflow）两个都显示：既可复制本页，也可粘贴
    const isPublishPage = pageInfo.kind === 'workflow';
    const isSourcePage = pageInfo.kind === 'webapp';
    copyBtn.style.display = (isPublishPage || isSourcePage) ? '' : 'none';
    pasteBtn.style.display = isPublishPage ? '' : 'none';

    // 🔍 诊断：把当前页面节点相关 DOM 结构输出到状态框，便于定位匹配问题
    debugBtn.addEventListener('click', () => {
      const map = buildNodeInputMap();
      const parts = [];
      parts.push('页面 URL: ' + window.location.pathname);
      parts.push('buildNodeInputMap 匹配到 ' + map.size + ' 个键：');
      map.forEach((v, k) => {
        const tag = v.el.tagName.toLowerCase();
        parts.push(
          '  · ' + k + ' → <' + tag + '> via=' + v.via +
          (v.nodeName ? ' nodeName=' + v.nodeName : '') +
          (v.fieldName ? ' field=' + v.fieldName : '') +
          ' value=' + JSON.stringify(readElValue(v.el)).slice(0, 40) +
          (v.descText ? ' desc="' + String(v.descText).slice(0, 40) + '"' : '') +
          (v.nameOnly ? ' [仅显示名]' : '') +
          (v.nameValue ? ' 显示名="' + String(v.nameValue).slice(0, 40) + '"' : '')
        );
      });
      // 常见节点容器类名是否存在
      const probes = [
        '.nodes-model-list-item',
        '.nodes-model-list',
        '[class*="node-item"]',
        '[class*="node-input"]',
        '.node-item-edit',
        '[class*="param-item"]',
        '[data-node-id]',
      ];
      parts.push('容器探测：');
      for (const sel of probes) {
        try {
          parts.push('  ' + sel + ' → ' + document.querySelectorAll(sel).length + ' 个');
        } catch (e) {
          parts.push('  ' + sel + ' → 无效');
        }
      }
      // 前几个 input 的 class/attr 快照
      const inputs = document.querySelectorAll('input, textarea, select');
      parts.push('前 8 个输入控件：');
      Array.from(inputs)
        .slice(0, 8)
        .forEach((el) => {
          const id = el.id ? ' id=' + el.id : '';
          const name = el.name ? ' name=' + el.name : '';
          const dataAttrs = Array.from(el.attributes)
            .filter((a) => a.name.indexOf('data-') === 0)
            .map((a) => a.name + '=' + a.value)
            .join(' ');
          parts.push('  <' + el.tagName.toLowerCase() + '>' + id + name + ' class="' + (el.className || '') + '" ' + dataAttrs + ' val=' + JSON.stringify(el.value || '').slice(0, 30));
        });
      // 找出页面上所有“像按钮/可点”的元素（含文案），便于定位「添加节点参数」按钮
      parts.push('按钮/可点元素（文本含 添加/节点/参数/Add，前 20 个）：');
      const clickable = document.querySelectorAll('button, div[role="button"], [class*="btn"], [class*="button"], [class*="add"], [class*="icon"]');
      let n = 0;
      for (const el of clickable) {
        if (n >= 20) break;
        const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        const cls = String(el.className || '').slice(0, 60);
        if (/添加|节点|参数|Add|add|Node|node|Param|param|编辑|edit|选择|select/i.test(txt + cls)) {
          parts.push('  <' + el.tagName.toLowerCase() + '> class="' + cls + '" 文本="' + txt + '"');
          n++;
        }
      }
      // 第一个 node-item 内部所有输入框（绕开大 SVG）
      parts.push('node-item 内部输入框（第 1 个）：');
      const firstItem = document.querySelector('[class*="node-item"]');
      if (firstItem) {
        const inputs = firstItem.querySelectorAll('input, textarea, select, [contenteditable="true"]');
        if (inputs.length) {
          inputs.forEach((el) => {
            const cls = String(el.className || '').slice(0, 50);
            const ro = el.readOnly ? ' readonly' : '';
            const ph = el.placeholder ? ' ph="' + el.placeholder + '"' : '';
            parts.push('  <' + el.tagName.toLowerCase() + ' class="' + cls + '"' + ro + ph + ' val="' + String(el.value || '').slice(0, 30) + '"');
          });
        } else {
          parts.push('  （该 node-item 内无 input/textarea/select）');
        }
        // desc 文本
        const desc = firstItem.querySelector('.node-item-desc, [class*="item-desc"]');
        if (desc) parts.push('  desc 文本: ' + (desc.textContent || '').slice(0, 60));
      } else {
        parts.push('  （无 node-item）');
      }
      // 发布页所有 node-item 的清单（desc 文本 + 显示名输入框值）
      parts.push('发布页 node-item 清单（前 12 个）：');
      const allItems = document.querySelectorAll('.node-item, [class*="node-item"]');
      let cnt = 0;
      for (const it of allItems) {
        const cls = String(it.className || '');
        if (cls.indexOf('node-item') === -1 || cls.indexOf('nodes-model') > -1) continue;
        if (cnt >= 12) break;
        const desc2 = it.querySelector('.node-item-desc, [class*="item-desc"]');
        const nameInput2 = it.querySelector('input.node-item-input, [class*="node-item"] input[class*="input"]');
        parts.push(
          '  desc="' + (desc2 ? (desc2.textContent || '').slice(0, 40) : '?') + '"' +
          '  显示名输入框="' + (nameInput2 ? String(nameInput2.value || '').slice(0, 30) : '无') + '"'
        );
        cnt++;
      }
      // 按来源节点文本反查发布页真实容器（定位显示名所在元素）
      parts.push('反查「输入=当前镜头-配图」所在容器：');
      const allEls = document.querySelectorAll('body *');
      let found = null;
      for (const el of allEls) {
        if (el.children.length > 0) continue; // 只要叶子元素
        if ((el.textContent || '').indexOf('输入=当前镜头-配图') > -1) {
          found = el;
          break;
        }
      }
      if (found) {
        // 向上找 4 层，输出每层 class
        let p = found;
        for (let i = 0; i < 4 && p; i++) {
          const c = String(p.className || '').slice(0, 60);
          const tag = p.tagName.toLowerCase();
          parts.push('  层级' + i + ': <' + tag + '> class="' + c + '"' + (i === 0 ? ' 文本="' + (p.textContent || '').slice(0, 40) + '"' : ''));
          p = p.parentElement;
        }
        // 该叶子元素是输入框还是文本
        parts.push('  叶子: <' + found.tagName.toLowerCase() + '> readonly=' + (found.readOnly || false) + ' val="' + String(found.value || found.textContent || '').slice(0, 40) + '"');
      } else {
        parts.push('  （页面未找到该文本 —— 节点可能在 iframe/Shadow DOM 或未渲染）');
      }
      // —— DOM 快照：把弹窗节点项 + 主列表节点项的原始 HTML 抓出来，复制到剪贴板（供核对真实结构）——
      const snap = [];
      snap.push('=== RHT DOM 快照 ' + new Date().toISOString() + ' ===');
      snap.push('URL: ' + location.href);
      const snapItems = (sel, title, limit) => {
        const arr = Array.from(document.querySelectorAll(sel));
        snap.push('--- ' + title + '（共 ' + arr.length + ' 个，取前 ' + limit + '）---');
        arr.slice(0, limit).forEach((it, i) => {
          const clone = it.cloneNode(true);
          clone.querySelectorAll && clone.querySelectorAll('svg,script,style').forEach((x) => x.remove());
          snap.push('#' + i + ' desc="' + itemTextOf(it).slice(0, 80) + '"');
          snap.push(String(clone.outerHTML).replace(/\s+/g, ' ').slice(0, 1500));
        });
      };
      snapItems('.nodes-model-list-item', '弹窗节点项（需先打开【添加节点参数】弹窗）', 12);
      snapItems('.node-item', '主列表节点项', 12);
      const snapText = snap.join('\n');
      if (!document.querySelector('.nodes-model-list-item')) {
        parts.push('（弹窗未打开：请先点【添加节点参数】再点本按钮，否则取不到弹窗项）');
      }
      try {
        navigator.clipboard.writeText(snapText);
        parts.push('（DOM 快照 ' + snapText.length + ' 字符已复制到剪贴板，直接粘贴给我即可）');
      } catch (e) {
        console.log(snapText);
        parts.push('（剪贴板写入失败，已输出到 Console）');
      }
      setStatus(parts.join('\n'), '');
    });

    // 渲染当前页面检测到的节点列表
    const renderDetected = (nodes) => {
      preview.innerHTML = '';
      if (!nodes || !nodes.length) {
        preview.innerHTML = '<div class="rht-warn">当前页面未检测到节点。</div>';
        return;
      }
      const count = document.createElement('div');
      count.textContent = '检测到 ' + nodes.length + ' 个节点：';
      count.style.cssText = 'font-size:12px;color:#57606a;margin-bottom:4px;';
      preview.appendChild(count);
      const list = document.createElement('div');
      list.style.cssText = 'max-height:160px;overflow:auto;';
      nodes.forEach((n) => {
        const row = document.createElement('div');
        row.className = 'rht-node';
        const left = document.createElement('span');
        left.textContent = (n.description || n.nodeName || n.fieldName || '节点') + (n.nodeId ? ' #' + n.nodeId : '');
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = isFileType(n.fieldType) ? '[文件]' : n.fieldValue || '（空）';
        val.title = n.fieldValue;
        row.appendChild(left);
        row.appendChild(val);
        list.appendChild(row);
      });
      preview.appendChild(list);
    };

    const showCopied = (data) => {
      copied = data;
    };

    // 自动检测：打开面板时检测当前页节点数并显示
    async function autoDetect() {
      const info = currentPageInfo();
      if (!info.id) return;
      try {
        const nodes = await detectNodes(info);
        renderDetected(nodes);
      } catch (e) {
        /* 忽略检测失败 */
      }
    }

    // 面板开着时，监听节点 DOM 变化实时刷新检测结果
    let detectTimer = null;
    const scheduleDetect = () => {
      if (!panel.classList.contains('open')) return;
      if (detectTimer) return; // 已有排队的刷新
      detectTimer = setTimeout(() => {
        detectTimer = null;
        autoDetect();
      }, 400);
    };

    fab.addEventListener('click', () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        // 只显示当前页面的节点（检测是自动的），不显示要粘贴的来源预览
        autoDetect();
      }
    });

    // 监听节点项（node-item / 弹窗列表）增删，实时刷新
    if (typeof MutationObserver !== 'undefined') {
      const detectMO = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type !== 'childList') continue;
          const target = m.target;
          const cls = String(target.className || '');
          if (
            cls.indexOf('node-item') > -1 ||
            cls.indexOf('nodes-model') > -1 ||
            cls.indexOf('node-list') > -1 ||
            target === document.body ||
            target === document.querySelector('.rht-panel')
          ) {
            scheduleDetect();
            break;
          }
        }
      });
      detectMO.observe(document.documentElement, { childList: true, subtree: true });
    }

    // 兜底：面板开着时每 2 秒刷新一次（防止某些变化未被 MutationObserver 捕获）
    setInterval(() => {
      if (panel.classList.contains('open')) {
        autoDetect();
      }
    }, 2000);

    // ① 复制本页参数
    copyBtn.addEventListener('click', async () => {
      const info = currentPageInfo();
      if (!info.id) {
        setStatus('当前页面未识别到应用 ID，请直接在来源应用页面（URL 含应用 ID）点此按钮。', 'error');
        return;
      }
      copyBtn.disabled = true;
      copyBtn.textContent = '复制中…';
      hideStatus();
      try {
        const nodes = await detectNodes(info);
        const data = { srcId: info.id, srcKind: info.kind, srcHost: HOST, time: Date.now(), nodes };
        showCopied(data);
        saveCopied(data);
        const clipOk = await copyToClipboard(data);
        if (!nodes.length) {
          setStatus('已复制，但当前页面未检测到可填的输入节点。', 'ok');
        } else if (clipOk) {
          setStatus('已复制，检测到 ' + nodes.length + ' 个输入节点。\n到发布页面点「② 粘贴到本页」即可同步。', 'ok');
        } else {
          setStatus('已复制，检测到 ' + nodes.length + ' 个输入节点（剪贴板不可用，已存本地）。\n到发布页面点「② 粘贴到本页」即可同步。', 'ok');
        }
      } catch (err) {
        setStatus('复制异常：' + String((err && err.message) || err), 'error');
      } finally {
        copyBtn.disabled = false;
        copyBtn.textContent = '① 复制本页参数';
      }
    });

    // ② 粘贴到本页
    pasteBtn.addEventListener('click', async () => {
      // 优先用内存里的；若为空，先从剪贴板读取（剪贴板不可用则回退 localStorage）
      if (!copied || !copied.nodes || !copied.nodes.length) {
        const fromClip = await readFromClipboard();
        if (fromClip) {
          copied = fromClip;
          showCopied(fromClip);
        }
      }
      if (!copied || !copied.nodes || !copied.nodes.length) {
        setStatus('还没有可粘贴的参数。\n请先到来源应用页面点「① 复制本页参数」，再回到这里点「② 粘贴到本页」。', 'error');
        return;
      }

      pasteBtn.disabled = true;
      pasteBtn.textContent = '粘贴中…';
      try {
        // 先清空发布页已有的节点，再按 id/key 添加来源节点
        let removed = 0;
        removed = clearExistingNodes();
        if (removed) await new Promise((r) => setTimeout(r, 400));

        // 打开发布页「选择节点参数」弹窗 → 逐节点匹配（[nodeId] / nodeId-fieldName）点「添加」。
        openNodeDialog();
        await new Promise((r) => setTimeout(r, 700));

        const missed = [];
        const added = [];
        const matched = [];
        const fieldDiff = [];
        let named = 0;

        for (const n of copied.nodes) {
          const addOk = addNodeInDialog(n);
          if (addOk === 'added') {
            added.push(n);
            matched.push(n);
            // 添加后等 Vue 渲染，再尝试同步显示名（description）
            await new Promise((r) => setTimeout(r, 150));
            if (setNodeDisplayName(n)) named++;
          } else if (addOk === 'exists') {
            // 已存在，直接同步显示名
            matched.push(n);
            if (setNodeDisplayName(n)) named++;
          } else {
            missed.push(n);
            continue;
          }
          // 核对页面实际字段：页面可能按自身规则选字段（如 VHS_LoadVideo 取 force_rate）
          const actual = matchedFieldOf(n);
          if (n.fieldName && actual && actual !== n.fieldName) {
            fieldDiff.push((n.key || n.nodeId) + ' → 页面实际 ' + n.nodeId + '-' + actual);
          }
        }

        let out = '粘贴完成：输入节点已按来源添加。\n';
        if (removed) {
          out += '🗑️ 已先清空发布页原有 ' + removed + ' 个节点。\n';
        }
        if (added.length) {
          out += '➕ 自动添加了 ' + added.length + ' 个节点。\n';
        }
        if (named) {
          out += '🏷️ 已更新 ' + named + ' 个节点的显示名。\n';
        }
        if (matched.length) {
          out += '📋 来源 → 已对应（nodeId-fieldName = 显示名）：\n' +
            matched.map((n) => '  · ' + (n.key || n.nodeId) + ' = ' + (n.description || n.fieldName || n.nodeName || '')).join('\n') + '\n';
        }
        if (fieldDiff.length) {
          out += '⚠️ 页面实际字段与来源不同（页面按自身规则取值，需手动改）：\n' +
            fieldDiff.map((s) => '  · ' + s).join('\n') + '\n';
        }
        if (missed.length) {
          out += '⚠️ ' + missed.length + ' 个节点未在弹窗中找到：\n' +
            missed.map((n) => '  · ' + (n.description || n.nodeName || n.fieldName) + ' #' + n.nodeId + (n.fieldName ? '-' + n.fieldName : '')).join('\n') + '\n';
        }
        out += '节点值沿用工作流默认值，无需填写。请核对后【手动点发布】。';
        setStatus(out, missed.length ? 'error' : 'ok');

        // 节点添加完，关闭「选择节点参数」弹窗
        await new Promise((r) => setTimeout(r, 300));
        closeNodeDialog();

      if (missed.length) {
        // 尝试定位第一个未找到的节点项并滚动到可见，方便手动处理
        const first = missed[0];
        const item = findMainNodeItem(first);
        if (item) {
          item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
      } catch (err) {
        setStatus('粘贴异常：' + String((err && err.message) || err), 'error');
      } finally {
        pasteBtn.disabled = false;
        pasteBtn.textContent = '② 粘贴到本页';
      }
    });

    return host;
  }

  // 只在发布页 / 编辑页 / AI 应用界面显示按钮
  //  - 发布/编辑页：  /publish/... 、/PublishView/publishAsNew（/workflow/:id 详情/运行页不显示）
  //  - AI 应用界面：  /ai-detail/... 、/ai-application、/ai-apps、/ai-detail-mobile/...
  // 其余页面（首页等）一律隐藏，避免打扰。
  function isRelevantPage() {
    const p = window.location.pathname;
    return (
      /\/publish\/.+/.test(p) ||
      /\/PublishView\/publishAsNew/.test(p) ||
      /\/ai-application/.test(p) ||
      /\/ai-apps/.test(p) ||
      /\/ai-detail(\/|-mobile\/)/.test(p)
    );
  }

  function refreshVisibility(host) {
    if (!host) return;
    host.style.display = isRelevantPage() ? '' : 'none';
    // 同时刷新按钮显隐（SPA 内部跳转后）
    const root = host.shadowRoot;
    if (!root) return;
    const info = currentPageInfo();
    const copyBtn = root.getElementById('copyBtn');
    const pasteBtn = root.getElementById('pasteBtn');
    const currentIdInput = root.getElementById('currentId');
    // 发布/编辑页（workflow）两个都显示；AI 应用界面（webapp）只显示复制
    if (copyBtn) copyBtn.style.display = (info.kind === 'workflow' || info.kind === 'webapp') ? '' : 'none';
    if (pasteBtn) pasteBtn.style.display = info.kind === 'workflow' ? '' : 'none';
    if (currentIdInput) currentIdInput.value = info.id || '未识别到';
  }

  // 页面可能是 SPA，给一个稍晚再挂载的兜底
  function mount() {
    if (!document.querySelector('#rht-host')) {
      const host = buildPanel();
      refreshVisibility(host);
    }
  }

  // 统一的「同步入口」：需要时挂载，已挂载则刷新显隐。
  // 关键背景：RunningHub 是 SPA，站内从 /post/xxx 等页面跳到 /ai-detail/xxx 常常不刷新文档，
  // 若脚本只在发布页/AI应用页注入，跳转后脚本从未运行 → 入口一直不显示（刷新才出现）。
  // 因此配合 manifest 全站注入，并用「路由钩子 + DOM 监听 + 周期兜底」三路同步。
  function syncPanel() {
    try {
      const host = document.querySelector('#rht-host');
      if (!host) {
        if (isRelevantPage()) mount();
        return;
      }
      refreshVisibility(host);
    } catch (e) {
      // 单次失败不能中断后续兜底（否则定时器里的异常会让入口彻底消失）
      console.warn('[RHT] syncPanel 失败:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncPanel);
  } else {
    syncPanel();
  }

  // SPA 路由变化：history.pushState / replaceState 不触发任何事件，这里包一层主动同步
  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    if (typeof orig !== 'function') return;
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      syncPanel();
      return r;
    };
  });
  window.addEventListener('popstate', syncPanel);
  window.addEventListener('hashchange', syncPanel);
  window.addEventListener('pageshow', syncPanel); // 前进/后退缓存恢复

  // DOM 变化兜底：面板被站点重渲染移除时补挂，路由变化后刷新显隐
  if (typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => syncPanel());
    mo.observe(document.documentElement, { childList: true, subtree: false });
  }

  // 周期兜底：覆盖首屏/路由就绪时序早于判定、以及上面所有钩子都漏掉的场景
  setInterval(syncPanel, 1000);
})();
