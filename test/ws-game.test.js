'use strict';
/** WebSocket 传输下完整 2 人对局 + 结算, 验证 WS 不丢事件 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));
const client = (transports) => new Promise((res, rej) => {
  const s = io(URL, { transports, reconnection: false, timeout: 15000 });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const emitAck = (s, ev, d = {}) => new Promise(r => s.emit(ev, d, r));

(async () => {
  const tr = process.env.TRANSPORT || 'websocket';
  console.log(`== WS 完整对局测试 (transport=${tr}) ==`);
  const a = await client([tr]);
  const b = await client([tr]);
  const latest = { a: null, b: null };
  a.on('room:state:me', s => latest.a = s);
  b.on('room:state:me', s => latest.b = s);

  const created = await emitAck(a, 'room:create', { name: 'WSA', sb: 5, bb: 10 });
  await emitAck(b, 'room:join', { roomId: created.roomId, name: 'WSB' });
  await emitAck(a, 'player:ready');
  await emitAck(b, 'player:ready');
  const st = await emitAck(a, 'game:start');
  if (!st.ok) throw new Error('开局失败: ' + st.msg);

  let guard = 0;
  while (guard++ < 80) {
    const cur = latest.a;
    if (!cur) { await delay(100); continue; }
    if (cur.state === 'showdown') break;
    const idx = cur.players.findIndex(p => p && p.id === cur.currentPlayerId);
    if (idx < 0) break;
    const sock = idx === 0 ? a : b;
    const me = cur.players[idx];
    const toCall = cur.currentBet - me.bet;
    const r = await emitAck(sock, 'game:action', { action: toCall > 0 ? 'call' : 'check' });
    if (!r.ok) break;
    await delay(80);
  }
  console.log(`  对局结束 state=${latest.a && latest.a.state} 结果: ${latest.a && latest.a.lastWinnerText}`);
  await delay(6500);
  const fin = latest.a;
  const total = fin.players.filter(p => p).reduce((s, p) => s + p.chips, 0);
  console.log(`  结算后 state=${fin.state} 筹码守恒=${total === 2000 ? '✓' : '✗ ' + total}`);
  a.close(); b.close();
  if (total !== 2000) process.exit(1);
  console.log('== WS 完整对局通过 ==');
  process.exit(0);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
