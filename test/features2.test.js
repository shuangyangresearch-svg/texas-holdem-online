'use strict';
/** 新功能综合验证: ①烧牌 ②行动倒计时 ③全局排行榜 ④观战模式 */
const { io } = require('socket.io-client');
const { GameRoom } = require('../src/game');

const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));
const client = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['polling'] });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const emitAck = (s, ev, d = {}) => new Promise(r => s.emit(ev, d, r));

(async () => {
  console.log('== 新功能综合验证 ==');

  // ① 烧牌 (引擎级)
  {
    const room = new GameRoom('B', { seats: 2, sb: 5, bb: 10 });
    const a = room.addPlayer('sa', 'A');
    const b = room.addPlayer('sb', 'B');
    a.chips = 1000; b.chips = 1000;
    room.tryStart();
    const deckAfterDeal = room.deck.length;
    room.doAction(a.socketId, 'call');
    room.doAction(b.socketId, 'check'); // → flop (烧1张)
    const afterFlop = room.community.length;
    const deckAfterFlop = room.deck.length;
    console.log(`  ① flop: 公共牌 ${afterFlop} 张, 发牌+烧牌共耗 ${deckAfterDeal - deckAfterFlop} 张 (期望 4) ${afterFlop === 3 && deckAfterDeal - deckAfterFlop === 4 ? '✓' : '✗'}`);
    // 单挑局翻牌后: 按钮(庄家 A)先行动 (标准单挑规则)
    const flopFirst = room.currentPlayerId;
    console.log(`  ① 单挑翻牌后先行动者=庄家A: ${flopFirst === a.id ? '✓' : '✗ (当前 ' + (flopFirst ? 'B' : '无') + ')'}`);
    room.doAction(a.socketId, 'check');
    room.doAction(b.socketId, 'check'); // → turn (烧1张)
    const deckAfterTurn = room.deck.length;
    console.log(`  ① turn: 公共牌 ${room.community.length} 张, 本街耗 ${deckAfterFlop - deckAfterTurn} 张 (期望 2) ${room.community.length === 4 && deckAfterFlop - deckAfterTurn === 2 ? '✓' : '✗'}`);
  }

  const p1 = await client(); // 玩家A (房主)
  const p2 = await client(); // 玩家B
  const spec = await client(); // 观战者
  let p1State = null, p2State = null, specState = null;
  p1.on('room:state:me', s => { p1State = s; });
  p2.on('room:state:me', s => { p2State = s; });
  spec.on('room:state', s => { specState = s; });

  const created = await emitAck(p1, 'room:create', { name: '房主', sb: 5, bb: 10 });
  const roomId = created.roomId;
  await emitAck(p2, 'room:join', { roomId, name: '玩家B' });
  await emitAck(p1, 'player:ready');
  await emitAck(p2, 'player:ready');
  await emitAck(p1, 'game:start');

  // ② 行动倒计时: 等到轮到 p1
  let gotDeadline = false;
  let guard = 0;
  while (guard++ < 60) {
    if (p1State && p1State.you && p1State.you.id === p1State.currentPlayerId && p1State.actionDeadline) {
      gotDeadline = p1State.actionDeadline > Date.now() && p1State.actionDeadline - Date.now() <= 45000;
      break;
    }
    await delay(150);
  }
  console.log(`  ② actionDeadline 下发: ${gotDeadline ? '✓' : '✗'} (state=${p1State && p1State.state})`);

  // ③ 排行榜
  const rank = await emitAck(p1, 'rank:list', {});
  console.log(`  ③ rank:list: ok=${rank.ok} 榜单 ${rank.list ? rank.list.length : 0} 人, 总 ${rank.total} 人 ${rank.ok && rank.list && rank.list.length > 0 ? '✓' : '✗'}`);
  if (rank.ok && rank.list && rank.list.length) console.log(`     榜首: ${rank.list[0].name} 积分=${rank.list[0].score} 段位=${rank.list[0].level.name}`);

  // ④ 观战: 对局中观战
  const specR = await emitAck(spec, 'room:spectate', { roomId });
  console.log(`  ④ room:spectate: ${specR.ok ? '✓' : '✗ ' + specR.msg}`);
  await delay(400);
  const specHasState = specState && specState.id === roomId;
  console.log(`  ④ 观战者收到公共状态: ${specHasState ? '✓' : '✗'}`);
  // 观战者不能行动
  const badAct = await emitAck(spec, 'game:action', { action: 'check' });
  console.log(`  ④ 观战者行动被拒: ${!badAct.ok ? '✓' : '✗'}`);
  // 观战者不占座位
  const seatCount = p1State && p1State.players.filter(p => p).length;
  console.log(`  ④ 座位数仍为 2 (观战不占座): ${seatCount === 2 ? '✓' : '✗ ' + seatCount}`);
  // 观战者退出
  const leaveR = await emitAck(spec, 'room:leave', {});
  console.log(`  ④ 观战退出: ${leaveR.ok && leaveR.left === 'spectate' ? '✓' : '✗'}`);
  // 等待中房间不可观战 (用新房间测)
  const created2 = await emitAck(p1, 'room:create', { name: '房主' }); // p1 已在房1 → 会先离开
  const specR2 = await emitAck(spec, 'room:spectate', { roomId: created2.roomId });
  console.log(`  ④ 等待中房间观战被拒: ${!specR2.ok ? '✓' : '✗'}`);

  p1.close(); p2.close(); spec.close();
  console.log('== 新功能综合验证完成 ==');
  process.exit(0);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
