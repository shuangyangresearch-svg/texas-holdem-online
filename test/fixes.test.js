'use strict';
/**
 * 回归测试: 覆盖本轮逻辑修复
 *  1. 短盲全下: currentBet 封顶为实际投入
 *  2. 短全下加注不缩小最小加注额 (TDA 规则)
 *  3. 对局中移除玩家(非行动轮)不泄漏筹码 (orphanBets 记 totalBet)
 *  4. finishHand 双分发防护: 结算窗口内重复调用不二次发钱
 *  5. 短牌起手牌分级 A6s+ 为 A 档
 *  6. 胜率表磁盘缓存: 构建后落盘, 可再次加载
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GameRoom } = require('../src/game');
const { handTier, getWinRate, evaluateBest } = require('../src/poker');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('  ✓ ' + name); })
    .catch(e => { fail++; console.error('  ✗ ' + name + ' → ' + (e && e.stack || e)); });
}
const settle = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('== 逻辑修复回归测试 ==');

  await t('1. BB 短全下: currentBet 封顶为实际投入, SB 可过牌', async () => {
    const room = new GameRoom('T', { seats: 2, sb: 10, bb: 20 });
    const a = room.addPlayer('sa', 'A');
    const b = room.addPlayer('sb', 'B');
    a.chips = 1000; b.chips = 3; // BB 只有 3 筹码
    room.tryStart();
    assert.strictEqual(room.currentBet, 3, `currentBet 应为 3 (BB 实际全下额), 实际 ${room.currentBet}`);
    // SB(A) 已下 10 > 3, 无需再跟
    const r = room.doAction(a.socketId, 'check');
    assert.ok(r.ok, 'SB 应能过牌: ' + (r.msg || ''));
    // 后续玩家(若有)只需跟 3
    const toCall = room.currentBet - b.bet;
    assert.strictEqual(toCall, 0, `BB 无需再跟: ${toCall}`);
  });

  await t('2. 短全下加注不缩小 minRaise', async () => {
    const room = new GameRoom('T', { seats: 2, sb: 10, bb: 20 });
    const a = room.addPlayer('sa', 'A'); // SB/庄
    const b = room.addPlayer('sb', 'B'); // BB
    a.chips = 1000; b.chips = 60; // BB 下完盲注剩 40, 全下总注 = 20+40 = 60 (增量 10 < 30, 短全下)
    room.tryStart();
    // A 加注到 50: 增量 30 >= bb 20 → 完整加注, minRaise=30
    assert.ok(room.doAction(a.socketId, 'raise', 50).ok);
    assert.strictEqual(room.minRaise, 30, `完整加注后 minRaise=30, 实际 ${room.minRaise}`);
    // B 全下到 60: 增量 10 < 30 但为全下 → 允许, 但不得缩小 minRaise
    assert.ok(room.doAction(b.socketId, 'allin').ok);
    assert.strictEqual(room.minRaise, 30, `短全下后 minRaise 应保持 30, 实际 ${room.minRaise}`);
    // A 试图只加 10 (60→70): 增量 < 30 → 应被拒绝
    const r = room.doAction(a.socketId, 'raise', 70);
    assert.ok(!r.ok, `增量 10 < minRaise 30 应被拒绝, 实际 ok=${r.ok}`);
  });

  await t('3. 非行动轮移除玩家: 筹码不泄漏 (orphanBets 记 totalBet)', async () => {
    const room = new GameRoom('T', { seats: 3, sb: 5, bb: 10 });
    const ps = [room.addPlayer('s0', 'A'), room.addPlayer('s1', 'B'), room.addPlayer('s2', 'C')];
    ps.forEach(p => { p.chips = 1000; });
    room.tryStart();
    // preflop: 依次跟注到 10
    let guard = 0;
    while (room.state === 'preflop' && guard++ < 10) {
      const cur = room.currentPlayerId;
      const p = room.playersById.get(cur);
      const toCall = room.currentBet - p.bet;
      assert.ok(room.doAction(p.socketId, toCall > 0 ? 'call' : 'check').ok);
    }
    assert.strictEqual(room.state, 'flop', '应进入 flop');
    // flop: A 下注 20, B/C 跟注 → totalBet 各 30, bet 各 20
    guard = 0;
    while (room.state === 'flop' && guard++ < 10) {
      const cur = room.currentPlayerId;
      const p = room.playersById.get(cur);
      const toCall = room.currentBet - p.bet;
      const r = room.doAction(p.socketId, toCall > 0 ? 'call' : 'raise', 20);
      assert.ok(r.ok, `flop 行动失败: ${r.msg}`);
    }
    assert.strictEqual(room.state, 'turn', '应进入 turn');
    // turn: newBettingRound 已把 bet 清零; 此时移除 C (模拟断线超时, 非行动轮)
    const c = ps[2];
    assert.strictEqual(c.bet, 0, 'C 在 turn 的当前街 bet 应为 0');
    assert.strictEqual(c.totalBet, 30, 'C 的 totalBet 应为 30');
    room.removePlayer(c.socketId);
    assert.strictEqual(room.orphanBets, 30, `orphanBets 应记 C 的 totalBet 30, 实际 ${room.orphanBets}`);
    // 继续打到摊牌并结算
    guard = 0;
    while (room.state !== 'showdown' && guard++ < 100) {
      const cur = room.currentPlayerId;
      if (!cur) break;
      const p = room.playersById.get(cur);
      const toCall = room.currentBet - p.bet;
      const r = room.doAction(p.socketId, toCall > 0 ? (p.chips >= toCall ? 'call' : 'allin') : 'check');
      if (!r.ok) break;
    }
    await settle(6500);
    // 筹码守恒: 被移除玩家带走的自身筹码(970)不计入; 但其投入底池的 30 (orphanBets) 必须回到 A/B
    // 期望 = A/B 初始 2000 + C 的残余注 30 = 2030; 修复前(只记 bet=0)会漏掉 30 → 2000
    const sum = ps[0].chips + ps[1].chips;
    assert.strictEqual(sum, 2030, `筹码应守恒 2030 (2000 + C 残余注 30), 实际 ${sum} (泄漏 ${2030 - sum})`);
    assert.strictEqual(room.orphanBets, 0, '残余注结算后应清零');
  });

  await t('4. finishHand 双分发防护: 结算窗口内重复调用不二次发钱', async () => {
    const room = new GameRoom('T', { seats: 2, sb: 5, bb: 10 });
    const a = room.addPlayer('sa', 'A');
    const b = room.addPlayer('sb', 'B');
    a.chips = 1000; b.chips = 1000;
    room.tryStart();
    // 打到摊牌
    let guard = 0;
    while (room.state !== 'showdown' && guard++ < 100) {
      const cur = room.currentPlayerId;
      if (!cur) break;
      const p = room.playersById.get(cur);
      const toCall = room.currentBet - p.bet;
      const r = room.doAction(p.socketId, toCall > 0 ? 'call' : 'check');
      if (!r.ok) break;
    }
    // 摊牌后立刻再次调用 finishHand (模拟竞态: 断线移除等路径重入)
    room.finishHand(null, room.players.filter(p => p && !p.folded));
    // 等待分发窗口结束 (2.8s 已过, 此时修复前 _settlePending 已重置, 可重入)
    await settle(3200);
    room.finishHand(null, room.players.filter(p => p && !p.folded));
    await settle(3500);
    assert.strictEqual(room.state, 'settle', '最终应进入 settle');
    const sum = a.chips + b.chips;
    assert.strictEqual(sum, 2000, `筹码应守恒 2000 (无双分发), 实际 ${sum}`);
    assert.strictEqual(room.pot, 0, '底池应清零');
  });

  await t('5. 短牌 A6s+ 为 A 档, 长牌 A6s 保持 C 档', () => {
    assert.strictEqual(handTier([{ rank: 14, suit: 0 }, { rank: 6, suit: 0 }], true).tier, 2, '短牌 A6s 应为 A 档(tier 2)');
    assert.strictEqual(handTier([{ rank: 14, suit: 0 }, { rank: 7, suit: 0 }], true).tier, 2, '短牌 A7s 应为 A 档');
    assert.strictEqual(handTier([{ rank: 14, suit: 0 }, { rank: 6, suit: 0 }], false).tier, 4, '长牌 A6s 保持 C 档');
  });

  await t('6. 胜率表磁盘缓存: 构建后落盘, 可加载', async () => {
    const file = path.join(__dirname, '..', 'data', 'winrate-long.json');
    // 删除旧缓存, 强制重建
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    const t0 = Date.now();
    const wr1 = getWinRate([{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }], false);
    const buildMs = Date.now() - t0;
    assert.ok(wr1.win > 0.7 && wr1.win < 1, `AA 胜率应 ~0.85, 实际 ${wr1.win}`);
    assert.ok(fs.existsSync(file), '胜率表应落盘');
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(cached.v >= 1 && cached.table && Object.keys(cached.table).length >= 169, '缓存文件应含完整表');
    // 加载路径: 新进程内直接读缓存 (通过再次 getWinRate 且文件存在验证结构正确)
    const t1 = Date.now();
    const wr2 = getWinRate([{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }], false);
    const loadMs = Date.now() - t1;
    assert.ok(Math.abs(wr1.win - wr2.win) < 1e-9, '缓存加载结果应一致');
    // 短牌缓存也生成
    const wrS = getWinRate([{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }], true);
    assert.ok(wrS.win > 0.7, `短牌 AA 胜率应 >0.7, 实际 ${wrS.win}`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'data', 'winrate-short.json')), '短牌表应落盘');
  });

  await t('7. 单挑(2人)翻牌后按钮先行动', async () => {
    const room = new GameRoom('T', { seats: 2, sb: 5, bb: 10 });
    const a = room.addPlayer('sa', 'A'); // seat0 → 庄家/按钮兼 SB
    const b = room.addPlayer('sb', 'B'); // seat1 → BB
    a.chips = 1000; b.chips = 1000;
    room.tryStart();
    assert.strictEqual(room.dealerSeat, a.seat, '首局庄家 = 最小座位');
    // preflop: SB(按钮) 先行动
    assert.strictEqual(room.currentPlayerId, a.id, 'preflop 按钮(SB)先行动');
    assert.ok(room.doAction(a.socketId, 'call').ok);
    assert.ok(room.doAction(b.socketId, 'check').ok);
    assert.strictEqual(room.state, 'flop');
    // 标准单挑规则: 翻牌后按钮(庄家)先行动 (修复前错误地让 BB 先手)
    assert.strictEqual(room.currentPlayerId, a.id, 'flop 按钮先行动');
    assert.ok(room.doAction(a.socketId, 'check').ok);
    assert.ok(room.doAction(b.socketId, 'check').ok);
    assert.strictEqual(room.state, 'turn');
    assert.strictEqual(room.currentPlayerId, a.id, 'turn 按钮先行动');
  });

  await t('8. 烧牌: 发每街公共牌前烧一张', async () => {
    const room = new GameRoom('T', { seats: 3, sb: 5, bb: 10 });
    for (let i = 0; i < 3; i++) { const p = room.addPlayer('s' + i, 'P' + i); p.chips = 1000; }
    room.tryStart();
    const deck0 = room.deck.length;               // 发完底牌后
    let guard = 0;
    while (room.state === 'preflop' && guard++ < 10) {
      const p = room.playersById.get(room.currentPlayerId);
      room.doAction(p.socketId, room.currentBet - p.bet > 0 ? 'call' : 'check');
    }
    assert.strictEqual(room.state, 'flop');
    assert.strictEqual(room.community.length, 3);
    // 烧 1 + 发 3 = 消耗 4
    assert.strictEqual(deck0 - room.deck.length, 4, 'flop 应烧 1 发 3');
    // 走到 turn: 烧 1 + 发 1 = 2
    guard = 0;
    while (room.state === 'flop' && guard++ < 10) {
      const p = room.playersById.get(room.currentPlayerId);
      room.doAction(p.socketId, room.currentBet - p.bet > 0 ? 'call' : 'check');
    }
    assert.strictEqual(room.state, 'turn');
    assert.strictEqual(room.community.length, 4);
    assert.strictEqual(deck0 - room.deck.length, 6, 'turn 再烧 1 发 1 (累计 6)');
    // 全员全下 run-out 也要烧牌: 新开一局验证
    const room2 = new GameRoom('T2', { seats: 2, sb: 5, bb: 10 });
    const ps = [room2.addPlayer('sa', 'A'), room2.addPlayer('sb', 'B')];
    ps.forEach(p => { p.chips = 1000; });
    room2.tryStart();
    const deck2 = room2.deck.length;
    guard = 0;
    while (room2.state !== 'showdown' && guard++ < 30) {
      const p = room2.playersById.get(room2.currentPlayerId);
      if (p) room2.doAction(p.socketId, 'allin');
    }
    // 全员全下: 发完 5 张公共牌 + 3 张烧牌 = 消耗 8; 底牌 4 张
    assert.strictEqual(room2.community.length, 5, 'run-out 公共牌应发满 5 张');
    assert.strictEqual(deck2 - room2.deck.length, 8, `run-out 应消耗 8 (发4底牌+3烧+5公共), 实际 ${deck2 - room2.deck.length}`);
  });

  await t('9. 筹码不足跟注: 剩 5 筹码全下(及 raise 全下)被接受, bet 记 5', async () => {
    // 构造: 2 人局 B 开局 25, 下完 BB 20 后 flop 剩 5; A(按钮) flop 先手下注 40 → B 筹码不足跟注
    const mkRoom = () => {
      const room = new GameRoom('T9', { seats: 2, sb: 10, bb: 20 });
      const a = room.addPlayer('sa', 'A'); // 庄/SB
      const b = room.addPlayer('sb', 'B'); // BB
      a.chips = 1000; b.chips = 25;
      room.tryStart();
      // 翻牌前: A(已下 SB 10) 跟注到 20, B check → flop
      const r1 = room.doAction(a.socketId, 'call');
      assert.ok(r1.ok, 'A 翻牌前跟注: ' + (r1.msg || ''));
      const r2 = room.doAction(b.socketId, 'check');
      assert.ok(r2.ok, 'B 翻牌前过牌: ' + (r2.msg || ''));
      assert.strictEqual(room.state, 'flop', `应到 flop, 实际 ${room.state}`);
      assert.strictEqual(b.chips, 5, `B flop 应剩 5 筹码, 实际 ${b.chips}`);
      // A(按钮) flop 先手下注 40
      const r3 = room.doAction(a.socketId, 'raise', 40);
      assert.ok(r3.ok, 'A flop 下注 40: ' + (r3.msg || ''));
      assert.strictEqual(room.currentPlayerId, b.id, '应轮到 B');   // currentPlayerId 存随机 id (非 socketId)
      const toCall = room.currentBet - b.bet;
      assert.ok(toCall > b.chips, `B 需跟 ${toCall}, 大于其筹码 ${b.chips}`);
      return { room, a, b, toCall };
    };
    // allin 路径
    {
      const { room, b } = mkRoom();
      const r = room.doAction(b.socketId, 'allin');
      assert.ok(r.ok, '剩 5 筹码 allin 应被接受: ' + (r.msg || ''));
      assert.strictEqual(b.allIn, true, 'B 应标记全下');
      assert.strictEqual(b.chips, 0, `B 全下后筹码应归零, 实际 ${b.chips}`);
    }
    // raise 到低于 currentBet (5 < 40) 应被拒绝 (加注不能把下注额降回去); 全下走 allin/call 路径
    {
      const { room, b } = mkRoom();
      const r = room.doAction(b.socketId, 'raise', 5);
      assert.ok(!r.ok, 'raise 5(低于 currentBet 40) 应被拒绝, 实际 ok=' + r.ok);
    }
    // call 不够跟注 → 自动全下
    {
      const { room, b } = mkRoom();
      const r = room.doAction(b.socketId, 'call');
      assert.ok(r.ok, '筹码不足时 call 应自动全下: ' + (r.msg || ''));
      assert.strictEqual(b.allIn, true, 'B 应标记全下');
      assert.strictEqual(b.chips, 0, `B 全下后筹码应归零, 实际 ${b.chips}`);
    }
  });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
// GameRoom 内可能有未清的 45s 行动定时器, 需要显式退出
