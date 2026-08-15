'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { GameRoom, getLevelByScore } = require('./src/game');
const { getWinRate, buildWinRateTableMultiAsync } = require('./src/poker');
const accounts = require('./src/accounts');
const auth = require('./src/auth');

/* ===== 全局崩溃保护: 记录异常详情 + 全部房间状态 (异常会中断状态推进, 记录现场便于定位) ===== */
process.on('uncaughtException', err => {
  console.error('[崩溃保护] 未捕获异常:', err && err.stack || err);
  try {
    for (const [rid, room] of rooms) {
      console.error(`[崩溃] 房间 ${rid}: state=${room.state} currentPlayer=${room.currentPlayerId || '无'} pot=${room.pot}`);
      console.error(`[崩溃]   玩家: ${room.players.filter(p => p).map(p => `${p.name}(chips=${p.chips} bet=${p.bet} totalBet=${p.totalBet} folded=${p.folded} allIn=${p.allIn} cards=${(p.cards || []).map(c => c ? c.rank + '/' + c.suit : '?').join(',')})`).join(' | ')}`);
      console.error(`[崩溃]   公共牌: ${(room.community || []).map(c => c ? c.rank + '/' + c.suit : '?').join(',') || '无'}`);
    }
  } catch (e) { /* 状态打印失败则忽略 */ }
});
process.on('unhandledRejection', reason => {
  console.error('[崩溃保护] 未处理 Promise 拒绝:', reason);
});

const app = express();
const server = http.createServer(app);

// gzip 压缩: 静态资源(html/js/css)与 socket.io 轮询响应显著减小传输体积 (弱网/隧道下"卡"的一大来源)
const compression = require('compression');
app.use(compression());

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
  // 传输策略: 轮询优先 + WebSocket 升级 (局域网/直连/正常隧道下大幅降低延迟, 显著减少"卡");
  // socket.io 升级失败会自动回落长轮询, 不影响 Cloudflare trycloudflare 等代理部署。
  // 如需强制长轮询可设环境变量 TRANSPORTS=polling (如隧道对 WS 升级不友好时)。
  transports: (process.env.TRANSPORTS || 'polling,websocket').split(',').map(s => s.trim()).filter(Boolean),
  // 心跳放宽: 手机锁屏/切后台时浏览器会节流 JS, 过短超时会被误判断线
  // 25s 间隔 + 20s 超时 (socket.io 默认, 宽容手机后台)
  pingInterval: 25000,
  pingTimeout: 20000
});

// 禁用前端静态资源缓存: 确保玩家刷新时拿到最新代码 (修复/美术更新即时生效)
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: r => r.setHeader('Cache-Control', 'no-store, must-revalidate') }));

// 背景歌曲列表: 玩家把 mp3 放进 public/music/ 即自动出现在播放列表 (无歌返回空, 前端回退合成 BGM)
app.get('/api/music', (req, res) => {
  const dir = path.join(__dirname, 'public', 'music');
  require('fs').readdir(dir, (err, files) => {
    if (err) return res.json({ songs: [] });
    res.json({ songs: files.filter(f => /\.(mp3|ogg|m4a|wav)$/i.test(f)) });
  });
});

const PORT = process.env.PORT || 3000;
const ROOM_CODE_LEN = 4;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map(); // roomId -> GameRoom
const socketRoom = new Map(); // socketId -> roomId
const spectatorRoom = new Map(); // socketId -> roomId (观战者: 不占座位, 只收公共状态)
const pendingJoin = new Map(); // socketId -> {roomId, name} 断线重连用
const clientToSocket = new Map(); // clientId(浏览器) -> 当前 socketId (用于同浏览器去重)
const usernameToSocket = new Map(); // username(正式账号) -> socketId (单点登录: 新登录挤掉旧连接)
const kickedClients = new Set();  // clientId: 被房主踢出者, 禁止其自动重连回房间 (冷却至 5 分钟后解除)

/**
 * 账号级单点登录: 同一正式账号只允许一个在线 socket。
 * 新登录/注册成功后调用, 会挤掉同一账号的旧在线连接。
 */
function bindUsernameToSocket(username, socket) {
  if (!username) return;
  // 找到所有"持有该 username 且不是当前新连接"的在线 socket (含 lobby 停留中的旧连接)。
  // 注意: 不能只用 usernameToSocket 里存的旧 id —— 因为 socket.io 断线重连后 socket.id 会变,
  // 旧 id 可能已失效(不 connected), 导致停留在 lobby 的旧连接收不到顶号事件。
  const staleSockets = [];
  for (const [, s] of io.sockets.sockets) {
    if (s && s.connected && s !== socket && s._username === username) {
      staleSockets.push(s);
    }
  }
  // 兼容: 若 usernameToSocket 里存的旧 id 仍有效也纳入(防止遗漏)
  const oldSocketId = usernameToSocket.get(username);
  if (oldSocketId && oldSocketId !== socket.id) {
    const oldSock = io.sockets.sockets.get(oldSocketId);
    if (oldSock && oldSock.connected && oldSock._username === username && !staleSockets.includes(oldSock)) {
      staleSockets.push(oldSock);
    }
  }
  for (const oldSock of staleSockets) {
    try {
      const oid = oldSock.id;
      // 同步把旧 socket 在房间里的玩家标记为离线, 这样新 socket 的 addPlayer
      // 能命中 sameUserOffline(接管同一玩家), 避免创建重复玩家
      const oldRoomId = socketRoom.get(oid);
      if (oldRoomId) {
        const oldRoom = rooms.get(oldRoomId);
        if (oldRoom) {
          const oldPlayer = [...oldRoom.playersById.values()].find(p => p.socketId === oid);
          if (oldPlayer) {
            oldPlayer.connected = false;
            oldPlayer.disconnectedAt = Date.now();
            // 注意: 不要调用 room.handleDisconnect, 避免重复处理(旧 socket disconnect 时还会触发)
            // 这里只同步标记状态, 真正的清理由旧 socket 的 disconnect 事件走 handleDisconnect
          }
        }
      }
      // 先发事件, 稍作延迟再断开, 确保 duplicate_login 送达客户端(被顶的人能回登录界面)
      oldSock.emit('duplicate_login', { msg: '该账号已在其他设备登录，此处自动退出' });
      setTimeout(() => {
        try { if (oldSock.connected) oldSock.disconnect(true); } catch (e) { /* ignore */ }
      }, 300);
      console.log(`[单点登录] 账号 ${username} 旧连接 ${oid} 被新连接 ${socket.id} 挤掉`);
    } catch (e) { /* ignore */ }
  }
  usernameToSocket.set(username, socket.id);
  socket._username = username;
}

function genRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function broadcastRoom(room, base) {
  // 复用已构建的公共状态: broadcast() 已调 toState() 一次, 避免每玩家再重复构建完整状态
  const s = base || room.toState();
  io.to(room.id).emit('room:state', s);
  // 给每个玩家单独发含自己手牌的视图 (复用 base 浅拷贝, 不再重新构建 toState)
  for (const p of room.players) {
    if (!p) continue;
    const socket = io.sockets.sockets.get(p.socketId);
    if (socket) {
      socket.emit('room:state:me', room.toStateFor(p.socketId, s));
    }
  }
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  // 房间保留条件: 至少一名真人且在房 (在线 或 断线重连窗口内)
  // 机器人、托管离开(away) 均不算 → 纯 bot / 全托管 / 空房间直接关闭
  const hasHuman = room.players.some(p => p && !p.isBot && !p.away);
  if (!hasHuman) {
    // 删除前结算仍在座真人玩家的当局积分 (断线超时/托管离开未等到当局正常结束, 已投入的筹码不丢失)
    try { room.settleAllScores(); } catch (e) { console.error('[清理] 结算积分失败:', e && e.message); }
    rooms.delete(roomId);
    io.emit('rooms:list', listRooms());
  }
}

/** 公开房间列表（所有存活房间，含对局中的房间，带状态供前端区分显示） */
function listRooms() {
  const arr = [];
  for (const room of rooms.values()) {
    const seated = room.players.filter(p => p);
    arr.push({
      id: room.id,
      name: room.name,
      state: room.state,
      sb: room.sb,
      bb: room.bb,
      count: seated.length,
      max: room.maxSeats,
      host: seated[0] ? seated[0].name : ''
    });
  }
  return arr;
}

function broadcastRoomList() {
  io.emit('rooms:list', listRooms());
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} 已连接 (在线 ${io.engine.clientsCount})`);

  // ===== 浏览器客户端标识: 仅记录 clientId 供快照/重连/踢人使用。
  // 不再做浏览器级强制去重(同一浏览器多标签页可共存不同账号);
  // 账号级单点登录(同一账号只在线一处, 新登录挤掉旧的)由 bindUsernameToSocket 负责。
  socket.on('client:hello', (data = {}, ack) => {
    const clientId = String(data.clientId || '').slice(0, 64);
    if (!clientId) return ack && ack({ ok: false });
    clientToSocket.set(clientId, socket.id);
    socket._clientId = clientId;
    ack && ack({ ok: true });
  });

  // ===== 鉴权: 注册 (用户名 + 密码 + 昵称; 附带游客 accountId 用于账号升级合并) =====
  socket.on('auth:register', (payload = {}, ack) => {
    const { username, password, nickname } = payload;
    const r = auth.register(username, password, nickname, payload.accountId);
    if (r.ok) {
      // 注册即自动登录: 单点登录挤掉同账号旧连接
      bindUsernameToSocket(r.username, socket);
      console.log(`[auth] 注册成功: ${r.username}`);
      return ack && ack({ ok: true, token: r.token, username: r.username, nickname: r.nickname, score: r.score, wins: r.wins, losses: r.losses });
    }
    return ack && ack({ ok: false, msg: r.msg });
  });

  // ===== 鉴权: 登录 (用户名 + 密码) =====
  socket.on('auth:login', (payload = {}, ack) => {
    const { username, password } = payload;
    const r = auth.login(username, password);
    if (r.ok) {
      // 单点登录: 同账号已在线则挤掉旧连接
      bindUsernameToSocket(r.username, socket);
      console.log(`[auth] 登录成功: ${r.username}`);
      return ack && ack({ ok: true, token: r.token, username: r.username, nickname: r.nickname, score: r.score, wins: r.wins, losses: r.losses });
    }
    return ack && ack({ ok: false, msg: r.msg });
  });

  // ===== 鉴权: 登出 =====
  socket.on('auth:logout', (payload = {}, ack) => {
    const { token } = payload;
    auth.logout(token);
    // 释放账号的单点登录绑定
    if (socket._username && usernameToSocket.get(socket._username) === socket.id) {
      usernameToSocket.delete(socket._username);
    }
    socket._username = null;
    ack && ack({ ok: true });
  });

  // ===== 账号信息: 正式账号(token)优先; 否则游客(accountId)兜底 =====
  socket.on('account:info', (data = {}, ack) => {
    const name = String(data.name || '').slice(0, 12);
    const { getLevelByScore } = require('./src/game');
    let acc = null, authed = false, username = null, nickname = null;
    if (data.token) {
      const u = auth.getUserByToken(data.token);
      if (u) { acc = u; authed = true; username = u.username; nickname = u.nickname; }
    }
    if (!acc && data.accountId) {
      try { acc = accounts.getOrCreateAccount(data.accountId, name); } catch (e) { /* ignore */ }
    }
    if (!acc) return ack && ack({ ok: false });
    const lv = getLevelByScore(acc.score);
    ack && ack({
      ok: true,
      authed,
      username: username,
      nickname: nickname || acc.name,
      name: name,
      accountId: acc.accountId,
      score: acc.score,
      wins: acc.wins,
      losses: acc.losses,
      level: lv
    });
  });

  socket.on('disconnect', () => {
    if (socket._clientId && clientToSocket.get(socket._clientId) === socket.id) {
      clientToSocket.delete(socket._clientId);
    }
    // 释放账号单点登录绑定 (仅当仍是该 socket 持有映射, 避免误删已被新连接接管的)
    if (socket._username && usernameToSocket.get(socket._username) === socket.id) {
      usernameToSocket.delete(socket._username);
    }
    socket._username = null;
    // 观战者断开: 释放观战绑定
    spectatorRoom.delete(socket.id);
  });

  // ===== 创建房间 =====
  socket.on('room:create', (opts = {}, ack) => {
    try {
      const name = String(opts.name || '玩家').slice(0, 12) || '玩家';
      const accountId = opts.accountId || undefined;
      const username = opts.username || undefined;
      // 标准德州规则: 小盲 = 大盲一半; 盲注统一为 10 的整数倍 (与加注 10 倍数规则一致)
      // 默认大盲 20 / 小盲 10 (历史默认 10/5, 现按用户要求调整)
      const bb = Math.max(10, Math.round((Number(opts.bb) || 20) / 10) * 10);
      const sb = Math.max(5, Math.floor(bb / 2));
      // 座位自适应: 固定上限 10 (经典德州 10 人桌), 按实际加入人数开局
      const seats = 10;

      // 如果已在房间，先离开
      leaveRoom(socket);

      const roomId = genRoomCode();
      const shortDeck = !!opts.shortDeck; // 短牌(6+ Hold'em)
      const room = new GameRoom(roomId, { name: `德州扑克 #${roomId}`, sb, bb, seats, shortDeck });
      room.broadcastFn = (base) => broadcastRoom(room, base);
      rooms.set(roomId, room);
      socketRoom.set(socket.id, roomId);
      socket.join(roomId);

      const player = room.addPlayer(socket.id, name, socket._clientId, accountId, username);
      if (!player) {
        rooms.delete(roomId);
        return ack && ack({ ok: false, msg: '创建房间失败' });
      }
      room.setReadyForce(socket.id, false);
      console.log(`[房] ${roomId} 由 ${name}${username ? '(' + username + ')' : ''} 创建`);
      ack && ack({ ok: true, roomId });
      broadcastRoom(room);
      broadcastRoomList();
    } catch (e) {
      console.error('room:create 错误', e);
      ack && ack({ ok: false, msg: '服务器错误' });
    }
  });

  // ===== 加入房间 =====
  socket.on('room:join', (opts = {}, ack) => {
    try {
      const roomId = String(opts.roomId || '').trim().toUpperCase();
      const name = String(opts.name || '玩家').slice(0, 12) || '玩家';
      const accountId = opts.accountId || undefined;
      const username = opts.username || undefined;
      const room = rooms.get(roomId);
      if (!room) return ack && ack({ ok: false, msg: '房间不存在，请检查房间号' });
      // 被房主踢出者: 禁止加入 (冷却至 5 分钟后自动解除)
      if (socket._clientId && kickedClients.has(socket._clientId)) {
        return ack && ack({ ok: false, msg: '你已被房主移出房间' });
      }
      // 对局进行中: 禁止新玩家加入 (会破坏发牌/行动顺序); 仅允许已在房间的玩家断线重连,
      // 或"托管离开(away)"的玩家回来观战/接手(牌未被托管弃掉时直接恢复参与)
      let existing = null, awayComeback = null, awayComebackAcc = null;
      if (room.state !== 'waiting') {
        existing = socket._clientId
          ? [...room.playersById.values()].find(p => p.clientId === socket._clientId)
          : null;
        // 托管离开的玩家回来(按 username / accountId 定位) → 允许
        awayComeback = username
          ? [...room.playersById.values()].find(p => p.username === username && p.away)
          : null;
        awayComebackAcc = accountId
          ? [...room.playersById.values()].find(p => p.accountId === accountId && p.away)
          : null;
        if (!existing && !awayComeback && !awayComebackAcc) {
          return ack && ack({ ok: false, msg: '对局进行中，请等待本局结束再加入' });
        }
      }
      // 满员检查: 已在房间的玩家(断线重连/离开回来)不占新名额
      const alreadyIn = existing || awayComeback || awayComebackAcc;
      if (!alreadyIn && room.players.filter(p => p).length >= room.maxSeats) {
        return ack && ack({ ok: false, msg: '房间已满' });
      }

      // 轻量解绑旧房间: 不能调用 leaveRoom (它内部 removePlayer 会删除离开玩家的座位+强制弃牌)
      const oldRoomId = socketRoom.get(socket.id);
      if (oldRoomId && oldRoomId !== roomId) {
        socket.leave(oldRoomId);
        socketRoom.delete(socket.id);
      }
      // 清理该 socket 的 pendingJoin 快照 (断线重连窗口), 避免旧快照干扰
      pendingJoin.delete(socket.id);
      if (socket._clientId) {
        for (const [sid, snap] of pendingJoin) {
          if (snap.clientId === socket._clientId) pendingJoin.delete(sid);
        }
      }
      socketRoom.set(socket.id, roomId);
      socket.join(roomId);
      const player = room.addPlayer(socket.id, name, socket._clientId, accountId, username);
      if (!player) {
        // addPlayer 返回 null: 满员或同名玩家在线 (防止重复创建)
        const nameTaken = room.players.filter(p => p).some(p => !p.isBot && p.name === name && p.connected);
        return ack && ack({ ok: false, msg: nameTaken ? `昵称「${name}」已在房间中` : '加入失败' });
      }
      // 若返回的是断线重连的原玩家, 更新 socketId 使操作可用
      if (player.socketId !== socket.id) {
        const prevSid = player.socketId;
        player.socketId = socket.id;
        player.connected = true;
        room.clearSuspend(player); // 重新进入时清除挂起 (可能曾正轮到行动时掉线)
        // 若原连接仍在线(如同浏览器多开窗口顶号), 顶掉它避免一玩家多连接(幽灵: 能看不能操作)
        if (prevSid) {
          const oldSock = io.sockets.sockets.get(prevSid);
          if (oldSock && oldSock.connected && oldSock.id !== socket.id) {
            // 先发事件, 稍作延迟再断开, 确保 duplicate_login 送达客户端
            oldSock.emit('duplicate_login', { msg: '该账号已在其他设备登录，此处自动退出' });
            setTimeout(() => {
              try { if (oldSock.connected) oldSock.disconnect(true); } catch (e) { /* ignore */ }
            }, 300);
            console.log(`[加入接管] ${player.name} 新连接 ${socket.id} 顶掉旧连接 ${prevSid}`);
          }
        }
      }
      room.setReadyForce(socket.id, false);
      console.log(`[房] ${name} 加入 ${roomId}`);
      ack && ack({ ok: true, roomId });
      broadcastRoom(room);
      broadcastRoomList();
    } catch (e) {
      console.error('room:join 错误', e);
      ack && ack({ ok: false, msg: '服务器错误' });
    }
  });

  // ===== 观战: 不占座位, 只收公共状态 (看不到未摊牌的底牌) =====
  socket.on('room:spectate', (data = {}, ack) => {
    try {
      const roomId = String(data.roomId || '').trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) return ack && ack({ ok: false, msg: '房间不存在' });
      if (room.state === 'waiting') return ack && ack({ ok: false, msg: '对局尚未开始，无内容可看' });
      // 离开旧房间/旧观战 (轻量解绑, 不触碰玩家身份)
      const oldRoomId = socketRoom.get(socket.id) || spectatorRoom.get(socket.id);
      if (oldRoomId && oldRoomId !== roomId) {
        socket.leave(oldRoomId);
        socketRoom.delete(socket.id);
        spectatorRoom.delete(socket.id);
      }
      spectatorRoom.set(socket.id, roomId);
      socket.join(roomId);
      // 立即下发当前公共状态 + 观战标记
      const st = room.toState();
      st.spectating = true;
      socket.emit('room:state', st);
      console.log(`[观战] ${socket.id} 观战房间 ${roomId}`);
      ack && ack({ ok: true, roomId });
    } catch (e) {
      console.error('room:spectate 错误', e);
      ack && ack({ ok: false, msg: '服务器错误' });
    }
  });

  // ===== 观战坐下: 对局中则本局继续观战, 下一局正式参与; 等待中直接加入 =====
  socket.on('room:sit', (data = {}, ack) => {
    try {
      const roomId = spectatorRoom.get(socket.id);
      const room = roomId ? rooms.get(roomId) : null;
      if (!room) return ack && ack({ ok: false, msg: '你不在观战中' });
      if (room.players.filter(p => p).length >= room.maxSeats) return ack && ack({ ok: false, msg: '房间已满' });
      const name = String(data.name || '玩家').slice(0, 12) || '玩家';
      // 先退出观战, 再作为玩家加入 (若失败恢复观战)
      spectatorRoom.delete(socket.id);
      socket.leave(roomId);
      const player = room.addPlayer(socket.id, name, socket._clientId, data.accountId, data.username);
      if (!player) {
        spectatorRoom.set(socket.id, roomId);
        socket.join(roomId);
        const nameTaken = room.players.filter(p => p).some(p => !p.isBot && p.name === name && p.connected);
        return ack && ack({ ok: false, msg: nameTaken ? `昵称「${name}」已在房间中` : '加入失败' });
      }
      socketRoom.set(socket.id, roomId);
      socket.join(roomId);
      // 对局进行中坐下: 标记本局观战、下一局参与 (不破坏发牌/行动顺序)
      const sitNext = room.state !== 'waiting';
      if (sitNext) {
        player.sitNext = true;
        room.log(`${player.name} 观战坐下, 下一局正式参与`);
      }
      room.setReadyForce(socket.id, false);
      console.log(`[坐下] ${name} 在 ${roomId} 坐下${sitNext ? ' (下局参与)' : ''}`);
      ack && ack({ ok: true, roomId, sitNext });
      broadcastRoom(room);
      broadcastRoomList();
    } catch (e) {
      console.error('room:sit 错误', e);
      ack && ack({ ok: false, msg: '服务器错误' });
    }
  });

  // ===== 房间列表 =====
  socket.on('rooms:list', (data, ack) => {
    ack && ack({ ok: true, rooms: listRooms() });
  });

  // ===== 全局排行榜: 按账号 (username/accountId) 排名, 同一人只出现一次 =====
  socket.on('rank:list', (data = {}, ack) => {
    try {
      const merged = [];
      const linked = new Set(); // 已被正式账号关联(注册升级)的游客 accountId → 跳过
      for (const u of auth.listAll()) {
        if (u.guestAccountId) linked.add(u.guestAccountId);
        merged.push({
          account: u.username, kind: 'user',
          name: u.nickname || u.username,
          score: u.score, wins: u.wins, losses: u.losses
        });
      }
      for (const a of accounts.listAll()) {
        if (linked.has(a.accountId)) continue; // 同一个人已以正式账号上榜
        // 清理: 跳过从未参与对局的僵尸游客 (无战绩), 避免占满榜单
        if (a.wins + a.losses === 0 && a.score === 1000) continue;
        merged.push({
          account: a.accountId, kind: 'guest',
          name: a.name || '玩家',
          score: a.score, wins: a.wins, losses: a.losses
        });
      }
      merged.sort((x, y) => y.score - x.score || (y.wins - x.wins));
      const top = merged.slice(0, 50).map((r, i) => ({
        rank: i + 1,
        account: r.account,          // 稳定账号标识 (排名键)
        kind: r.kind,                // user=正式账号, guest=游客
        name: String(r.name).slice(0, 12),
        score: r.score,
        wins: r.wins,
        losses: r.losses,
        level: getLevelByScore(r.score)
      }));
      ack && ack({ ok: true, list: top, total: merged.length });
    } catch (e) {
      console.error('rank:list 错误', e);
      ack && ack({ ok: false });
    }
  });

  // ===== 重连（断线后拿回原身份）=====
  socket.on('room:rejoin', (opts = {}, ack) => {
    try {
      const clientId = String(opts.clientId || socket._clientId || '').slice(0, 64);
      const oldSocketId = String(opts.oldSocketId || '');
      const accountId = opts.accountId || undefined;
      const username = opts.username || undefined;
      // 被房主踢出者: 拒绝重连 (冷却至 5 分钟后自动解除)
      if (clientId && kickedClients.has(clientId)) {
        return ack && ack({ ok: false, msg: '你已被房主移出房间' });
      }
      // 安全校验: 旧连接若仍在线(未真正断开) → 仅同浏览器(clientId 相同, 如刷新页面)允许顶号;
      // 不同浏览器(多开窗口)拒绝, 防止互相踢
      const oldSock = oldSocketId ? io.sockets.sockets.get(oldSocketId) : null;
      if (oldSock && oldSock.connected && oldSocketId !== socket.id) {
        const sameClient = clientId && oldSock._clientId && clientId === oldSock._clientId;
        if (!sameClient) {
          return ack && ack({ ok: false, msg: '原连接仍在线，无法重连' });
        }
        // 同浏览器刷新: 旧连接将被顶掉, 断开它避免双连接
        oldSock.disconnect(true);
      }
      // 房间定位: 优先 clientId (稳定), 回退 oldSocketId
      let roomId = '';
      if (clientId) {
        for (const [sid, snap] of pendingJoin) {
          if (snap.clientId === clientId) { roomId = snap.roomId; break; }
        }
      }
      if (!roomId) roomId = socketRoom.get(oldSocketId);
      // 顶号场景: 新设备登录同账号 → 按 username 定位其在房间的玩家身份
      if (!roomId && username) {
        for (const room of rooms.values()) {
          const p = [...room.playersById.values()].find(x => x && x.username === username);
          if (p) { roomId = room.id; break; }
        }
      }
      if (!roomId) {
        return ack && ack({ ok: false, msg: '找不到原房间' });
      }
      const room = rooms.get(roomId);
      if (!room) return ack && ack({ ok: false, msg: '房间已关闭' });
      // 接管前先记录旧连接 id: reconnect 系列函数内部会立即把 p.socketId 换成新 socket.id,
      // 若在接管后才读 p.socketId 会拿到当前连接, 导致顶号逻辑永远失效(旧窗口变"幽灵"能看不能操作)。
      const oldP = (clientId && [...room.playersById.values()].find(x => x.clientId === clientId))
        || (oldSocketId && room.bySocket(oldSocketId))
        || (username && [...room.playersById.values()].find(x => x.username === username && !x.isBot))
        || (accountId && [...room.playersById.values()].find(x => x.accountId === accountId && !x.isBot))
        || (String(opts.name || '') && [...room.playersById.values()].find(x => x.name === String(opts.name) && !x.isBot));
      const oldSockId = oldP ? oldP.socketId : '';
      // 匹配玩家: 优先 clientId (socketId 每次断线都变, 不可靠), 其次旧 socketId, 最后按账号标识接管
      let p = (clientId && room.reconnectByClientId(clientId, socket.id, String(opts.name || '')))
        || room.reconnectPlayer(oldSocketId, socket.id, String(opts.name || ''))
        || room.reconnectByName(String(opts.name || ''), socket.id, clientId, accountId, username);
      if (p && oldSockId && oldSockId !== socket.id) {
        // 顶掉接管前同账号仍在线的那条旧连接, 避免一玩家多连接(被顶的人能回登录界面)
        const oldSock = io.sockets.sockets.get(oldSockId);
        if (oldSock && oldSock.connected && oldSock.id !== socket.id) {
          // 先发事件, 稍作延迟再断开, 确保 duplicate_login 送达客户端
          oldSock.emit('duplicate_login', { msg: '该账号已在其他设备登录，此处自动退出' });
          setTimeout(() => {
            try { if (oldSock.connected) oldSock.disconnect(true); } catch (e) { /* ignore */ }
          }, 300);
          console.log(`[接管] ${p.name} 新连接 ${socket.id} 顶掉旧连接 ${oldSockId}`);
        }
      }
      if (!p) {
        // 玩家可能已被移除 (断线超过窗口) → 尝试从快照恢复原座位与筹码
        let snap = clientId ? [...pendingJoin.values()].find(s => s.clientId === clientId) : null;
        if (!snap) snap = pendingJoin.get(oldSocketId);
        if (snap && snap.roomId === roomId) {
          const restored = room.restorePlayer(snap, socket.id);
          if (restored) {
            room.clearSuspend(restored); // 清除挂起(若曾正轮到行动时掉线)
            pendingJoin.delete(oldSocketId);
            socketRoom.delete(oldSocketId);
            socketRoom.set(socket.id, roomId);
            socket.join(roomId);
            // 发送个人状态: 重连玩家立即拿到自己的座位/手牌/筹码
            socket.emit('room:state:me', room.toStateFor(socket.id));
            ack && ack({ ok: true, roomId, restored: true });
            broadcastRoom(room);
            broadcastRoomList();
            return;
          }
        }
        return ack && ack({ ok: false, msg: '重连失败，请重新加入' });
      }
      room.clearSuspend(p); // 清除挂起(若曾正轮到行动时掉线) → 牌还在
      pendingJoin.delete(oldSocketId);
      socketRoom.delete(oldSocketId);
      socketRoom.set(socket.id, roomId);
      socket.join(roomId);
      // 发送个人状态: 重连玩家立即拿到自己的座位/手牌/筹码
      socket.emit('room:state:me', room.toStateFor(socket.id));
      ack && ack({ ok: true, roomId });
      broadcastRoom(room);
    } catch (e) {
      console.error('room:rejoin 错误', e);
      ack && ack({ ok: false, msg: '服务器错误' });
    }
  });

  // ===== 准备/确认 =====
  socket.on('player:ready', (data, ack) => {
    try {
      const room = currentRoom(socket);
      if (!room) return ack && ack({ ok: false, msg: '不在房间中' });
      const p = room.bySocket(socket.id);
      if (!p) return ack && ack({ ok: false, msg: '你不是玩家' });
      const r = room.setReady(socket.id);
      ack && ack(r);
      if (!r.ok) socket.emit('toast', r.msg);
    } catch (e) { console.error('player:ready 错误', e); ack && ack({ ok: false, msg: '服务器错误' }); }
  });

  // ===== 房主开始 =====
  socket.on('game:start', (data, ack) => {
    try {
      const room = currentRoom(socket);
      if (!room) return ack && ack({ ok: false, msg: '不在房间中' });
      const p = room.bySocket(socket.id);
      if (!p || p.id !== room.hostId) return ack && ack({ ok: false, msg: '只有房主可以开始' });
      const seated = room.players.filter(x => x);
      if (seated.length < 2) return ack && ack({ ok: false, msg: '至少需要 2 名玩家' });
      // 自动开局后(settle 全员确认→startHand) 不再接受手动 start
      if (room.state !== 'waiting') return ack && ack({ ok: false, msg: '对局已在进行' });
      // 有效玩家 = 在线且非托管离开 (离开置灰/断线未回的玩家下一局不参与, 无需等其准备)
      const active = seated.filter(x => !x.away && x.connected);
      if (!active.every(x => x.ready)) return ack && ack({ ok: false, msg: '还有玩家未准备' });
      const r = room.tryStart();
      ack && ack({ ok: r.ok, msg: r.msg || '' });
    } catch (e) { console.error('game:start 错误', e); ack && ack({ ok: false, msg: '服务器错误' }); }
  });

  // ===== 暂离/回到牌桌 已移除 (恢复原始断线逻辑) =====

  // ===== 离开房间 =====
  socket.on('room:leave', (data, ack) => {
    try {
      // 观战者退出: 只离开 socket.io 房间, 不触碰任何玩家身份
      const specRoomId = spectatorRoom.get(socket.id);
      if (specRoomId) {
        spectatorRoom.delete(socket.id);
        socket.leave(specRoomId);
        ack && ack({ ok: true, left: 'spectate' });
        return;
      }
      const room = currentRoom(socket);
      if (room) {
        // 托管离开: 不移除玩家, 标记离线并立即 AI 托管代打, 座位/手牌保留, 可 rejoin 回来
        room.markAway(socket.id);
        // 退出 socket.io 房间: 大厅中不再接收本房间广播(回来时 room:join/rejoin 会重新 join)
        socket.leave(room.id);
        socket.emit('toast', '已托管离开，AI 代打中');
        // 托管离开不算真人占位: 若房间已无其他真人(仅剩 bot/全托管) → 立即清理
        cleanupRoom(room.id);
        broadcastRoomList();
      }
      ack && ack({ ok: true });
    } catch (e) {
      console.error('room:leave 错误', e);
      ack && ack({ ok: false });
    }
  });

  // ===== 添加 AI 机器人 (仅房主) =====
  socket.on('room:addbot', (data = {}, ack) => {
    try {
      const room = currentRoom(socket);
      if (!room) return ack && ack({ ok: false, msg: '不在房间中' });
      const p = room.bySocket(socket.id);
      if (!p || p.id !== room.hostId) return ack && ack({ ok: false, msg: '只有房主可以添加机器人' });
      const r = room.addBot(data.name);
      ack && ack(r);
      if (r.ok) {
        broadcastRoom(room);
        broadcastRoomList();
      }
    } catch (e) {
      console.error('room:addbot 错误', e);
      ack && ack({ ok: false, msg: '服务器错误' });
    }
  });

  // ===== 向银行买筹码（欠款记账）=====
  socket.on('player:buyin', (data = {}, ack) => {
    try {
      const room = currentRoom(socket);
      if (!room) return ack && ack({ ok: false, msg: '不在房间中' });
      const r = room.buyIn(socket.id, Number(data.amount) || 1000);
      ack && ack(r);
      if (r.ok) socket.emit('toast', r.msg);
    } catch (e) { console.error('player:buyin 错误', e); ack && ack({ ok: false, msg: '服务器错误' }); }
  });

  // ===== 放弃游戏（输光后退出）=====
  socket.on('player:forfeit', (data, ack) => {
    try {
      const room = currentRoom(socket);
      if (!room) return ack && ack({ ok: false, msg: '不在房间中' });
      const r = room.forfeit(socket.id);
      ack && ack(r);
      if (r.ok) {
        socketRoom.delete(socket.id);
        // 彻底退出 socket.io 房间: 否则仍会收到 room:state/结算等广播, 大厅里弹出游戏信息
        socket.leave(room.id);
        cleanupRoom(room.id);
        socket.emit('toast', '已退出游戏');
        // 通知前端离开房间
        socket.emit('game:left');
        broadcastRoomList();
      }
    } catch (e) { console.error('player:forfeit 错误', e); ack && ack({ ok: false, msg: '服务器错误' }); }
  });

  // ===== 房主踢人 =====
  socket.on('player:kick', (data = {}, ack) => {
    try {
      const room = currentRoom(socket);
      if (!room) return ack && ack({ ok: false, msg: '不在房间中' });
      const r = room.kickPlayer(socket.id, String(data.playerId || ''));
      ack && ack(r);
      if (r.ok) {
        // 清理被踢者的重连快照, 防止其通过快照自动重连回房间
        for (const [sid, snap] of pendingJoin) {
          if (snap.id === r.targetId) pendingJoin.delete(sid);
        }
        pendingJoin.delete(r.targetSocketId);
        // 标记 clientId 为"已踢出": 即使其 socket 自动重连, room:join/room:rejoin 也会拒绝
        // (核心修复: 之前只发 game:kicked 事件, 但 disconnect(true) 关 socket 导致消息常丢失 → 客户端仍自动重连 → "踢不掉")
        if (r.targetClientId) {
          kickedClients.add(r.targetClientId);
          // 5 分钟后解除封禁, 允许被误踢的玩家重新加入
          setTimeout(() => kickedClients.delete(r.targetClientId), 5 * 60 * 1000);
        }
        // 通知被踢玩家（用移除前记录的 socketId）
        const targetSock = r.targetSocketId ? io.sockets.sockets.get(r.targetSocketId) : null;
        if (targetSock) {
          socketRoom.delete(r.targetSocketId);
          targetSock.emit('toast', '你已被房主移出房间');
          targetSock.emit('game:kicked');
          // 先发消息, 稍后再断开, 确保 game:kicked 能送达 (否则客户端不会清 pk_in_room, 会自动重连)
          setTimeout(() => {
            try { targetSock.disconnect(true); } catch (e) {}
            console.log(`[踢人] ${r.name} 已被 ${socket.id} 踢出并断开连接`);
          }, 200);
        }
        // 房间内其他人收到提示
        io.to(room.id).emit('toast', `${r.name} 已被移出房间`);
        broadcastRoom(room);
        broadcastRoomList();
      }
    } catch (e) { console.error('player:kick 错误', e); ack && ack({ ok: false, msg: '服务器错误' }); }
  });

  // ===== 游戏操作 =====
  socket.on('game:action', (data = {}, ack) => {
    try {
      const room = currentRoom(socket);
      if (!room) return ack && ack({ ok: false, msg: '不在房间中' });
      const r = room.doAction(socket.id, String(data.action || ''), Number(data.amount) || 0);
      ack && ack(r);
      if (r.ok && r.msg) socket.emit('toast', r.msg);
    } catch (e) { console.error('game:action 错误', e); ack && ack({ ok: false, msg: '服务器错误' }); }
  });

  // ===== 聊天 =====
  socket.on('chat:send', (data = {}, ack) => {
    try {
      const room = currentRoom(socket);
      if (!room) return ack && ack({ ok: false, msg: '不在房间中' });
      const p = room.bySocket(socket.id);
      const text = String(data.text || '').slice(0, 100).trim();
      if (!p || !text) return ack && ack({ ok: false, msg: '消息不能为空' });
      io.to(room.id).emit('chat:recv', {
        from: p.name,
        seat: p.seat,
        text,
        ts: Date.now()
      });
      ack && ack({ ok: true });
    } catch (e) { console.error('chat:send 错误', e); ack && ack({ ok: false }); }
  });

  // 牌力评估: 按需计算 (点开面板时调用, 避免每次广播算 9 次胜率拖慢服务器)
  socket.on('hand:eval', (data = {}, ack) => {
    try {
      const room = currentRoom(socket);
      if (!room) return;
      const he = room.evalHand(socket.id);
      ack && ack({ ok: !!he, handEval: he });
    } catch (e) { console.error('hand:eval 错误', e); ack && ack({ ok: false }); }
  });

  // ===== 断开 =====
  socket.on('disconnect', (reason) => {
    console.log(`[-] ${socket.id} 断开 (${reason})`);
    const room = currentRoom(socket);
    if (!room) return;
    const p = room.bySocket(socket.id);
    if (p) {
      // 快照 (供超时移除后重连恢复原筹码); clientId 是稳定标识
      const snap = { roomId: room.id, id: p.id, name: p.name, chips: p.chips, debt: p.debt, clientId: socket._clientId || '', accountId: p.accountId || undefined, username: p.username || undefined };
      // 掉线按行动超时处理: 若正轮到该玩家, 重启 45s 行动计时器, 超时自动过牌/弃牌 (不阻塞牌局)
      room.handleDisconnect(socket.id);
      // 保留 5 分钟重连窗口 (快照恢复筹码)
      pendingJoin.set(socket.id, snap);
      setTimeout(() => {
        if (pendingJoin.has(socket.id) && (!p.connected)) {
          pendingJoin.delete(socket.id);
          // 解除踢出封禁 (2 分钟窗口已过, 允许重新加入)
          if (p.clientId) kickedClients.delete(p.clientId);
          room.removePlayer(socket.id);
          socketRoom.delete(socket.id);
          cleanupRoom(room.id);
          broadcastRoom(room);
          broadcastRoomList();
        }
      }, 2 * 60 * 1000);
      broadcastRoom(room);
      broadcastRoomList();
    }
  });

  // 房间内发给自己也要广播，所以把当前房间的广播函数绑定好
  socket.on('disconnecting', () => {
    // noop
  });

  function currentRoom(sock) {
    const roomId = socketRoom.get(sock.id);
    return roomId ? rooms.get(roomId) : null;
  }

  function leaveRoom(sock) {
    const room = currentRoom(sock);
    if (!room) return;
    // 主动离开: 清理该客户端的重连快照, 防止离开后被自动 rejoin 拉回房间
    if (sock._clientId) {
      for (const [sid, snap] of pendingJoin) {
        if (snap.clientId === sock._clientId) pendingJoin.delete(sid);
      }
    }
    pendingJoin.delete(sock.id);
    room.removePlayer(sock.id);
    socketRoom.delete(sock.id);
    cleanupRoom(room.id);
    broadcastRoom(room);
    broadcastRoomList();
  }
});

/* ============ 房间自动清理: 每 60s 扫描 ============ */
setInterval(() => {
  for (const [roomId, room] of rooms.entries()) {
    // 保留条件: 至少一名真人且在房 (在线 或 断线重连窗口内)
    // 机器人、托管离开(away) 不算 → 纯 bot / 全托管 / 空房间直接删除
    const hasHuman = room.players.some(p => p && !p.isBot && !p.away);
    if (!hasHuman) {
      // 删除前结算仍在座真人玩家的当局积分
      try { room.settleAllScores(); } catch (e) { console.error('[清理] 结算积分失败:', e && e.message); }
      rooms.delete(roomId);
      console.log(`[清理] 房间 ${roomId} 已删除 (无真人玩家)`);
      broadcastRoomList();
    }
  }
  // 观战绑定清扫: 房间已被删除时释放对应观战者
  for (const [sid, rid] of spectatorRoom) {
    if (!rooms.has(rid)) spectatorRoom.delete(sid);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`🃏 德州扑克服务器已启动: http://localhost:${PORT}`);
  // 预热起手牌胜率表 (长牌/短牌各一次, 避免首个玩家发牌时卡顿; 命中磁盘缓存时近乎即时)
  setImmediate(() => {
    try {
      const t0 = Date.now();
      getWinRate([{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }], false);
      getWinRate([{ rank: 14, suit: 0 }, { rank: 14, suit: 1 }], true);
      console.log(`[预热] 起手牌胜率表就绪 (${Date.now() - t0}ms)`);
    } catch (e) { console.error('[预热] 失败:', e.message); }
    // vs N 对手胜率表: 磁盘缓存命中即加载; 否则后台异步分批构建 (不阻塞, 期间回退近似)
    buildWinRateTableMultiAsync(false).then(() => console.log('[预热] vs N 对手胜率表(长牌)就绪'));
    buildWinRateTableMultiAsync(true).then(() => console.log('[预热] vs N 对手胜率表(短牌)就绪'));
  });
});

/* ============ 健康监控: 事件循环阻塞检测 + 内存追踪 + 连接数日志 + 自愈 ============ */
const HEALTH_CHECK_MS = 15000;   // 每 15 秒检查一次
const BLOCKED_WARN_MS = 3000;    // 事件循环延迟 > 3s → 告警
const BLOCKED_EXIT_MS = 15000;   // 事件循环延迟 > 15s → 自愈重启(由守护脚本拉起)
let _lastBlockedLog = 0;
let _lastHeapMB = 0;

setInterval(() => {
  const start = Date.now();
  // 延迟到下一个 tick, 测量事件循环实际等待时间 (阻塞时远大于预期)
  setTimeout(() => {
    const latency = Date.now() - start - HEALTH_CHECK_MS;
    const sockets = io.engine.clientsCount;
    const roomCount = rooms.size;
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    // 内存增长趋势: 变化 >10MB 时采样
    if (Math.abs(heapMB - _lastHeapMB) > 10) {
      _lastHeapMB = heapMB;
      console.log(`[健康] 堆内存 ${heapMB}MB, 连接=${sockets}, 房间=${roomCount} (${[...rooms.keys()].join(',') || '空'})`);
    }
    if (latency > BLOCKED_WARN_MS && Date.now() - _lastBlockedLog > 60000) {
      _lastBlockedLog = Date.now();
      console.error(`[健康] ⚠ 事件循环延迟 ${Math.round(latency)}ms! 连接=${sockets} 房间=${roomCount} 堆=${heapMB}MB`);
      console.error(`[健康] 房间详情: ${[...rooms.keys()].join(',') || '(空)'}`);
      for (const [rid, room] of rooms) {
        console.error(`[健康]   房间 ${rid}: state=${room.state} 玩家=${room.players.filter(p => p).map(p => `${p.name}(${p.chips})`).join(',')}`);
      }
    }
    if (latency > BLOCKED_EXIT_MS) {
      console.error(`[健康] ✗ 事件循环阻塞超过 ${Math.round(latency)}ms, 自动退出等待守护脚本重启...`);
      process.exit(1);
    }
  }, HEALTH_CHECK_MS);
}, HEALTH_CHECK_MS);

// 连接数变化日志 (排查连接泄漏)
io.on('connection', (socket) => {
  if (io.engine.clientsCount % 5 === 0 || io.engine.clientsCount < 10) {
    console.log(`[连接] 当前连接数: ${io.engine.clientsCount}, 房间数: ${rooms.size}`);
  }
});
