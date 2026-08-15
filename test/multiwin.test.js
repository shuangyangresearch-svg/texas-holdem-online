'use strict';
/** 多开窗口测试: 模拟同一机器 3 个标签页同时在线, 验证互不顶号 */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));
const emitAck = (s, ev, d = {}) => new Promise(r => s.emit(ev, d, r));

async function main() {
  console.log('== 多开窗口测试: 3 个标签页同时在线 ==');

  // 模拟 3 个独立标签页（每个拥有独立 socket）
  const wins = [];
  for (let i = 0; i < 3; i++) {
    const s = await new Promise((res, rej) => {
      const sock = io(URL, { transports: ['polling'] });
      sock.on('connect', () => res(sock));
      sock.on('connect_error', rej);
    });
    wins.push({ sock: s, name: '窗口' + i, id: s.id });
  }
  console.log('✓ 3 个标签页已连接');

  // 窗口0 建房
  const created = await emitAck(wins[0].sock, 'room:create', { name: '窗口0', seats: 3 });
  if (!created.ok) throw new Error('建房失败');
  const roomId = created.roomId;
  console.log(`✓ 窗口0 建房 ${roomId}`);

  // 窗口1、2 加入
  const j1 = await emitAck(wins[1].sock, 'room:join', { roomId, name: '窗口1' });
  const j2 = await emitAck(wins[2].sock, 'room:join', { roomId, name: '窗口2' });
  if (!j1.ok || !j2.ok) throw new Error('加入失败');
  console.log('✓ 窗口1、窗口2 均加入成功');

  // 模拟旧版本 bug: 窗口2 误用 窗口1 的 socketId 触发 rejoin（应被拒绝）
  const fakeRejoin = await emitAck(wins[2].sock, 'room:rejoin', { oldSocketId: wins[1].id, name: '窗口2' });
  console.log(`✓ 顶号尝试被拒绝: ${JSON.stringify(fakeRejoin)}`);
  if (fakeRejoin.ok) {
    throw new Error('BUG: 顶号竟成功了! 窗口1 会被踢下线');
  }

  // 验证窗口1 仍然在线且身份未被顶
  const state = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('超时')), 5000);
    wins[1].sock.on('room:state:me', function h(s) {
      clearTimeout(t);
      wins[1].sock.off('room:state:me', h);
      res(s);
    });
    wins[1].sock.emit('player:ready');
  });
  const mySeat = state.players.findIndex(p => p && p.id === state.you.id);
  if (mySeat < 0) throw new Error('窗口1 身份丢失!');
  console.log('✓ 窗口1 身份完好 (座位 ' + mySeat + ')');

  // 3 人都能收到状态（都在线）
  const playersOnline = state.players.filter(p => p && p.connected).length;
  console.log(`✓ 在线玩家数: ${playersOnline}/3`);
  if (playersOnline !== 3) throw new Error('有窗口被顶下线');

  wins.forEach(w => w.sock.close());
  console.log('== 多开窗口测试通过: 互不顶号 ==');
  process.exit(0);
}

main().catch(e => {
  console.error('多开测试失败:', e.message);
  process.exit(1);
});
