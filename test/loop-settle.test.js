'use strict';
/** 引擎级: 6 人连续多局, 每局 settle 后全员 ready 必须自动开局 (确定性验证) */
const assert = require('assert');
const { GameRoom } = require('../src/game');
const settle = ms => new Promise(r => setTimeout(r, ms));

async function playToShowdown(room) {
  let guard = 0;
  while (room.state !== 'showdown' && guard++ < 300) {
    const cur = room.currentPlayerId;
    if (!cur) break;
    const p = room.playersById.get(cur);
    if (!p) break;
    const toCall = room.currentBet - p.bet;
    const r = room.doAction(p.socketId, toCall > 0 ? (p.chips >= toCall ? 'call' : 'allin') : 'check');
    if (!r.ok) break;
  }
  return room.state === 'showdown';
}

(async () => {
  const N = 6, GAMES = 10;
  console.log(`== 引擎级: ${N} 人 × ${GAMES} 局, settle 自动开局确定性 ==`);
  let ok = 0, fail = 0;
  for (let g = 0; g < GAMES; g++) {
    const room = new GameRoom('T' + g, { seats: N });
    const ps = [];
    for (let i = 0; i < N; i++) { const p = room.addPlayer('s' + i, 'P' + i); p.chips = 1000; ps.push(p); }
    const total = N * 1000;
    // 第 1 手: waiting → tryStart
    const first = room.tryStart();
    assert.ok(first.ok, `第${g}局第1手无法开局: ${first.msg}`);
    for (let rnd = 1; rnd <= 3; rnd++) {
      const roundBefore = room.round;
      const reached = await playToShowdown(room);
      assert.ok(reached, `第${g}局第${rnd}手未能到达摊牌, state=${room.state}`);
      // 等 finishHand 的 2.8s + 2.5s 两个阶段 → settle
      await settle(6500);
      assert.strictEqual(room.state, 'settle', `第${g}局第${rnd}手结算后应为 settle, 实际 ${room.state}`);
      // 输光者借钱 (最后一手不进入下一局, 跳过确认)
      if (rnd < 3) {
        for (const p of ps) { if (p.chips <= 0) { const r = room.buyIn(p.socketId, 1000); assert.ok(r.ok, `借钱失败: ${r.msg}`); } }
        // 全员确认 → 应自动开局
        for (const p of ps) { const r = room.setReady(p.socketId); assert.ok(r.ok, `确认失败: ${r.msg}`); }
        await settle(300);
        assert.strictEqual(room.state, 'preflop', `第${g}局第${rnd + 1}手应自动开局, 实际 ${room.state}`);
        assert.strictEqual(room.round, roundBefore + 1, `round 应+1`);
      }
    }
    const sum = ps.reduce((s, p) => s + p.chips, 0);
    assert.strictEqual(sum, total, `第${g}局筹码不守恒: ${sum} != ${total}`);
    ok++;
    console.log(`  ✓ 第 ${g} 局: 3 手完成, 筹码守恒 ${sum}`);
  }
  console.log(`\n结果: ${ok} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
// 注意: GameRoom 内可能有未清的 45s 行动定时器, 需要显式退出
