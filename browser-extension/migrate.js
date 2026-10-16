/**
 * RunningHub 双站「同名覆盖迁移」面板 — content script (wallet-migrate 页面专用)
 *
 * 功能：从源站读取工作流/AI应用资产列表 → 按名字匹配目标站同名资产 →
 *       同名用源站数据覆盖（保留目标 id）、不同名官方迁移新建。双向 .cn↔.ai。
 *
 * 通过 background.js（service worker）跨站调用接口：
 *   chrome.runtime.sendMessage({ action:'getTokens' })  查登录状态
 *   chrome.runtime.sendMessage({ action:'api', site, method, path, body })
 *
 * 安全：默认只读预览匹配结果，用户确认后才执行写操作。
 */
(() => {
  if (window.__rhtMigLoaded) return;
  window.__rhtMigLoaded = true;

  const HOST = window.location.origin;
  const THIS_SITE = HOST.indexOf('runninghub.cn') > -1 ? 'cn' : 'ai';
  const OTHER_SITE = THIS_SITE === 'cn' ? 'ai' : 'cn';

  /* ---------- 调 background ---------- */
  // 检测 background 是否存在（chrome.runtime.sendMessage 无响应时 resp 为 undefined）
  function bg(msg, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          done = true;
          resolve(resp || { ok: false, error: 'NO_RESPONSE(background可能未加载)' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'SEND_ERR:' + String(e) });
      }
      // 兜底：无响应超时（默认 180s，检测/执行涉及多次翻页接口调用，需较长超时）
      setTimeout(() => {
        if (!done) resolve({ ok: false, error: 'TIMEOUT(background可能未加载)' });
      }, timeoutMs || 180000);
    });
  }

  // 按站取 token：当前页用 localStorage，另一站用 chrome.storage（用户在另一站打开时存入）
  async function getTokenFor(site) {
    try {
      const pageToken = localStorage.getItem('Rh-Accesstoken') || '';
      if (site === THIS_SITE) return pageToken;
      // 另一站的 token 从 chrome.storage.local 读
      return await getStoredToken(site);
    } catch (e) { return ''; }
  }

  // 异步读 chrome.storage 里的另一站 token
  function getStoredToken(site) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('rht_tokens', (d) => {
          const t = (d && d.rht_tokens && d.rht_tokens[site]) || '';
          resolve(t);
        });
      } catch (e) { resolve(''); }
    });
  }

  async function api(site, path, body, method) {
    const token = await getTokenFor(site);
    const r = await bg({ action: 'api', site, method: method || 'POST', path, body, token });
    if (!r.ok) throw new Error(r.error || 'api failed');
    return r.data; // { httpStatus, json, raw }
  }

  /* ---------- 迁移核心 ---------- */

  // 目标站官方迁移的 aiTargetTicket（从当前 wallet-migrate 页面 URL / sessionStorage 获取）
  // 返回 { ticket, expired }；expired=true 表示 ticket 存在但已过期
  function getTargetTicket(dstSite) {
    let found = null;
    try {
      const params = new URLSearchParams(window.location.search);
      const t = params.get('aiTargetTicket') || '';
      if (t) found = { ticket: t, expireAt: 0 };
    } catch (e) { /* 忽略 */ }
    // 兜底：sessionStorage 里的 ticket（key 如 walletMigrate.aiTarget.<userId> / targetInfo...）
    if (!found) {
      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && (/aiTarget|targetInfo|target/i.test(k))) {
            const raw = sessionStorage.getItem(k);
            if (!raw) continue;
            let data = null;
            try { data = JSON.parse(raw); } catch (e) { continue; }
            if (data && data.aiTargetTicket) {
              found = { ticket: data.aiTargetTicket, expireAt: Number(data.aiTicketExpireAt) || 0 };
              break;
            }
          }
        }
      } catch (e) { /* 忽略 */ }
    }
    if (!found) return { ticket: '', expired: false };
    const now = Date.now();
    const expired = !!found.expireAt && now > found.expireAt;
    return { ticket: found.ticket, expired };
  }

  // 读某站资产列表（工作流 / AI应用）—— 翻页读取；传 limit 则最多取前 limit 个（默认不限）
  // 源站(.cn)：过滤掉未发布的（工作台草稿），只留已发布的可迁移
  async function fetchAssets(site, kind, limit) {
    const path = kind === 'webapp' ? '/uc/ai-migration/summary/webapps' : '/uc/ai-migration/summary/workflows';
    const all = [];
    let current = 1;
    const max = (Number.isFinite(limit) && limit > 0) ? limit : Infinity;
    const size = Math.min(100, max); // 接口单页上限 100，按 limit 截断
    for (;;) {
      const res = await api(site, path, { current, size });
      const data = res.json && res.json.data;
      const recs = (data && data.records) || [];
      recs.forEach((r) => all.push({ id: String(r.id), name: r.name }));
      const total = data && data.total ? Number(data.total) : 0;
      if (!recs.length || all.length >= max || all.length >= total || current >= 20) break;
      current++;
    }
    // 源站过滤未发布（草稿）：workflowState!==1 且 webappState!==1
    if (site === 'cn') {
      const published = [];
      const BATCH = 10;
      for (let i = 0; i < all.length; i += BATCH) {
        const batch = all.slice(i, i + BATCH);
        const results = await Promise.all(batch.map((a) => isPublished(site, kind, a.id).catch(() => false)));
        batch.forEach((a, idx) => { if (results[idx]) published.push(a); });
      }
      return published;
    }
    return all;
  }

  // 判断某资产是否已发布
  async function isPublished(site, kind, id) {
    if (kind === 'webapp') {
      const res = await api(site, '/api/webapp/detail', { webappId: id });
      const d = res.json && (res.json.data || res.json);
      if (!d) return false;
      return d.webappState === 1;
    }
    const res = await api(site, '/api/workflow/getDetail', { workflowId: id });
    const d = res.json && (res.json.data || res.json);
    if (!d) return false;
    return d.workflowState === 1 || d.webappState === 1;
  }

  // 读某站单个资产详情（webapp 用 /api/webapp/detail，workflow 用 /api/workflow/getDetail）
  async function fetchAssetDetail(site, kind, id) {
    if (kind === 'workflow') {
      const res = await api(site, '/api/workflow/getDetail', { workflowId: id });
      return res.json && (res.json.data || res.json);
    }
    const res = await api(site, '/api/webapp/detail', { webappId: id });
    if (res.json && res.json.code !== 0) {
      const res2 = await api(site, '/api/webapp/detail', { workflowId: id });
      return res2.json && (res2.json.data || res2.json);
    }
    return res.json && (res.json.data || res.json);
  }

  // 取目标站工作流已发布版本的 versionId（覆盖工作流需要）
  // 覆盖 AI 应用（保留 webappId）
  // 判断英文封面是否有效：objName 非空且 url 存在
  function isValidEnCover(c) {
    if (!c) return false;
    return !!(c.url && c.objName);
  }

  // 海报：中文封面跟随源站；英文封面优先用目标站已有的有效项，无效则空数组
  // 若封面触发敏感审核（IMAGE_SENSITIVE_TRIGGER），改用 .ai 目标站自身封面重试
  async function overwriteWebapp(srcSite, dstSite, srcDetail, dstId, dstName, dstWfId, dstCover, dstEnCover) {
    const nodes = (srcDetail && (srcDetail.nodeInfos || srcDetail.inputNodes)) || [];
    // 中文封面跟随源站（.cn 源 covers）
    const cnCover = (srcDetail && srcDetail.covers) || [];
    // 英文封面：优先目标已有的有效项，无效则空数组
    const enCover = (dstEnCover && dstEnCover.filter(isValidEnCover)) || [];
    const buildPayload = (cover, enCov) => ({
      workflowId: dstWfId || dstId,
      webappId: dstId,
      webappName: srcDetail && srcDetail.name ? srcDetail.name : dstName,
      tags: (srcDetail && srcDetail.tags) || [],
      description: (srcDetail && srcDetail.description) || '',
      state: (srcDetail && (srcDetail.state || srcDetail.webappState)) || 1,
      preview: null,
      coverFiles: cover,
      englishCoverFiles: enCov,
      nodeInfos: nodes,
      publishType: '1',
    });
    // 第一次：源封面
    let res = await api(dstSite, '/api/webapp/publish', buildPayload(cnCover, enCover));
    // 敏感触发 → 用 .ai 自身封面重试
    if (res.json && res.json.code && /SENSITIVE|TRIGGER/i.test(String(res.json.msg || ''))) {
      const retryPayload = buildPayload(dstCover || [], (dstEnCover && dstEnCover.filter(isValidEnCover)) || []);
      res = await api(dstSite, '/api/webapp/publish', retryPayload);
    }
    return res.json;
  }

  // 覆盖工作流（保留 workflowId）—— 全程只用「已发布版本」，不碰草稿
  // 1) 源内容读已发布版本；2) 目标 setContent 存到已发布版本；3) publish 用已发布版本
  // 任一站点没有已发布版本则跳过覆盖（返回提示，不拿草稿版本硬发）
  async function overwriteWorkflow(srcSite, dstSite, srcDetail, dstId, dstName, dstWfId, dstCover, dstEnCover, dstTags) {
    const dstWorkflowId = dstWfId || dstId;
    const srcName = (srcDetail && (srcDetail.name || srcDetail.workflowName)) || dstName;
    const srcDesc = (srcDetail && (srcDetail.description || srcDetail.desc)) || '';
    const srcWfId = (srcDetail && (srcDetail.id || srcDetail.workflowId)) || '';

    // 目标站必须已有已发布版本（publish 的 versionId 必须指向已发布版本，草稿会导致 SavedToVersionNoId）
    const dstVersionId = await getPublishedVersionId(dstSite, dstWorkflowId);
    if (!dstVersionId) {
      return { code: -1, msg: '目标站工作流没有已发布版本，跳过覆盖（publish 需要已发布 versionId）' };
    }

    // 1) 复制工作流内容：源读「已发布版本」（getContent 不带 versionId 返回的是最新草稿）
    const srcVersionId = await getPublishedVersionId(srcSite, srcWfId);
    if (srcWfId && srcVersionId) {
      const contentRes = await api(srcSite, '/api/workflow/getContent', { workflowId: srcWfId, versionId: srcVersionId });
      const wfContent = contentRes.json && contentRes.json.data && contentRes.json.data.workflowContent;
      if (wfContent) {
        await api(dstSite, '/api/workflow/setContent', { workflowId: dstWorkflowId, versionId: dstVersionId, workflowContent: wfContent });
      }
    }

    // 2) 发布（用已发布版本 id，使新内容成为线上）
    // 中文封面跟随源站；英文封面优先目标已有的有效项，无效则空数组
    // 敏感触发（IMAGE_SENSITIVE_TRIGGER）→ 改用 .ai 自身封面重试
    const cnCover = (srcDetail && srcDetail.covers) || [];
    const enCover = (dstEnCover && dstEnCover.filter(isValidEnCover)) || [];
    const buildPayload = (cover, enCov) => ({
      workflowId: dstWorkflowId,
      workflowName: srcName,
      tags: dstTags || [],
      description: srcDesc,
      preview: null,
      coverFiles: cover,
      englishCoverFiles: enCov,
      publishType: '1',
      accessType: 0,
      publishScope: 0,
      state: 1,
      versionId: dstVersionId,
    });
    let res = await api(dstSite, '/api/workflow/publish', buildPayload(cnCover, enCover));
    if (res.json && res.json.code && /SENSITIVE|TRIGGER/i.test(String(res.json.msg || ''))) {
      const retryPayload = buildPayload(dstCover || [], (dstEnCover && dstEnCover.filter(isValidEnCover)) || []);
      res = await api(dstSite, '/api/workflow/publish', retryPayload);
    }
    return res.json;
  }

  // 取某站工作流「已发布版本」id（严格已发布）；没有则返回 ''
  // 对比/覆盖必须以已发布版本为准：getContent 不带 versionId 返回的是最新草稿，会把未发布的修改误判为「更新」
  async function getPublishedVersionId(site, workflowId) {
    const res = await api(site, '/api/workflow/version/list', { workflowId });
    const versions = (res.json && res.json.data && res.json.data.versions) || [];
    const pub = versions.find((v) => v.published);
    return pub ? String(pub.id) : '';
  }

  // 用源站数据覆盖目标站同名资产（保留目标 id）
  // 目标站已有的海报（covers）和 tags 保留，避免 WORKFLOW_POSTER/TAG_CANNOT_EMPTY
  async function overwriteAsset(srcSite, dstSite, kind, srcDetail, dstId, dstName, dstWfId) {
    // 读目标站工作流/应用已有海报和 tags
    let dstCover = [];
    let dstEnCover = [];
    let dstTags = [];
    try {
      const dstDetail = await fetchAssetDetail(dstSite, kind === 'webapp' ? 'webapp' : 'workflow', kind === 'webapp' ? dstId : (dstWfId || dstId));
      dstCover = (dstDetail && dstDetail.covers) || [];
      dstEnCover = (dstDetail && dstDetail.englishCovers) || [];
      dstTags = (dstDetail && dstDetail.tags) || [];
    } catch (e) { /* 读不到就退回源的 */ }

    if (kind === 'webapp') {
      return overwriteWebapp(srcSite, dstSite, srcDetail, dstId, dstName, dstWfId, dstCover, dstEnCover);
    }
    // 工作流：内容(setContent) + 发布信息(publish) 都在 overwriteWorkflow 内完成
    return overwriteWorkflow(srcSite, dstSite, srcDetail, dstId, dstName, dstWfId, dstCover, dstEnCover, dstTags);
  }

  // 目标站无同名 → 新建（用官方迁移接口，保留迁移记录 sourceAssetId→targetAssetId）
  // 注意：官方迁移工具在 .cn 站运行（ticket 在 .cn 验证），assets 接口必须在 .cn 站调用，
  // 且 srcId 是 .cn 站的工作流/应用 id。因此 migrateNew 固定用 cn 站 + cn 侧 id。
  async function migrateNew(srcSite, dstSite, kind, srcId, ticket) {
    // cn→ai：官方迁移接口（在 CN 站，CN 源 id → AI 目标），保留迁移记录
    if (srcSite === 'cn') {
      const path = '/uc/ai-migration/assets';
      const body = {
        aiTargetTicket: ticket,
        assetType: kind === 'webapp' ? 'WEBAPP' : 'WORKFLOW',
        migrationScope: 'PARTIAL',
      };
      body[kind === 'webapp' ? 'webappIds' : 'workflowIds'] = [srcId];
      const res = await api('cn', path, body);
      return res.json;
    }
    // ai→cn：官方迁移不支持反向，改用目标站（CN）create/publish 从 AI 源创建
    const srcDetail = await fetchAssetDetail(srcSite, kind, srcId);
    if (kind === 'webapp') {
      const nodes = (srcDetail && (srcDetail.nodeInfos || srcDetail.inputNodes)) || [];
      const payload = {
        workflowId: srcDetail && srcDetail.workflowId ? srcDetail.workflowId : '',
        webappId: '',
        webappName: (srcDetail && srcDetail.name) || '',
        tags: (srcDetail && srcDetail.tags) || [],
        description: (srcDetail && srcDetail.description) || '',
        state: 1,
        preview: null,
        coverFiles: (srcDetail && srcDetail.covers) || [],
        englishCoverFiles: (srcDetail && srcDetail.englishCovers) || [],
        nodeInfos: nodes,
        publishType: '1',
      };
      const res = await api('cn', '/api/webapp/publish', payload);
      return res.json;
    }
    // 工作流：读 AI 源内容 → 在 CN 站创建并发布
    const srcWfId = (srcDetail && (srcDetail.id || srcDetail.workflowId)) || srcId;
    const contentRes = await api(srcSite, '/api/workflow/getContent', { workflowId: srcWfId });
    const wfContent = contentRes.json && contentRes.json.data && contentRes.json.data.workflowContent;
    if (wfContent) {
      await api('cn', '/api/workflow/setContent', { workflowId: '', workflowContent: wfContent });
    }
    return { code: -1, msg: 'AI→CN 新建工作流：需先创建 CN 工作流再 setContent（暂未完成自动创建）' };
  }

  // 计算同名匹配（只读）—— 按名字
  function buildPlan(srcAssets, dstAssets, kind) {
    const dstByName = new Map();
    dstAssets.forEach((a) => dstByName.set(a.name, a));
    const plan = {
      overwrite: [], // 同名，用源数据覆盖目标
      create: [],    // 目标没有，新建
    };
    srcAssets.forEach((a) => {
      const match = dstByName.get(a.name);
      if (match) plan.overwrite.push({ src: a, dst: match, kind });
      else plan.create.push({ src: a, kind });
    });
    return plan;
  }

  // 读迁移记录（sourceAssetId → targetAssetId 映射）
  async function fetchMigrationRecords(site, assetType) {
    const all = [];
    let current = 1;
    const size = 100;
    for (;;) {
      const res = await api(site, '/uc/ai-migration/records', {
        current, size, migrationType: 'ASSET', assetType,
      });
      const data = res.json && res.json.data;
      const records = (data && data.records) || [];
      // 记录里 sourceAssetId/targetAssetId/sourceAssetName
      records.forEach((r) => all.push({
        srcId: String(r.sourceAssetId),
        dstId: String(r.targetAssetId),
        name: r.sourceAssetName || '',
        assetType: r.assetType,
      }));
      const total = data && data.total ? Number(data.total) : 0;
      if (!records.length || all.length >= total || current >= 20) break;
      current++;
    }
    return all;
  }

  // 计算按迁移记录的匹配（默认）：源资产 → 记录映射里的目标 id（精确，不靠名字）
  // 迁移记录总是 CN→AI 方向（sourceAssetId=CN, targetAssetId=AI）。
  //  - cn→ai：源=CN，用 srcId 匹配；目标=AI，用 dstId
  //  - ai→cn：源=AI，用 dstId 匹配；目标=CN，用 srcId
  async function buildPlanByRecord(srcAssets, dstAssets, kind, srcSite, dstSite) {
    const kindType = kind === 'webapp' ? 'WEBAPP' : 'WORKFLOW';
    const records = await fetchMigrationRecords('cn', kindType);
    const plan = { overwrite: [], create: [] };
    const dstById = new Map(dstAssets.map((a) => [a.id, a]));
    const srcIsCn = srcSite === 'cn';
    // 记录里的「源侧 id」和「目标侧 id」
    const srcIdOf = (r) => (srcIsCn ? String(r.srcId) : String(r.dstId));
    const dstIdOf = (r) => (srcIsCn ? String(r.dstId) : String(r.srcId));
    const srcToRec = new Map(records.map((r) => [srcIdOf(r), r]));
    srcAssets.forEach((srcAsset) => {
      const rec = srcToRec.get(srcAsset.id);
      if (rec) {
        const dst = dstById.get(dstIdOf(rec));
        if (dst) plan.overwrite.push({ src: srcAsset, dst, kind, byRecord: true });
        else {
          // 记录里的目标被删（清理重复导致）→ 回退按名字匹配目标站已有资产
          const dstByName = dstAssets.find((a) => a.name === srcAsset.name);
          if (dstByName) plan.overwrite.push({ src: srcAsset, dst: dstByName, kind, byRecord: true, nameFallback: true });
          else plan.create.push({ src: srcAsset, kind, byRecord: true });
        }
      } else {
        plan.create.push({ src: srcAsset, kind });
      }
    });
    return plan;
  }

  // 资产列表缓存（site:kind:limit → 列表），避免匹配方式/页签切换重复拉取
  const assetCache = {};
  // 只获取前 N 个工作流/AI 应用（标题旁输入框控制，默认 100）
  let fetchLimit = 100;

  // 按模式构建计划：record（默认）用迁移记录 id；name 用名字
  // 来源站按 site:kind:limit 缓存（只取前 N 个），目标站不限制读取全部
  async function buildPlanByMode(mode, srcSite, dstSite, kind) {
    const ckSrc = srcSite + ':' + kind + ':' + fetchLimit;
    const ckDst = dstSite + ':' + kind;
    if (!assetCache[ckSrc]) assetCache[ckSrc] = await fetchAssets(srcSite, kind, fetchLimit);
    if (!assetCache[ckDst]) assetCache[ckDst] = await fetchAssets(dstSite, kind);
    const src = assetCache[ckSrc];
    const dst = assetCache[ckDst];
    if (mode === 'record') {
      return buildPlanByRecord(src, dst, kind, srcSite, dstSite);
    }
    return buildPlan(src, dst, kind);
  }

  /* ---------- 面板 UI ---------- */
  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'rht-mig-host';
    host.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;font-family:-apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;';
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .rht-fab{position:fixed;right:16px;bottom:16px;width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:#8b5cf6;color:#fff;font-size:20px;box-shadow:0 4px 14px rgba(139,92,246,.4);display:flex;align-items:center;justify-content:center;z-index:2147483646;}
        .rht-fab:hover{transform:scale(1.06);}
        .rht-panel{position:fixed;right:16px;bottom:80px;width:430px;max-height:80vh;overflow:auto;background:#fff;border:1px solid #e2e6f0;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:14px 16px;color:#24292f;font-size:13px;line-height:1.6;display:none;z-index:2147483646;}
        .rht-panel.open{display:block;}
        .rht-panel h3{margin:0 0 4px;font-size:15px;}
        .rht-sub{color:#8a94a6;font-size:12px;margin:0 0 10px;}
        .rht-row{margin:8px 0;}
        .rht-row label{display:block;font-size:12px;color:#57606a;margin-bottom:4px;}
        .rht-opt{display:flex;align-items:center;gap:6px;font-size:12px;color:#57606a;margin:2px 0;cursor:pointer;}
        .rht-opt input{accent-color:#4f6ef7;}
        .rht-btn{width:100%;padding:9px 10px;border:none;border-radius:8px;font-size:13px;cursor:pointer;color:#fff;margin-top:6px;}
        .rht-btn.primary{background:#4f6ef7;}
        .rht-btn.danger{background:#cf222e;}
        .rht-btn:disabled{background:#b8c0d8;cursor:not-allowed;}
        .rht-status{margin-top:8px;padding:8px 10px;border-radius:8px;background:#f6f8fa;font-size:12px;white-space:pre-wrap;max-height:220px;overflow:auto;}
        .rht-status.error{background:#ffebe9;color:#cf222e;}
        .rht-status.ok{background:#dafbe1;color:#116329;}
        .rht-promo{margin-top:10px;padding:8px 10px;border-radius:8px;background:linear-gradient(135deg,#f3f0ff,#eef2ff);border:1px solid #e4dcff;}
        .rht-promo .t{display:block;font-size:12px;font-weight:700;color:#5b3dc4;margin-bottom:2px;}
        .rht-promo .d{display:block;font-size:11px;line-height:1.55;color:#6b6f76;}
        .rht-promo a{display:inline-block;margin-top:4px;font-size:11px;color:#4f6ef7;text-decoration:none;}
        .rht-promo a:hover{text-decoration:underline;}
        .rht-item{margin:3px 0;padding:4px 6px;background:#f6f8fa;border-radius:6px;font-size:12px;}
        .rht-item .t{color:#9a6700;}
        .rht-item .c{color:#1a7f37;}
        .rht-login{color:#cf222e;font-weight:600;}
        /* 大弹窗 —— 贴合 wallet-migrate 深色主题 */
        .rht-modal{display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);align-items:center;justify-content:center;}
        .rht-modal.open{display:flex;}
        .rht-modal-box{width:946px;max-width:94vw;height:80vh;background:#0e1116;color:#e6edf3;border:1px solid #30363d;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;}
        .rht-modal-box *{color:#e6edf3;}
        .rht-modal-head{padding:14px 18px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;background:#161b22;}
        .rht-modal-head h3{margin:0;font-size:15px;color:#f0f6fc;}
        .rht-modal-head .rht-limit{display:flex;align-items:center;gap:6px;font-size:12px;color:#8b949e;white-space:nowrap;}
        .rht-modal-head .rht-limit input{width:60px;padding:3px 6px;border:1px solid #30363d;border-radius:6px;background:#0d1117;color:#e6edf3;font-size:12px;text-align:center;}
        .rht-modal-head .rht-limit input:focus{outline:none;border-color:#58a6ff;}
        .rht-modal-head .x{cursor:pointer;border:none;background:none;font-size:18px;color:#8b949e;}
        .rht-modal-head .x:hover{color:#f0f6fc;}
        .rht-tabs{display:flex;border-bottom:1px solid #30363d;background:#161b22;}
        .rht-tab{padding:10px 22px;cursor:pointer;font-size:13px;color:#8b949e;border-bottom:2px solid transparent;background:transparent;}
        .rht-tab:hover{color:#f0f6fc;}
        .rht-tab.active{color:#58a6ff;border-bottom-color:#58a6ff;font-weight:600;background:#0e1116;}
        .rht-filter{display:flex;align-items:center;gap:6px;padding:8px 18px;border-bottom:1px solid #30363d;background:#0e1116;flex-wrap:wrap;}
        .rht-flabel{font-size:12px;color:#8b949e;margin-right:2px;}
        .rht-fsep{width:1px;height:16px;background:#30363d;margin:0 6px;}
        .rht-fbtn{display:flex;align-items:center;gap:4px;font-size:12px;color:#8b949e;cursor:pointer;padding:3px 10px;border-radius:6px;border:1px solid #30363d;}
        .rht-fbtn:hover{background:#161b22;}
        .rht-fbtn input{margin:0;accent-color:#58a6ff;}
        .fcount{display:inline-block;min-width:16px;margin-left:3px;padding:0 5px;border-radius:8px;background:#21262d;color:#8b949e;font-size:10px;line-height:16px;text-align:center;}
        .rht-fact{border:none;background:#21262d;color:#58a6ff;padding:3px 12px;border-radius:6px;cursor:pointer;font-size:12px;border:1px solid #30363d;}
        .rht-fact:hover{background:#30363d;}
        .rht-modal-body{flex:1;overflow:auto;padding:14px 18px;font-size:13px;background:#0e1116;color:#e6edf3;}
        .rht-modal-body .sum{margin:0 0 8px;color:#8b949e;font-size:12px;}
        .rht-checkrow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;color:#e6edf3;border-bottom:1px solid #1c2128;}
        .rht-checkrow:hover{background:#161b22;}
        .rht-checkrow input{margin:0;accent-color:#58a6ff;}
        .rht-checkrow .nm{flex:1;color:#e6edf3;}
        .rht-checkrow .tag{font-size:11px;padding:1px 8px;border-radius:10px;}
        .rht-checkrow .tag.o{background:rgba(248,81,73,.15);color:#ff7b72;}
        .rht-checkrow .tag.c{background:rgba(63,185,80,.15);color:#3fb950;}
        .rht-checkrow .tag.g{background:rgba(139,148,158,.2);color:#8b949e;}
        .rht-checkrow .id{color:#8b949e;font-family:monospace;font-size:11px;}
        .rht-modal-foot{padding:12px 18px;border-top:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;gap:10px;background:#161b22;}
        .rht-modal-foot .sel{font-size:12px;color:#8b949e;}
        .rht-modal-foot .page{font-size:12px;color:#8b949e;display:flex;align-items:center;gap:6px;}
        .rht-modal-foot .page button{background:#21262d;color:#58a6ff;padding:4px 12px;margin:0;border-radius:6px;border:1px solid #30363d;}
        .rht-modal-foot .page button:disabled{color:#484f58;cursor:not-allowed;}
        .rht-modal-foot button{padding:8px 18px;border:none;border-radius:8px;color:#fff;font-size:13px;cursor:pointer;}
        .rht-modal-foot .exec{background:#da3633;color:#fff;}
        .rht-modal-foot .exec:disabled{background:#3a3f45;color:#8b949e;cursor:not-allowed;}
        .rht-modal-foot .cancel{background:#21262d;color:#e6edf3;border:1px solid #30363d;}
        /* 比较状态条（大弹窗顶部） */
        .rht-compare{display:none;padding:6px 18px;background:#0e1116;color:#8b949e;font-size:11px;border-bottom:1px solid #30363d;align-items:center;gap:6px;}
        .rht-compare.show{display:flex;}
        .rht-compare .spin{width:10px;height:10px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:rht-spin .8s linear infinite;}
        @keyframes rht-spin{to{transform:rotate(360deg);}}
        .rht-compare.done{color:#3fb950;}
        .rht-compare.done .spin{display:none;}
        /* 更新差异弹窗 */
        .diff-sec{font-size:12px;color:#8b949e;margin:14px 0 6px;font-weight:600;border-bottom:1px solid #21262d;padding-bottom:4px;}
        .diff-row{margin:3px 0;padding:6px 10px;border-radius:6px;background:#161b22;font-size:12px;}
        .diff-row .dn{color:#e6edf3;font-weight:600;}
        .diff-row .did{color:#8b949e;font-family:monospace;font-size:10px;margin-left:6px;}
        .diff-row .dt{color:#8b949e;font-size:11px;margin-left:8px;}
        .diff-row .df{color:#ff7b72;font-size:11px;}
        .diff-row .dg{color:#3fb950;font-size:11px;}
        .diff-row .dd{color:#d29922;font-size:11px;}
        .diff-row pre{margin:4px 0 0;padding:6px 8px;background:#0e1116;border:1px solid #21262d;border-radius:6px;color:#9da7b3;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;}
        .diff-empty{color:#8b949e;font-size:12px;padding:20px 0;text-align:center;}
      </style>
      <div class="rht-panel" id="panel">
        <h3>🔄 双站同名覆盖迁移</h3>
        <p class="rht-sub" id="panelDesc">从源站读资产 → 匹配目标站：匹配到的用源站数据<b>覆盖</b>（保留目标 id），未匹配的<b>新建</b>。可双向。</p>
        <div class="rht-row" id="loginRow">检查登录中…</div>
        <div class="rht-row">
          <label>迁移方向</label>
          <label class="rht-opt"><input type="radio" name="dir" value="cn->ai" checked> CN → AI</label>
          <label class="rht-opt" style="display:none;"><input type="radio" name="dir" value="ai->cn"> AI → CN</label>
        </div>
        <button class="rht-btn primary" id="previewBtn">① 打开迁移界面</button>
        <button class="rht-btn danger" id="execBtn" style="display:none;">② 执行迁移</button>
        <div class="rht-status" id="status" style="display:none;"></div>
        <div class="rht-promo">
          <span class="t">途视——AI 批量视频生成利器</span>
          <span class="d">小说、剧本、参考视频一键转分镜，批量跑 ComfyUI / RunningHub 工作流，生图、生视频、配音到剪映成片全自动。</span>
          <a href="https://space.bilibili.com/199774118" target="_blank" rel="noopener">B 站教程 @zzbbto ↗</a>
        </div>
      </div>
      <button class="rht-fab" id="fab" title="双站同名覆盖迁移">🔄</button>
      <!-- 迁移界面大弹窗 -->
      <div class="rht-modal" id="resultModal">
        <div class="rht-modal-box">
          <div class="rht-modal-head">
            <div style="display:flex;align-items:center;gap:10px">
              <h3 id="modalTitle">迁移界面</h3>
              <span class="rht-limit">
                <label for="limitInput">获取前</label>
                <input type="number" id="limitInput" min="1" step="1" value="100" title="只获取来源站前 N 个工作流/AI 应用（默认 100，目标站不限制）" />
                <label for="limitInput">个</label>
              </span>
            </div>
            <span style="display:flex;align-items:center;gap:8px">
              <button class="rht-fbtn rht-fact" id="refreshBtn">⟳ 刷新</button>
              <button class="x" id="modalClose">✕</button>
            </span>
          </div>
          <div class="rht-tabs" id="modalTabs"></div>
          <div class="rht-filter" id="modalFilter">
            <span class="rht-flabel">匹配方式</span>
            <label class="rht-fbtn"><input type="radio" name="mmode" value="record" checked> 按记录id</label>
            <label class="rht-fbtn"><input type="radio" name="mmode" value="name"> 按名字</label>
            <span class="rht-fsep"></span>
            <span class="rht-flabel">筛选</span>
            <label class="rht-fbtn"><input type="radio" name="filt" value="all"> 全部<span class="fcount" id="cntAll"></span></label>
            <label class="rht-fbtn"><input type="radio" name="filt" value="overwrite"> 相同<span class="fcount" id="cntOverwrite"></span></label>
            <label class="rht-fbtn"><input type="radio" name="filt" value="upd"> 更新<span class="fcount" id="cntUpd"></span></label>
            <label class="rht-fbtn"><input type="radio" name="filt" value="create"> 新增<span class="fcount" id="cntCreate"></span></label>
            <label class="rht-fbtn"><input type="radio" name="filt" value="todo" checked> 更新与新增<span class="fcount" id="cntTodo"></span></label>
            <span class="rht-fsep"></span>
            <button class="rht-fbtn rht-fact" id="selAll">全选</button>
            <button class="rht-fbtn rht-fact" id="selNone">全不选</button>
          </div>
          <div class="rht-compare" id="compareStatus">正在对比中…</div>
          <div style="padding:6px 18px;background:#0e1116;color:#8b949e;font-size:11px;border-bottom:1px solid #30363d;">
            提示：<b style="color:#d29922">更新</b> = 源站与目标站内容不一致，覆盖会用源站内容更新目标；<b style="color:#8b949e">相同</b> = 内容一致无需处理。可悬停查看。
          </div>
          <div class="rht-modal-body" id="modalBody"></div>
          <div class="rht-modal-foot">
            <span class="sel" id="modalSel">已选 0 项</span>
            <span class="page" id="modalPage"></span>
            <span>
              <button class="cancel" id="modalCancel">取消</button>
              <button class="exec" id="modalExec" disabled>执行所选</button>
            </span>
          </div>
        </div>
      </div>
      <!-- 更新差异弹窗 -->
      <div class="rht-modal" id="diffModal">
        <div class="rht-modal-box" style="height:80vh;">
          <div class="rht-modal-head">
            <h3 id="diffTitle">更新差异</h3>
            <button class="x" id="diffClose">✕</button>
          </div>
          <div style="padding:8px 18px;border-bottom:1px solid #30363d;background:#0e1116;color:#8b949e;font-size:11px;">
            <b style="color:#3fb950">新增</b> = 源站有、目标站没有（迁移时加到目标）；<b style="color:#ff7b72">删除</b> = 源站没有、目标站有（迁移时从目标移除）；<b style="color:#d29922">更新</b> = 两端都有但内容不同。覆盖会用源站内容更新目标。
          </div>
          <div class="rht-modal-body" id="diffBody"></div>
          <div class="rht-modal-foot">
            <span class="sel" id="diffSummary"></span>
            <button class="cancel" id="diffClose2">关闭</button>
          </div>
        </div>
      </div>
      <!-- 执行结果弹窗 -->
      <div class="rht-modal" id="resultDoneModal">
        <div class="rht-modal-box" style="height:70vh;">
          <div class="rht-modal-head">
            <h3 id="doneTitle">执行结果</h3>
            <button class="x" id="doneClose">✕</button>
          </div>
          <div id="doneProgress" style="padding:8px 18px;border-bottom:1px solid #30363d;background:#0e1116;color:#58a6ff;font-size:13px;display:none;"></div>
          <div class="rht-modal-body" id="doneBody"></div>
          <div class="rht-modal-foot">
            <span></span>
            <button class="exec" id="doneOk" style="background:#238636;">完成</button>
          </div>
        </div>
      </div>
    `;

    const panel = root.getElementById('panel');
    const fab = root.getElementById('fab');
    const loginRow = root.getElementById('loginRow');
    const panelDesc = root.getElementById('panelDesc');
    const previewBtn = root.getElementById('previewBtn');
    const execBtn = root.getElementById('execBtn');
    const preview = root.getElementById('preview');
    const status = root.getElementById('status');
    // 大弹窗
    const resultModal = root.getElementById('resultModal');
    const modalTitle = root.getElementById('modalTitle');
    const limitInput = root.getElementById('limitInput');
    const modalClose = root.getElementById('modalClose');
    const modalTabs = root.getElementById('modalTabs');
    const modalFilter = root.getElementById('modalFilter');
    const modalBody = root.getElementById('modalBody');
    const modalSel = root.getElementById('modalSel');
    const modalPage = root.getElementById('modalPage');
    const modalCancel = root.getElementById('modalCancel');
    const modalExec = root.getElementById('modalExec');
    const selAllBtn = root.getElementById('selAll');
    const selNoneBtn = root.getElementById('selNone');
    const refreshBtn = root.getElementById('refreshBtn');
    const compareStatus = root.getElementById('compareStatus');
    // 对比状态条：对比中显示「正在对比中…」，全部完成显示「全部对比完成」
    // 计数当前页签待完成的对比数（Promise.all 聚合，避免逐条闪烁）
    const cmpWatch = { running: 0 };
    const showComparing = (text) => {
      if (!compareStatus) return;
      compareStatus.className = 'rht-compare show';
      compareStatus.innerHTML = '<span class="spin"></span>' + (text || '正在对比中…');
    };
    const showCompareDone = () => {
      if (!compareStatus) return;
      compareStatus.className = 'rht-compare show done';
      compareStatus.textContent = '✅ 全部对比完成';
    };
    const hideCompare = () => { if (compareStatus) { compareStatus.className = 'rht-compare'; compareStatus.textContent = ''; } };
    // 筛选数量
    const cntAll = root.getElementById('cntAll');
    const cntOverwrite = root.getElementById('cntOverwrite');
    const cntUpd = root.getElementById('cntUpd');
    const cntCreate = root.getElementById('cntCreate');
    const cntTodo = root.getElementById('cntTodo');
    // 执行结果弹窗
    const doneModal = root.getElementById('resultDoneModal');
    const doneTitle = root.getElementById('doneTitle');
    const doneProgress = root.getElementById('doneProgress');
    const doneBody = root.getElementById('doneBody');
    const doneClose = root.getElementById('doneClose');
    const doneOk = root.getElementById('doneOk');
    // 更新差异弹窗
    const diffModal = root.getElementById('diffModal');
    const diffTitle = root.getElementById('diffTitle');
    const diffBody = root.getElementById('diffBody');
    const diffSummary = root.getElementById('diffSummary');
    const diffCloseBtn = root.getElementById('diffClose');
    const diffClose2 = root.getElementById('diffClose2');
    const openDiffModal = (title, bodyHtml, summary) => {
      diffTitle.textContent = title;
      diffBody.innerHTML = bodyHtml;
      if (summary) diffSummary.textContent = summary;
      diffModal.classList.add('open');
    };
    const closeDiff = () => diffModal.classList.remove('open');
    diffCloseBtn.addEventListener('click', closeDiff);
    diffClose2.addEventListener('click', closeDiff);
    const showDone = (title, bodyHtml, scrollBottom) => {
      doneTitle.textContent = title;
      doneBody.innerHTML = bodyHtml;
      doneModal.classList.add('open');
      // 迁移执行时：仅当用户在底部附近才自动滚到底（上滑查看历史时不强制拉回）
      if (scrollBottom && isNearBottom()) {
        doneBody.scrollTop = doneBody.scrollHeight;
      }
    };
    // 用户是否在滚动区底部附近（100px 内）
    const isNearBottom = () => {
      if (!doneBody) return true;
      const dist = doneBody.scrollHeight - doneBody.scrollTop - doneBody.clientHeight;
      return dist < 100;
    };
    const closeDone = () => doneModal.classList.remove('open');
    doneClose.addEventListener('click', closeDone);
    doneOk.addEventListener('click', closeDone);

    // 匹配方式变化时更新面板描述
    const updateDesc = () => {
      const mode = (root.querySelector('input[name="match"]:checked') || {}).value || 'record';
      if (panelDesc) {
        panelDesc.innerHTML = mode === 'record'
          ? '按<b>迁移记录 id</b>（sourceAssetId→targetAssetId）匹配：已迁移过的用源站数据<b>覆盖</b>目标（保留目标 id），未迁移的<b>新建</b>。'
          : '按<b>名字</b>匹配：目标站有同名则用源站数据<b>覆盖</b>（保留目标 id），不同名<b>新建</b>。';
      }
    };
    root.querySelectorAll('input[name="match"]').forEach((r) => r.addEventListener('change', updateDesc));
    updateDesc();

    let plan = null; // { overwrite:[], create:[] }
    let planKind = null;
    let planMode = 'record';

    const setStatus = (text, kind) => {
      status.style.display = 'block';
      status.textContent = text;
      status.className = 'rht-status' + (kind ? ' ' + kind : '');
    };
    const hideStatus = () => (status.style.display = 'none');

    fab.addEventListener('click', async () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) await checkLogin();
    });

    // 检查两站登录状态
    async function checkLogin() {
      // 当前页 token（同源 localStorage）
      const pageToken = localStorage.getItem('Rh-Accesstoken') || '';
      // 另一站 token（chrome.storage）
      const otherSite = THIS_SITE === 'cn' ? 'ai' : 'cn';
      const otherToken = await getStoredToken(otherSite);
      const cnTok = THIS_SITE === 'cn' ? pageToken : otherToken;
      const aiTok = THIS_SITE === 'ai' ? pageToken : otherToken;
      const cn = cnTok ? '✅ 已登录' : '❌ 未登录';
      const ai = aiTok ? '✅ 已登录' : '❌ 未登录';
      loginRow.innerHTML =
        '<label>登录状态（两站的正式网站需都登录）</label><div class="rht-sub">CN 站：' + cn + '　AI 站：' + ai +
        '<br><span style="font-size:11px;color:#8a94a6">当前页 token=' + (pageToken ? '有(' + pageToken.slice(0, 15) + '…)' : '空') + '　' + otherSite.toUpperCase() + '站已存 token=' + (otherToken ? '有(' + otherToken.slice(0, 15) + '…)' : '空') +
        (aiTok ? '' : '<br>提示：若另一站未登录，请在该站打开一次页面（插件会自动记录 token）') + '</span></div>';
    }

    // ① 打开迁移界面（在弹窗内拉数据、分页、筛选、勾选）
    previewBtn.addEventListener('click', async () => {
      const dir = (root.querySelector('input[name="dir"]:checked') || {}).value || 'cn->ai';
      const srcSite = dir.startsWith('cn') ? 'cn' : 'ai';
      const dstSite = dir.startsWith('cn') ? 'ai' : 'cn';

      // 校验两站登录
      const srcToken = await getTokenFor(srcSite);
      const dstToken = await getTokenFor(dstSite);
      const notLogged = [];
      if (!srcToken) notLogged.push('源站(' + srcSite.toUpperCase() + ')');
      if (!dstToken) notLogged.push('目标站(' + dstSite.toUpperCase() + ')');
      if (notLogged.length) {
        setStatus('⚠️ ' + notLogged.join('、') + ' 未检测到登录。\n请在未登录的站点打开一次页面（插件自动记录 token）后重试。', 'error');
        return;
      }

      previewBtn.disabled = true;
      previewBtn.textContent = '打开中…';
      hideStatus();
      try {
        planKind = dir;
        // 匹配方式在大界面内选（openModal 读取 modalFilter 的 mmode）
        openModal(['workflow', 'webapp'], srcSite, dstSite, dir);
      } catch (e) {
        setStatus('打开失败：' + String(e.message || e), 'error');
      } finally {
        previewBtn.disabled = false;
        previewBtn.textContent = '① 打开迁移界面';
      }
    });

    async function buildPlanForKind(mode, srcSite, dstSite, kind) {
      return buildPlanByMode(mode, srcSite, dstSite, kind);
    }

    // 勾选项：{ key: {item, kind} }，key 用 srcId-kind 唯一标识
    let selected = new Map();
    // 覆盖项是否「需要更新」：对比未完成（contentSame 未定）时视为需要更新，先显示，完成后自动纠正
    // 定义在 buildPanel 级：openModal 内部（渲染/筛选）与外部（modalExec 执行）共用
    const isUpdate = (x) => x.contentSame !== true;
    // 当前页签与筛选（openModal 内更新，modalExec 读取）
    let curActiveKind = 'workflow';
    let curFilt = 'all';
    let curMode = 'record';
    let curDir = 'cn->ai';
    let tabData = {}; // 每类型数据（openModal 填充，按 dir:mode:kind 缓存）
    // 渲染检测结果到弹窗（页签：工作流 / AI应用）
    // 打开迁移界面：弹窗内拉数据、分页、筛选、勾选；匹配方式在弹窗内选
    async function openModal(kinds, srcSite, dstSite, dir) {
      curDir = dir;
      // 缓存键：方向 + 匹配方式 + 类型 + 数量限制（数量变化即失效重新拉取）
      const ck = (k) => dir + ':' + modeKey() + ':' + k + ':' + fetchLimit;
      const modeKey = () => (modalFilter.querySelector('input[name="mmode"]:checked') || {}).value || 'record';
      // 从弹窗内读取匹配方式
      const readMode = modeKey;
      let mode = readMode();
      const modeLabel = mode === 'record' ? '按记录id' : '按名字';
      modalTitle.textContent = dir + '　' + modeLabel;

      // 页签（仅选中的类型）
      modalTabs.innerHTML = '';
      const tabsEls = {};
      kinds.forEach((k) => {
        const tab = document.createElement('div');
        tab.className = 'rht-tab';
        tab.textContent = k === 'workflow' ? '工作流' : 'AI 应用';
        tab.addEventListener('click', () => showTab(k));
        modalTabs.appendChild(tab);
        tabsEls[k] = tab;
      });

      // 每页签数据在 buildPanel 级 tabData 中
      let activeKind = kinds[0] || 'workflow';
      let filt = 'todo';
      let pageNum = 1;
      const PAGE_SIZE = 50;

      // 默认全选该页签所有项（若尚未勾选）
      function ensureDefaults(k) {
        const v = tabData[ck(k)];
        if (!v) return;
        v.overwrite.forEach((x) => { const key = x.src.id + '-' + k; if (!selected.has(key)) { selected.set(key, { item: x, kind: k, isOverwrite: true }); } });
        v.create.forEach((x) => { const key = x.src.id + '-' + k; if (!selected.has(key)) { selected.set(key, { item: x, kind: k, isOverwrite: false }); } });
      }

      // 加载某类型数据（按方向+模式缓存）
      async function loadKind(k) {
        const cacheKey = ck(k);
        const v = await buildPlanByMode(mode, srcSite, dstSite, k);
        tabData[cacheKey] = v;
        // 默认全选
        ensureDefaults(k);
        // 批量对比：顶部状态条显示「正在对比中…」，全部完成后「全部对比完成」
        compareAll(k, v.overwrite).then(() => { if (activeKind === k) renderBody(); });
      }

      // 批量对比源/目标「内容」，限流并发（一次若干条），逐条更新进度，全部完成后置「全部对比完成」
      // 不用 Promise.all 全量并发：几十上百条会瞬间完成，进度数字一帧跳完看不到；限流让数字平滑递减
      async function compareAll(k, overwrite) {
        const list = (overwrite || []).filter((x) => x.contentSame === undefined);
        if (!list.length) { hideCompare(); return; }
        const total = list.length;
        const CONCURRENCY = 5;
        let done = 0;
        showComparing('正在对比中…（' + total + '/' + total + '）');
        let idx = 0;
        async function worker() {
          while (idx < list.length) {
            const x = list[idx++];
            try {
              const r = await diffContent(srcSite, dstSite, x, k);
              x.contentSame = r ? (r.del.length + r.add.length + r.upd.length === 0) : null;
            } catch (e) {
              x.contentSame = null;
            }
            done++;
            if (activeKind === k) renderBody(); // 每条对比完成即刷新列表（覆盖项从「查看更新」变「相同」）
            if (done < total) showComparing('正在对比中…（' + (total - done) + '/' + total + '）');
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
        showCompareDone();
      }

      // 统一对比接口：返回 { del, add, upd }（无差异时三个都为空），读取失败返回 null。
      // 列表「更新」检测（compareAll）与差异弹窗（showWorkflowDiff/showWebappDiff）共用，
      // 保证两处语义永远一致，避免重复实现导致漏改。
      // 方向语义：add = 源独有（迁移时加到目标），del = 目标独有（迁移时从目标移除），upd = 两端都有但内容不同
      async function diffContent(srcSite, dstSite, x, kind) {
        if (kind === 'workflow') {
          const srcId = (x.src && x.src.id) || '';
          const dstId = (x.dst && x.dst.id) || '';
          if (!srcId || !dstId) return null;
          const [srcRes, dstRes] = await Promise.all([
            getPublishedContent(srcSite, srcId),
            getPublishedContent(dstSite, dstId),
          ]);
          const sc = srcRes && srcRes.workflowContent;
          const dc = dstRes && dstRes.workflowContent;
          if (!sc || !dc) return null;
          let sNodes = [], dNodes = [];
          try { sNodes = (JSON.parse(sc) || {}).nodes || []; } catch (e) {}
          try { dNodes = (JSON.parse(dc) || {}).nodes || []; } catch (e) {}
          const typeOf = (n) => n.type || n.class_type || '';
          const nameOf = (n) => n.title || typeOf(n) || '节点';
          // 节点内容字段：只比较类型 + 标题 + 参数值（widgets_values）。
          // 排除 id/order/pos/size/flags/mode/inputs/outputs/properties/color/bgcolor 等布局与外观字段：
          // 两端相同参数只因 order/颜色 不同会误报「更新」
          const SEMANTIC_KEYS = ['type', 'class_type', 'title', 'widgets_values'];
          const semantic = (n) => {
            const o = {};
            SEMANTIC_KEYS.forEach((k) => { if (n[k] !== undefined) o[k] = n[k]; });
            return JSON.stringify(o);
          };
          const byId = (arr) => { const m = new Map(); arr.forEach((n) => m.set(String(n.id), n)); return m; };
          const sMap = byId(sNodes), dMap = byId(dNodes);
          const del = [], add = [], upd = [];
          sMap.forEach((n, id) => {
            if (!dMap.has(id)) add.push({ id, name: nameOf(n), type: typeOf(n) });
            else if (semantic(n) !== semantic(dMap.get(id))) upd.push({ id, name: nameOf(n), type: typeOf(n), s: n, d: dMap.get(id) });
          });
          dMap.forEach((n, id) => { if (!sMap.has(id)) del.push({ id, name: nameOf(n), type: typeOf(n) }); });
          return { del, add, upd };
        }
        // AI 应用：按 nodeId/fieldName 分组，比较显示名 + 值
        const srcId = (x.src && x.src.id) || '';
        const dstId = (x.dst && x.dst.id) || '';
        if (!srcId || !dstId) return null;
        const [srcRes, dstRes] = await Promise.all([
          api(srcSite, '/api/webapp/detail', { webappId: srcId }),
          api(dstSite, '/api/webapp/detail', { webappId: dstId }),
        ]);
        const s = srcRes.json && (srcRes.json.data || srcRes.json);
        const d = dstRes.json && (dstRes.json.data || dstRes.json);
        if (!s || !d) return null;
        const sArr = (s.nodeInfos || s.inputNodes) || [];
        const dArr = (d.nodeInfos || d.inputNodes) || [];
        // 节点参数：key = nodeId + '/' + fieldName，显示名优先 description
        const keyOf = (n) => String(n.nodeId) + '/' + (n.fieldName || n.key || '');
        const descOf = (n) => n.description || n.descriptionCn || n.nodeName || ('节点 #' + n.nodeId);
        const sMap = new Map(sArr.map((n) => [keyOf(n), n]));
        const dMap = new Map(dArr.map((n) => [keyOf(n), n]));
        const del = [], add = [], upd = [];
        sMap.forEach((n, k) => {
          if (!dMap.has(k)) add.push({ key: k, id: n.nodeId, name: descOf(n), type: n.fieldType, val: n.fieldValue });
          else {
            const dn = dMap.get(k);
            const nameChanged = descOf(n) !== descOf(dn);
            const valChanged = String(dn.fieldValue) !== String(n.fieldValue);
            if (nameChanged || valChanged) {
              upd.push({ key: k, id: n.nodeId, name: descOf(n), type: n.fieldType, s: n.fieldValue, d: dn.fieldValue, nameS: descOf(n), nameD: descOf(dn) });
            }
          }
        });
        dMap.forEach((n, k) => { if (!sMap.has(k)) del.push({ key: k, id: n.nodeId, name: descOf(n), type: n.fieldType, val: n.fieldValue }); });
        return { del, add, upd };
      }

      // 取某站工作流「已发布版本」内容：getContent 不带 versionId 返回的是最新草稿，
      // 会把未发布的修改误判为「更新」；必须带已发布 versionId
      async function getPublishedContent(site, workflowId) {
        const verId = await getPublishedVersionId(site, workflowId);
        if (!verId) return null;
        const res = await api(site, '/api/workflow/getContent', { workflowId, versionId: verId });
        return (res.json && res.json.data) || null;
      }

      // 展示源/目标工作流内容差异（节点级）：删除 / 新增 / 更新
      // 点击列表里的「更新」标签触发；workflowContent 是 ComfyUI 图 JSON
      async function showWorkflowDiff(srcSite, dstSite, x) {
        const srcLabel = srcSite === 'cn' ? '.cn' : '.ai';
        const dstLabel = dstSite === 'cn' ? '.cn' : '.ai';
        const title = '更新差异　' + srcLabel + ' → ' + dstLabel;
        // 先开弹窗显示加载中，再异步拉取内容，避免点击后卡住
        openDiffModal(title, '<div class="diff-empty">加载中…</div>', '');
        const r = await diffContent(srcSite, dstSite, x, 'workflow');
        if (!r) {
          diffBody.innerHTML = '<div class="diff-empty">无法读取源/目标工作流内容（可能未发布）。</div>';
          return;
        }
        const del = r.del, add = r.add, upd = r.upd;

        let html = '';
        // 节点行：名称 + id + 类型 + 差异标记
        const mkRow = (o, icon, cls) => '<div class="diff-row"><span class="dn">' + esc(o.name) + '</span><span class="did">#' + esc(String(o.id)) + '</span>' + (o.type ? '<span class="dt">' + esc(o.type) + '</span>' : '') + '<span class="d' + cls + '">' + icon + '</span></div>';
        if (del.length) {
          html += '<div class="diff-sec">删除（' + del.length + '）</div>';
          html += del.map((o) => mkRow(o, '✕ 删除', 'f')).join('');
        }
        if (add.length) {
          html += '<div class="diff-sec">新增（' + add.length + '）</div>';
          html += add.map((o) => mkRow(o, '＋ 新增', 'g')).join('');
        }
        if (upd.length) {
          html += '<div class="diff-sec">更新（' + upd.length + '）</div>';
          upd.forEach((o) => {
            html += '<div class="diff-row"><span class="dn">' + esc(o.name) + '</span><span class="did">#' + esc(String(o.id)) + '</span>' + (o.type ? '<span class="dt">' + esc(o.type) + '</span>' : '') + '<span class="dd">↻ 更新</span>';
            if (o.s && o.d && (o.s.title || '') !== (o.d.title || '')) {
              html += '<div class="diff-row" style="margin:-2px 0 6px 12px;padding-top:0;"><span class="df">标题：' + esc(o.d.title || '(无)') + ' → ' + esc(o.s.title || '(无)') + '</span></div>';
            }
            const sDetail = esc(JSON.stringify(o.s && o.s.widgets_values !== undefined ? o.s.widgets_values : (o.s || {}), null, 1));
            const dDetail = esc(JSON.stringify(o.d && o.d.widgets_values !== undefined ? o.d.widgets_values : (o.d || {}), null, 1));
            html += '<pre><span style="color:#ff7b72">- ' + esc(dstLabel) + ' 目标(旧)</span> ' + dDetail + '\n<span style="color:#3fb950">+ ' + esc(srcLabel) + ' 源(新)</span> ' + sDetail + '</pre></div>';
          });
        }
        if (!del.length && !add.length && !upd.length) html = '<div class="diff-empty">两端内容一致，无差异。</div>';
        diffBody.innerHTML = html;
        diffTitle.textContent = title + '　总览　新增 ' + add.length + ' · 删除 ' + del.length + ' · 更新 ' + upd.length;
        diffSummary.textContent = '总览　新增 ' + add.length + ' · 删除 ' + del.length + ' · 更新 ' + upd.length;
      }

      // 展示源/目标 AI 应用差异（节点参数级）：删除 / 新增 / 更新
      async function showWebappDiff(srcSite, dstSite, x) {
        const srcLabel = srcSite === 'cn' ? '.cn' : '.ai';
        const dstLabel = dstSite === 'cn' ? '.cn' : '.ai';
        const title = '更新差异　' + srcLabel + ' → ' + dstLabel;
        // 先开弹窗显示加载中，再异步拉取内容，避免点击后卡住
        openDiffModal(title, '<div class="diff-empty">加载中…</div>', '');
        const r = await diffContent(srcSite, dstSite, x, 'webapp');
        if (!r) {
          diffBody.innerHTML = '<div class="diff-empty">无法读取源/目标 AI 应用详情。</div>';
          return;
        }
        const del = r.del, add = r.add, upd = r.upd;

        let html = '';
        const mkRow = (o, icon, cls) => '<div class="diff-row"><span class="dn">' + esc(o.name) + '</span><span class="did">#' + esc(String(o.id)) + '</span>' + (o.type ? '<span class="dt">' + esc(o.type) + '</span>' : '') + '<span class="d' + cls + '">' + icon + '</span></div>';
        if (del.length) {
          html += '<div class="diff-sec">删除（' + del.length + '）</div>';
          html += del.map((o) => mkRow(o, '✕ 删除', 'f') + (o.val !== undefined && o.val !== null && o.val !== '' ? '<div class="diff-row" style="margin:-2px 0 6px 12px;padding-top:0;"><span class="df">原值：' + esc(String(o.val)) + '</span></div>' : '')).join('');
        }
        if (add.length) {
          html += '<div class="diff-sec">新增（' + add.length + '）</div>';
          html += add.map((o) => mkRow(o, '＋ 新增', 'g') + (o.val !== undefined && o.val !== null && o.val !== '' ? '<div class="diff-row" style="margin:-2px 0 6px 12px;padding-top:0;"><span class="dg">值：' + esc(String(o.val)) + '</span></div>' : '')).join('');
        }
        if (upd.length) {
          html += '<div class="diff-sec">更新（' + upd.length + '）</div>';
          upd.forEach((o) => {
            html += '<div class="diff-row"><span class="dn">' + esc(o.name) + '</span><span class="did">#' + esc(String(o.id)) + '</span>' + (o.type ? '<span class="dt">' + esc(o.type) + '</span>' : '') + '<span class="dd">↻ 更新</span>';
            if (o.nameS !== o.nameD) {
              html += '<div class="diff-row" style="margin:-2px 0 6px 12px;padding-top:0;"><span class="df">名字：' + esc(o.nameD) + ' → ' + esc(o.nameS) + '</span></div>';
            }
            html += '<pre><span style="color:#ff7b72">- ' + esc(dstLabel) + ' 目标(旧)</span> ' + esc(String(o.d)) + '\n<span style="color:#3fb950">+ ' + esc(srcLabel) + ' 源(新)</span> ' + esc(String(o.s)) + '</pre></div>';
          });
        }
        if (!del.length && !add.length && !upd.length) html = '<div class="diff-empty">两端节点参数一致，无差异。</div>';
        diffBody.innerHTML = html;
        diffTitle.textContent = title + '　总览　新增 ' + add.length + ' · 删除 ' + del.length + ' · 更新 ' + upd.length;
        diffSummary.textContent = '总览　新增 ' + add.length + ' · 删除 ' + del.length + ' · 更新 ' + upd.length;
      }

      // 渲染当前页签
      function renderBody() {
        modalBody.innerHTML = '';
        const cacheKey = ck(activeKind);
        const v = tabData[cacheKey];
        if (!v) {
          modalBody.innerHTML = '<div class="sum">加载中…</div>';
          return;
        }
        // 筛选：全部 / 相同 / 更新 / 新增 / 更新与新增（已迁移的 _migrated 过滤掉）
        let rows = [];
        if (filt === 'overwrite') rows = v.overwrite.filter((x) => !x._migrated).map((x) => ({ item: x, isOverwrite: true }));
        else if (filt === 'upd') rows = v.overwrite.filter((x) => !x._migrated && isUpdate(x)).map((x) => ({ item: x, isOverwrite: true }));
        else if (filt === 'create') rows = v.create.filter((x) => !x._migrated).map((x) => ({ item: x, isOverwrite: false }));
        else if (filt === 'todo') {
          // 内容不同 = 新增 + 更新（覆盖且内容不同）；对比未完成的覆盖项先当「更新」显示
          rows = [
            ...v.create.filter((x) => !x._migrated).map((x) => ({ item: x, isOverwrite: false })),
            ...v.overwrite.filter((x) => !x._migrated && isUpdate(x)).map((x) => ({ item: x, isOverwrite: true })),
          ];
        }
        else rows = [...v.overwrite.filter((x) => !x._migrated).map((x) => ({ item: x, isOverwrite: true })), ...v.create.filter((x) => !x._migrated).map((x) => ({ item: x, isOverwrite: false }))];

        // 更新筛选数量
        const nAll = v.overwrite.filter((x) => !x._migrated).length + v.create.filter((x) => !x._migrated).length;
        const nOv = v.overwrite.filter((x) => !x._migrated).length;
        const nCr = v.create.filter((x) => !x._migrated).length;
        const nUpd = v.overwrite.filter((x) => !x._migrated && isUpdate(x)).length;
        const nTodo = nCr + nUpd;
        if (cntAll) cntAll.textContent = String(nAll);
        if (cntOverwrite) cntOverwrite.textContent = String(nOv);
        if (cntUpd) cntUpd.textContent = String(nUpd);
        if (cntCreate) cntCreate.textContent = String(nCr);
        if (cntTodo) cntTodo.textContent = String(nTodo);

        // 空列表：显示提示
        if (!rows.length) {
          modalBody.innerHTML = '<div class="sum" style="padding:20px 0;text-align:center;color:#8b949e">没有可选的项</div>';
          modalPage.innerHTML = '';
          updateSel();
          return;
        }

        // 分页
        const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
        if (pageNum > totalPages) pageNum = totalPages;
        const slice = rows.slice((pageNum - 1) * PAGE_SIZE, pageNum * PAGE_SIZE);

        slice.forEach(({ item, isOverwrite }) => {
          const label = document.createElement('label');
          label.className = 'rht-checkrow';
          const key = item.src.id + '-' + activeKind;
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selected.has(key);
          cb.addEventListener('change', () => {
            if (cb.checked) selected.set(key, { item, kind: activeKind, isOverwrite });
            else selected.delete(key);
            updateSel();
          });
          const nm = document.createElement('span');
          nm.className = 'nm';
          nm.textContent = item.src.name;
          const tag = document.createElement('span');
          // 覆盖项：内容相同→「相同」，内容不同（需更新）→「查看更新」；对比未完成先按「查看更新」显示；新增→「新增」
          let tagText, tagTitle;
          if (isOverwrite) {
            if (isUpdate(item)) { tagText = '查看更新'; tagTitle = '点击查看差异（删除/新增/更新）'; }
            else { tagText = '相同'; tagTitle = '目标站已有同名且内容一致'; }
            tag.className = 'tag ' + (isUpdate(item) ? 'o' : 'g');
          } else {
            tagText = '新增'; tagTitle = '目标站没有，迁移新建';
            tag.className = 'tag c';
          }
          tag.textContent = tagText;
          tag.title = tagTitle;
          if (isOverwrite && isUpdate(item)) {
            tag.style.cursor = 'pointer';
            tag.style.textDecoration = 'underline';
            tag.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (activeKind === 'workflow') {
                showWorkflowDiff(srcSite, dstSite, item).catch((err) => openDiffModal('更新差异', '<div class="diff-empty">读取差异失败：' + esc(String((err && err.message) || err)) + '</div>', ''));
              } else {
                showWebappDiff(srcSite, dstSite, item).catch((err) => openDiffModal('更新差异', '<div class="diff-empty">读取差异失败：' + esc(String((err && err.message) || err)) + '</div>', ''));
              }            });
          }
          const id = document.createElement('span');
          id.className = 'id';
          id.textContent = '#' + (isOverwrite ? item.dst.id : item.src.id);
          label.appendChild(cb);
          label.appendChild(nm);
          label.appendChild(tag);
          label.appendChild(id);
          // 查看 .cn / .ai 链接按钮
          const srcId = item.src.id;
          const dstId = isOverwrite ? item.dst.id : null;
          const urlOf = (site, kind, id) => {
            const base = site === 'cn' ? 'https://www.runninghub.cn' : 'https://www.runninghub.ai';
            return kind === 'workflow' ? base + '/workflow/' + id : base + '/ai-detail/' + id;
          };
          const viewBtn = (labelText, site, kind, id) => {
            const a = document.createElement('a');
            a.textContent = labelText;
            a.href = urlOf(site, kind, id);
            a.target = '_blank';
            a.rel = 'noopener';
            a.style.cssText = 'font-size:11px;color:#58a6ff;text-decoration:none;margin-left:6px;white-space:nowrap;';
            a.addEventListener('click', (e) => e.stopPropagation());
            return a;
          };
          // src 在 srcSite 站，dst 在 dstSite 站
          const srcSiteLabel = srcSite === 'cn' ? '.cn' : '.ai';
          const dstSiteLabel = dstSite === 'cn' ? '.cn' : '.ai';
          label.appendChild(viewBtn('查看' + srcSiteLabel, srcSite, activeKind, srcId));
          if (dstId) label.appendChild(viewBtn('查看' + dstSiteLabel, dstSite, activeKind, dstId));
          modalBody.appendChild(label);
        });

        // 分页控件
        modalPage.innerHTML = '';
        const prevBtn = document.createElement('button');
        prevBtn.textContent = '‹';
        prevBtn.disabled = pageNum <= 1;
        prevBtn.addEventListener('click', () => { pageNum--; renderBody(); });
        const info = document.createElement('span');
        info.textContent = '第 ' + pageNum + '/' + totalPages + ' 页';
        const nextBtn = document.createElement('button');
        nextBtn.textContent = '›';
        nextBtn.disabled = pageNum >= totalPages;
        nextBtn.addEventListener('click', () => { pageNum++; renderBody(); });
        modalPage.appendChild(prevBtn);
        modalPage.appendChild(info);
        modalPage.appendChild(nextBtn);
        updateSel();
      }

      const updateSel = () => {
        // 统计「当前筛选 + 当前页签」下的勾选项数
        const k = activeKind;
        const v = tabData[ck(k)];
        curActiveKind = k;
        curFilt = filt;
        curMode = mode;
        let visible = 0;
        if (v) {
          // 与 renderBody 的过滤一致：全部 / 相同 / 更新 / 新增 / 更新与新增
          const isVisible = (x, isO) => {
            if (filt === 'overwrite' && !isO) return false;
            if (filt === 'upd') {
              if (!isO) return false;
              return isUpdate(x); // 更新（覆盖且内容不同；未完成对比先当更新）
            }
            if (filt === 'create' && isO) return false;
            if (filt === 'todo') {
              if (isO) return isUpdate(x); // 更新（覆盖且内容不同；未完成对比先当更新）
              return true; // 新增
            }
            return true;
          };
          v.overwrite.forEach((x) => { if (isVisible(x, true) && selected.has(x.src.id + '-' + k)) visible++; });
          v.create.forEach((x) => { if (isVisible(x, false) && selected.has(x.src.id + '-' + k)) visible++; });
        }
        modalSel.textContent = '已选 ' + visible + ' 项';
        modalExec.disabled = visible === 0;
      };

      const showTab = (k) => {
        activeKind = k;
        pageNum = 1;
        kinds.forEach((kk) => tabsEls[kk].className = 'rht-tab' + (kk === k ? ' active' : ''));
        // 该模式该类型没加载过则加载（已缓存则直接渲染，不重复请求）
        const cacheKey = ck(k);
        if (!tabData[cacheKey]) {
          modalBody.innerHTML = '<div class="sum">加载中…</div>';
          loadKind(k).then(() => renderBody()).catch((e) => { modalBody.innerHTML = '<div class="sum" style="color:#cf222e">加载失败：' + String(e.message || e) + '</div>'; });
        } else {
          // 缓存命中：重新默认全选 + 重新对比内容（覆盖/变更后显示最新状态）
          ensureDefaults(k);
          const v = tabData[ck(k)];
          if (v && v.overwrite) {
            // 重新对比，完成后状态条显示「全部对比完成」
            compareAll(k, v.overwrite).then(() => { if (activeKind === k) renderBody(); });
          }
          renderBody();
        }
      };

      // 筛选变化（类型）
      modalFilter.querySelectorAll('input[name="filt"]').forEach((r) => {
        r.addEventListener('change', () => {
          filt = (modalFilter.querySelector('input[name="filt"]:checked') || {}).value || 'all';
          pageNum = 1;
          renderBody();
        });
      });

      // 刷新：重新加载当前页签数据（清缓存 + 重拉）
      refreshBtn.addEventListener('click', async () => {
        // 清资产缓存（重新拉取 + 重新过滤发布状态）
        Object.keys(assetCache).forEach((k) => { delete assetCache[k]; });
        const cacheKey = ck(activeKind);
        delete tabData[cacheKey];
        selected = new Map();
        pageNum = 1;
        showTab(activeKind);
      });

      // 数量限制变化：更新 fetchLimit，清缓存并重新加载当前页签（来源站只取前 N 个）
      limitInput.addEventListener('change', () => {
        let v = parseInt(limitInput.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 100;
        limitInput.value = String(v);
        fetchLimit = v;
        Object.keys(assetCache).forEach((k) => { delete assetCache[k]; });
        selected = new Map();
        pageNum = 1;
        showTab(activeKind);
      });

      // 全选 / 全不选：作用于当前筛选 + 当前页签
      const matchesFilt = (isO, x) => {
        if (filt === 'overwrite' && !isO) return false;
        if (filt === 'upd') {
          if (!isO) return false;
          return isUpdate(x);
        }
        if (filt === 'create' && isO) return false;
        if (filt === 'todo') {
          if (isO) return isUpdate(x);
          return true;
        }
        return true;
      };
      selAllBtn.addEventListener('click', () => {
        const v = tabData[ck(activeKind)];
        if (!v) return;
        v.overwrite.forEach((x) => { if (matchesFilt(true, x)) selected.set(x.src.id + '-' + activeKind, { item: x, kind: activeKind, isOverwrite: true }); });
        v.create.forEach((x) => { if (matchesFilt(false, x)) selected.set(x.src.id + '-' + activeKind, { item: x, kind: activeKind, isOverwrite: false }); });
        renderBody();
        updateSel();
      });
      selNoneBtn.addEventListener('click', () => {
        const v = tabData[ck(activeKind)];
        if (!v) return;
        v.overwrite.forEach((x) => { if (matchesFilt(true, x)) selected.delete(x.src.id + '-' + activeKind); });
        v.create.forEach((x) => { if (matchesFilt(false, x)) selected.delete(x.src.id + '-' + activeKind); });
        renderBody();
        updateSel();
      });

      // 匹配方式变化：切换缓存键（已加载的模式不重新请求），勾选重置
      modalFilter.querySelectorAll('input[name="mmode"]').forEach((r) => {
        r.addEventListener('change', async () => {
          mode = readMode();
          modalTitle.textContent = dir + '　' + (mode === 'record' ? '按记录id' : '按名字');
          selected = new Map();
          pageNum = 1;
          showTab(activeKind);
        });
      });

      // 打开弹窗并加载第一个页签
      resultModal.classList.add('open');
      // 重置筛选：内容不同（默认）
      const allFilt = modalFilter.querySelector('input[name="filt"][value="todo"]');
      if (allFilt) allFilt.checked = true;
      filt = 'todo';
      showTab(activeKind);
    }

    // 弹窗关闭
    const closeModal = () => {
      resultModal.classList.remove('open');
    };
    modalClose.addEventListener('click', closeModal);
    modalCancel.addEventListener('click', closeModal);

    // 执行所选（当前页签 + 当前筛选 下勾选的项）
    modalExec.addEventListener('click', async () => {
      try {
        const k = curActiveKind;
        const f = curFilt;
        const m = curMode || 'record';
        const matches = (isO, x) => {
          if (f === 'overwrite' && !isO) return false;
          if (f === 'upd') {
            if (!isO) return false;
            return isUpdate(x);
          }
          if (f === 'create' && isO) return false;
          if (f === 'todo') {
            if (isO) return isUpdate(x);
            return true;
          }
          return true;
        };
        const items = [];
        const cacheKey = curDir + ':' + m + ':' + k + ':' + fetchLimit;
        const v = tabData && tabData[cacheKey];
        if (v) {
          v.overwrite.forEach((x) => { const key = x.src.id + '-' + k; if (matches(true, x) && selected.has(key)) items.push({ item: x, isOverwrite: true }); });
          v.create.forEach((x) => { const key = x.src.id + '-' + k; if (matches(false, x) && selected.has(key)) items.push({ item: x, isOverwrite: false }); });
        }
        if (!items.length) {
          // 无选中项时给明确提示，而非静默无反应
          showDone('执行所选', '<div class="sum" style="color:#d29922">没有选中可执行的项。\n请确认当前筛选下已勾选条目（已选数量为 0）。</div>');
          return;
        }
        if (!confirm('确认执行所选 ' + items.length + ' 项迁移？\n覆盖会真实修改目标站数据（保留目标 id），不可撤销。')) return;
        closeModal();
        await runMigration(items, planKind || 'cn->ai');
      } catch (e) {
        showDone('执行出错', '<div class="sum" style="color:#ff7b72">' + esc(String(e && e.message || e)) + '</div>');
      }
    });

    // 执行迁移（items: [{item, kind, isOverwrite}], dir: 'cn->ai'/'ai->cn'）
    async function runMigration(items, dir) {
      const srcSite = dir.startsWith('cn') ? 'cn' : 'ai';
      const dstSite = dir.startsWith('cn') ? 'ai' : 'cn';
      const tk = getTargetTicket(dstSite);
      const ticket = tk.ticket;
      // 有新增项但 ticket 无效/过期 → 提示重新验证 AI 账号
      const hasCreate = items.some((s) => !s.isOverwrite);
      if (hasCreate && (!ticket || tk.expired)) {
        doneProgress.style.display = 'none';
        showDone('无法执行新增',
          '<div class="sum" style="color:#ff7b72">AI 目标账号验证' + (tk.expired ? '已过期' : '未完成') + '。\n请到迁移页重新验证 AI 站账号（谷歌邮箱验证）后重试。</div>');
        setStatus('新增失败：AI 目标账号验证' + (tk.expired ? '已过期，请重新验证' : '未完成'), 'error');
        return;
      }
      execBtn.disabled = true;
      execBtn.textContent = '执行中…';
      // 显示执行进度（固定进度条 + 明细滚动）
      doneProgress.style.display = 'block';
      doneProgress.textContent = '开始执行 ' + items.length + ' 项…';
      showDone('执行中', '');
      try {
        const lines = [];
        let okO = 0, okC = 0, fail = 0;
        for (let i = 0; i < items.length; i++) {
          const sel = items[i];
          const { item, isOverwrite } = sel;
          // 进度固定显示在弹窗顶部（不随明细滚动消失）
          doneProgress.style.display = 'block';
          doneProgress.textContent = '执行中 ' + (i + 1) + '/' + items.length + '：[' + (item.kind === 'webapp' ? 'AI应用' : '工作流') + '] ' + item.src.name;
          showDone('执行中', lines.map((l) => {
            const ok = l.indexOf('✅') === 0 || l.indexOf('🆕') === 0;
            return '<div class="rht-checkrow" style="cursor:default"><span class="nm" style="color:' + (ok ? '#3fb950' : '#ff7b72') + '">' + esc(l) + '</span></div>';
          }).join(''), true);
          try {
            if (isOverwrite) {
              const srcDetail = await fetchAssetDetail(srcSite, item.kind, item.src.id);
              let dstWfId = '';
              if (item.kind === 'webapp') {
                const dstDetail = await fetchAssetDetail(dstSite, 'webapp', item.dst.id);
                dstWfId = (dstDetail && dstDetail.workflowId) || item.dst.id;
              } else {
                dstWfId = item.dst.id;
              }
              const r = await overwriteAsset(srcSite, dstSite, item.kind, srcDetail, item.dst.id, item.dst.name, dstWfId);
              if (r && r.code === 0) {
                okO++;
                lines.push('✅ 覆盖 ' + item.dst.name + '（' + (item.kind === 'webapp' ? 'AI应用' : '工作流') + '） #' + item.dst.id);
                // 覆盖成功 → 内容已同步，标记为相同（下次检测不再显示“不同”）
                if (item.contentSame !== undefined) item.contentSame = true;
              }
              else { fail++; lines.push('❌ 覆盖失败 ' + item.dst.name + '（' + (item.kind === 'webapp' ? 'AI应用' : '工作流') + '）：' + (r && r.msg)); }
            } else {
              const r = await migrateNew(srcSite, dstSite, item.kind, item.src.id, ticket);
              if (r && r.code === 0) {
                okC++;
                lines.push('🆕 新增 ' + item.src.name + '（' + (item.kind === 'webapp' ? 'AI应用' : '工作流') + '）');
                // 新增成功 → 标记已迁移，缓存里过滤掉，避免刷新后仍显示“新增”
                item._migrated = true;
              }
              else { fail++; lines.push('❌ 新增失败 ' + item.src.name + '：' + (r && r.msg)); }
            }
          } catch (e) {
            fail++; lines.push('❌ ' + item.src.name + '：' + String(e.message || e));
          }
        }
        // 结果弹窗：明细（汇总固定在进度条位置显示，见下方）
        const html = [];
        lines.forEach((l) => {
          const cls = l.indexOf('✅') === 0 || l.indexOf('🆕') === 0 ? 'c' : 'e';
          html.push('<div class="rht-checkrow" style="cursor:default"><span class="nm" style="color:' + (cls === 'c' ? '#3fb950' : '#ff7b72') + '">' + esc(l) + '</span></div>');
        });
        html.push('<div class="sum" style="margin-top:8px;color:#8b949e">以上结果供核对，可到目标站确认。</div>');
        // 汇总复用执行进度条：同一位置、同一样式，只改文本（不隐藏不重排，避免视觉跳动）
        showDone('执行结果', html.join(''));
        doneProgress.textContent = '执行完成：覆盖 ' + okO + ' 项、新增 ' + okC + ' 项' + (fail ? '、失败 ' + fail + ' 项' : '');
        setStatus('执行完成：覆盖 ' + okO + '、新增 ' + okC + (fail ? '、失败 ' + fail : ''), fail ? 'error' : 'ok');
      } catch (e) {
        doneProgress.style.display = 'none';
        showDone('执行异常', '<div class="sum" style="color:#ff7b72">' + esc(String(e.message || e)) + '</div>');
        setStatus('执行异常：' + String(e.message || e), 'error');
      } finally {
        // 迁移后清资产缓存（.ai 资产已变化），下次检测重新拉取
        Object.keys(assetCache).forEach((k) => { delete assetCache[k]; });
        execBtn.disabled = false;
        execBtn.textContent = '② 执行迁移';
      }
    }

    function esc(s) {
      return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    return host;
  }

  function mount() {
    if (!document.querySelector('#rht-mig-host')) {
      buildPanel();
      // 记录本站在当前页的 token（另一站打开时也记录），供跨站调用
      try {
        const t = localStorage.getItem('Rh-Accesstoken') || '';
        if (t) {
          chrome.storage.local.get('rht_tokens', (d) => {
            const cur = (d && d.rht_tokens) || {};
            if (cur[THIS_SITE] !== t) {
              cur[THIS_SITE] = t;
              chrome.storage.local.set({ rht_tokens: cur });
            }
          });
        }
      } catch (e) { /* 忽略 */ }
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
