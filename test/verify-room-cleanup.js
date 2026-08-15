'use strict';
/** 临时验证: 真人退出后, 纯 bot 房间应解散 (不继续自动开局) */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['polling'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const emitAck = (s, ev, data = {}) => new Promise(resolve => s.emit(ev, data, resolve));

async function main() {
  console.log('== 验证: 对局进行中真人退出 → 纯 bot 房间自动解散 ==');

  const a = await client('A');
  console.log('✓ 真人 A 已连接');

  let roomList = [];
  let myState = null;
  a.on('rooms:list', l => { roomList = l; });
  a.on('room:state:me', s => { myState = s; });

  // 1. 创建 3 座房间
  const created = await emitAck(a, 'room:create', { name: '验证员', sb: 5, bb: 10, seats: 3 });
  if (!created.ok) throw new Error('创建失败: ' + created.msg);
  const roomId = created.roomId;
  console.log(`✓ 创建房间 ${roomId}`);
  await delay(300);

  // 2. 添加 2 个 bot
  const b1 = await emitAck(a, 'room:addbot', { name: '电脑1' });
  const b2 = await emitAck(a, 'room:addbot', { name: '电脑2' });
  if (!b1.ok || !b2.ok) throw new Error('添加 bot 失败: ' + (b1.msg || b2.msg));
  console.log('✓ 已添加 2 个 bot');

  // 3. 真人准备并开局
  const ready = await emitAck(a, 'player:ready');
  console.log('  ready ack:', JSON.stringify(ready));
  const started = await emitAck(a, 'game:start');
  console.log('  start ack:', JSON.stringify(started));
  if (!started.ok) throw new Error('开局失败: ' + started.msg);

  // 4. 等待对局真正开始 (state 离开 waiting)
  let enteredGame = false;
  for (let i = 0; i < 20; i++) {
    await delay(250);
    if (myState && myState.state !== 'waiting' && myState.state !== 'settle') {
      enteredGame = true;
      break;
    }
  }
  if (!enteredGame) throw new Error('对局未开始, 最后状态: ' + (myState && myState.state));
  console.log(`✓ 对局已开始, 当前阶段: ${myState.stageName || myState.state}, 座位: ${myState.players.filter(p => p).length}人`);

  // 5. 真人退出游戏
  const quit = await emitAck(a, 'player:forfeit');
  if (!quit.ok) throw new Error('退出失败: ' + quit.msg);
  console.log('✓ 真人已退出游戏');

  // 6. 等待片刻, 检查房间是否解散
  await delay(1500);
  const after = roomList.find(r => r.id === roomId);
  console.log(after
    ? `✗ 失败! 房间仍存在: state=${after.state}, count=${after.count}`
    : '✓ 成功! 房间已解散 (纯 bot 房间不再继续)');

  a.disconnect();
  process.exit(after ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
