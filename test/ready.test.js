'use strict';
/** 准备按钮流程验证 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));
const emitAck = (s, ev, d = {}) => new Promise(r => s.emit(ev, d, r));

async function main() {
  console.log('== 准备流程验证 ==');
  const a = await new Promise((res, rej) => { const s = io(URL, { transports: ['polling'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
  const b = await new Promise((res, rej) => { const s = io(URL, { transports: ['polling'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });

  const latestA = {}, latestB = {};
  a.on('room:state:me', s => latestA.s = s);
  b.on('room:state:me', s => latestB.s = s);

  const created = await emitAck(a, 'room:create', { name: '甲', seats: 2 });
  await emitAck(b, 'room:join', { roomId: created.roomId, name: '乙' });
  await delay(300);

  // 玩家B 点一次准备
  const r1 = await emitAck(b, 'player:ready');
  await delay(300);
  const st1 = latestB.s;
  const bReady1 = st1.players[st1.you.seat].ready;
  console.log('点1次准备后 B ready = ' + bReady1);
  if (!bReady1) throw new Error('BUG: 点1次准备应变为已准备');

  // 再点一次 = 取消
  await emitAck(b, 'player:ready');
  await delay(300);
  const st2 = latestB.s;
  const bReady2 = st2.players[st2.you.seat].ready;
  console.log('再点1次准备后 B ready = ' + bReady2);
  if (bReady2) throw new Error('BUG: 第二次应取消准备');

  // 重新准备, A也准备, 房主开局
  await emitAck(b, 'player:ready');
  await emitAck(a, 'player:ready');
  await delay(300);
  const st3 = latestA.s;
  const allReady = st3.players.filter(p => p).every(p => p.ready);
  console.log('双方都准备: ' + allReady);
  if (!allReady) throw new Error('双方应都已准备');

  const started = await emitAck(a, 'game:start');
  console.log('开局返回: ' + JSON.stringify(started));
  if (!started.ok) throw new Error('开局失败: ' + started.msg);

  await delay(400);
  if (latestA.s.state !== 'preflop') throw new Error('应进入翻牌前, 实际: ' + latestA.s.state);
  console.log('✓ 开局成功进入翻牌前');
  a.close(); b.close();
  console.log('== 准备流程验证通过 ==');
  process.exit(0);
}
main().catch(e => { console.error('验证失败:', e.message); process.exit(1); });
