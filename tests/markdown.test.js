const test = require('node:test');
const assert = require('node:assert');
const md = require('../assets/markdown.js');

test('嵌套列表不会被拍平', () => {
  const src = [
    '- 已知：五年未晋升。',
    '- 待核实：',
    '  1. 有没有一件由你主导的事。',
    '  2. 终面被拒的具体理由。',
    '',
    '## 下一段',
    '正文。',
  ].join('\n');

  const html = md.renderMarkdown(src, false);
  // 「待核实」会被术语标记包成 chip，但子列表必须嵌在同一个 li 里
  assert.ok(
    html.includes('<ol><li>有没有一件由你主导的事。</li><li>终面被拒的具体理由。</li></ol></li></ul>'),
    html
  );
  // 嵌套列表要闭合，后面的标题还在
  assert.match(html, /<\/ul>\s*<h2>下一段<\/h2>/);
});

test('三级嵌套也能闭合', () => {
  const src = [
    '1. 第一层',
    '   - 第二层',
    '     1. 第三层',
    '2. 回到第一层',
  ].join('\n');
  const html = md.renderMarkdown(src, false);
  assert.match(html, /<ol><li>第一层<ul><li>第二层<ol><li>第三层<\/li><\/ol><\/li><\/ul><\/li><li>回到第一层<\/li><\/ol>/);
});

test('列表结束后接普通段落', () => {
  const html = md.renderMarkdown('- a\n- b\n\n收尾的一句话。', false);
  assert.match(html, /<\/ul>\s*<p>收尾的一句话。<\/p>/);
});

test('同级换符号会开新列表', () => {
  const html = md.renderMarkdown('- a\n1. b', false);
  assert.match(html, /<\/ul>\s*<ol><li>b<\/li><\/ol>/);
});

test('表格生成五列结构', () => {
  const src = [
    '| 矛盾 | 对立的两方 | 性质 | 当前态势 | 主次 |',
    '| --- | --- | --- | --- | --- |',
    '| A | 甲/乙 | 非对抗性 | 胶着 | 主要 |',
  ].join('\n');
  const html = md.renderMarkdown(src, false);
  assert.equal((html.match(/<th>/g) || []).length, 5);
  assert.match(html, /<td>A<\/td>/);
});

test('行动段的三步变成可勾选项，其他段落不变', () => {
  const src = [
    '## 行动',
    '1. **本周把事列成表** —— 检验标准：能一句话说清。',
    '2. **拿三件事去面两家** —— 检验标准：拿到一个报价。',
    '',
    '## 可能的误判',
    '- 把忙当成有价值。',
  ].join('\n');
  const html = md.renderMarkdown(src, true, { taskList: true });
  assert.equal((html.match(/data-task="/g) || []).length, 2);
  assert.match(html, /data-task="0"/);
  assert.match(html, /data-task="1"/);
  // 「可能的误判」里的列表不该带勾选框
  assert.equal((html.match(/task-box/g) || []).length, 2);
});

test('用户内容不会变成 HTML', () => {
  const html = md.renderMarkdown('<img src=x onerror=alert(1)>', false);
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img/);
});

test('extractSection 只取本段，遇到下一个二级标题停下', () => {
  const src = '## 判断\n三句话。\n\n## 事实清点\n- 已知：x';
  assert.equal(md.extractSection(src, '判断'), '三句话。');
  assert.match(md.extractSection(src, '事实清点'), /已知/);
});

const FULL = [
  '## 判断', '真正的卡点是证据不足。', '',
  '## 事实清点', '- 已知：五年未晋升。', '- 待核实：', '  1. 查记录。', '  2. 问 HR。', '',
  '## 矛盾清单',
  '| 矛盾 | 对立的两方 | 性质 | 当前态势 | 主次 |',
  '| --- | --- | --- | --- | --- |',
  '| A | 甲/乙 | 非对抗性 | 胶着 | 主要 |',
  '| B | 丙/丁 | 非对抗性 | 走弱 | 次要 |',
  '| C | 戊/己 | 待判 | 未知 | 待定 |', '',
  '## 主要矛盾', '暂定 A，它牵动着 B、C 两条。', '',
  '## 主要方面', '甲占主导，两方被沉没成本绑在一起，谁也离不开。', '',
  '## 阶段', '处在量变积累的末尾，出现报价这个信号时该回来重看。', '',
  '## 内因与外因', '- 内因（你能改变的）：默认接受分工。', '- 外因（你只能应对的）：没有空位。', '',
  '## 转化条件', '拿得出一件可验证的事；若三个月内还没有，说明判断错了。', '',
  '## 行动',
  '1. **本周列表** —— 检验标准：能一句话说清。',
  '2. **面试** —— 检验标准：拿到一个报价。',
  '3. **再决策** —— 检验标准：三个月内拿到 offer。',
  '维持最低限度运转、不能因此丢掉的：手上那几件杂事。',
  '最坏情况：三个月白耗，收入不变，损失可承受。', '',
  '## 可能的误判', '- 把忙当成有价值。',
].join('\n');

test('结构完整的报告没有 error 级问题', () => {
  const issues = md.lintReport(FULL);
  assert.equal(issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(issues));
});

test('方法缺失能查出来：不判性质、不说依存点、第一步没时限、没算最坏', () => {
  const poor = FULL
    .replace(/非对抗性/g, '待判')
    .replace('甲占主导，两方被沉没成本绑在一起，谁也离不开。', '甲占主导，且在增强。')
    .replace('1. **本周列表**', '1. **列表**')
    .replace('最坏情况：三个月白耗，收入不变，损失可承受。', '');
  const text = md.lintReport(poor).map((i) => i.text).join('|');
  assert.match(text, /没判「性质」/);
  assert.match(text, /靠什么绑在一起/);
  assert.match(text, /几天内做完/);
  assert.match(text, /最坏/);
});

test('写得齐的报告不会误报方法缺失', () => {
  const text = md.lintReport(FULL).map((i) => i.text).join('|');
  assert.ok(!/没判「性质」|靠什么绑在一起|几天内做完|没写最坏/.test(text), text);
});

test('缺段、缺检验标准、缺最低限度运转都能查出来', () => {
  const issues = md.lintReport('## 判断\n就一句话。\n\n## 行动\n1. 做点什么。');
  const text = issues.map((i) => i.text).join('|');
  assert.match(text, /缺了这几段/);
  assert.match(text, /没给检验标准/);
  assert.match(text, /最低限度运转/);
});

test('矛盾清单条数越界会提示', () => {
  const twoRows = FULL.replace(/\| C \| 戊\/己 \| 待判 \| 未知 \| 待定 \|/, '');
  assert.match(md.lintReport(twoRows).map((i) => i.text).join('|'), /列了 2 条/);
});

test('sectionMeta 认得简写与全称', () => {
  assert.equal(md.sectionMeta('判断', 0).key, 'judge');
  assert.equal(md.sectionMeta('事实清点：', 0).key, 'facts');
  assert.equal(md.sectionMeta('内因与外因', 0).key, 'cause');
  assert.equal(md.sectionMeta('别的东西', 0).key, 'other');
});
