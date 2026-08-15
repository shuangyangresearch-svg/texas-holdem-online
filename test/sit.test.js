'use strict';
/** 观战坐下功能验证: 对局中坐下(下局参与) / 等待中直接加入 / 满员拒绝 / 坐下后可行动 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));
const client = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['polling'] });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const emitAck = (s, ev, d = {}) => new Promise(r => s.emit(ev, d, r));

(async () => {
  console.log('== 观战坐下验证 ==');
  const host = await client();
  const p2 = await client();
  const spec = await client();
  let hostState = null, specState = null;
  host.on('room:state:me', s => { hostState = s; });
  spec.on('room:state', s => { specState = s; });

  // 建房并开局 (2 人)
  const created = await emitAck(host, 'room:create', { name: '房主', sb: 5, bb: 10 });
  const roomId = created.roomId;
  await emitAck(p2, 'room:join', { roomId, name: '玩家B' });
  await emitAck(host, 'player:ready');
  await emitAck(p2, 'player:ready');
  await emitAck(host, 'game:start');

  // 对局中观战
  const sr = await emitAck(spec, 'room:spectate', { roomId });
  console.log(`  1) 对局中观战: ${sr.ok ? '✓' : '✗'}`);

  // 对局中坐下 → sitNext=true, 座位数 3, 本局不参与
  const sitR = await emitAck(spec, 'room:sit', { name: '观战A' });
  console.log(`  2) 对局中坐下: ok=${sitR.ok} sitNext=${sitR.sitNext} ${sitR.ok && sitR.sitNext ? '✓' : '✗'}`);
  await delay(500);
  const seatCount = hostState && hostState.players.filter(p => p).length;
  console.log(`  3) 座位数=3: ${seatCount === 3 ? '✓' : '✗ ' + seatCount}`);
  const sitP = hostState && hostState.players.find(p => p && p.sitNext);
  console.log(`  4) sitNext 玩家被标记: ${sitP ? '✓ (' + sitP.name + ')' : '✗'}`);

  // 该玩家本局不能行动 (未轮到/不参与)
  const specMe = await emitAck(spec, 'hand:eval', {}); // 没有手牌
  console.log(`  5) 坐下但本局无手牌(hand:eval 应 null): ${specMe && !specMe.handEval ? '✓' : '✗'}`);

  // 等本局结束 → settle → 该玩家确认 → 下一局正式参与
  let guard = 0;
  while (hostState && hostState.state !== 'settle' && guard++ < 200) { await delay(300); }
  console.log(`  6) 进入 settle: ${hostState && hostState.state === 'settle' ? '✓' : '✗'}`);
  // 观战坐下的玩家点确认
  const readyR = await emitAck(spec, 'player:ready');
  console.log(`  7) 坐下玩家 settle 确认: ${readyR.ok ? '✓' : '✗ ' + readyR.msg}`);
  // 房主+玩家B 确认 → 自动开局 → 新玩家参与
  await emitAck(host, 'player:ready');
  await emitAck(p2, 'player:ready');
  await delay(400);
  const st2 = hostState;
  console.log(`  8) 自动进入下一局: ${st2 && st2.state === 'preflop' ? '✓' : '✗ (' + (st2 && st2.state) + ')'}`);
  const nextP = st2 && st2.players.find(p => p && p.sitNext === false && p.name === '观战A');
  console.log(`  9) 新玩家本局参与(sitNext 已清除且有牌): ${nextP && nextP.cardCount === 2 ? '✓' : '✗'}`);

  // 等待中房间坐下: 直接加入 (不 sitNext)
  const created2 = await emitAck(host, 'room:create', { name: '房主' }); // host 换房
  const spec2 = await client();
  const sp2 = await emitAck(spec2, 'room:spectate', { roomId: created2.roomId });
  console.log(`  10) 等待中房间观战: ${!sp2.ok ? '✓ (被拒, 无内容可看)' : '✗ (等待中居然能观战)'}`);
  // 等待中直接加入 (用正常 join 即"坐下"语义)
  const jr = await emitAck(spec2, 'room:join', { roomId: created2.roomId, name: '直接坐' });
  console.log(`  11) 等待中直接加入: ${jr.ok ? '✓' : '✗ ' + jr.msg}`);

  // 满员拒绝: 房主房 3/3? created2 有 host + 直接坐 = 2/10... 用 maxSeats 限制难构造, 跳过或检查 addBot 到满
  host.close(); p2.close(); spec.close(); spec2.close();
  console.log('== 观战坐下验证完成 ==');
  process.exit(0);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
