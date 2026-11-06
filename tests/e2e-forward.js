/* 一次性端到端检查：假上游 → server.js 转发 → 客户端拿到的 SSE 内容 */
const http = require('node:http');
const { spawn } = require('node:child_process');

const mock = http.createServer((req, res) => {
  if (req.url.includes('abort')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '半句' } }] }) + '\n\n');
    setTimeout(() => res.destroy(), 80); // 模拟上游中途断流
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let i = 0;
  const t = setInterval(() => {
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '第' + i + '段；' } }] }) + '\n\n');
    if (++i >= 3) {
      clearInterval(t);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, 30);
});

mock.listen(4111, '127.0.0.1', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: '3998', MAODUN_ALLOW_PRIVATE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));

  const ready = () => new Promise((r) => setTimeout(r, 600));
  await ready();

  try {
    const res = await fetch('http://127.0.0.1:3998/api/analyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'http://127.0.0.1:4111/v1/chat/completions',
        apiKey: 'test-key',
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    console.log('status =', res.status, '| content-type =', res.headers.get('content-type'));
    const text = await res.text();
    console.log('收到帧数 =', (text.match(/^data: /gm) || []).length);
    console.log('内容 =', text.trim().slice(0, 160).replace(/\n/g, ' | '));

    // 上游中途断流：服务端不能崩，客户端要收到一条 error 帧
    const res2 = await fetch('http://127.0.0.1:3998/api/analyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'http://127.0.0.1:4111/abort',
        apiKey: 'x',
        model: 'm',
        messages: [],
      }),
    });
    const text2 = await res2.text();
    console.log('断流情形 status =', res2.status, '| 收到 =', text2.trim().replace(/\n/g, ' | ').slice(0, 160));

    // 断流之后进程还活着吗
    const alive = await fetch('http://127.0.0.1:3998/api/prompts');
    console.log('断流后服务仍在：', alive.status === 200);
  } catch (e) {
    console.log('请求失败：', e.message);
  } finally {
    child.kill();
    mock.close();
    setTimeout(() => process.exit(0), 200);
  }
});
