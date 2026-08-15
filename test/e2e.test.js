'use strict';
/** 端到端联调: 3 个真实 Socket.IO 客户端走完一整局 */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['polling'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function emitAck(s, ev, data = {}) {
  return new Promise(resolve => s.emit(ev, data, resolve));
}

function R(c) {
  const rk = [0, 0, '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  return rk[c.rank] + ['♠', '♥', '♦', '♣'][c.suit];
}

async function main() {
  console.log('== 端到端联调开始 ==');
  const a = await client('A');
  const b = await client('B');
  const c = await client('C');
  console.log('✓ 3 个客户端已连接');

  // 持续监听: 保存每个客户端看到的最新状态
  const latest = { a: null, b: null, c: null };
  a.on('room:state:me', s => { latest.a = s; });
  b.on('room:state:me', s => { latest.b = s; });
  c.on('room:state:me', s => { latest.c = s; });

  const created = await emitAck(a, 'room:create', { name: '小明', sb: 5, bb: 10, seats: 3 });
  if (!created.ok) throw new Error('创建失败: ' + created.msg);
  const roomId = created.roomId;
  console.log(`✓ 创建房间 ${roomId}`);

  const bj = await emitAck(b, 'room:join', { roomId, name: '小红' });
  const cj = await emitAck(c, 'room:join', { roomId, name: '小刚' });
  if (!bj.ok || !cj.ok) throw new Error('加入失败');
  console.log('✓ B/C 已加入');

  await emitAck(a, 'player:ready');
  await emitAck(b, 'player:ready');
  await emitAck(c, 'player:ready');
  console.log('✓ 全部准备');

  const started = await emitAck(a, 'game:start');
  if (!started.ok) throw new Error('开局失败: ' + started.msg);
  await delay(500);

  const meA = latest.a;
  if (!meA || !meA.you || meA.you.cards.length !== 2) throw new Error('A 未收到 2 张手牌');
  console.log(`✓ 开局成功, A 手牌: ${meA.you.cards.map(R).join(', ')}`);

  // 行动循环: 轮询最新状态直到摊牌
  const sockets = [a, b, c];
  const names = ['小明', '小红', '小刚'];
  let guard = 0;
  let lastActionCount = -1;

  while (guard++ < 80) {
    const st = latest.a;
    if (!st) { await delay(150); continue; }
    if (st.state === 'showdown') break;

    // 找到当前行动玩家
    const actorIdx = st.players.findIndex(p => p && p.id === st.currentPlayerId);
    if (actorIdx < 0) break;
    const actor = sockets[actorIdx];
    const me = st.players[actorIdx];
    const toCall = st.currentBet - me.bet;

    let action = 'check', amount = 0;
    if (toCall > 0) {
      if (me.chips > toCall * 3) { action = 'raise'; amount = st.currentBet + st.bb * 2; }
      else action = 'call';
    }
    const r = await emitAck(actor, 'game:action', { action, amount });
    if (!r.ok) {
      await emitAck(actor, 'game:action', { action: toCall > 0 ? 'call' : 'check' });
    }
    console.log(`   ${names[actorIdx]} 行动: ${action}${amount ? '→' + amount : ''} [阶段: ${st.stageName}]`);
    await delay(200);
  }

  const showState = latest.a;
  if (!showState || showState.state !== 'showdown') throw new Error('未能走到摊牌阶段');
  console.log('✓ 到达摊牌阶段, 公共牌: ' + showState.community.map(R).join(' '));

  await delay(5000);
  const finalState = latest.a;
  if (!finalState) throw new Error('未收到结算状态');
  console.log('✓ 结算完成');
  console.log('   底池: ' + finalState.pot);
  console.log('   结果: ' + (finalState.lastWinnerText || ''));
  console.log('   筹码: ' + finalState.players.filter(p => p).map(p => `${p.name}=${p.chips}`).join(', '));

  const total = finalState.players.filter(p => p).reduce((s, p) => s + p.chips, 0);
  if (total !== 3000) throw new Error(`筹码不守恒: ${total} != 3000`);
  console.log('✓ 筹码守恒校验通过');

  a.close(); b.close(); c.close();
  console.log('== 联调全部通过 ==');
  process.exit(0);
}

main().catch(e => {
  console.error('联调失败:', e.message);
  process.exit(1);
});
