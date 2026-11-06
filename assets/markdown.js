/* ============================================================
   矛盾分析室 — Markdown 渲染与报告质检
   纯字符串处理，不碰 DOM，可单独跑测试（node --test tests/）。
   ============================================================ */
const MaodunMd = (function () {
  'use strict';

  /* ------------------------------------------------------------
     十段结构：与 skills/contradiction-analysis/references/analysis-prompt.md 的
     二级标题一一对应。改提示词结构时，这里和样式里的 .is-* 一起改；
     页面启动时会拿 /api/prompts 返回的 sections 做一次对齐校验。
     ------------------------------------------------------------ */
  const SECTION_MAP = [
    { key: 'judge',   title: '判断',       n: '1',  tag: '结论' },
    { key: 'facts',   title: '事实清点',   n: '2',  tag: '调查' },
    { key: 'list',    title: '矛盾清单',   n: '3',  tag: '图景' },
    { key: 'main',    title: '主要矛盾',   n: '4',  tag: '抓主' },
    { key: 'aspect',  title: '主要方面',   n: '5',  tag: '主次' },
    { key: 'stage',   title: '阶段',       n: '6',  tag: '病程' },
    { key: 'cause',   title: '内因与外因', n: '7',  tag: '内外' },
    { key: 'cond',    title: '转化条件',   n: '8',  tag: '条件' },
    { key: 'action',  title: '行动',       n: '9',  tag: '实践' },
    { key: 'misread', title: '可能的误判', n: '10', tag: '校验' },
  ];

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(s) {
    let out = esc(s);
    // 方法术语标记：让「内因 / 外因」「检验标准」「已知 / 待核实」在长文里能被一眼扫到
    out = out.replace(/内因(?:（[^）]*）)?\s*[：:]/g, '<span class="pole pole-in">内因</span>');
    out = out.replace(/外因(?:（[^）]*）)?\s*[：:]/g, '<span class="pole pole-out">外因</span>');
    out = out.replace(/(已知|待核实)\s*[：:]/g, '<span class="hint-chip">$1</span>');
    out = out.replace(/——\s*检验标准\s*[：:]/g, '<span class="std">检验标准</span>');
    out = out.replace(/检验标准\s*[：:]/g, '<span class="std">检验标准</span>');
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out;
  }

  function sectionMeta(text, index) {
    const t = String(text).replace(/[\s，。、：:；;（）()《》「」“”"'']/g, '');
    const hit =
      SECTION_MAP.find((s) => s.title === t) ||
      SECTION_MAP.find((s) => t.length >= 2 && s.title.startsWith(t)) ||
      SECTION_MAP.find((s) => t.startsWith(s.title));
    return hit
      ? { key: hit.key, n: hit.n, tag: hit.tag, cls: ' is-' + hit.key }
      : { key: 'other', n: String(index + 1), tag: '', cls: '' };
  }

  /* ------------------------------------------------------------
     列表：按缩进递归，支持任意层级嵌套
     （提示词里的「- 待核实：」下面接 1./2./3. 就靠这个才不会被拍平）
     ------------------------------------------------------------ */
  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function matchList(line) {
    const m = line.match(LIST_RE);
    if (!m) return null;
    return {
      indent: m[1].replace(/\t/g, '  ').length,
      ordered: /^\d/.test(m[2]),
      text: m[3],
    };
  }

  function isBlockStart(line) {
    return /^(#{1,4}\s|\s*>|\s*\|)/.test(line) || /^\s*(---+|\*\*\*+|___+)\s*$/.test(line);
  }

  function renderList(items, tag, ctx) {
    const lis = items.map((it) => {
      const body = inline(it.text) + it.extra;
      if (ctx.tasks && tag === 'ol') {
        const idx = ctx.counter.n++;
        return '<li class="task"><label class="task-line">' +
          `<input type="checkbox" class="task-box" data-task="${idx}">` +
          `<span class="task-text">${body}</span></label></li>`;
      }
      return `<li>${body}</li>`;
    }).join('');
    return `<${tag}>${lis}</${tag}>`;
  }

  /** 从 lines[start] 起解析一个列表；返回 [html, 下一行索引] */
  function parseList(lines, start, ctx) {
    const first = matchList(lines[start]);
    const baseIndent = first.indent;
    const tag = first.ordered ? 'ol' : 'ul';
    const items = [];
    let cur = null;
    let i = start;

    while (i < lines.length) {
      const line = lines[i];

      // 空行：后面还接着这个列表就继续，否则列表到此为止
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nx = j < lines.length ? matchList(lines[j]) : null;
        if (nx && nx.indent >= baseIndent) { i = j; continue; }
        break;
      }

      const m = matchList(line);
      if (m) {
        if (m.indent < baseIndent) break;
        if (m.indent === baseIndent) {
          if (m.ordered !== first.ordered) break; // 同级换符号 → 交给外层另开一个列表
          cur = { text: m.text, extra: '' };
          items.push(cur);
          i++;
          continue;
        }
        // 更深一层：嵌进当前项
        if (cur) {
          const [sub, next] = parseList(lines, i, { ...ctx, tasks: false, nested: true });
          cur.extra += sub;
          i = next;
          continue;
        }
      }

      // 续行（缩进文本或没被别的块认领的普通行），接到当前项
      if (cur && line.trim() && !isBlockStart(line)) {
        cur.text += ' ' + line.trim();
        i++;
        continue;
      }
      break;
    }

    return [renderList(items, tag, ctx), i];
  }

  /* ------------------------------------------------------------
     表格
     ------------------------------------------------------------ */
  function splitRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  function renderTable(header, rows) {
    const th = header.map((h) => `<th>${inline(h)}</th>`).join('');
    const body = rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('');
    return '<p class="table-hint">窄屏只露出一部分，左右滑动看全表</p>' +
      `<div class="table-wrap"><div class="table-scroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div></div>`;
  }

  /* ------------------------------------------------------------
     主渲染
     ------------------------------------------------------------ */
  function renderMarkdown(md, withSteps, opts) {
    const options = opts || {};
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let secOpen = false;
    let secIndex = 0;
    let curKey = '';
    const taskCtx = { tasks: Boolean(options.taskList), counter: { n: 0 }, nested: false };

    const closeSec = () => { if (secOpen) { out.push('</div></section>'); secOpen = false; } };

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      // 表格
      const next = lines[i + 1] || '';
      if (/^\s*\|/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next)) {
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        out.push(renderTable(header, rows));
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const lv = Math.min(h[1].length, 3);
        const text = h[2].trim();
        if (withSteps && lv === 2) {
          closeSec();
          const meta = sectionMeta(text, secIndex++);
          curKey = meta.key;
          taskCtx.counter.n = 0;
          out.push(
            `<section class="step${meta.cls}" data-k="${meta.key}">` +
            `<header class="step-head"><span class="step-n">${meta.n}</span>` +
            `<h2>${inline(text)}</h2>` +
            (meta.tag ? `<span class="step-tag">${meta.tag}</span>` : '') +
            `</header><div class="step-body">`
          );
          secOpen = true;
        } else {
          out.push(`<h${lv}>${inline(text)}</h${lv}>`);
        }
        i++; continue;
      }

      // 分隔线
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { out.push('<hr />'); i++; continue; }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
        continue;
      }

      // 列表（含嵌套；这里遇到的一定是新列表块的第一行）
      if (matchList(line)) {
        const ctx = { ...taskCtx, tasks: taskCtx.tasks && curKey === 'action' };
        const [html, nextIdx] = parseList(lines, i, ctx);
        out.push(html);
        i = nextIdx;
        continue;
      }

      // 段落
      const para = [line.trim()];
      i++;
      while (
        i < lines.length && lines[i].trim() &&
        !/^(#{1,4}\s|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*>|\s*\|)/.test(lines[i]) &&
        !/^\s*(---+|\*\*\*+|___+)\s*$/.test(lines[i])
      ) { para.push(lines[i].trim()); i++; }
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }

    closeSec();
    return out.join('\n');
  }

  /* ------------------------------------------------------------
     段落抽取：对照两次分析时，只取变化最关键的几段
     ------------------------------------------------------------ */
  function extractSection(md, title) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex((l) => {
      const m = l.match(/^##\s+(.+?)\s*$/);
      return m && (m[1] === title || sectionMeta(m[1], 0).key === sectionMeta(title, 0).key);
    });
    if (start < 0) return '';
    const buf = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,2}\s+/.test(lines[i])) break;
      buf.push(lines[i]);
    }
    return buf.join('\n').trim();
  }

  function countCJK(md) {
    const m = String(md || '').match(/[\u4e00-\u9fa5]/g);
    return m ? m.length : 0;
  }

  function countTableRows(md, sectionTitle) {
    const sec = extractSection(md, sectionTitle);
    if (!sec) return 0;
    return sec.split('\n').filter((l) => /^\s*\|/.test(l)).length - 2; // 去掉表头与分隔行
  }

  /* ------------------------------------------------------------
     报告质检：模型跑偏的地方，用规则兜住
     ------------------------------------------------------------ */
  function lintReport(md) {
    const text = String(md || '');
    const issues = [];
    const headings = text.split('\n')
      .map((l) => l.match(/^##\s+(.+?)\s*$/))
      .filter(Boolean)
      .map((m) => m[1]);

    if (!headings.length) return issues;

    const keys = headings.map((h) => sectionMeta(h, 0).key);
    const missing = SECTION_MAP.filter((s) => !keys.includes(s.key));
    if (missing.length) {
      issues.push({ level: 'error', text: '缺了这几段：' + missing.map((s) => s.title).join('、') });
    }

    const present = keys.filter((k) => k !== 'other');
    const expected = SECTION_MAP.map((s) => s.key).filter((k) => present.includes(k));
    if (present.join(',') !== expected.join(',')) {
      issues.push({ level: 'warn', text: '小节顺序和规定的不一样，推理链条被打断了' });
    }

    if (keys.includes('list')) {
      const rows = countTableRows(text, '矛盾清单');
      if (rows && (rows < 3 || rows > 5)) {
        issues.push({ level: 'warn', text: `矛盾清单列了 ${rows} 条，规定 3-5 条` });
      }
    }

    // 形式之外，还要查方法：判了没有依据，等于没判
    if (keys.includes('list') && !/对抗/.test(extractSection(text, '矛盾清单'))) {
      issues.push({ level: 'warn', text: '矛盾清单没判「性质」——对抗性还是非对抗性没分，能不能谈就定不下来' });
    }

    const aspect = extractSection(text, '主要方面');
    if (aspect && !/绑|依存|离不开|统一体|互为/.test(aspect)) {
      issues.push({ level: 'warn', text: '「主要方面」没写两方靠什么绑在一起——切割的代价落在谁身上就说不清' });
    }

    const action = extractSection(text, '行动');
    if (action) {
      if (!/检验标准/.test(action)) {
        issues.push({ level: 'error', text: '「行动」段没给检验标准，这些动作没法验证对错' });
      }
      const steps = (action.match(/^\s*\d+[.)]\s+/gm) || []).length;
      if (steps && steps < 3) {
        issues.push({ level: 'warn', text: `「行动」只给了 ${steps} 步，规定三步` });
      }
      const firstMatch = action.match(/(^|\n)\s*1[.)][\s\S]*?(?=\n\s*2[.)]\s|$)/);
      const first = firstMatch ? firstMatch[0] : '';
      if (first && !/48\s*小时|[一两三几]天|本周|今天|明天|当天|一周内/.test(first)) {
        issues.push({ level: 'warn', text: '第一步没写清几天内做完——没有时限的那一步，通常永远不会开始' });
      }
    }

    if (!/最低限度运转|不能因此丢掉/.test(text)) {
      issues.push({ level: 'warn', text: '没写「哪些事要维持最低限度运转」——抓主要矛盾不等于把别的全丢' });
    }

    if (!/最坏/.test(text)) {
      issues.push({ level: 'warn', text: '没写最坏会坏到什么程度——方案缺了下限，一遇到意外就散' });
    }

    const cond = extractSection(text, '转化条件');
    if (cond && !/\d|若|如果|一旦|谁|之前|之后/.test(cond)) {
      issues.push({ level: 'info', text: '「转化条件」看不出可被第三方观察的痕迹，容易写成空话' });
    }

    const stage = extractSection(text, '阶段');
    if (stage && !/(量变|转折|阶段)/.test(stage)) {
      issues.push({ level: 'warn', text: '「阶段」段没判处在哪个阶段，攻守就没有依据' });
    }

    const words = countCJK(text);
    if (words && (words < 900 || words > 2200)) {
      issues.push({ level: 'info', text: `正文约 ${words} 字，规定 1100-1600 字` });
    }

    return issues;
  }

  return {
    esc,
    inline,
    SECTION_MAP,
    sectionMeta,
    renderMarkdown,
    extractSection,
    countCJK,
    lintReport,
  };
})();

if (typeof module === 'object' && module.exports) module.exports = MaodunMd;
if (typeof window !== 'undefined') window.MaodunMd = MaodunMd;
