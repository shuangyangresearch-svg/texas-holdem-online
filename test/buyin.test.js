'use strict';
/** 复现: 输光后买筹码全链路 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));
const emitAck = (s, ev, d = {}) => new Promise(r => s.emit(ev, d, r));

async function client() {
  return new Promise((res, rej) => {
    const s = io(URL, { transports: ['polling'] });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
}

async function main() {
  console.log('== 复现: 输光后买筹码 ==');
  const a = await client();
  const b = await client();
  const latest = { a: null, b: null };
  a.on('room:state:me', s => latest.a = s);
  b.on('room:state:me', s => latest.b = s);

  const created = await emitAck(a, 'room:create', { name: '有钱A', seats: 2 });
  await emitAck(b, 'room:join', { roomId: created.roomId, name: '破产B' });
  console.log('✓ 两人入座');

  // 让 B 一开始筹码极少, 模拟破产边缘
  // (通过服务器无法直接改筹码, 只能打一局输光; 但为快速复现, 这里先验证 buyin 的事件链路)

  // 直接测试: B 模拟 chips=0 后点买筹码 (正常玩家是打牌输光的)
  const st = latest.b;
  console.log('B 当前筹码:', st.you ? st.you.chips : '?');

  // 先测试一个更直接的问题: 两个人都准备好, 看看 B 破产时能否开局
  await emitAck(a, 'player:ready');
  await emitAck(b, 'player:ready');
  const startR = await emitAck(a, 'game:start');
  console.log('开局尝试:', JSON.stringify(startR));

  // 打一局: B 全下输光
  let guard = 0;
  while (guard++ < 40) {
    const cur = latest.a;
    if (!cur || cur.state === 'showdown') break;
    const idx = cur.players.findIndex(p => p && p.id === cur.currentPlayerId);
    if (idx < 0) break;
    const sock = idx === 0 ? a : b;
    const me = cur.players[idx];
    const toCall = cur.currentBet - me.bet;
    // B 全下, A 跟注
    const action = me.name === '破产B' ? 'allin' : (toCall > 0 ? 'call' : 'check');
    const r = await emitAck(sock, 'game:action', { action, amount: 0 });
    if (!r.ok && action === 'allin') {
      await emitAck(sock, 'game:action', { action: toCall > 0 ? 'call' : 'check' });
    }
    await delay(150);
  }
  console.log('✓ 对局结束, 等待结算...');
  await delay(9000);

  const after = latest.b;
  const bChips = after && after.you ? after.you.chips : '?';
  console.log('B 结算后筹码:', bChips);
  console.log('B 状态:', after ? after.state : '?');

  if (after && after.state === 'waiting' && bChips === 0) {
    // B 买筹码
    const buyR = await emitAck(b, 'player:buyin', { amount: 1000 });
    console.log('B 点买筹码返回:', JSON.stringify(buyR));
    await delay(500);
    const afterBuy = latest.b;
    console.log('B 买后筹码:', afterBuy.you.chips, '| 欠款:', afterBuy.you.debt);
    if (afterBuy.you.chips !== 1000) {
      console.error('BUG: 买筹码后筹码未变 1000!');
      process.exit(1);
    }
    console.log('✓ 买筹码成功');
  } else {
    console.log('注: B 未处于可买入状态 (chips=' + bChips + ', state=' + (after && after.state) + ')');
    console.log('这说明前端 buyin-bar 显示条件与服务端 buyIn 条件可能有出入');
    // 即使有筹码, 也测一下 buyIn 的返回
    const buyR2 = await emitAck(b, 'player:buyin', { amount: 1000 });
    console.log('B 点买筹码返回:', JSON.stringify(buyR2));
  }

  a.close(); b.close();
  console.log('== 复现结束 ==');
  process.exit(0);
}
main().catch(e => { console.error('错误:', e.message); process.exit(1); });
