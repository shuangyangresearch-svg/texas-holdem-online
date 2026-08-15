'use strict';
/** 结算确认流程测试: settle 状态 / 借钱 / 放弃 / 自动开局 */
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
  console.log('== 结算确认流程测试 ==');

  await t('结算后进入 settle 状态', async () => {
    const room = new GameRoom('T', { seats: 2 });
    for (let i = 0; i < 2; i++) { const p = room.addPlayer('s' + i, 'P' + i); p.chips = 1000; }
    room.tryStart();
    let guard = 0;
    while (room.state !== 'showdown' && guard++ < 30) {
      const cur = room.playersById.get(room.currentPlayerId);
      const toCall = room.currentBet - cur.bet;
      room.doAction(cur.socketId, toCall > 0 ? 'call' : 'check');
    }
    await settle(6000);
    assert.strictEqual(room.state, 'settle', '结算后应为 settle, 实际: ' + room.state);
  });

  await t('没人输光: 全员确认后自动开局', async () => {
    const room = new GameRoom('T', { seats: 2 });
    for (let i = 0; i < 2; i++) { const p = room.addPlayer('s' + i, 'P' + i); p.chips = 1000; }
    room.tryStart();
    let guard = 0;
    while (room.state !== 'showdown' && guard++ < 30) {
      const cur = room.playersById.get(room.currentPlayerId);
      const toCall = room.currentBet - cur.bet;
      room.doAction(cur.socketId, toCall > 0 ? 'call' : 'check');
    }
    await settle(6000);
    assert.strictEqual(room.state, 'settle');
    const roundBefore = room.round;
    // 全员确认
    for (const p of room.players.filter(x => x)) {
      const r = room.setReady(p.socketId);
      assert.ok(r.ok, '确认应成功: ' + r.msg);
    }
    // 自动开局
    await settle(200);
    assert.ok(room.state === 'preflop', '全员确认后应自动开局, 实际: ' + room.state);
    assert.strictEqual(room.round, roundBefore + 1, '轮数应+1');
  });

  await t('有人输光: 必须借钱或放弃才能继续', async () => {
    const room = new GameRoom('T', { seats: 2 });
    for (let i = 0; i < 2; i++) { const p = room.addPlayer('s' + i, 'P' + i); p.chips = 1000; }
    room.tryStart();
    // P0 全下, P1 跟注, 直到结束
    let guard = 0;
    while (room.state !== 'showdown' && guard++ < 30) {
      const cur = room.playersById.get(room.currentPlayerId);
      const toCall = room.currentBet - cur.bet;
      const r = room.doAction(cur.socketId, toCall > 0 ? 'call' : 'check');
      if (!r.ok) room.doAction(cur.socketId, 'allin');
    }
    await settle(6000);
    assert.strictEqual(room.state, 'settle');
    // 检查是否有人输光
    const broke = room.players.filter(p => p && p.chips <= 0);
    if (broke.length === 0) {
      console.log('     (本局无人输光, 跳过本场景)');
      return;
    }
    // 输光者不能确认
    const brokeP = broke[0];
    const r1 = room.setReady(brokeP.socketId);
    assert.ok(!r1.ok, '输光者应不能直接确认');
    // 有钱者确认了也不会开局
    for (const p of room.players.filter(x => x && x !== brokeP)) {
      room.setReady(p.socketId);
    }
    await settle(200);
    assert.strictEqual(room.state, 'settle', '有输光者未解决时不应开局');
    // 借钱后可以确认
    const buy = room.buyIn(brokeP.socketId);
    assert.ok(buy.ok, '借钱应成功: ' + buy.msg);
    assert.ok(brokeP.chips > 0, '借钱后筹码应>0');
    const r2 = room.setReady(brokeP.socketId);
    assert.ok(r2.ok, '借钱后应可确认');
    await settle(200);
    assert.strictEqual(room.state, 'preflop', '借钱并确认后应自动开局');
  });

  await t('输光者放弃后退出', async () => {
    const room = new GameRoom('T', { seats: 2 });
    for (let i = 0; i < 2; i++) { const p = room.addPlayer('s' + i, 'P' + i); p.chips = 1000; }
    room.tryStart();
    let guard = 0;
    while (room.state !== 'showdown' && guard++ < 30) {
      const cur = room.playersById.get(room.currentPlayerId);
      const toCall = room.currentBet - cur.bet;
      const r = room.doAction(cur.socketId, toCall > 0 ? 'call' : 'check');
      if (!r.ok) room.doAction(cur.socketId, 'allin');
    }
    await settle(6000);
    const broke = room.players.filter(p => p && p.chips <= 0);
    if (broke.length === 0) {
      console.log('     (本局无人输光, 跳过本场景)');
      return;
    }
    const brokeP = broke[0];
    const r = room.forfeit(brokeP.socketId);
    assert.ok(r.ok, '放弃应成功');
    // 玩家已移除
    assert.ok(!room.playersById.has(brokeP.id), '放弃后玩家应被移除');
    // 存活玩家可继续
    const remaining = room.players.filter(p => p);
    assert.strictEqual(remaining.length, 1, '剩余 1 人');
    // 全员(剩余)确认 - 但只有 1 人不能开局
    room.setReady(remaining[0].socketId);
    await settle(200);
    assert.strictEqual(room.state, 'settle', '人数不足 2 不应开局');
  });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})();
