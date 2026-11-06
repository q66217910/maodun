/* ============================================================
   矛盾分析室 — 交互与推理
   Markdown 渲染与报告质检在 assets/markdown.js（window.MaodunMd），这里只管交互。
   ============================================================ */
(function () {
  'use strict';

  const M = window.MaodunMd;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const LS_SETTINGS = 'maodun.settings.v1';
  const LS_CASES = 'maodun.cases.v1';
  const LS_DRAFT = 'maodun.draft.v1';

  /* ------------------------------------------------------------
     提示词：全部来自 skills/contradiction-analysis，代码里不存文本
     ------------------------------------------------------------ */
  let prompts = null;
  let promptError = null;
  let skillVersion = null;

  async function ensurePrompts() {
    if (prompts) return prompts;
    try {
      const res = await fetch('/api/prompts', { cache: 'no-cache' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || '读不到分析提示词');
      if (!data.analysis || !data.followup) throw new Error('提示词文件内容不完整');
      prompts = data;
      skillVersion = data.version || null;
      promptError = null;
      checkSectionAlignment(data.sections);
      return prompts;
    } catch (e) {
      promptError = /Failed to fetch|NetworkError/i.test(e.message)
        ? '读不到提示词：请用 server.js（npm start）打开页面，不要直接双击 html'
        : e.message;
      throw new Error(promptError);
    }
  }

  /** 提示词的小节改过、前端 SECTION_MAP 没跟着改时，早点出声 */
  function checkSectionAlignment(sections) {
    if (!Array.isArray(sections) || !sections.length) return;
    const titles = M.SECTION_MAP.map((s) => s.title);
    const missing = titles.filter((t) => !sections.includes(t));
    const extra = sections.filter((s) => !titles.includes(s));
    if (!missing.length && !extra.length) return;

    console.warn(
      '[矛盾分析室] 提示词小节与前端 SECTION_MAP 不一致。\n' +
      '提示词里没有：' + (missing.join('、') || '（无）') + '\n' +
      '前端多出来：' + (extra.join('、') || '（无）') + '\n' +
      '改结构时请同时改 assets/markdown.js 的 SECTION_MAP 与 style.css 的 .is-* 样式。'
    );
    const foot = $('#footEngine');
    if (foot) {
      foot.textContent = '结构待对齐';
      foot.classList.add('is-warn');
      foot.title = '提示词小节与前端 SECTION_MAP 不一致，按 F12 看控制台详情';
    }
  }

  /* ------------------------------------------------------------
     状态
     ------------------------------------------------------------ */
  let settings = loadSettings();
  let cases = loadCases();
  let current = null;        // 当前会话 { id, question, extra, analysis, followups, tasks, createdAt }
  let abortCtrl = null;
  let proxyOk = null;        // null 未知 / true 可用 / false 不可用
  let lastAttempt = null;    // 出错后重试用
  let ignoreStream = false;  // 主动放弃当前流时，别再往页面里画

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) return Object.assign({ endpoint: '', model: '', key: '' }, JSON.parse(raw));
    } catch (e) { /* 忽略损坏数据 */ }
    return { endpoint: '', model: '', key: '' };
  }

  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) {}
  }

  function loadCases() {
    try {
      const raw = localStorage.getItem(LS_CASES);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveCases() {
    try {
      localStorage.setItem(LS_CASES, JSON.stringify(cases.slice(0, 60)));
    } catch (e) {
      // 配额满了还静默失败最坑：至少让用户知道这一条没存上
      console.warn('本地存储写不进去（可能已满）', e);
      const hint = $('#engineHint');
      if (hint) {
        hint.textContent = '本地存储已满，新分析可能没保存。可以先导出 Markdown。';
        hint.style.color = 'var(--zhu)';
      }
    }
  }

  const configured = () => Boolean(settings.endpoint && settings.model && settings.key);

  /* ------------------------------------------------------------
     草稿：流式过程中随时落盘，刷新或崩了都能捞回来
     ------------------------------------------------------------ */
  function saveDraft(analysis) {
    if (!current) return;
    try {
      localStorage.setItem(LS_DRAFT, JSON.stringify({
        id: current.id,
        question: current.question,
        extra: current.extra || {},
        analysis: typeof analysis === 'string' ? analysis : current.analysis,
        followups: current.followups || [],
        createdAt: current.createdAt,
        at: Date.now(),
      }));
    } catch (e) { /* 配额问题忽略，正文仍会尝试写入历史 */ }
  }

  function clearDraft() {
    try { localStorage.removeItem(LS_DRAFT); } catch (e) {}
  }

  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(LS_DRAFT) || 'null');
      return d && d.analysis && d.question ? d : null;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------
     视图切换
     ------------------------------------------------------------ */
  function showView(name) {
    ['ask', 'cases', 'method'].forEach((v) => {
      const el = $('#view-' + v);
      if (el) el.hidden = v !== name;
    });
    $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === name));
    $$('.nav-item').forEach((b) => b.setAttribute('aria-current', b.dataset.nav === name ? 'page' : 'false'));
    if (name === 'cases') renderCaseList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $$('[data-nav]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showView(el.dataset.nav);
    });
  });

  /* ------------------------------------------------------------
     渲染：渲染器在 markdown.js，这里补上「结论标记」与「行动勾选」
     ------------------------------------------------------------ */
  const elBody = $('#analysisBody');
  const elWrap = $('#analysisWrap');
  const elFoot = $('#reportFoot');

  /* 表格里的「性质 / 主次」是判断结论，不该只是一格灰字 */
  function decorate(root) {
    root.querySelectorAll('table').forEach((table) => {
      const heads = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
      const iMain = heads.findIndex((h) => /主次|主要次要/.test(h));
      const iNat = heads.findIndex((h) => /性质/.test(h));

      table.querySelectorAll('tbody tr').forEach((tr) => {
        const cells = tr.children;

        if (iMain > -1 && cells[iMain]) {
          const v = cells[iMain].textContent.trim();
          if (v && v.length <= 8) {
            const cls = /主要/.test(v) ? 'tagx-main' : /次要/.test(v) ? 'tagx-sub' : /待定|待判/.test(v) ? 'tagx-wait' : '';
            if (cls) {
              cells[iMain].innerHTML = `<span class="tagx ${cls}">${M.esc(v)}</span>`;
              if (cls === 'tagx-main') tr.classList.add('row-main');
            }
          }
        }

        if (iNat > -1 && cells[iNat]) {
          const v = cells[iNat].textContent.trim();
          if (v && v.length <= 12) {
            const cls = /非对抗/.test(v) ? 'tagx-har' : /对抗/.test(v) ? 'tagx-ant' : /待判|待定/.test(v) ? 'tagx-wait' : '';
            if (cls) cells[iNat].innerHTML = `<span class="tagx ${cls}">${M.esc(v)}</span>`;
          }
        }
      });
    });
  }

  function paintMd(el, md, withSteps, opts) {
    const options = Object.assign({ taskList: false }, opts);
    el.innerHTML = M.renderMarkdown(md, withSteps, options);
    decorate(el);
    if (options.taskList) { syncTasks(el); syncChecks(el); }
    el.classList.toggle('has-steps', Boolean(el.querySelector('.step')));
  }

  /* ------------------------------------------------------------
     行动清单：勾选、约验证日期、逾期提醒
     ------------------------------------------------------------ */
  function todayStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function isOverdue(due) {
    if (!due) return false;
    return due < todayStamp();
  }

  function gapWords(gap) {
    return gap === 'yes' ? '符合预期' : gap === 'part' ? '部分符合' : gap === 'no' ? '和预期相反' : '';
  }

  function syncTasks(root) {
    const map = (current && current.tasks) || {};
    const boxes = $$('input.task-box', root);

    boxes.forEach((box) => {
      const k = box.dataset.task;
      const st = map[k] || {};
      const li = box.closest('li');
      if (li && li.dataset.taskReady !== '1') {
        li.dataset.taskReady = '1';
        li.appendChild(buildDueRow(k));
        li.appendChild(buildResultRow(k));
      }

      box.checked = Boolean(st.done);
      if (li) li.classList.toggle('is-done', Boolean(st.done));
      paintTaskState(li, st);
    });

    if (current) current.taskTotal = boxes.length;
    updateTaskProgress();
  }

  function buildDueRow(k) {
    const row = document.createElement('div');
    row.className = 'task-due-row';

    const cap = document.createElement('span');
    cap.className = 'task-due-cap';
    cap.textContent = '验证日';

    const due = document.createElement('input');
    due.type = 'date';
    due.className = 'task-due';
    due.dataset.task = k;
    due.title = '打算哪天验证这一步';
    due.setAttribute('aria-label', '这一步的验证日期');

    row.appendChild(cap);
    row.appendChild(due);
    return row;
  }

  /* 实践的回填口：勾掉只是"做了"，这一行才是"做出什么结果" */
  function buildResultRow(k) {
    const row = document.createElement('div');
    row.className = 'task-result-row';

    const cap = document.createElement('span');
    cap.className = 'task-due-cap';
    cap.textContent = '实际';

    const result = document.createElement('input');
    result.type = 'text';
    result.className = 'task-result';
    result.dataset.task = k;
    result.maxLength = 160;
    result.placeholder = '实际发生了什么（一句话）';
    result.setAttribute('aria-label', '这一步的实际结果');

    row.appendChild(cap);
    row.appendChild(result);

    const group = document.createElement('span');
    group.className = 'gap-group';
    [['yes', '符合'], ['part', '部分'], ['no', '相反']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gap-btn';
      b.dataset.task = k;
      b.dataset.gap = v;
      b.textContent = label;
      b.title = '实际结果和当初的检验标准相比';
      group.appendChild(b);
    });
    row.appendChild(group);
    return row;
  }

  function paintTaskState(li, st) {
    if (!li) return;
    li.classList.toggle('is-done', Boolean(st.done));
    const due = li.querySelector('.task-due');
    if (due) {
      if (document.activeElement !== due) due.value = st.due || '';
      due.classList.toggle('is-overdue', !st.done && isOverdue(st.due));
    }
    const result = li.querySelector('.task-result');
    if (result && document.activeElement !== result) result.value = st.result || '';
    $$('.gap-btn', li).forEach((b) => b.classList.toggle('is-on', st.gap === b.dataset.gap));
  }

  /* 待核实项：调查的工单，勾上时必须落一句核实到的答案 */
  function syncChecks(root) {
    const scope = root.querySelector('.step.is-facts');
    if (!scope) return;
    const map = (current && current.checks) || {};

    scope.querySelectorAll('li').forEach((li) => {
      if (li.dataset.ckHost === '1') return;
      const chip = Array.from(li.children).find((c) => c.classList && c.classList.contains('hint-chip') && /待核实/.test(c.textContent));
      if (!chip) return;
      const list = Array.from(li.children).find((c) => c.tagName === 'UL' || c.tagName === 'OL');
      if (!list) return;

      li.dataset.ckHost = '1';
      let i = 0;
      Array.from(list.children).forEach((item) => {
        if (item.tagName !== 'LI' || item.dataset.ck) return;
        const key = 'f' + i++;
        item.dataset.ck = key;

        const row = document.createElement('div');
        row.className = 'check-row';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'check-box';
        box.dataset.check = key;
        box.setAttribute('aria-label', '这一条核实过了');
        box.title = '核实过了就勾上';

        const cap = document.createElement('span');
        cap.className = 'check-cap';
        cap.textContent = '核实到';

        const ans = document.createElement('input');
        ans.type = 'text';
        ans.className = 'check-answer';
        ans.dataset.check = key;
        ans.maxLength = 200;
        ans.placeholder = '问到 / 查到的答案';

        row.appendChild(box);
        row.appendChild(cap);
        row.appendChild(ans);
        item.appendChild(row);
      });
    });

    scope.querySelectorAll('li[data-ck]').forEach((li) => {
      const st = map[li.dataset.ck] || {};
      const box = li.querySelector('.check-box');
      const ans = li.querySelector('.check-answer');
      if (box) box.checked = Boolean(st.done);
      if (ans && document.activeElement !== ans) ans.value = st.answer || '';
      li.classList.toggle('is-checked', Boolean(st.done || st.answer));
    });

    if (current) current.checkTotal = scope.querySelectorAll('li[data-ck]').length;
    updateTaskProgress();
  }

  function setTask(k, patch, quiet) {
    if (!current) return;
    current.tasks = current.tasks || {};
    current.tasks[k] = Object.assign({}, current.tasks[k], patch);
    if (!quiet) {
      const box = elBody.querySelector(`input.task-box[data-task="${k}"]`);
      paintTaskState(box && box.closest('li'), current.tasks[k]);
    }
    queueSave();
    updateTaskProgress();
  }

  function setCheck(k, patch, quiet) {
    if (!current) return;
    current.checks = current.checks || {};
    current.checks[k] = Object.assign({}, current.checks[k], patch);
    if (!quiet) {
      const li = elBody.querySelector(`li[data-ck="${k}"]`);
      if (li) li.classList.toggle('is-checked', Boolean(current.checks[k].done || current.checks[k].answer));
    }
    queueSave();
    updateTaskProgress();
  }

  let saveTimer = null;
  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveCases(), 600);
  }

  function taskStats(c) {
    const map = (c && c.tasks) || {};
    const keys = Object.keys(map);
    const total = (c && c.taskTotal) || keys.length;
    const done = keys.filter((k) => map[k] && map[k].done).length;
    const overdue = keys.filter((k) => !map[k].done && isOverdue(map[k].due)).length;
    const recorded = keys.filter((k) => map[k] && map[k].result).length;
    return { total, done, overdue, recorded };
  }

  function checkStats(c) {
    const map = (c && c.checks) || {};
    const keys = Object.keys(map);
    const total = (c && c.checkTotal) || keys.length;
    const done = keys.filter((k) => map[k] && (map[k].done || map[k].answer)).length;
    return { total, done };
  }

  function updateTaskProgress() {
    const el = $('#taskProgress');
    if (!el) return;
    const { total, done, overdue } = taskStats(current);
    const ck = checkStats(current);
    const bits = [];
    if (total) bits.push(`行动 ${done}/${total}`);
    if (ck.total) bits.push(`核实 ${ck.done}/${ck.total}`);
    if (!bits.length) { el.textContent = ''; el.hidden = true; return; }
    el.hidden = false;
    el.textContent = bits.join(' · ');
    el.classList.toggle('is-overdue', overdue > 0);
    el.title = overdue > 0 ? `有 ${overdue} 项过了验证日期还没做` : '勾掉做完的步骤，并记一句实际结果';
  }

  elBody.addEventListener('change', (e) => {
    const box = e.target.closest('.task-box');
    if (box) { setTask(box.dataset.task, { done: box.checked }); return; }
    const due = e.target.closest('.task-due');
    if (due) { setTask(due.dataset.task, { due: due.value }); return; }
    const ckb = e.target.closest('.check-box');
    if (ckb) setCheck(ckb.dataset.check, { done: ckb.checked });
  });

  elBody.addEventListener('input', (e) => {
    const result = e.target.closest('.task-result');
    if (result) { setTask(result.dataset.task, { result: result.value }, true); return; }
    const ans = e.target.closest('.check-answer');
    if (ans) setCheck(ans.dataset.check, { answer: ans.value }, true);
  });

  elBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.gap-btn');
    if (!btn) return;
    const k = btn.dataset.task;
    const cur = (current && current.tasks && current.tasks[k]) || {};
    setTask(k, { gap: cur.gap === btn.dataset.gap ? '' : btn.dataset.gap });
  });

  /* ------------------------------------------------------------
     质检结果：模型跑偏时，用规则兜住
     ------------------------------------------------------------ */
  function renderLint(issues) {
    const box = $('#lintBox');
    if (!box) return;
    const list = (issues || []).filter((i) => i.level !== 'info');
    const info = (issues || []).filter((i) => i.level === 'info');
    if (!list.length && !info.length) { box.hidden = true; box.innerHTML = ''; return; }

    box.hidden = false;
    box.innerHTML =
      '<p class="lint-title">这份拆解有几处还没给到位</p><ul>' +
      (list.concat(info)).map((i) =>
        `<li class="lint-item is-${i.level}">${M.esc(i.text)}</li>`
      ).join('') +
      '</ul><p class="lint-foot">不一定要重跑；缺哪条补哪条——尤其是方法层面的缺口，补不上结论就站不住。</p>';
  }

  /* ------------------------------------------------------------
     流式调用
     ------------------------------------------------------------ */
  function buildMessages(question, extra, baseline) {
    const parts = [`用户的问题：${question}`];
    if (extra.role) parts.push(`他/她的位置：${extra.role}`);
    if (extra.limit) parts.push(`时间与资源限制：${extra.limit}`);
    if (extra.tried) parts.push(`已经试过、结果如下：${extra.tried}`);

    if (baseline) {
      parts.push(
        `这是对同一件事的第二次拆解，距上次已经过去一段时间。上次（${fmtTime(baseline.at)}）的判断是：\n` +
        `${baseline.judge || '（无）'}\n\n` +
        `上次认定的主要矛盾：\n${baseline.main || '（无）'}\n\n` +
        `上次判断的阶段：\n${baseline.stage || '（无）'}`
      );

      if (baseline.practice) {
        parts.push(
          `上次三步行动的实际情况（使用者按当时方案做完或没做，自己记下的，属于新的事实，不是推测）：\n` +
          `${baseline.practice}\n\n` +
          '处理要求：先把「实际结果」当事实用，逐条对照上次的检验标准，明确哪条判断被证实、哪条被推翻。' +
          '行动没做或没记录的，也要据此修正对阶段的估计，不要当成「条件未成熟」糊过去。'
        );
      }

      if (baseline.misread) {
        parts.push(
          `上次列出的「可能的误判」：\n${baseline.misread}\n\n` +
          '请逐条对照：有证据说明哪一条真的发生了？发生了就直说，没发生也说一句。不要重抄一遍。'
        );
      }

      parts.push('这次请重新完整拆一遍，十段全写。不要照抄上次的措辞；如果结论变了就直接给新的，如果没变就说明为什么没变。');
    }

    parts.push('请按规定的结构输出分析。');
    return [
      { role: 'system', content: prompts.analysis },
      { role: 'user', content: parts.join('\n') },
    ];
  }

  async function* readSSE(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let json;
        try { json = JSON.parse(data); } catch (e) { continue; }
        if (json.error) throw new Error(json.error.message || '接口返回错误');
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (delta && typeof delta.content === 'string' && delta.content) yield delta.content;
      }
    }
  }

  function friendlyError(err, status) {
    const msg = (err && err.message) || String(err);
    if (status === 401 || status === 403) return 'Key 无效，或没有这个模型的权限（401/403）。到设置里换一个 Key。';
    if (status === 402) return '账户额度不足（402）。';
    if (status === 429) return '请求太频繁或超出限额（429），等一会儿再试。';
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return '连不上接口。可能是地址写错、网络不通，或浏览器跨域被拒。用本项目自带的 server.js 打开页面可以绕开跨域。';
    }
    return msg;
  }

  async function* streamChat(messages, signal) {
    const payload = {
      endpoint: settings.endpoint,
      apiKey: settings.key,
      model: settings.model,
      messages,
      temperature: 0.6,
    };

    // 优先走本地/服务端代理（避免浏览器跨域），不可用时直连
    if (proxyOk !== false && location.protocol !== 'file:') {
      let res;
      try {
        res = await fetch('/api/analyse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        proxyOk = false;
      }
      if (res) {
        if (res.ok && res.body) {
          proxyOk = true;
          yield* readSSE(res);
          return;
        }
        if (res.status === 404 || res.status === 405) {
          proxyOk = false;
        } else {
          let detail = '';
          let status = res.status;
          try {
            const j = await res.json();
            detail = j.message || j.error || '';
          } catch (e) {}
          const err = new Error(detail || `请求失败（${status}）`);
          err.status = status;
          throw err;
        }
      }
    }

    // 直连
    const res = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + settings.key,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: payload.temperature,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      let detail = '';
      try {
        const text = await res.text();
        try { detail = JSON.parse(text).error?.message || text.slice(0, 200); }
        catch (e) { detail = text.slice(0, 200); }
      } catch (e) {}
      const err = new Error(detail || `请求失败（${res.status}）`);
      err.status = res.status;
      throw err;
    }
    yield* readSSE(res);
  }

  /* ------------------------------------------------------------
     发起分析
     ------------------------------------------------------------ */
  function showFoot(on) {
    if (elFoot) elFoot.hidden = !on;
  }

  function setBusy(on, label) {
    const btn = $('#submitBtn');
    btn.disabled = on;
    btn.querySelector('span').textContent = on ? (label || '拆解中…') : '开始拆解';
    ['#followBtn', '#reBtn'].forEach((sel) => {
      const el = $(sel);
      if (el) el.disabled = on;
    });
    ['#stopBtn', '#followStop'].forEach((sel) => {
      const el = $(sel);
      if (el) el.hidden = !on;
    });
  }

  function stopStream() {
    if (abortCtrl) abortCtrl.abort();
  }

  function showThinking(text) {
    elBody.innerHTML = `<div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span>${text || '正在梳理事实与结构'}</div>`;
  }

  async function runAnalysis(question, extra, opts) {
    const options = opts || {};
    try { await ensurePrompts(); } catch (e) { hintError(e.message); return; }

    lastAttempt = { question, extra: extra || {}, opts: options };
    const baseline = options.baseline || null;

    current = {
      id: 'c_' + Date.now().toString(36),
      question,
      extra: extra || {},
      analysis: '',
      followups: [],
      tasks: {},
      createdAt: new Date().toISOString(),
    };
    ignoreStream = false;

    $('#questionRecap').textContent = recapText(current);
    $('#caseTime').textContent = fmtTime(current.createdAt);
    $('#caseTag').textContent = baseline ? '第二次拆解' : '新分析';
    $('#followList').innerHTML = '';
    const fInput = $('#followInput');
    if (fInput) fInput.value = '';
    renderLint([]);
    renderCompare(null);
    showFoot(false);
    updateTaskProgress();
    elWrap.hidden = false;
    showThinking();
    elWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });

    abortCtrl = new AbortController();
    setBusy(true);

    let acc = '';
    let lastPaint = 0;
    let lastDraft = 0;
    let pending = false;

    const paint = (force) => {
      const now = performance.now();
      if (!force && now - lastPaint < 55) { pending = true; return; }
      lastPaint = now;
      pending = false;
      current.analysis = acc; // 让草稿与 beforeunload 随时能拿到最新内容
      paintMd(elBody, acc, true, { taskList: true });
      elBody.insertAdjacentHTML('beforeend', '<span class="caret"></span>');
      if (now - lastDraft > 1500) { lastDraft = now; saveDraft(acc); }
    };

    const finish = (interrupted) => {
      current.analysis = acc;
      current.lint = M.lintReport(acc);
      // 先渲染再落盘：checkTotal 是渲染时数出来的，晚一步存就会丢
      paintMd(elBody, acc, true, { taskList: true });
      if (baseline) current.compare = makeCompare(baseline, acc);
      if (interrupted) current.interrupted = true;
      current.taskTotal = $$('input.task-box', elBody).length;

      cases.unshift(current);
      saveCases();
      clearDraft();

      showFoot(true);
      renderLint(current.lint);
      renderCompare(current.compare);
      renderCaseList();
      $('#caseTag').textContent = interrupted ? '已停止 · 不完整' : '已保存';
    };

    try {
      for await (const chunk of streamChat(buildMessages(question, current.extra, baseline), abortCtrl.signal)) {
        if (chunk) acc += chunk;
        paint(false);
      }
      paint(true);
      finish(false);
    } catch (err) {
      if (err.name === 'AbortError') {
        if (ignoreStream) return;
        if (acc) finish(true);
        else { elBody.innerHTML = ''; if (!ignoreStream) showFoot(false); }
        return;
      }
      if (ignoreStream) return;
      paintMd(elBody, acc, true, { taskList: true });
      showFoot(Boolean(acc));
      if (acc) {
        current.analysis = acc;
        current.lint = M.lintReport(acc);
        cases.unshift(current);
        saveCases();
        clearDraft();
        renderLint(current.lint);
      }
      const box = document.createElement('div');
      box.className = 'err';
      box.innerHTML =
        `<p>${M.esc(friendlyError(err, err.status))}</p>` +
        '<button type="button" class="mini" data-retry="1">重试这一次</button>';
      elBody.appendChild(box);
      box.querySelector('[data-retry]').addEventListener('click', () => {
        if (!lastAttempt) return;
        runAnalysis(lastAttempt.question, lastAttempt.extra, lastAttempt.opts);
      });
      if (acc) renderCaseList();
      current = acc ? current : null;
    } finally {
      setBusy(false);
      abortCtrl = null;
    }
  }

  function recapText(c) {
    const bits = [];
    if (c.extra && c.extra.role) bits.push('位置：' + c.extra.role);
    if (c.extra && c.extra.limit) bits.push('限制：' + c.extra.limit);
    if (c.extra && c.extra.tried) bits.push('已试：' + c.extra.tried);
    return c.question + (bits.length ? '\n（' + bits.join('；') + '）' : '');
  }

  /* ------------------------------------------------------------
     复拆对照
     ------------------------------------------------------------ */
  const COMPARE_SECTIONS = ['判断', '主要矛盾', '阶段'];

  function makeCompare(baseline, nextText) {
    const items = COMPARE_SECTIONS.map((title) => {
      const before = (baseline.byTitle && baseline.byTitle[title]) || '';
      const after = M.extractSection(nextText, title);
      const norm = (s) => String(s).replace(/\s/g, '');
      return { title, before, after, changed: norm(before) !== norm(after) };
    });
    return { prevAt: baseline.at, items };
  }

  /* 实践记录：把行动结果与核实答案收成一段可注入的事实 */
  function practiceSummary(c) {
    const lines = [];
    const tasks = (c && c.tasks) || {};
    const taskKeys = Object.keys(tasks);
    const taskTotal = Math.max((c && c.taskTotal) || 0, taskKeys.length);

    for (let i = 0; i < taskTotal; i++) {
      const t = tasks[i] || {};
      const step = `第 ${i + 1} 步`;
      if (t.result) {
        lines.push(`${step}：${t.result}${t.gap ? '（' + gapWords(t.gap) + '）' : ''}`);
      } else if (t.done) {
        lines.push(`${step}：做了，但没记结果`);
      } else {
        lines.push(`${step}：还没动`);
      }
    }

    const checks = (c && c.checks) || {};
    const checkKeys = Object.keys(checks);
    const checkTotal = Math.max((c && c.checkTotal) || 0, checkKeys.length);
    for (let i = 0; i < checkTotal; i++) {
      const ck = checks['f' + i] || {};
      if (ck.answer) lines.push(`待核实第 ${i + 1} 条：${ck.answer}`);
      else if (ck.done) lines.push(`待核实第 ${i + 1} 条：核实过了，但没记结果`);
      else lines.push(`待核实第 ${i + 1} 条：还没去核实`);
    }

    return lines.join('\n');
  }

  /* 真正被记下来的条目数：只有"还没动"的情况不算实践记录 */
  function practiceCount(c) {
    const tasks = (c && c.tasks) || {};
    const checks = (c && c.checks) || {};
    return Object.keys(tasks).filter((k) => tasks[k] && tasks[k].result).length +
      Object.keys(checks).filter((k) => checks[k] && checks[k].answer).length;
  }

  function renderCompare(cmp) {
    const box = $('#compareBox');
    if (!box) return;
    if (!cmp || !cmp.items || !cmp.items.length) { box.hidden = true; box.innerHTML = ''; return; }

    box.hidden = false;
    box.innerHTML =
      '<div class="compare-head">' +
        `<span class="compare-title">对照上一次</span><span class="compare-at">${fmtTime(cmp.prevAt)}</span>` +
        `<span class="compare-sum">${cmp.items.filter((i) => !i.changed).length}/${cmp.items.length} 条未变</span>` +
      '</div>' +
      cmp.items.map((it) => `
        <div class="cmp-row">
          <div class="cmp-label">${it.title}${it.changed ? '<span class="cmp-mark">变了</span>' : '<span class="cmp-mark is-same">未变</span>'}</div>
          <div class="cmp-cell"><span class="cmp-tag">上次</span>${M.renderMarkdown(it.before || '（上次没写这一节）', false)}</div>
          <div class="cmp-cell is-after"><span class="cmp-tag">这次</span>${M.renderMarkdown(it.after || '（这次没写这一节）', false)}</div>
        </div>`).join('');
  }

  function openReDialog() {
    if (!current || !current.analysis || abortCtrl) return;
    const dlg = $('#reDialog');
    const input = $('#reInput');
    if (!dlg || !input) return;
    input.value = '';

    const carry = $('#reCarry');
    if (carry) {
      const n = practiceCount(current);
      carry.textContent = n
        ? `会带上你记过的 ${n} 条实践记录（行动结果 + 核实答案），一起交给重新判断。`
        : '上次没有记录任何行动结果，这次只能靠你补充——这也说明那三步一直没落地。';
      carry.classList.toggle('is-warn', !n);
    }

    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => input.focus(), 60);
  }

  function closeReDialog() {
    const dlg = $('#reDialog');
    if (!dlg) return;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function submitReanalyse() {
    if (!current || !current.analysis) return;
    const note = ($('#reInput')?.value || '').trim();

    const baseline = {
      at: current.createdAt,
      byTitle: {},
      practice: '',
      misread: '',
    };
    COMPARE_SECTIONS.forEach((t) => { baseline.byTitle[t] = M.extractSection(current.analysis, t); });
    baseline.practice = practiceSummary(current);
    baseline.misread = M.extractSection(current.analysis, '可能的误判');

    const extra = Object.assign({}, current.extra);
    if (note) {
      extra.tried = [current.extra && current.extra.tried, '这期间的新情况：' + note].filter(Boolean).join('；');
    }

    closeReDialog();
    runAnalysis(current.question, extra, { baseline });
  }

  /* ------------------------------------------------------------
     追问
     ------------------------------------------------------------ */
  async function runFollowup(text) {
    if (!current) return;
    try { await ensurePrompts(); } catch (e) { hintError(e.message); return; }

    const item = document.createElement('div');
    item.className = 'follow-item';
    item.innerHTML = `<p class="follow-q">${M.esc(text)}</p><div class="follow-a"></div>`;
    $('#followList').appendChild(item);
    const target = item.querySelector('.follow-a');
    target.innerHTML = '<div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span>重新称量</div>';

    const history = (current.followups || []).map((f) => `用户：${f.q}\n你的回答：${f.a}`).join('\n\n');
    const practice = practiceSummary(current);
    const userContent = [
      `原问题：${current.question}`,
      current.extra.role ? `位置：${current.extra.role}` : '',
      current.extra.limit ? `限制：${current.extra.limit}` : '',
      current.extra.tried ? `已试过：${current.extra.tried}` : '',
      `原分析：\n${current.analysis}`,
      practice ? `使用者按方案做完后记下的实际结果（属于新的事实）：\n${practice}` : '',
      history ? `此前的追问记录：\n${history}` : '',
      `用户这次说：${text}`,
    ].filter(Boolean).join('\n\n');

    const messages = [
      { role: 'system', content: prompts.followup },
      { role: 'user', content: userContent },
    ];

    abortCtrl = new AbortController();
    ignoreStream = false;
    setBusy(true);
    const btn = $('#followBtn');
    btn.textContent = '…';
    let acc = '';
    try {
      for await (const chunk of streamChat(messages, abortCtrl.signal)) {
        if (chunk) acc += chunk;
        paintMd(target, acc, false);
        target.insertAdjacentHTML('beforeend', '<span class="caret"></span>');
      }
      paintMd(target, acc, false);
      current.followups = current.followups || [];
      current.followups.push({ q: text, a: acc, at: new Date().toISOString() });
      saveCases();
      renderCaseList();
    } catch (err) {
      if (err.name === 'AbortError') {
        if (acc) paintMd(target, acc, false);
        else if (!ignoreStream) target.textContent = '已停止。';
        return;
      }
      target.innerHTML = `<p class="err">${M.esc(friendlyError(err, err.status))}</p>`;
    } finally {
      setBusy(false);
      btn.textContent = '继续';
      abortCtrl = null;
    }
  }

  /* ------------------------------------------------------------
     历史
     ------------------------------------------------------------ */
  function fmtTime(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderCaseList() {
    const box = $('#caseList');
    const empty = $('#caseEmpty');
    const count = $('#caseCount');
    if (count) count.textContent = cases.length ? String(cases.length) : '';

    if (!cases.length) { box.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;

    box.innerHTML = cases.map((c) => {
      const { total, done, overdue, recorded } = taskStats(c);
      const meta = [
        fmtTime(c.createdAt),
        (c.followups && c.followups.length) ? '追问 ' + c.followups.length + ' 次' : '未追问',
        total ? `行动 ${done}/${total}` : '',
        recorded ? `记了结果 ${recorded} 条` : '',
        c.compare ? '有对照' : '',
        c.interrupted ? '不完整' : '',
      ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');

      return `
      <button class="case-item${overdue ? ' has-overdue' : ''}" data-id="${c.id}">
        <span class="del" data-del="${c.id}" title="删除" role="button" tabindex="-1">✕</span>
        <div class="q">${M.esc(c.question)}</div>
        <div class="meta">${meta}</div>
        ${overdue ? `<div class="case-due">有 ${overdue} 项过了验证日期</div>` : ''}
      </button>`;
    }).join('');

    $$('.case-item', box).forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (e.target.dataset.del) {
          const id = e.target.dataset.del;
          if (confirm('删除这条分析？删除后无法恢复。')) {
            cases = cases.filter((c) => c.id !== id);
            saveCases();
            renderCaseList();
          }
          return;
        }
        openCase(btn.dataset.id);
      });
    });
  }

  function openCase(id) {
    const c = cases.find((x) => x.id === id);
    if (!c) return;

    // 切历史时把在途的流掐掉，别让它继续往正文里写
    if (abortCtrl) { ignoreStream = true; abortCtrl.abort(); abortCtrl = null; setBusy(false); }

    current = c;
    $('#questionRecap').textContent = recapText(c);
    $('#caseTime').textContent = fmtTime(c.createdAt);
    $('#caseTag').textContent = c.interrupted ? '已停止 · 不完整' : '历史记录';
    paintMd(elBody, c.analysis, true, { taskList: true });
    renderLint(c.lint || M.lintReport(c.analysis));
    renderCompare(c.compare);
    showFoot(true);
    $('#followList').innerHTML = (c.followups || []).map((f) => `
      <div class="follow-item">
        <p class="follow-q">${M.esc(f.q)}</p>
        <div class="follow-a">${M.renderMarkdown(f.a)}</div>
      </div>`).join('');
    elWrap.hidden = false;
    showView('ask');
    setTimeout(() => elWrap.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }

  /* ------------------------------------------------------------
     设置
     ------------------------------------------------------------ */
  const PRESETS = {
    deepseek: { endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
    reasoner: { endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-reasoner' },
    openai: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
    moonshot: { endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
    custom: { endpoint: '', model: '' },
  };

  function openSettings() {
    $('#cfgEndpoint').value = settings.endpoint || '';
    $('#cfgModel').value = settings.model || '';
    $('#cfgKey').value = settings.key || '';
    const dlg = $('#settingsDialog');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => $('#cfgEndpoint').focus(), 60);
  }

  function closeSettings() {
    const dlg = $('#settingsDialog');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  $('#openSettings').addEventListener('click', openSettings);
  $('#cancelSettings').addEventListener('click', closeSettings);

  $('#saveSettings').addEventListener('click', () => {
    settings = {
      endpoint: $('#cfgEndpoint').value.trim(),
      model: $('#cfgModel').value.trim(),
      key: $('#cfgKey').value.trim(),
    };
    if (!/^https?:\/\//.test(settings.endpoint)) {
      alert('接口地址要以 http:// 或 https:// 开头');
      return;
    }
    saveSettings();
    closeSettings();
    updateEngineHint();
  });

  $$('.chip[data-preset]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const p = PRESETS[chip.dataset.preset];
      $$('.chip[data-preset]').forEach((c) => c.classList.remove('is-on'));
      chip.classList.add('is-on');
      if (chip.dataset.preset !== 'custom') {
        $('#cfgEndpoint').value = p.endpoint;
        $('#cfgModel').value = p.model;
        $('#cfgKey').focus();
      }
    });
  });

  function hintError(msg) {
    const hint = $('#engineHint');
    if (!hint) return;
    hint.innerHTML = '';
    hint.textContent = msg;
    hint.style.color = 'var(--zhu)';
  }

  function updateEngineHint() {
    const hint = $('#engineHint');
    const foot = $('#footEngine');
    if (!hint) return;
    hint.style.color = '';
    const suffix = skillVersion ? ' · 方法 v' + skillVersion : '';

    if (configured()) {
      hint.innerHTML = '';
      hint.textContent = '模型：' + settings.model;
      if (foot && !foot.classList.contains('is-warn')) foot.textContent = '当前模型 ' + settings.model + suffix;
    } else {
      hint.innerHTML = '还没配置模型，<button type="button" id="hintCfg">先填一个 Key</button>';
      const b = $('#hintCfg');
      if (b) b.addEventListener('click', openSettings);
      if (foot && !foot.classList.contains('is-warn')) foot.textContent = '未配置模型' + suffix;
    }
  }

  /* ------------------------------------------------------------
     表单
     ------------------------------------------------------------ */
  const elQuestion = $('#question');
  const elCharCount = $('#charCount');

  function syncCharCount() {
    if (!elCharCount) return;
    const n = elQuestion.value.length;
    elCharCount.textContent = n + ' / 2000';
    elCharCount.classList.toggle('is-near', n > 1600);
  }
  elQuestion.addEventListener('input', syncCharCount);
  syncCharCount();

  $('#askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#question').value.trim();
    if (q.length < 6) {
      alert('说具体一点：至少写清楚碰到了什么事。');
      $('#question').focus();
      return;
    }
    if (!configured()) { openSettings(); return; }
    const extra = {
      role: $('#role').value.trim(),
      limit: $('#limit').value.trim(),
      tried: $('#tried').value.trim(),
    };
    runAnalysis(q, extra);
  });

  // Ctrl / Cmd + Enter 提交（问题框与追问框都支持）
  $$('#question, #followInput').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        el.closest('form').requestSubmit();
      }
    });
  });

  $('#followForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#followInput').value.trim();
    if (!v) return;
    if (!configured()) { openSettings(); return; }
    $('#followInput').value = '';
    runFollowup(v);
  });

  $('#newBtn').addEventListener('click', () => {
    if (abortCtrl) { ignoreStream = true; abortCtrl.abort(); abortCtrl = null; setBusy(false); }
    elWrap.hidden = true;
    current = null;
    $('#question').value = '';
    $('#followList').innerHTML = '';
    renderLint([]);
    renderCompare(null);
    updateTaskProgress();
    showFoot(false);
    showView('ask');
    $('#question').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  ['#stopBtn', '#followStop'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('click', stopStream);
  });

  $('#reBtn').addEventListener('click', openReDialog);
  $('#reCancel').addEventListener('click', closeReDialog);
  $('#reSubmit').addEventListener('click', submitReanalyse);

  const printBtn = $('#printBtn');
  if (printBtn) printBtn.addEventListener('click', () => window.print());

  $('#copyBtn').addEventListener('click', async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.analysis);
      flash($('#copyBtn'), '已复制');
    } catch (e) {
      alert('复制失败，可以手动选中文本。');
    }
  });

  function taskLines() {
    if (!current) return [];
    const out = [];
    const tasks = current.tasks || {};
    Object.keys(tasks).sort((a, b) => Number(a) - Number(b)).forEach((k) => {
      const t = tasks[k];
      const bits = [`- [${t.done ? 'x' : ' '}] 第 ${Number(k) + 1} 步`];
      if (t.due) bits.push(`（验证日 ${t.due}）`);
      if (t.result) bits.push(` —— 实际：${t.result}`);
      if (t.gap) bits.push(`（${gapWords(t.gap)}）`);
      out.push(bits.join(''));
    });

    const checks = current.checks || {};
    Object.keys(checks)
      .sort((a, b) => Number(String(a).replace(/\D/g, '')) - Number(String(b).replace(/\D/g, '')))
      .forEach((k, i) => {
        const ck = checks[k];
        if (!ck || (!ck.done && !ck.answer)) return;
        out.push(`- [${ck.done ? 'x' : ' '}] 核实第 ${i + 1} 条${ck.answer ? ' —— ' + ck.answer : ''}`);
      });
    return out;
  }

  $('#exportBtn').addEventListener('click', () => {
    if (!current) return;
    const md = [
      '# ' + current.question,
      recapText(current).includes('（') ? '> ' + recapText(current).split('\n')[1] : '',
      '',
      current.analysis,
      '',
      ...(current.followups || []).map((f) => `---\n\n**追问：** ${f.q}\n\n${f.a}`),
      '',
      taskLines().length ? '## 行动与核实进度\n' + taskLines().join('\n') + '\n' : '',
      `> 由「矛盾分析室」按《矛盾论》方法生成 · ${fmtTime(current.createdAt)}`,
    ].filter((x) => x !== null).join('\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '矛盾分析-' + fmtTime(current.createdAt).replace(/[: ]/g, '-') + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });

  function flash(el, text) {
    const old = el.textContent;
    el.textContent = text;
    setTimeout(() => { el.textContent = old; }, 1400);
  }

  /* ------------------------------------------------------------
     示例：正文不再塞在代码里，改去 assets/demo.md
     ------------------------------------------------------------ */
  const DEMO_QUESTION = '我在现在的岗位干了五年，事情越来越杂，向上走却看不到位置；想走，又怕外面行情差。到底是该熬还是该走？';
  const DEMO_EXTRA = {
    role: '部门里资历最老的一线主管，直接向总监汇报',
    limit: '三个月内必须有结果；不能脱产；有房贷',
    tried: '跟总监提过一次晋升，被以「再沉淀」挡回；投过两家公司，都卡在终面',
  };
  let demoMd = null;

  async function loadDemo() {
    if (demoMd) return demoMd;
    const res = await fetch('./assets/demo.md', { cache: 'no-cache' });
    if (!res.ok) throw new Error('读不到示例文件 assets/demo.md');
    demoMd = await res.text();
    return demoMd;
  }

  $('#demoBtn').addEventListener('click', async () => {
    let text;
    try {
      text = await loadDemo();
    } catch (e) {
      alert(e.message);
      return;
    }

    if (abortCtrl) { ignoreStream = true; abortCtrl.abort(); abortCtrl = null; setBusy(false); }

    current = {
      id: 'c_demo_' + Date.now().toString(36),
      question: DEMO_QUESTION,
      extra: DEMO_EXTRA,
      analysis: '',
      followups: [],
      tasks: {},
      createdAt: new Date().toISOString(),
      demo: true,
    };
    $('#questionRecap').textContent = recapText(current);
    $('#caseTime').textContent = fmtTime(current.createdAt);
    $('#caseTag').textContent = '示例 · 未调用模型';
    $('#followList').innerHTML = '';
    renderLint([]);
    renderCompare(null);
    showFoot(false);
    updateTaskProgress();
    elWrap.hidden = false;
    elWrap.scrollIntoView({ behavior: 'auto', block: 'start' });

    let i = 0;
    elBody.innerHTML = '';
    const step = () => {
      i = Math.min(text.length, i + 26);
      paintMd(elBody, text.slice(0, i), true, { taskList: true });
      if (i < text.length) {
        elBody.insertAdjacentHTML('beforeend', '<span class="caret"></span>');
        setTimeout(step, 12);
      } else {
        current.analysis = text;
        current.lint = M.lintReport(text);
        current.taskTotal = $$('input.task-box', elBody).length;
        showFoot(true);
        renderLint(current.lint);
        updateTaskProgress();
      }
    };
    step();
  });

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */
  updateEngineHint();
  renderCaseList();

  // 上次没跑完的草稿：给一个捞回来的入口，而不是默默丢掉
  const draft = loadDraft();
  const bar = $('#resumeBar');
  if (draft && bar) {
    const mins = Math.max(1, Math.round((Date.now() - (draft.at || Date.now())) / 60000));
    $('#resumeText').textContent = `上次的拆解没跑完（${mins} 分钟前）：${draft.question.slice(0, 28)}${draft.question.length > 28 ? '…' : ''}`;
    bar.hidden = false;
    $('#resumeBtn').addEventListener('click', () => {
      current = Object.assign({ followups: [], tasks: {} }, draft);
      $('#questionRecap').textContent = recapText(current);
      $('#caseTime').textContent = fmtTime(current.createdAt);
      $('#caseTag').textContent = '草稿 · 可能不完整';
      paintMd(elBody, draft.analysis, true, { taskList: true });
      renderLint(M.lintReport(draft.analysis));
      showFoot(true);
      elWrap.hidden = false;
      bar.hidden = true;
      elWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#resumeDrop').addEventListener('click', () => {
      clearDraft();
      bar.hidden = true;
    });
  }

  // 预热提示词，顺便把版本与来源暴露到页脚
  ensurePrompts()
    .then((p) => {
      const foot = $('#footEngine');
      if (foot) foot.title = '提示词来源：' + (p.skillDir || '') + (p.version ? '\n方法版本 v' + p.version : '');
      updateEngineHint();
    })
    .catch((e) => hintError(e.message));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && abortCtrl) stopStream();
  });

  document.addEventListener('beforeunload', (e) => {
    if (!abortCtrl) return;
    saveDraft(null);
    e.preventDefault();
    e.returnValue = '';
  });

  const params = new URLSearchParams(location.search);
  if (params.get('demo') === '1') {
    setTimeout(() => $('#demoBtn').click(), 260);
  } else if (location.hash === '#method') {
    showView('method');
  }
})();
