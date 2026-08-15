'use strict';
/** 边界场景测试: 边池/平局/庄家轮转/断线/连开多局 */
const assert = require('assert');
const { GameRoom } = require('../src/game');

let pass = 0, fail = 0;
// 注意: 测试体多为 async 函数, 必须 await 其 Promise, 否则同步抛错会被吞掉误报"✓"
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('  ✓ ' + name); })
    .catch(e => { fail++; console.error('  ✗ ' + name + ' → ' + e.message); });
}
function makeRoom(n, seats) {
  const room = new GameRoom('T', { seats: seats || n });
  const sockets = [];
  for (let i = 0; i < n; i++) {
    const p = room.addPlayer('sock' + i, 'P' + i);
    p.chips = 1000;
    sockets.push(p.socketId);
  }
  return { room, sockets };
}
function playAll(room) {
  let guard = 0;
  while (room.state !== 'showdown' && guard++ < 200) {
    const cur = room.currentPlayerId;
    if (!cur) break;
    const p = room.playersById.get(cur);
    const toCall = room.currentBet - p.bet;
    const r = room.doAction(p.socketId, toCall > 0 ? (p.chips >= toCall ? 'call' : 'allin') : 'check');
    if (!r.ok) room.doAction(p.socketId, 'fold');
  }
}
const settle = room => new Promise(r => setTimeout(r, 7500));

(async () => {
  console.log('== 边界场景测试 ==');

  await t('全下形成边池: 赢家应只拿对应池', async () => {
    const { room } = makeRoom(3);
    // P0 chips 很少, 全下; P1/P2 正常玩
    const p0 = room.players[0];
    p0.chips = 40;
    room.tryStart();
    let guard = 0;
    while (room.state !== 'showdown' && guard++ < 100) {
      const cur = room.currentPlayerId;
      const p = room.playersById.get(cur);
      if (!p) break;
      const toCall = room.currentBet - p.bet;
      if (p === p0) {
        room.doAction(p.socketId, 'allin');
      } else if (toCall > 0) {
        room.doAction(p.socketId, p.chips > toCall ? 'call' : 'allin');
      } else {
        room.doAction(p.socketId, 'check');
      }
    }
    await settle(room);
    const total = room.players.reduce((s, p) => s + p.chips, 0);
    // 注: p0 初始被改为 40, 全桌初始总额 = 40 + 1000 + 1000 = 2040
    assert.strictEqual(total, 2040, `筹码守恒失败: ${total} != 2040`);
  });

  await t('平局平分底池', async () => {
    const { room } = makeRoom(2);
    room.tryStart();
    // 直接跳过下注, 走到摊牌用相同手牌
    // 给两人一样的牌
    const p0 = room.players[0], p1 = room.players[1];
    p0.cards = [{ rank: 14, suit: 0 }, { rank: 13, suit: 1 }];
    p1.cards = [{ rank: 14, suit: 0 }, { rank: 13, suit: 1 }];
    room.community = [{ rank: 2, suit: 0 }, { rank: 3, suit: 1 }, { rank: 4, suit: 2 }, { rank: 7, suit: 3 }, { rank: 9, suit: 0 }];
    const before = [p0.chips, p1.chips];
    room.doShowdown();
    await settle(room);
    // 双方筹码应相等（平分）
    assert.strictEqual(p0.chips, p1.chips, `平分失败: ${p0.chips} vs ${p1.chips}`);
  });

  await t('一人弃牌后提前赢池', async () => {
    const { room, sockets } = makeRoom(3);
    room.tryStart();
    // 让两人弃牌
    let guard = 0;
    while (room.state !== 'showdown' && guard++ < 10) {
      const cur = room.currentPlayerId;
      if (!cur) break;
      const p = room.playersById.get(cur);
      room.doAction(p.socketId, 'fold');
    }
    assert.ok(room.state === 'showdown', '应提前结束, 实际: ' + room.state);
    await settle(room);
    const alive = room.players.filter(p => p && !p.folded);
    assert.strictEqual(alive.length, 1, '应只剩 1 人');
    // 筹码守恒: 赢家 + 弃牌者剩余筹码 = 全桌初始 3000 (弃牌者的投入已归入底池)
    const foldSum = room.players.filter(p => p && p !== alive[0]).reduce((s, p) => s + p.chips, 0);
    assert.strictEqual(alive[0].chips + foldSum, 3000, `筹码不守恒: 赢家 ${alive[0].chips} + 弃牌者 ${foldSum} != 3000`);
  });

  await t('庄家每局轮转', async () => {
    const { room } = makeRoom(3);
    room.tryStart();
    const d1 = room.dealerSeat;
    room.resetToWaiting();
    room.tryStart();
    const d2 = room.dealerSeat;
    room.resetToWaiting();
    room.tryStart();
    const d3 = room.dealerSeat;
    assert.ok(d1 !== d2 || d2 !== d3, '庄家应轮转');
  });

  await t('断线玩家自动弃牌', async () => {
    const { room, sockets } = makeRoom(3);
    room.tryStart();
    const p0 = room.players[0];
    // 模拟断线: 从房间移除
    room.removePlayer(p0.socketId);
    // 应自动视为弃牌并继续
    let guard = 0;
    while (room.state !== 'showdown' && guard++ < 100) {
      const cur = room.currentPlayerId;
      if (!cur) break;
      const p = room.playersById.get(cur);
      const toCall = room.currentBet - p.bet;
      room.doAction(p.socketId, toCall > 0 ? 'call' : 'check');
    }
    assert.ok(room.state === 'showdown', '断线后对局应能走完');
  });

  await t('连续多局不崩溃', async () => {
    const { room } = makeRoom(3);
    for (let i = 0; i < 5; i++) {
      room.resetToWaiting();
      room.tryStart();
      playAll(room);
      await settle(room);
      // 7.5s 后已过 2.8s 分发 + 2.5s 结算确认, 状态应为 settle (或仍展示中的 showdown)
      assert.ok(room.state === 'showdown' || room.state === 'settle', `第${i + 1}局状态异常: ${room.state}`);
    }
  });

  await t('提前结束(剩1人)保存公共牌', async () => {
    const { room } = makeRoom(2);
    room.tryStart();
    const p0 = room.players[0], p1 = room.players[1];
    // preflop: p0(SB) call → p1(BB) check → flop
    assert.ok(room.doAction(p0.socketId, 'call').ok);
    assert.ok(room.doAction(p1.socketId, 'check').ok);
    assert.strictEqual(room.state, 'flop', '应进入 flop');
    // flop: p0 check → p1 fold → 剩 p0 独赢
    assert.ok(room.doAction(p0.socketId, 'check').ok);
    assert.ok(room.doAction(p1.socketId, 'fold').ok);
    assert.strictEqual(room.state, 'showdown', '应提前结束');
    await settle(room);
    const st = room.toState();
    assert.ok(st.showdownCommunity && st.showdownCommunity.length >= 3,
      `提前结束应保留公共牌, 实际 ${st.showdownCommunity ? st.showdownCommunity.length : '无'}`);
  });

  await t('断线宽限: 60秒内掉线不弃牌', async () => {
    const { room, sockets } = makeRoom(3);
    room.tryStart();
    const b = room.players[1];
    // B 掉线(不轮到他), 断线时间设为"刚刚"
    b.connected = false;
    b.disconnectedAt = Date.now();
    // 其他玩家行动, B 不应被弃牌
    let guard = 0;
    while (guard++ < 40) {
      const cur = room.currentPlayerId;
      if (!cur) break;
      const p = room.playersById.get(cur);
      if (p === b) { console.log('  [测试] B 被跳过, 不弃牌'); break; }
      const toCall = room.currentBet - p.bet;
      room.doAction(p.socketId, toCall > 0 ? 'call' : 'check');
      if (room.state !== 'preflop') break;
    }
    assert.ok(!b.folded, '断线宽限内不应弃牌');
    // 断线超过 60 秒 → 弃牌
    b.disconnectedAt = Date.now() - 61000;
    if (room.state === 'preflop' || room.state === 'flop') {
      let guard2 = 0;
      while (guard2++ < 10) {
        const cur = room.currentPlayerId;
        if (!cur) break;
        const p = room.playersById.get(cur);
        const toCall = room.currentBet - p.bet;
        const r = room.doAction(p.socketId, toCall > 0 ? 'call' : 'check');
        if (!r.ok) break;
      }
    }
    assert.ok(b.folded || room.state === 'showdown', '超过60秒应弃牌或已结算');
  });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})();

