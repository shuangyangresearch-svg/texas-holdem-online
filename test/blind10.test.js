'use strict';
/** 默认盲注 20/10 + 加注 10 倍数 端到端验证 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));
const client = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['polling'] });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const emitAck = (s, ev, d = {}) => new Promise(r => s.emit(ev, d, r));

(async () => {
  console.log('== 默认盲注与 10 倍数加注验证 ==');
  const a = await client();
  const b = await client();
  let st = null;
  a.on('room:state:me', s => { st = s; });

  // 建房不传盲注 → 默认 20/10
  const created = await emitAck(a, 'room:create', { name: 'A' });
  await emitAck(b, 'room:join', { roomId: created.roomId, name: 'B' });
  await emitAck(a, 'player:ready');
  await emitAck(b, 'player:ready');
  await emitAck(a, 'game:start');
  await delay(400);
  console.log(`  1) 默认盲注: sb=${st.sb} bb=${st.bb} ${st.sb === 10 && st.bb === 20 ? '✓' : '✗'}`);

  // 轮到我(或B)行动时, 非 10 倍数加注被拒
  let guard = 0;
  while ((!st || !st.you || st.you.id !== st.currentPlayerId) && guard++ < 60) { await delay(150); }
  const me = st.you;
  const toCall = Math.max(0, st.currentBet - me.bet);
  const bad = await emitAck(a, 'game:action', { action: 'raise', amount: toCall + 15 });
  console.log(`  2) 非 10 倍数加注被拒: ${!bad.ok ? '✓ (' + bad.msg + ')' : '✗'}`);
  const good = await emitAck(a, 'game:action', { action: 'raise', amount: st.currentBet + st.bb * 2 });
  console.log(`  3) 10 倍数加注成功: ${good.ok ? '✓' : '✗ ' + good.msg}`);
  a.close(); b.close();
  console.log('== 验证完成 ==');
  process.exit(0);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
