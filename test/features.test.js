'use strict';
/** 新功能/修复专项验证: 离线自动处理 + 买筹码欠款 */
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

(async () => {
  console.log('== 新功能专项验证 ==');

  await t('离线玩家轮到行动时自动弃牌, 不跳过', async () => {
    const room = new GameRoom('T', { seats: 3 });
    const ps = [];
    for (let i = 0; i < 3; i++) {
      const p = room.addPlayer('s' + i, 'P' + i);
      p.chips = 1000;
      ps.push(p);
    }
    // 开局前让 P0 离线: 3 人局 dealer=0, SB=1, BB=2, preflop 首行动者=BB下家=P0(庄家自己)
    ps[0].connected = false;
    room.tryStart();
    assert.ok(ps[0].folded, '离线玩家应被自动弃牌');
    assert.ok(room.actionLog.some(l => l.text.includes('自动')), '应出现自动处理日志');
    assert.ok(room.actionLog.some(l => l.text.includes('离线')), '日志应标注离线');
    // 对局应正常走完
    let g2 = 0;
    while (room.state !== 'showdown' && g2++ < 60) {
      const cur = room.currentPlayerId;
      if (!cur) break;
      const p = room.playersById.get(cur);
      const toCall = room.currentBet - p.bet;
      if (p.connected) {
        room.doAction(p.socketId, toCall > 0 ? 'call' : 'check');
      } else {
        break; // advanceTurn 内部自动处理
      }
    }
    assert.ok(room.state === 'showdown', '离线玩家应被自动弃牌, 对局走完');
    await settle(7600);
  });

  await t('买筹码 + 欠款记账', async () => {
    const room = new GameRoom('T', { seats: 2 });
    const p0 = room.addPlayer('s0', 'P0');
    const p1 = room.addPlayer('s1', 'P1');
    p0.chips = 1000; p1.chips = 1000;

    // P0 输光
    p0.chips = 0;
    const r1 = room.buyIn('s0');
    assert.ok(r1.ok, r1.msg);
    assert.strictEqual(p0.chips, 1000, '买入后应有 1000 筹码');
    assert.strictEqual(p0.debt, 1000, '欠款应记 1000');

    // 有筹码时不能买
    const r2 = room.buyIn('s0');
    assert.ok(!r2.ok, '有筹码时不应允许买入');

    // 状态透出 debt
    const st = room.toState();
    assert.strictEqual(st.players[0].debt, 1000);
    assert.ok(st.brokeCount === undefined || typeof st.brokeCount === 'number');
  });

  await t('筹码耗尽时禁止开局', async () => {
    const room = new GameRoom('T', { seats: 2 });
    const p0 = room.addPlayer('s0', 'P0');
    const p1 = room.addPlayer('s1', 'P1');
    p0.chips = 1000; p1.chips = 1000;
    p0.ready = true; p1.ready = true;
    // P1 输光
    p1.chips = 0;
    const r = room.tryStart();
    assert.ok(!r.ok, '有玩家筹码耗尽时应拒绝开局');
    assert.ok(r.msg.includes('买入'), '提示应包含买入');
    // 买入后可开局
    room.buyIn('s1');
    p0.ready = true; p1.ready = true;
    const r2 = room.tryStart();
    assert.ok(r2.ok, '买入后应能开局');
  });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})();
