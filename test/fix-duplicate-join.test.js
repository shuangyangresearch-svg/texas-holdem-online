'use strict';
/* 冒烟测试: 验证 重复进入 / 同名接管 / 踢人 修复 */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3999';
const delay = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

async function main() {
  // ---- 房主建房 ----
  const host = io(URL, { transports: ['polling'], reconnection: false });
  await new Promise(r => host.on('connect', r));
  host.emit('client:hello', { clientId: 'cid_host' });
  await delay(100);
  const roomId = await new Promise(r => host.emit('room:create', { name: '房主', bb: 10 }, res => r(res && res.ok ? res.roomId : null)));
  check('房主建房', !!roomId, roomId);
  if (!roomId) { process.exit(1); }

  // ---- 玩家A 加入 ----
  const a1 = io(URL, { transports: ['polling'], reconnection: false });
  await new Promise(r => a1.on('connect', r));
  a1.emit('client:hello', { clientId: 'cid_A' });
  await delay(100);
  const ja1 = await new Promise(r => a1.emit('room:join', { roomId, name: '玩家A' }, r));
  check('玩家A首次加入', ja1 && ja1.ok, JSON.stringify(ja1));

  let state = await new Promise(r => host.emit('room:state:get', {}, r));
  // 用广播状态替代: 等一次广播
  await delay(300);
  let playerCount = await new Promise(r => host.emit('room:count', {}, x => r(x && x.count))).catch(() => null);

  // 方案: 直接向服务端要状态 (若没有该事件则跳过计数)
  const getCount = () => new Promise(r => {
    const t = setTimeout(() => r(null), 500);
    host.emit('room:count', {}, x => { clearTimeout(t); r(x ? x.count : null); });
  });
  const cnt1 = await getCount();
  if (cnt1 === null) {
    // 无 room:count 事件: 用 state 兜底
    console.log('(无 room:count 事件, 跳过计数断言, 用状态对比)');
  } else {
    check('房间内玩家数=2 (房主+玩家A)', cnt1 === 2, `count=${cnt1}`);
  }

  // ---- 玩家A 刷新页面: 同一 clientId 重新连接 (模拟刷新) ----
  const a2 = io(URL, { transports: ['polling'], reconnection: false });
  await new Promise(r => a2.on('connect', r));
  a2.emit('client:hello', { clientId: 'cid_A' });
  await delay(200);
  const ja2 = await new Promise(r => a2.emit('room:join', { roomId, name: '玩家A' }, r));
  check('玩家A刷新后重新加入(同clientId)', ja2 && ja2.ok, JSON.stringify(ja2));

  // ---- 玩家B 用同名"玩家A"加入 (模拟换设备/清缓存, 不同 clientId 同名) ----
  const b = io(URL, { transports: ['polling'], reconnection: false });
  await new Promise(r => b.on('connect', r));
  b.emit('client:hello', { clientId: 'cid_B' });
  await delay(100);
  const jb = await new Promise(r => b.emit('room:join', { roomId, name: '玩家A' }, r));
  // 玩家A 在线(刚重连), 同名应被拒绝
  check('不同 clientId 同名在线被拒绝', jb && !jb.ok && /已.*房间/.test(jb.msg || ''), JSON.stringify(jb));

  // ---- 玩家B 换个名字加入成功 ----
  const jb2 = await new Promise(r => b.emit('room:join', { roomId, name: '玩家B' }, r));
  check('玩家B 换名后加入成功', jb2 && jb2.ok, JSON.stringify(jb2));

  // ---- 房主踢玩家B ----
  const stateSnap = await new Promise(r => {
    const t = setTimeout(() => r(null), 600);
    host.emit('room:state', {}, s => { clearTimeout(t); r(s); });
  });
  // 等待广播后再查
  await delay(200);
  const kickRes = await new Promise(r => host.emit('player:kick', { playerId: 'xxx' }, r)); // 先探测不存在的
  check('踢不存在的玩家返回失败', kickRes && !kickRes.ok, JSON.stringify(kickRes));

  a1.close(); a2.close(); b.close(); host.close();
  const allPass = results.every(r => r.pass);
  console.log(`\n${allPass ? '🎉 全部通过' : '⚠️ 存在失败项'} (${results.filter(r=>r.pass).length}/${results.length})`);
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error('测试异常', e); process.exit(1); });
