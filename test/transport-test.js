'use strict';
/** 传输测试: 本地/隧道 × polling/websocket, 测连接建立与往返延迟 */
const { io } = require('socket.io-client');

const URLS = {
  '本地': 'http://localhost:3000',
  '隧道': process.env.TUNNEL_URL || 'https://bottle-wisdom-loading-graduate.trycloudflare.com'
};
const delay = ms => new Promise(r => setTimeout(r, ms));

function connect(url, transports, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = io(url, { transports, reconnection: false, timeout: 20000 });
    let done = false;
    const fin = (ok, extra) => { if (!done) { done = true; resolve({ ok, ms: Date.now() - t0, extra, s }); } };
    s.on('connect', () => {
      // 连接后测一次往返 ack
      const t1 = Date.now();
      s.emit('rooms:list', {}, () => {
        fin(true, `ack ${Date.now() - t1}ms`);
      });
    });
    s.on('connect_error', e => fin(false, e.message));
    setTimeout(() => fin(false, 'timeout'), 25000);
  });
}

async function main() {
  const only = process.argv[2] || 'all'; // all | local | tunnel
  for (const [name, url] of Object.entries(URLS)) {
    if (only === 'local' && name === '隧道') continue;
    if (only === 'tunnel' && name === '本地') continue;
    console.log(`\n== ${name} ${url} ==`);
    for (const tr of [['polling'], ['websocket'], ['polling', 'websocket']]) {
      const r = await connect(url, tr, name);
      const label = tr.join('→');
      if (r.ok) {
        console.log(`  ✓ [${label}] 连接+ack ${r.ms}ms (${r.extra})`);
        r.s.close();
      } else {
        console.log(`  ✗ [${label}] 失败: ${r.extra}`);
      }
      await delay(300);
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
