/**
 * 矛盾分析室 — 零依赖本地服务
 * 1) 托管静态文件（只开 index.html 与 assets/，提示词与笔记不对外）
 * 2) GET  /api/prompts  从 skills/contradiction-analysis 读取提示词（代码里不存提示词文本）
 * 3) POST /api/analyse  把模型请求转发出去（绕开浏览器跨域限制）
 *
 * 用户的 API Key 只在每次请求的 body 里透传，不写日志、不落盘。
 *
 * 安全边界：
 * - 默认只监听 127.0.0.1，局域网访问不到（要开给别的设备，显式设 MAODUN_HOST=0.0.0.0）
 * - /api/analyse 不当代练：默认拒绝指向私有网段/回环地址的 endpoint，
 *   防止有人拿它嗅探内网。要连本地模型（Ollama / LM Studio）就设 MAODUN_ALLOW_PRIVATE=1
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns').promises;
const { Readable } = require('node:stream');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.MAODUN_HOST || '127.0.0.1';
const ALLOW_PRIVATE = /^(1|true|yes)$/i.test(process.env.MAODUN_ALLOW_PRIVATE || '');

// 提示词独立成 skill 目录，与源码分离；可用环境变量指到别处
const SKILL_DIR = process.env.MAODUN_SKILL_DIR || path.join(ROOT, 'skills', 'contradiction-analysis');
const PROMPT_DIR = path.join(SKILL_DIR, 'references');

const MAX_BODY = 512 * 1024;
const CONNECT_TIMEOUT = 30_000; // 从发起到拿到响应头
const IDLE_TIMEOUT = 90_000;    // 流式期间两块数据之间的最长静默

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// 不对外托管的目录：提示词、项目记忆、依赖、测试
const BLOCKED_TOP = new Set(['skills', 'node_modules', 'tests', '.git']);

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...BASE_HEADERS,
  });
  res.end(body);
}

/* ---------- 提示词：从 skill 目录读取，每次请求都重读，改完刷新页面即生效 ---------- */
function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

function readPrompt(file) {
  return stripFrontmatter(fs.readFileSync(path.join(PROMPT_DIR, file), 'utf8'));
}

/** 版本号只在 SKILL.md 的 frontmatter 里维护一处，别的地方都从这里读 */
function readSkillVersion() {
  try {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return null;
    const v = fm[1].match(/^version:\s*(.+)$/m);
    return v ? v[1].trim() : null;
  } catch (e) {
    return null;
  }
}

/** 提示词里的一级小节标题，供前端校验 SECTION_MAP 是否还跟提示词对得上 */
function readPromptSections(promptText) {
  return promptText
    .split('\n')
    .map((line) => line.match(/^##\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
}

function handlePrompts(req, res) {
  try {
    const analysis = readPrompt('analysis-prompt.md');
    const followup = readPrompt('followup-prompt.md');
    sendJson(res, 200, {
      analysis,
      followup,
      sections: readPromptSections(analysis),
      skillDir: SKILL_DIR,
      version: readSkillVersion(),
    });
  } catch (e) {
    sendJson(res, 503, {
      message:
        '读不到提示词：' + PROMPT_DIR +
        '（把 skills/contradiction-analysis 放回工程根目录，或用 MAODUN_SKILL_DIR 指定位置）',
    });
  }
}

/* ---------- 静态文件 ---------- */
/** 把请求路径解析成磁盘路径；越界、隐藏目录、被禁目录一律返回 null */
function resolveStaticPath(pathname) {
  if (pathname.includes('\0')) return null;
  const joined = path.join(ROOT, path.normalize(pathname));
  const rel = path.relative(ROOT, joined);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const segs = rel.split(/[\\/]/);
  if (segs.some((s) => s.startsWith('.'))) return null; // .workbuddy / .git / 任何隐藏项
  if (BLOCKED_TOP.has(segs[0].toLowerCase())) return null;
  return joined;
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400, BASE_HEADERS).end('Bad Request');
    return;
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    res.writeHead(403, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      ETag: etag,
      ...BASE_HEADERS,
    };

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return;
    }

    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { if (!res.writableEnded) res.destroy(); });
    stream.pipe(res);
  });
}

/* ---------- endpoint 校验：别让这个转发接口变成内网探测器 ---------- */
const PRIVATE_HINT =
  '接口地址指向内网或本机，已被拒绝。要用本地模型（Ollama / LM Studio 等），' +
  '启动时加 MAODUN_ALLOW_PRIVATE=1。';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7));
  return false;
}

const dnsCache = new Map(); // host -> { at, list }

async function lookupHost(host) {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const list = await dns.lookup(host, { all: true });
  dnsCache.set(host, { at: Date.now(), list });
  return list;
}

async function assertEndpointAllowed(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('接口地址缺少主机名');
  if (ALLOW_PRIVATE) return;

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(PRIVATE_HINT);
    return;
  }
  if (/^(localhost|.*\.localhost)$/i.test(host)) throw new Error(PRIVATE_HINT);

  let list;
  try {
    list = await lookupHost(host);
  } catch (e) {
    throw new Error('域名解析不了：' + host + '（检查网络或地址有没有写错）');
  }
  if (list.some((a) => isPrivateIp(a.address))) throw new Error(PRIVATE_HINT);
}

/** 只接受同源或没有 Origin 的请求，挡住别的网页借用本机转发 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (e) {
    return false;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        const err = new Error('body too large');
        err.status = 413;
        req.pause();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); }
    });
    req.on('error', (e) => {
      if (!settled) { settled = true; reject(e); }
    });
  });
}

/* ---------- 转发 ---------- */
async function handleAnalyse(req, res) {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { message: '只接受本页面的请求' });
    return;
  }

  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch (e) {
    if (e.status === 413) {
      sendJson(res, 413, { message: '请求体太大（上限 512 KB）' });
      req.resume();
    } else {
      sendJson(res, 400, { message: '读取请求失败' });
    }
    return;
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch (e) {
    sendJson(res, 400, { message: '请求格式错误' });
    return;
  }

  const { endpoint, apiKey, model, messages, temperature } = body;

  if (!endpoint || !apiKey || !model || !Array.isArray(messages)) {
    sendJson(res, 400, { message: '缺少必要的参数（接口地址 / Key / 模型 / 消息）' });
    return;
  }

  let target;
  try {
    target = new URL(endpoint);
    if (!/^https?:$/.test(target.protocol)) throw new Error('protocol');
  } catch (e) {
    sendJson(res, 400, { message: '接口地址不是合法的 http/https 地址' });
    return;
  }

  try {
    await assertEndpointAllowed(target);
  } catch (e) {
    sendJson(res, 400, { message: e.message });
    return;
  }

  const controller = new AbortController();
  let idleFired = false;
  let timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT);
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => { idleFired = true; controller.abort(); }, ms);
  };
  let clientGone = false;

  // 客户端中途断开（如用户点了停止）才中止上游请求；
  // 注意要监听 res 而不是 req —— req 的 close 在请求体读完时就已触发。
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      clearTimeout(timer);
      controller.abort();
    }
  });

  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof temperature === 'number' ? temperature : 0.6,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (clientGone || res.writableEnded) return;
    if (controller.signal.aborted) {
      sendJson(res, 504, { message: `模型接口 ${CONNECT_TIMEOUT / 1000} 秒内没有响应，可能网络不通或地址不对` });
    } else {
      sendJson(res, 502, { message: '连不上模型接口：' + e.message });
    }
    return;
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    let detail = '';
    try {
      detail = (await upstream.text()).slice(0, 600);
      try {
        const j = JSON.parse(detail);
        detail = (j.error && j.error.message) || j.message || detail;
      } catch (e) { /* 保留原文 */ }
    } catch (e) { /* 忽略 */ }
    if (!res.writableEnded) {
      sendJson(res, upstream.status, { message: detail || `上游返回 ${upstream.status}` });
    }
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...BASE_HEADERS,
  });

  arm(IDLE_TIMEOUT);

  // 手动转流：既能每块重置空闲计时，也能在断流时把错误告诉前端，而不是让进程崩掉
  const fail = (message) => {
    if (!message || res.writableEnded || res.destroyed) return;
    try {
      res.write('data: ' + JSON.stringify({ error: { message } }) + '\n\n');
    } catch (e) { /* 连接已断 */ }
  };

  try {
    for await (const chunk of Readable.fromWeb(upstream.body)) {
      if (res.writableEnded || res.destroyed) break;
      res.write(chunk);
      arm(IDLE_TIMEOUT);
    }
  } catch (e) {
    if (clientGone) {
      // 用户点了停止或关了页面，不用再说别的
    } else if (idleFired) {
      fail(`上游 ${IDLE_TIMEOUT / 1000} 秒没有新数据，已中断。已收到的部分仍保留。`);
    } else {
      fail('上游连接中断（网络抖动或对方关了连接）。已收到的部分仍保留。');
    }
  } finally {
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  }
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (req.method === 'GET' && pathname === '/api/prompts') {
    handlePrompts(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/analyse') {
    handleAnalyse(req, res);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  const v = readSkillVersion();
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`矛盾分析室已启动： http://${shown}:${PORT}`);
  console.log(`  监听 ${HOST}:${PORT}${HOST === '0.0.0.0' ? '（局域网可访问，本机代理能力也一并暴露）' : '（仅本机）'}`);
  console.log(`  提示词 ${v ? 'v' + v + ' ' : ''}${SKILL_DIR}`);
  if (ALLOW_PRIVATE) console.log('  MAODUN_ALLOW_PRIVATE 已开启：允许转发到内网/本地模型');
});
