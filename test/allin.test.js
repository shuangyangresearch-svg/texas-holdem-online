'use strict';
/** all-in / 边池分配专项验证: 3人全下各种筹码组合
 *  核心断言: ①筹码守恒(总筹码不变) ②玩家筹码非负 ③底池清零 ④赢家筹码必然增加 */
const assert = require('assert');
const { GameRoom } = require('../src/game');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('  ✓ ' + name); })
    .catch(e => { fail++; console.error('  ✗ ' + name + ' → ' + e.message); });
}
const settle = ms => new Promise(r => setTimeout(r, ms));

/** 3 人全 all-in, 验证分配正确性 (随机牌, 任何结果都应符合守恒) */
async function runAllIn(chips, name) {
  const room = new GameRoom('T', { seats: 3 });
  const ps = [room.addPlayer('s0', '我'), room.addPlayer('s1', '甲'), room.addPlayer('s2', '乙')];
  ps[0].chips = chips[0]; ps[1].chips = chips[1]; ps[2].chips = chips[2];
  const total = chips[0] + chips[1] + chips[2];
  room.tryStart();
  let guard = 0;
  while (room.state !== 'showdown' && guard++ < 60) {
    const cur = room.currentPlayerId ? room.playersById.get(room.currentPlayerId) : null;
    if (cur) room.doAction(cur.socketId, 'allin');
    await settle(30);
  }
  await settle(4200); // 等 3s 分配延迟 + settle
  const after = ps.map(p => p.chips);
  const sum = after.reduce((a, b) => a + b, 0);
  // ① 筹码守恒: 总筹码不变
  assert.strictEqual(sum, total, `${name}: 筹码守恒失败 分配后 ${sum} != 初始 ${total} (${after.join('/')})`);
  // ② 每人筹码非负
  for (const c of after) assert.ok(c >= 0, `${name}: 出现负筹码 ${c}`);
  // ③ 底池清零
  assert.strictEqual(room.pot, 0, `${name}: 底池未清零 ${room.pot}`);
  // ④ 非全平局: 至少一人拿到主池的 1/2 以上 (平局时主池被平分)
  const minBet = Math.min(...chips);
  assert.ok(after.some(c => c >= minBet * 3 / 2), `${name}: 主池 ${minBet * 3} 分配异常 ${after.join('/')}`);
  return { after, total };
}

/** 断线移除场景: 3人各 all-in 100, 对局中移除一个玩家(断线), 底池 300 必须全部分给剩余玩家 */
async function runRemovedPlayer() {
  const room = new GameRoom('T', { seats: 3 });
  const me = room.addPlayer('s0', '我');
  const b1 = room.addPlayer('s1', '甲');
  const b2 = room.addPlayer('s2', '乙');
  me.chips = 100; b1.chips = 100; b2.chips = 100;
  room.tryStart();
  let guard = 0;
  while (room.state !== 'showdown' && guard++ < 60) {
    const cur = room.currentPlayerId ? room.playersById.get(room.currentPlayerId) : null;
    if (cur) room.doAction(cur.socketId, 'allin');
    await settle(30);
  }
  // 对局中移除一个玩家 (模拟断线超时被移除)
  room.removePlayer(b1.socketId);
  await settle(4200);
  // 底池 300 (3×100) 必须全部分给剩余玩家: 我 + 乙 = 300 (不蒸发)
  assert.strictEqual(me.chips + b2.chips, 300, `移除玩家后底池应全分配, 实际 我=${me.chips} 乙=${b2.chips} 合计=${me.chips + b2.chips}`);
  assert.strictEqual(room.orphanBets, 0, '残余注应清零');
  // 且赢家必须拿到主池 200 以上 (移除者的 100 应并入分配)
  assert.ok(Math.max(me.chips, b2.chips) >= 200, '赢家应拿到 ≥200 (主池+残余)');
}

(async () => {
  console.log('== all-in 边池分配验证 ==');
  await t('等额 1000/1000/1000', () => runAllIn([1000, 1000, 1000], '等额'));
  await t('我少 600/1000/1000', () => runAllIn([600, 1000, 1000], '我少'));
  await t('甲少 1000/600/1000', () => runAllIn([1000, 600, 1000], '甲少'));
  await t('三不等 500/1000/1500', () => runAllIn([500, 1000, 1500], '三不等'));
  await t('我最多 2000/1000/1000', () => runAllIn([2000, 1000, 1000], '我最多'));
  await t('极限 10/5/1', () => runAllIn([10, 5, 1], '极限'));
  await t('对局中移除玩家后结算守恒', runRemovedPlayer);
  console.log('');
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
