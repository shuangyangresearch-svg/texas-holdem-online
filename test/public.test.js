'use strict';
/** 公网穿透验证: 通过公网 URL 跑 2 人完整对局 */
const { io } = require('socket.io-client');
const URL = process.argv[2] || 'https://minneapolis-webmaster-pcs-glory.trycloudflare.com';
const delay = ms => new Promise(r => setTimeout(r, ms));
const emitAck = (s, ev, d = {}) => new Promise(r => s.emit(ev, d, r));

async function main() {
  console.log(`测试公网: ${URL}`);
  const a = await new Promise((res, rej) => { const s = io(URL, { transports: ['websocket', 'polling'], timeout: 30000 }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
  const b = await new Promise((res, rej) => { const s = io(URL, { transports: ['websocket', 'polling'], timeout: 30000 }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
  console.log('✓ 公网 WebSocket 连接成功');

  const latest = { a: null, b: null };
  a.on('room:state:me', s => latest.a = s);
  b.on('room:state:me', s => latest.b = s);

  const created = await emitAck(a, 'room:create', { name: '公网A', seats: 2 });
  if (!created.ok) throw new Error('建房失败: ' + created.msg);
  const jr = await emitAck(b, 'room:join', { roomId: created.roomId, name: '公网B' });
  if (!jr.ok) throw new Error('加入失败: ' + jr.msg);
  console.log(`✓ 公网建房/加入成功 (${created.roomId})`);

  await emitAck(a, 'player:ready'); await emitAck(b, 'player:ready');
  const st = await emitAck(a, 'game:start');
  if (!st.ok) throw new Error('开局失败: ' + st.msg);
  await delay(600);
  console.log('✓ 公网开局成功');

  let guard = 0;
  while (guard++ < 40) {
    const cur = latest.a;
    if (!cur) { await delay(200); continue; }
    if (cur.state === 'showdown') break;
    const idx = cur.players.findIndex(p => p && p.id === cur.currentPlayerId);
    if (idx < 0) break;
    const sock = idx === 0 ? a : b;
    const me = cur.players[idx];
    const toCall = cur.currentBet - me.bet;
    await emitAck(sock, 'game:action', { action: toCall > 0 ? 'call' : 'check' });
    await delay(300);
  }
  await delay(6000);
  const fin = latest.a;
  console.log('✓ 公网完整对局完成: ' + (fin && fin.lastWinnerText));
  const total = fin.players.filter(p => p).reduce((s, p) => s + p.chips, 0);
  if (total !== 2000) throw new Error('公网对局筹码不守恒: ' + total);
  console.log('✓ 公网筹码守恒: ' + total);
  a.close(); b.close();
  console.log('== 公网穿透验证通过 ==');
  process.exit(0);
}
main().catch(e => { console.error('公网验证失败:', e.message); process.exit(1); });
