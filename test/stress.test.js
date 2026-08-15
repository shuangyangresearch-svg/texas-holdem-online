'use strict';
/** 满桌压力测试: 6 人完整对局, 连续 3 局, 验证服务器稳定性 */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));

function client() {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['polling'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const emitAck = (s, ev, data = {}) => new Promise(r => s.emit(ev, data, r));

async function main() {
  console.log('== 满桌压力测试: 6 人 × 3 局 ==');
  const sockets = [];
  for (let i = 0; i < 6; i++) sockets.push(await client());
  console.log('✓ 6 客户端已连接');

  const latest = sockets.map(() => null);
  sockets.forEach((s, i) => s.on('room:state:me', st => { latest[i] = st; }));

  const created = await emitAck(sockets[0], 'room:create', { name: '玩家0', seats: 6 });
  if (!created.ok) throw new Error('建房失败');
  const roomId = created.roomId;

  for (let i = 1; i < 6; i++) {
    const r = await emitAck(sockets[i], 'room:join', { roomId, name: '玩家' + i });
    if (!r.ok) throw new Error(`玩家${i}加入失败: ${r.msg}`);
  }
  console.log(`✓ 6 人全部入座, 房间 ${roomId}`);

  for (const s of sockets) await emitAck(s, 'player:ready');
  const started = await emitAck(sockets[0], 'game:start');
  if (!started.ok) throw new Error('开局失败: ' + started.msg);
  console.log('✓ 第 1 局开始');

  // 打 3 局
  for (let round = 1; round <= 3; round++) {
    // 等到开局状态 (preflop)
    let st = latest[0];
    let wait = 0;
    while ((!st || st.state === 'waiting' || st.round < round) && wait++ < 100) {
      await delay(200);
      st = latest[0];
    }
    if (!st) throw new Error('无状态');

    // 行动直到本局结束
    let guard = 0;
    let lastRound = st.round;
    while (guard++ < 200) {
      const cur = latest[0];
      if (!cur) break;
      if (cur.round !== lastRound) break; // 进入下一局了
      if (cur.state === 'showdown') {
        await delay(1000);
        break;
      }
      const actorIdx = cur.players.findIndex(p => p && p.id === cur.currentPlayerId);
      if (actorIdx < 0) break;
      const me = cur.players[actorIdx];
      const toCall = cur.currentBet - me.bet;
      let action = 'check', amount = 0;
      if (toCall > 0) {
        if (me.chips > toCall * 3 && Math.random() > 0.5) { action = 'raise'; amount = cur.currentBet + cur.bb * 2; }
        else if (Math.random() > 0.3) action = 'call';
        else action = 'fold';
      } else if (Math.random() > 0.85) {
        action = 'raise'; amount = cur.currentBet + cur.bb * 2;
      }
      const r = await emitAck(sockets[actorIdx], 'game:action', { action, amount });
      if (!r.ok && action === 'raise') {
        await emitAck(sockets[actorIdx], 'game:action', { action: toCall > 0 ? 'call' : 'check' });
      }
      await delay(80);
    }

    // 等待结算完成
    await delay(8000);
    const fin = latest[0];
    const total = fin.players.filter(p => p).reduce((s2, p) => s2 + p.chips, 0);
    console.log(`✓ 第 ${round} 局完成 | 底池 ${fin.pot} | 结果: ${fin.lastWinnerText}`);
    if (total !== 6000) throw new Error(`第${round}局筹码不守恒: ${total} != 6000`);

    // 等待下一局: settle 全员确认后服务器自动开局
    if (round < 3) {
      await delay(1000); // 进入 settle 确认阶段
      // 输光者必须先借钱, 否则 ready 会被服务器拒绝, 无法进入下一局
      const st = latest[0];
      if (st && st.players) {
        for (let i = 0; i < sockets.length; i++) {
          const pl = st.players[i];
          if (pl && pl.chips <= 0) await emitAck(sockets[i], 'player:buyin', { amount: 1000 });
        }
      }
      for (const s of sockets) await emitAck(s, 'player:ready'); // 全员确认
      // 等自动进入下一局 (round 变化)
      let wait = 0;
      const r0 = latest[0] ? latest[0].round : 0;
      while (wait++ < 40) {
        await delay(200);
        if (latest[0] && latest[0].round > r0) break;
      }
      if (!(latest[0] && latest[0].round > r0)) throw new Error(`第${round + 1}局未能自动开始`);
      console.log(`✓ 第 ${round + 1} 局开始`);
    }
  }

  console.log('== 满桌压力测试通过 ==');
  sockets.forEach(s => s.close());
  process.exit(0);
}

main().catch(e => {
  console.error('压力测试失败:', e.message);
  process.exit(1);
});
