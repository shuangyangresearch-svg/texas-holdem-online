'use strict';
/** e2e: 1) 对局进行中添加机器人 → 成功且 sitNext 下一局参与
    2) 房主可踢机器人 (按钮条件放宽后服务端仍可踢) */
const io = require('socket.io-client');
const URL = 'http://localhost:3000';

function connect(name, accountId) {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['polling'], reconnection: false, forceNew: true, query: { name, accountId } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', e => { console.error('connect_error', e.message); resolve(null); });
  });
}
function emitAck(s, ev, data) {
  return new Promise(r => s.emit(ev, data || {}, r));
}
function lastState(s) {
  return new Promise(r => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; s.off('room:state', h); r(null); } }, 2000);
    const h = st => { if (!done) { done = true; clearTimeout(to); s.off('room:state', h); r(st); } };
    s.on('room:state', h);
    // 立即请求一次 (无 room:state 请求事件, 靠广播)
    s.emit('room:list', {}, () => {});
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fail = 0;
  const check = (label, cond, extra) => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ← ' + (extra || '')}`); if (!cond) fail++; };

  const host = await connect('房主', 'acc-host');
  const guest = await connect('玩家2', 'acc-g2');
  check('host 连接', !!host); check('guest 连接', !!guest);
  if (!host || !guest) process.exit(1);

  // 广播状态收集器
  let hState = null;
  host.on('room:state', st => { hState = st; });

  const cr = await emitAck(host, 'room:create', { name: '测试房', sb: 10, bb: 20, rule: 0 });
  check('建房', cr && cr.ok, JSON.stringify(cr));
  await sleep(300);

  const sr = await emitAck(guest, 'room:join', { roomId: cr.roomId, name: '玩家2' });
  check('加入', sr && sr.ok, JSON.stringify(sr));
  await sleep(300);

  // 加 1 个机器人
  const b1 = await emitAck(host, 'room:addbot', {});
  check('加机器人1', b1 && b1.ok, JSON.stringify(b1));
  await sleep(300);

  // 全员准备 (guest + host)
  await emitAck(guest, 'player:ready', {});
  await emitAck(host, 'player:ready', {});
  await sleep(200);

  // 房主开局
  const st = await emitAck(host, 'game:start', {});
  check('开局', st && st.ok, JSON.stringify(st));
  await sleep(500);
  check('对局进行中', !!hState && hState.state && hState.state !== 'waiting', JSON.stringify(hState && hState.state));

  // 对局进行中再加机器人 → 应成功 (旧代码: 拒绝)
  const b2 = await emitAck(host, 'room:addbot', {});
  check('对局中加机器人成功', b2 && b2.ok, JSON.stringify(b2));
  await sleep(400);

  // 新机器人应标记 sitNext (下一局参与)
  const bot2 = hState && hState.players && hState.players.find(p => p && p.isBot && p.name === b2.name);
  check('新机器人 sitNext=true', !!(bot2 && bot2.sitNext), JSON.stringify(bot2));

  // 踢机器人 (房主可踢, 含对局中): 从 state 找机器人1 的 id
  const bot1 = hState && hState.players && hState.players.find(p => p && p.name === b1.name);
  const kick = await emitAck(host, 'player:kick', { playerId: bot1 && bot1.id });
  check('踢机器人成功', kick && kick.ok, JSON.stringify(kick));
  await sleep(400);

  const gone = hState && hState.players && !hState.players.some(p => p && p.name === b1.name);
  check('机器人1已被移除', !!gone, JSON.stringify(hState && hState.players.map(p => p && p.name)));

  host.close(); guest.close();
  console.log(fail === 0 ? '\n== 全部通过 ==' : `\n== ${fail} 处失败 ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('e2e error', e); process.exit(1); });
