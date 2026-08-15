'use strict';
/** 引擎自测: 验证牌型评估与完整对局 */
const assert = require('assert');
const { evaluateBest, compareScore, createDeck } = require('../src/poker');
const { GameRoom } = require('../src/game');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' → ' + e.message); }
}

// ===== 牌型评估测试 =====
const c = (r, s) => ({ rank: r, suit: s });

console.log('\n== 牌型评估 ==');
t('皇家同花顺 > 同花顺', () => {
  const a = evaluateBest([c(14,0),c(13,0),c(12,0),c(11,0),c(10,0)]);
  const b = evaluateBest([c(9,0),c(8,0),c(7,0),c(6,0),c(5,0)]);
  assert.strictEqual(a.name, '同花顺');
  assert.ok(compareScore(a.score, b.score) > 0);
});
t('四条 > 葫芦', () => {
  const a = evaluateBest([c(9,0),c(9,1),c(9,2),c(9,3),c(2,0)]);
  const b = evaluateBest([c(8,0),c(8,1),c(8,2),c(3,0),c(3,1)]);
  assert.strictEqual(a.name, '四条');
  assert.ok(compareScore(a.score, b.score) > 0);
});
t('A2345 是最小顺子', () => {
  const a = evaluateBest([c(14,0),c(2,1),c(3,2),c(4,3),c(5,0)]);
  const b = evaluateBest([c(2,0),c(3,1),c(4,2),c(5,3),c(6,0)]);
  assert.strictEqual(a.name, '顺子');
  assert.ok(compareScore(a.score, b.score) < 0);
});
t('两对比一对', () => {
  const a = evaluateBest([c(10,0),c(10,1),c(7,0),c(7,1),c(2,0)]);
  const b = evaluateBest([c(14,0),c(14,1),c(3,0),c(4,1),c(5,0)]);
  assert.strictEqual(a.name, '两对');
  assert.ok(compareScore(a.score, b.score) > 0);
});
t('同点一对比踢脚', () => {
  const a = evaluateBest([c(10,0),c(10,1),c(9,0),c(8,1),c(7,0)]);
  const b = evaluateBest([c(10,2),c(10,3),c(9,1),c(8,2),c(6,0)]);
  assert.ok(compareScore(a.score, b.score) > 0);
});
t('7 选 5 取最优', () => {
  const a = evaluateBest([c(14,0),c(13,0),c(12,0),c(11,0),c(10,0),c(2,1),c(3,1)]);
  assert.strictEqual(a.name, '同花顺');
  assert.strictEqual(a.cards.length, 5);
});

// ===== 对局测试 =====
console.log('\n== 对局流程 ==');
function makeRoom(n) {
  const room = new GameRoom('TEST', { seats: n });
  const sockets = [];
  for (let i = 0; i < n; i++) {
    const p = room.addPlayer('sock' + i, 'P' + i);
    sockets.push(p.socketId);
    p.chips = 1000;
  }
  return { room, sockets };
}

t('2 人对局完整流程', () => {
  const { room, sockets } = makeRoom(2);
  room.tryStart();
  assert.strictEqual(room.state, 'preflop');
  // 玩家行动: 走完所有轮
  let guard = 0;
  while (room.state !== 'showdown' && guard++ < 100) {
    const cur = room.currentPlayerId;
    if (!cur) break;
    const p = room.playersById.get(cur);
    const toCall = room.currentBet - p.bet;
    if (toCall > 0 && p.chips >= toCall) {
      room.doAction(p.socketId, 'call');
    } else if (toCall > 0) {
      room.doAction(p.socketId, 'allin');
    } else {
      room.doAction(p.socketId, 'check');
    }
  }
  assert.ok(room.state === 'showdown', '最终应到摊牌, 实际: ' + room.state);
  assert.ok(room.actionLog.length > 0);
  console.log('    日志: ' + room.actionLog.slice(-3).map(l => l.text).join(' | '));
});

t('弃牌后单挑结束', () => {
  const { room, sockets } = makeRoom(3);
  room.tryStart();
  let guard = 0;
  while (room.state !== 'showdown' && guard++ < 100) {
    const cur = room.currentPlayerId;
    if (!cur) break;
    const p = room.playersById.get(cur);
    // 第一个人弃牌
    room.doAction(p.socketId, 'fold');
    // 剩下的人 check/call 到底
    break; // 弃牌后 should finish
  }
  // 弃牌后应只剩 2 人继续, 继续走完
  let g2 = 0;
  while (room.state !== 'showdown' && g2++ < 100) {
    const cur = room.currentPlayerId;
    if (!cur) break;
    const p = room.playersById.get(cur);
    const toCall = room.currentBet - p.bet;
    room.doAction(p.socketId, toCall > 0 ? 'call' : 'check');
  }
  assert.ok(room.state === 'showdown');
});

t('加注与跟注', () => {
  const { room, sockets } = makeRoom(2);
  room.tryStart();
  const cur = room.currentPlayerId;
  const p = room.playersById.get(cur);
  const bb = room.bb;
  const r = room.doAction(p.socketId, 'raise', bb * 4);
  assert.ok(r.ok, r.msg);
  assert.strictEqual(p.bet, bb * 4);
  const next = room.currentPlayerId;
  const p2 = room.playersById.get(next);
  const r2 = room.doAction(p2.socketId, 'call');
  assert.ok(r2.ok, r2.msg);
});

t('非法操作被拒绝', () => {
  const { room, sockets } = makeRoom(2);
  room.tryStart();
  const cur = room.currentPlayerId;
  const p = room.playersById.get(cur);
  // 错误玩家操作
  const other = sockets.find(s => s !== p.socketId);
  const r = room.doAction(other, 'fold');
  assert.ok(!r.ok, '非当前玩家应被拒绝');
  // 非法加注
  const r2 = room.doAction(p.socketId, 'raise', room.currentBet);
  assert.ok(!r2.ok, '加注需大于当前注');
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
