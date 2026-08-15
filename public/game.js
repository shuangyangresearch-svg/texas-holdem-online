'use strict';
/* ===== 德州扑克 - 前端逻辑 ===== */

const $ = id => document.getElementById(id);
let socket = null;
let mySeat = -1;
let myId = null;
let roomState = null;
let spectating = false;   // 观战模式: 不占座位, 只看公共状态
let myCards = [];
let myName = localStorage.getItem('pk_name') || '';
// 正式账号会话: username + token (登录后持久化, 存 sessionStorage → 每个窗口独立,
// 同窗口刷新保留, 不同窗口不共享登录态, 需各自登录, 同一账号登录才会挤掉旧的)
function getAuth() {
  const token = sessionStorage.getItem('pk_token');
  const username = sessionStorage.getItem('pk_username');
  return (token && username) ? { token, username } : null;
}
function setAuth(token, username, nickname) {
  sessionStorage.setItem('pk_token', token);
  sessionStorage.setItem('pk_username', username);
  if (nickname) { localStorage.setItem('pk_name', nickname); myName = nickname; }
}
function clearAuth() {
  sessionStorage.removeItem('pk_token');
  sessionStorage.removeItem('pk_username');
}
// 统一取"展示名": 昵称优先(myName, 游客/登录后均指向昵称), 空时回退账号名
function displayName() {
  if (myName) return myName;
  const auth = getAuth();
  return (auth && auth.username) || '玩家';
}
// 账号唯一ID (轻量游客兜底): 本地生成并持久化
// 注意: 必须带 a_ 前缀 (服务端以此识别客户端已有 id, 否则会被视为新游客每次新建账号, 积分无法累计)
function getAccountId() {
  let aid = localStorage.getItem('pk_account_id');
  if (!aid || !String(aid).startsWith('a_')) {
    // 存量旧 id (crypto.randomUUID 生成的无前缀 UUID) 会导致服务端无法回读积分, 统一换为规范 id
    aid = 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    localStorage.setItem('pk_account_id', aid);
  }
  return aid;
}
// 下注飞筹追踪: 记录每个座位上次 bet, 用于检测增量触发飞筹动画
let _lastBets = {};
// socket_id 必须用 sessionStorage: 每个标签页独立, 避免多开窗口互相顶号
let savedOldSocket = sessionStorage.getItem('pk_socket_id') || '';

const SUIT_CHAR = ['♠', '♥', '♦', '♣'];
const RANK_CHAR = [0, 0, '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SEAT_CLASS = ['seat-pos-0', 'seat-pos-1', 'seat-pos-2', 'seat-pos-3', 'seat-pos-4',
  'seat-pos-5', 'seat-pos-6', 'seat-pos-7', 'seat-pos-8'];

/* ============ 随机昵称 ============ */
const NICK_NAMES = [
  '牌桌老手', '翻牌专家', '河牌女王', '皇家同花顺', '底池猎人', '盲注勇者',
  '顺子制造机', '葫芦大师', '慢打高手', '诈唬小王', '鱼塘霸主', '夜店赌神',
  '德州之王', '偷鸡一哥', '压轴选手', '天选之人', '好运常在', '微笑刺客',
  '冷静如冰', '火拼到底'
];
function randomName() {
  const n = NICK_NAMES[Math.floor(Math.random() * NICK_NAMES.length)];
  return n + Math.floor(Math.random() * 900 + 100); // 加 3 位数字防重复
}
/* 首次进入自动生成昵称; 之后记住 */
if (!myName) {
  myName = randomName();
  localStorage.setItem('pk_name', myName);
}

/* ============ 账号面板 (昵称即账号) ============ */
let _accountCache = null; // { name, score, wins, losses, level }
function updateAccountBar() {
  const bar = $('account-bar');
  if (!bar) return;
  const auth = getAuth();
  $('acc-name').textContent = (displayName() || '游客');
  // 账号面板加"退出登录"按钮 (已登录时)
  let logoutBtn = $('acc-logout');
  if (auth) {
    if (!logoutBtn) {
      logoutBtn = document.createElement('button');
      logoutBtn.id = 'acc-logout';
      logoutBtn.className = 'btn small ghost';
      logoutBtn.textContent = '退出';
      logoutBtn.style.marginLeft = '8px';
      logoutBtn.addEventListener('click', doLogout);
      bar.appendChild(logoutBtn);
    }
  } else if (logoutBtn) {
    logoutBtn.remove();
  }
  const draw = (acc) => {
    const lv = (acc && acc.level) || { icon: '🌱', name: '新手', level: 1 };
    $('acc-meta').textContent = acc
      ? `积分 ${acc.score} · 胜 ${acc.wins} 负 ${acc.losses}`
      : '游客';
    $('acc-level').innerHTML = `<span class="acc-icon">${lv.icon}</span><span class="acc-lvname">${lv.name}</span>`;
    $('acc-level').title = `Lv.${lv.level}` + (lv.nextName ? ` · 距${lv.nextName}还差 ${lv.toNext}` : ' · 已达最高段位');
  };
  draw(_accountCache);
  // 向服务端查询账号最新积分/等级 (正式账号带 token; 游客带 accountId)
  if (socket && socket.connected) {
    const payload = auth
      ? { token: auth.token, name: myName }
      : { name: myName, accountId: getAccountId() };
    socket.emit('account:info', payload, res => {
      if (res && res.ok) {
        if (res.authed && res.nickname) { myName = res.nickname; localStorage.setItem('pk_name', res.nickname); }
        if (res.accountId) localStorage.setItem('pk_account_id', res.accountId);
        _accountCache = res; draw(res);
      }
    });
  }
}

function doLogout() {
  const auth = getAuth();
  if (auth) socket && socket.emit('auth:logout', { token: auth.token });
  clearAuth();
  _accountCache = null;
  toast('已退出登录');
  showAuthScreen();
}

/* ============ Toast ============ */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* ============ 音频初始化与解锁 ============
   浏览器自动播放策略: 带声音的音频必须由用户手势解锁。
   - pointerdown 在部分浏览器(尤其 iOS 旧版)不算有效解锁手势, touchend/keydown 才算;
   - 因此保持常驻监听, 每次手势都 init+resume (均幂等且廉价), 并触发 AudioEngine 内部
     对"被拦截歌曲"的补播重试 → 保证 BGM 最终一定能响起来, 不再出现"部分浏览器没背景音乐"。 */
function initAudio() {
  if (window.AudioEngine) {
    AudioEngine.init();
    AudioEngine.resume();
  }
}
document.addEventListener('pointerdown', initAudio, { capture: true, passive: true });
document.addEventListener('touchend', initAudio, { capture: true, passive: true });
document.addEventListener('keydown', initAudio, { capture: true, passive: true });

/**
 * 自适应音乐张力计算 (0~1)
 * 驱动源: 底池规模40% + 行动强度35% + 未弃牌人数15% + 当前下注额10%
 * 说明: 若引擎为旧版 audio.js (无 music API) 则安全跳过
 */
function updateMusicTension(s) {
  if (!window.AudioEngine || !AudioEngine.music) return;
  try {
    let t = 0;
    const bb = (s.smallBlind || 5) * 2;
    // 1) 底池规模: pot 达到 20BB 即满张力
    t += 0.4 * Math.min(1, (s.pot || 0) / (bb * 20));
    // 2) 行动强度: 最近一次行动为加注/全下时抬升 (由 lastAction 字段驱动, 无则略)
    if (s.lastAction === 'raise') t += 0.35;
    else if (s.lastAction === 'allin') t += 0.45;
    // 3) 未弃牌人数占比
    const inHand = (s.players || []).filter(p => p && !p.folded).length;
    const total = Math.max(1, (s.players || []).filter(Boolean).length);
    t += 0.15 * (inHand / total);
    // 4) 当前下注额占比 (对当前玩家筹码)
    const me = s.you || (s.players && s.players[mySeat]);
    const curBet = s.currentBet || 0;
    const myStack = me ? (me.chips || 0) : 1000;
    t += 0.1 * Math.min(1, curBet / Math.max(1, myStack * 0.5));
    // 等待/结算阶段回归平静
    if (s.state === 'waiting' || s.state === 'settle') t = 0;
    AudioEngine.music.setTension(Math.round(t * 100) / 100);
  } catch (e) { /* 静默降级 */ }
}

/* 静音开关 + 音乐设置面板 */
function setupMute() {
  const buttons = [$('btn-mute'), $('btn-mute-lobby')].filter(Boolean);
  if (!buttons.length) return;
  const panel = $('music-panel');
  const refreshBtn = () => {
    const on = window.AudioEngine && (AudioEngine.isBGMOn() || AudioEngine.isSFXOn());
    buttons.forEach(b => b.classList.toggle('dim', !on));
  };
  const refreshPanel = () => {
    if (!window.AudioEngine) return;
    $('mp-bgm-toggle').textContent = AudioEngine.isBGMOn() ? '开' : '关';
    $('mp-sfx-toggle').textContent = AudioEngine.isSFXOn() ? '开' : '关';
    const cur = AudioEngine.getBGMStyle();
    document.querySelectorAll('.mp-style').forEach(b => {
      b.classList.toggle('active', b.dataset.style === cur);
      // "歌曲"按钮: 只有 music/ 目录有歌才显示
      if (b.dataset.style === 'song') b.classList.toggle('hidden', !AudioEngine.hasSongs());
    });
    $('mp-bgm-volume').value = Math.round(AudioEngine.getBGMVolume() * 100);
    // 歌曲播放器显隐 + 歌名
    const has = AudioEngine.hasSongs();
    const player = $('mp-song-player');
    if (player) player.classList.toggle('hidden', !has);
    if (has) {
      const info = AudioEngine.getSongInfo();
      const np = $('mp-now-playing');
      if (np) np.textContent = info.song ? info.song.replace(/\.(mp3|ogg|m4a|wav)$/i, '') : '—';
      $('mp-prev').disabled = info.total <= 1;
      $('mp-next').disabled = info.total <= 1;
    }
  };
  // 主按钮: 点击打开/关闭面板 (房间/大厅按钮一致)
  buttons.forEach(btn => btn.addEventListener('click', () => {
    initAudio();
    if (panel.classList.contains('hidden')) {
      refreshPanel();
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  }));
  // 面板内交互
  $('mp-bgm-toggle').addEventListener('click', () => {
    initAudio();
    AudioEngine.toggleBGM();
    refreshPanel(); refreshBtn();
  });
  $('mp-sfx-toggle').addEventListener('click', () => {
    initAudio();
    AudioEngine.toggleSFX();
    refreshPanel(); refreshBtn();
  });
  $('mp-bgm-volume').addEventListener('input', (e) => {
    initAudio();
    AudioEngine.setBGMVolume(e.target.value / 100);
  });
  // 歌曲播放器: 上一首 / 下一首 / 进度条
  const prevBtn = $('mp-prev'), nextBtn = $('mp-next'), progBar = $('mp-song-progress');
  let _curDur = 0;   // 当前歌曲时长缓存
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60), ss = s % 60;
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  };
  const updateTime = (info) => {
    if (!info || !info.song) return;
    if (info.duration > 0) _curDur = info.duration;   // 缓存时长供进度跳转
    if (progBar && info.duration > 0) {
      if (!progBar._seeking) progBar.value = Math.round((info.current / info.duration) * 1000);
    }
    const t = $('mp-song-time');
    if (t) t.textContent = fmtTime(info.current) + ' / ' + fmtTime(info.duration);
    const np = $('mp-now-playing');
    if (np) np.textContent = info.song.replace(/\.(mp3|ogg|m4a|wav)$/i, '');
    $('mp-prev').disabled = info.total <= 1;
    $('mp-next').disabled = info.total <= 1;
  };
  if (window.AudioEngine && AudioEngine.onSongProgress) {
    AudioEngine.onSongProgress(updateTime);
  }
  if (prevBtn) prevBtn.addEventListener('click', () => {
    initAudio();
    AudioEngine.prevSong();
    refreshPanel();
  });
  if (nextBtn) nextBtn.addEventListener('click', () => {
    initAudio();
    AudioEngine.nextSong();
    refreshPanel();
  });
  if (progBar) {
    progBar.addEventListener('input', () => { progBar._seeking = true; });
    progBar.addEventListener('change', (e) => {
      initAudio();
      if (_curDur > 0) AudioEngine.seekTo((e.target.value / 1000) * _curDur);
      progBar._seeking = false;
    });
  }
  document.querySelectorAll('.mp-style').forEach(b => {
    b.addEventListener('click', () => {
      initAudio();
      AudioEngine.setBGMStyle(b.dataset.style);
      AudioEngine.sfx.click();
      refreshPanel();
    });
  });
  // 点击面板外关闭
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !buttons.some(b => b === e.target || b.contains(e.target))) {
      panel.classList.add('hidden');
    }
  });
  refreshBtn();
}

/* 同浏览器唯一标识: 用于服务端去重 (一浏览器只能一个玩家) */
function getClientId() {
  // 用 sessionStorage: 同一标签页刷新保留(可重连回房间), 不同标签页各自独立(不共享),
  // 避免同一浏览器多开不同账号时 clientId 冲突导致互相挤号
  let cid = sessionStorage.getItem('pk_client_id');
  if (!cid) {
    cid = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('pk_client_id', cid);
  }
  return cid;
}

/* ============ 连接 Socket ============ */
function connect() {
  // 移动端适配: WebSocket 优先, 失败自动降级长轮询; 心跳放宽(手机后台节流不易误断)
  // 无限重连 + 快速重连; 页面回前台/网络恢复时手动补触发重连
  socket = io({
    // 轮询优先 + WebSocket 升级: 局域网/直连显著降低延迟; 升级失败自动回落长轮询 (与 server 一致)
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 300,
    reconnectionDelayMax: 3000,
    timeout: 20000,   // 连接建立超时放宽 (弱网/隧道握手慢)
    pingInterval: 25000,
    pingTimeout: 20000
  });

  // 手机锁屏/切后台 → 回前台: 若连接断开, 立即手动重连 (浏览器后台节流可能暂停自动重连)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && socket && !socket.connected) {
      socket.connect();
    }
  });
  // 网络恢复 (WiFi/4G 切换): 立即重连
  window.addEventListener('online', () => {
    if (socket && !socket.connected) socket.connect();
  });
  // 断网提示
  window.addEventListener('offline', () => {
    toast('网络已断开，恢复后自动重连', 'err');
  });
  // 定期自检: 连接意外断开且未自动重连时补一次
  setInterval(() => {
    if (socket && !socket.connected && !socket.active) {
      socket.connect();
    }
  }, 5000);
  // 大厅房间列表自动刷新: 让玩家不用手动刷新页面就能看到新开的房间
  // 仅在大厅且连接正常时轮询, 避免打扰房间内对局
  setInterval(() => {
    const lobbyActive = $('lobby') && $('lobby').classList.contains('active');
    const roomActive = $('room') && $('room').classList.contains('active');
    if (lobbyActive && !roomActive && socket && socket.connected) {
      fetchRoomList();
    }
  }, 6000);

  socket.on('connect', () => {
    console.log('已连接', socket.id);
    // 连接成功后立即拉取房间列表（可靠时机）
    fetchRoomList();
    // 同浏览器去重: 发送 clientId (一浏览器只能一个玩家)
    const clientId = getClientId();
    socket.emit('client:hello', { clientId });
    // 断线重连：尝试回到原房间 (仅当确实在房间中, 避免大厅也触发 rejoin 提示"找不到原房间")
    // 注意: pk_in_room 必须用 localStorage (而非 sessionStorage), 否则手机上滑退出关掉标签页后
    // 标记被清空, 重开页面不会触发 rejoin, 就"连不回去"了
    if (myName && localStorage.getItem('pk_in_room')) {
      socket.emit('room:rejoin', { clientId, oldSocketId: savedOldSocket, name: myName, accountId: getAccountId(), username: (getAuth() || {}).username }, res => {
        if (res && res.ok) {
          savedOldSocket = socket.id; // 更新为当前连接, 供下次重连
          toast('已重连回房间', 'ok');
          // 切回房间界面 (此时可能还在大厅/旧界面)
          showRoom(res.roomId || (roomState && roomState.id) || '');
        } else {
          // 重连失败(房间已关/被移除): 回到大厅, 避免卡在房间界面无法操作
          savedOldSocket = socket.id;
          localStorage.removeItem('pk_in_room');
          if (res && res.msg) toast(res.msg, 'err');
          roomState = null;
          mySeat = -1;
          $('room').classList.remove('active');
          $('lobby').classList.add('active');
          fetchRoomList();
        }
      });
    }
    sessionStorage.setItem('pk_socket_id', socket.id);
  });

  socket.on('disconnect', () => {
    toast('连接断开，正在重连…', 'err');
  });

  socket.on('room:state:me', s => {
    if (spectating) return; // 观战者无个人状态
    // 旧房间延迟到达的个人状态: 忽略 (已进新房间时不被覆盖)
    if (roomState && s.id && roomState.id && s.id !== roomState.id) return;
    // 房间界面未激活: 若这是"重连/接管回房"场景 (本地标记在房间中, 或 afterAuth 正在接管),
    // 缓存状态等 showRoom 渲染; 否则是主动离开/托管退出的迟到状态, 忽略 (避免大厅弹出游戏界面)
    const roomInactive = !$('room') || !$('room').classList.contains('active');
    if (roomInactive) {
      const takingOver = localStorage.getItem('pk_in_room') || _pendingTakeover;
      if (!takingOver) return; // 非重连/接管场景: 丢弃迟到状态
      // 重连/接管场景: 先更新身份信息, showRoom 会触发 render
      mySeat = s.you ? s.you.seat : -1;
      myId = s.you ? s.you.id : null;
      myCards = s.you ? s.you.cards : [];
      roomState = s;
      return;
    }
    // 房间切换时才重置飞筹追踪; 同房间每次广播不清空 → 弃牌等不触发假飞筹
    if (!roomState || (s.id && roomState.id && s.id !== roomState.id)) {
      _lastBets = {};
    }
    mySeat = s.you ? s.you.seat : -1;
    myId = s.you ? s.you.id : null;
    myCards = s.you ? s.you.cards : [];
    roomState = s;
    // 账号面板同步: 用服务端下发的本局实时积分/等级
    if (s.you) {
      _accountCache = { name: myName, score: s.you.score, wins: s.you.wins, losses: s.you.losses, level: s.you.level };
      updateAccountBar();
    }
    render();
  });

  socket.on('room:state', s => {
    // 观战者: 直接使用公共视图 (无 you/手牌), 渲染牌桌
    if (spectating) {
      if (roomState && s.id && roomState.id && s.id !== roomState.id) return;
      roomState = s;
      roomState.you = null;
      render();
      return;
    }
    // 公共视图（无手牌），合并我的信息
    if (!roomState || mySeat < 0) return;
    // 只接受当前房间的广播: 离开旧房间后其延迟广播会覆盖新房间状态(导致误判"已离开")
    if (s.id && roomState.id && s.id !== roomState.id) return;
    const prev = roomState;
    roomState = s;
    // 保留个人视图(you): 公共视图不含 you, 丢失后牌力面板/个人状态无法更新
    roomState.you = prev.you || null;
    if (mySeat >= 0 && s.players[mySeat]) {
      s.players[mySeat].cards = prev.players[mySeat] ? prev.players[mySeat].cards : myCards;
    }
    updateMusicTension(s);
    render();
  });

  socket.on('toast', m => toast(m, 'ok'));

  // 聊天消息
  socket.on('chat:recv', msg => {
    if (!msg || !msg.text) return;
    appendChatMsg(msg);
  });

  // 房间列表更新
  socket.on('rooms:list', rooms => {
    renderRoomList(rooms);
  });

  socket.on('game:left', () => {
    // 放弃后回到大厅
    savedOldSocket = '';
    sessionStorage.removeItem('pk_socket_id');
    localStorage.removeItem('pk_in_room');
    roomState = null;
    mySeat = -1;
    _accountCache = null; // 回到大厅重新拉取账号信息
    $('room').classList.remove('active');
    $('lobby').classList.add('active');
    resetChatUI();
    updateAccountBar();
    // 刷新房间列表
    fetchRoomList();
  });

  socket.on('game:kicked', () => {
    // 被房主移出房间
    toast('你已被房主移出房间', 'err');
    savedOldSocket = '';
    sessionStorage.removeItem('pk_socket_id');
    localStorage.removeItem('pk_in_room');
    roomState = null;
    mySeat = -1;
    $('room').classList.remove('active');
    $('lobby').classList.add('active');
    resetChatUI();
    fetchRoomList();
  });

  socket.on('duplicate_login', (data) => {
    // 单点登录: 该账号已在别处登录(或本浏览器开了新标签页), 当前连接被替换
    toast((data && data.msg) || '该账号已在其他设备登录', 'err');
    roomState = null;
    mySeat = -1;
    _accountCache = null;
    localStorage.removeItem('pk_in_room');
    localStorage.removeItem('pk_room_id');
    // 清除登录态, 回到登录界面 (账号被新设备接管)
    clearAuth();
    $('room').classList.remove('active');
    showAuthScreen();
    // 不再自动重连, 避免死循环
    savedOldSocket = '';
  });
}

/* ============ 行动倒计时 (服务端 actionDeadline 驱动) ============ */
const TURN_TIMEOUT_SEC = 45; // 与服务端 ACTION_TIMEOUT_MS 一致
function updateTurnCountdown(s) {
  const el = $('turn-countdown');
  if (!el) return;
  const me = s && s.you;
  const acting = me && !me.folded && !me.away
    && s.state !== 'waiting' && s.state !== 'showdown' && s.state !== 'settle'
    && s.currentPlayerId === me.id && s.actionDeadline;
  if (!acting) { el.classList.add('hidden'); return; }
  const remainMs = Math.max(0, s.actionDeadline - Date.now());
  const remain = Math.ceil(remainMs / 1000);
  const frac = Math.max(0, Math.min(1, remainMs / (TURN_TIMEOUT_SEC * 1000)));
  el.classList.remove('hidden');
  el.classList.toggle('warn', remain <= 15 && remain > 5);
  el.classList.toggle('danger', remain <= 5);
  const num = $('turn-countdown-num');
  if (num) num.textContent = remain;
  const fg = el.querySelector('.tc-ring-fg');
  if (fg) {
    const C = 2 * Math.PI * 15.5;
    fg.style.strokeDasharray = String(C);
    fg.style.strokeDashoffset = String(C * (1 - frac));
  }
}
// 300ms 平滑刷新 (渲染钩子之外持续走秒)
setInterval(() => {
  if (roomState && !document.hidden) updateTurnCountdown(roomState);
}, 300);

/* 渲染在线房间列表 */
let _roomListTries = 0;
function fetchRoomList() {
  if (!socket || !socket.connected) return;
  socket.emit('rooms:list', {}, res => {
    if (res && res.ok) {
      _roomListTries = 0;
      renderRoomList(res.rooms);
    } else if (_roomListTries < 3) {
      // 兜底重试
      _roomListTries++;
      setTimeout(fetchRoomList, 800);
    }
  });
}

/* 渲染在线房间列表 */
function renderRoomList(rooms) {
  const el = $('room-list');
  if (!el) return;
  if (!rooms || rooms.length === 0) {
    el.innerHTML = '<div class="room-list-empty muted">暂无可加入的房间，创建一个吧</div>';
    return;
  }
  el.innerHTML = rooms.map(r => {
    // 对局中(preflop/flop/turn/river/showdown)的房间也显示:
    // 离开的玩家可看到自己的房间并点击回来(服务端对托管离开的玩家放行回房)
    const playing = r.state && r.state !== 'waiting' && r.state !== 'settle';
    const stateLabel = r.state === 'settle' ? '本局结束' : (playing ? '对局中' : '等待中');
    return `
    <div class="room-item" data-room="${esc(r.id)}">
      <div class="ri-left">
        <div class="ri-name">房间 ${esc(r.id)}</div>
        <div class="ri-meta">房主 ${esc(r.host)} · ${r.count}/${r.max} 人 · 盲注 ${r.sb}/${r.bb} · ${stateLabel}</div>
      </div>
      <div class="ri-btns">
        <div class="ri-btn">${playing ? '进入' : '加入'}</div>
        ${playing ? '<div class="ri-btn spectate">观战</div>' : ''}
      </div>
    </div>
  `;
  }).join('');
  el.querySelectorAll('.room-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const code = item.dataset.room;
      // 观战按钮: 不加入, 只看对局
      if (e.target.closest('.ri-btn.spectate')) {
        startSpectate(code);
        return;
      }
      const name = $('join-name').value.trim() || myName;
      if (!name) return toast('请输入昵称', 'err');
      myName = name;
      localStorage.setItem('pk_name', name);
      socket.emit('room:join', { roomId: code, name: displayName(), accountId: getAccountId(), username: (getAuth() || {}).username }, res => {
        if (res && res.ok) {
          showRoom(res.roomId);
        } else {
          toast((res && res.msg) || '加入失败', 'err');
        }
      });
    });
  });
}

/* ============ 大厅交互 ============ */
function initLobby() {
  // 昵称同步: 两个输入框共用同一个昵称
  function syncName(val) {
    $('join-name').value = val;
    $('create-name').value = val;
    updateAccountBar(); // 昵称变化 → 刷新账号面板
  }
  syncName(myName);

  // 昵称输入框互相联动
  ['join-name', 'create-name'].forEach(id => {
    $(id).addEventListener('input', e => {
      myName = e.target.value.trim();
      syncName(myName);
      localStorage.setItem('pk_name', myName);
      updateAccountBar();
    });
  });

  // 换一个昵称
  function rerollName() {
    myName = randomName();
    syncName(myName);
    localStorage.setItem('pk_name', myName);
    updateAccountBar();
    toast(`昵称: ${myName}`, 'ok');
  }
  $('btn-random-name').addEventListener('click', rerollName);
  // 第二个"换一个"按钮 (创建面板)
  const r2 = $('btn-random-name2');
  if (r2) r2.addEventListener('click', rerollName);
  $('btn-random-name2').addEventListener('click', rerollName);

  // ===== 全局排行榜 =====
  const rankPanel = $('rank-panel');
  const rankList = $('rank-list');
  function openRank() {
    if (!socket || !socket.connected) return toast('连接未就绪', 'err');
    rankPanel.classList.remove('hidden');
    rankList.innerHTML = '<div class="rank-loading muted">加载中…</div>';
    socket.emit('rank:list', {}, res => {
      if (!res || !res.ok) { rankList.innerHTML = '<div class="rank-loading muted">排行榜获取失败</div>'; return; }
      $('rank-total').textContent = `共 ${res.total} 位玩家`;
      if (!res.list || !res.list.length) {
        rankList.innerHTML = '<div class="rank-loading muted">暂无玩家数据</div>';
        return;
      }
      rankList.innerHTML = res.list.map(r => {
        // "我"按账号判定 (正式=username, 游客=accountId), 与昵称/改名无关
        const myAccount = (getAuth() || {}).username || getAccountId();
        const me = r.account === myAccount;
        const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank;
        // 账号标识: 正式账号显示 @用户名 (昵称可重名, 账号唯一)
        const acctTag = r.kind === 'user' ? `<span class="rank-acct">@${esc(r.account)}</span>` : '';
        return `
          <div class="rank-row ${me ? 'me' : ''}">
            <span class="rank-pos">${medal}</span>
            <span class="rank-name">${esc(r.name)}${me ? ' (我)' : ''}${acctTag}</span>
            <span class="rank-lv">${r.level.icon} ${r.level.name}</span>
            <span class="rank-score">${r.score}</span>
            <span class="rank-wl muted">${r.wins}胜/${r.losses}负</span>
          </div>`;
      }).join('');
    });
  }
  $('btn-rank').addEventListener('click', openRank);
  $('rank-close').addEventListener('click', () => rankPanel.classList.add('hidden'));

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $('panel-join').classList.toggle('hidden', btn.dataset.tab !== 'join');
      $('panel-create').classList.toggle('hidden', btn.dataset.tab !== 'create');
    });
  });

  $('btn-join').addEventListener('click', doJoin);
  $('join-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') doJoin();
  });
  function doJoin() {
    const name = $('join-name').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    if (!name) return toast('请输入昵称', 'err');
    if (!code) return toast('请输入房间号', 'err');
    myName = name;
    localStorage.setItem('pk_name', name);
    socket.emit('room:join', { roomId: code, name: displayName(), accountId: getAccountId(), username: (getAuth() || {}).username }, res => {
      if (res && res.ok) {
        showRoom(res.roomId);
      } else {
        toast((res && res.msg) || '加入失败', 'err');
      }
    });
  }

  $('btn-create').addEventListener('click', () => {
    const auth = getAuth();
    const name = auth ? displayName() : $('create-name').value.trim();
    if (!name) return toast('请输入昵称', 'err');
    if (!auth) { myName = name; localStorage.setItem('pk_name', name); }
    socket.emit('room:create', {
      name,
      accountId: getAccountId(),
      username: (getAuth() || {}).username,
      // 标准德州规则: 小盲 = 大盲一半 (强制对齐, 忽略不匹配的小盲选择)
      sb: Math.max(1, Math.floor(+$('create-bb').value / 2)),
      bb: +$('create-bb').value,
      shortDeck: +$('create-rule').value === 1
    }, res => {
      if (res && res.ok) {
        showRoom(res.roomId);
        // 创建成功后自动复制邀请链接
        const url = location.origin + location.pathname + '?room=' + res.roomId;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(() => {
            toast(`房间 ${res.roomId} 已创建，邀请链接已复制，发给朋友即可加入`, 'ok');
          }).catch(() => {
            toast(`房间 ${res.roomId} 已创建，点右上角「复制邀请链接」发给朋友`, 'ok');
          });
        } else {
          toast(`房间 ${res.roomId} 已创建，点右上角「复制邀请链接」发给朋友`, 'ok');
        }
      } else {
        toast((res && res.msg) || '创建失败', 'err');
      }
    });
  });

  $('btn-copy-link').addEventListener('click', () => {
    if (!roomState) return;
    const url = location.origin + location.pathname + '?room=' + roomState.id;
    const full = `${url}\n房间号: ${roomState.id}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(full).then(() => toast('邀请链接已复制', 'ok'));
    } else {
      prompt('复制邀请信息:', full);
    }
  });

  $('btn-leave').addEventListener('click', () => {
    // 观战模式: 直接退出, 无需确认
    if (spectating) {
      socket.emit('room:leave', {}, () => exitSpectate());
      return;
    }
    if (!confirm('托管离开？AI 将代你继续打，座位保留，可回房继续或换房。')) return;    socket.emit('room:leave', {}, res => {
      roomState = null;
      mySeat = -1;
      myId = null;
      // 清除重连标识: 避免在大厅时 connect() 自动 rejoin 被拉回原房间(卡死出不去)
      // 服务端仍保留该玩家的托管座位, 想回来时点房间列表加入即可接管
      localStorage.removeItem('pk_in_room');
      savedOldSocket = '';
      $('room').classList.remove('active');
      $('lobby').classList.add('active');
      if (location.search) history.replaceState(null, '', location.pathname);
      $('showdown-panel').classList.add('hidden');
      $('stage-overlay').classList.add('hidden');
      $('turn-alert').classList.add('hidden');
      resetChatUI();
      fetchRoomList();
      toast('已托管离开，AI 代打中', 'ok');
    });
  });

  $('btn-addbot').addEventListener('click', () => {
    socket.emit('room:addbot', {}, res => {
      if (res && !res.ok) toast(res.msg || '添加失败', 'err');
      else if (res && res.ok) toast(`已添加 ${res.name}`, 'ok');
    });
  });

  // 观战者"坐下加入"
  const sitBtn = $('btn-sit');
  if (sitBtn) sitBtn.addEventListener('click', sitDown);

  // 牌力评估按钮: 点击切换显示, 打开时按需请求服务器计算 (不再每次广播算)
  $('btn-hand-eval').addEventListener('click', () => {
    const panel = $('hand-eval-panel');
    const willShow = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    if (willShow) {
      socket.emit('hand:eval', {}, res => {
        // 只缓存结果; 面板渲染由 render() 在每次状态更新时用缓存完成
        if (res && res.ok && res.handEval) myHandEval = res.handEval;
      });
    }
  });
  // 牌力面板关闭按钮 (任何时候都能关闭, 解决面板遮挡时关不了的问题)
  $('he-close').addEventListener('click', () => {
    $('hand-eval-panel').classList.add('hidden');
  });

  $('btn-buyin').addEventListener('click', () => {
    socket.emit('player:buyin', { amount: 1000 }, res => {
      if (!res || !res.ok) toast((res && res.msg) || '买入失败', 'err');
    });
  });

  $('btn-forfeit').addEventListener('click', () => {
    if (!confirm('确定退出本局并离开吗？将释放座位，可换房间。')) return;
    // 彻底退出: 清除重连标识, 防止被自动拉回; 服务端移除座位释放
    savedOldSocket = '';
    sessionStorage.removeItem('pk_socket_id');
    localStorage.removeItem('pk_in_room');
    socket.emit('player:forfeit', {}, res => {
      if (res && !res.ok) toast(res.msg || '操作失败', 'err');
    });
  });

  // 准备/开局按钮由 render() 统一绑定 onclick, 此处不再重复 addEventListener
  // (避免一次点击触发两次事件, 导致准备状态翻转无效)
}

function showRoom(roomId) {
  $('lobby').classList.remove('active');
  $('room').classList.add('active');
  $('room-code').textContent = `房间 ${roomId}`;
  // 记录"在房间中": 刷新/重连时才尝试自动回房, 避免大厅也触发 rejoin
  localStorage.setItem('pk_in_room', roomId);
  // 从 URL 移除 room 参数
  if (location.search) {
    history.replaceState(null, '', location.pathname);
  }
  // 竖屏窄屏首次进入房间: 提示横屏
  maybeShowRotateHint();
  // 关键修复: 重连时 room:state:me 可能先于 rejoin ack 到达被丢弃 (当时房间界面未 active),
  // showRoom 切换界面后必须立即渲染已有状态, 否则只剩静态底池/空牌桌
  if (roomState) render();
}

/* ============ 观战模式: 不占座位, 只看公共状态 (看不到未摊牌底牌) ============ */
function startSpectate(roomId) {
  if (!socket || !socket.connected) return toast('连接未就绪', 'err');
  socket.emit('room:spectate', { roomId }, res => {
    if (res && res.ok) enterSpectate(res.roomId);
    else toast((res && res.msg) || '观战失败', 'err');
  });
}
function enterSpectate(roomId) {
  spectating = true;
  roomState = null;
  mySeat = -1;
  myId = null;
  myCards = [];
  myHandEval = null;
  $('lobby').classList.remove('active');
  $('room').classList.add('active');
  $('room-code').textContent = `房间 ${roomId}`;
  $('room-meta').textContent = ' · 观战中';
  $('spectate-banner').classList.remove('hidden');
  $('btn-copy-link').classList.add('hidden');
  $('btn-addbot').classList.add('hidden');
  $('btn-forfeit').classList.add('hidden');
  $('btn-leave').textContent = '退出观战';
  $('btn-leave').classList.remove('danger');
  $('hand-eval-panel').classList.add('hidden');
  $('showdown-panel').classList.add('hidden');
  if (location.search) history.replaceState(null, '', location.pathname);
  maybeShowRotateHint();
}
function exitSpectate() {
  spectating = false;
  roomState = null;
  mySeat = -1;
  myId = null;
  myCards = [];
  myHandEval = null;
  $('spectate-banner').classList.add('hidden');
  $('btn-copy-link').classList.remove('hidden');
  $('btn-addbot').classList.remove('hidden');
  $('btn-leave').textContent = '离开';
  $('btn-leave').classList.add('danger');
  $('room').classList.remove('active');
  $('lobby').classList.add('active');
  $('showdown-panel').classList.add('hidden');
  $('stage-overlay').classList.add('hidden');
  $('turn-alert').classList.add('hidden');
  resetChatUI();
  fetchRoomList();
  toast('已退出观战', 'ok');
}

/* 观战者坐下加入: 对局中 → 本局观战、下局参与; 等待中 → 直接加入 */
function sitDown() {
  if (!socket || !socket.connected) return toast('连接未就绪', 'err');
  socket.emit('room:sit', {
    name: displayName(),
    accountId: getAccountId(),
    username: (getAuth() || {}).username
  }, res => {
    if (res && res.ok) {
      spectating = false;
      roomState = null;
      mySeat = -1;
      myId = null;
      $('spectate-banner').classList.add('hidden');
      $('btn-copy-link').classList.remove('hidden');
      $('btn-addbot').classList.remove('hidden');
      $('btn-leave').textContent = '离开';
      $('btn-leave').classList.add('danger');
      if (res.sitNext) toast('已坐下，本局观战，下一局正式参与', 'ok');
      else toast('已入座', 'ok');
      // 个人状态 (room:state:me) 由服务端广播到达后自动接管
    } else {
      toast((res && res.msg) || '入座失败', 'err');
    }
  });
}

/* 检测竖屏窄屏, 提示横屏游玩 */
function maybeShowRotateHint() {
  if (localStorage.getItem('pk_rotate_dismissed')) return;
  const isPortrait = window.matchMedia('(orientation: portrait) and (max-width: 640px)').matches;
  if (isPortrait) {
    const hint = $('rotate-hint');
    if (hint) hint.classList.remove('hidden');
  }
}

/* ============ 操作按钮 ============ */
// 最小合法加注目标额: currentBet + minRaise (超过全下时即全下)
// 说明: 服务端要求加注目标 >= currentBet + minRaise, 否则拒绝; 前端据此吸附避免提交非法值
// 模块级函数: 同时被 setupActions 与 renderActions 调用
function betMinRaiseTo(rs, max) {
  return Math.min(rs.currentBet + (rs.minRaise || rs.bb || 0), max);
}

// 下注额统一为 10 的整数倍 (与服务端校验一致; 盲注 20/10 起, 全链 10 倍数)
function snapTo10(v) {
  return Math.round(Number(v) / 10) * 10;
}

function setupActions() {
  setupMute();
  // 所有按钮点击播放音效 (音频引擎存在时)
  document.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.AudioEngine) AudioEngine.sfx.click();
    });
  });

  $('btn-fold').addEventListener('click', () => act('fold'));

  // 主操作按钮: 根据滑块值判断 过牌/跟注/加注/全下
  const betBtn = $('btn-bet');
  const slider = $('bet-slider');
  betBtn.addEventListener('click', () => {
    let val = +slider.value;
    const me = roomState && roomState.players[mySeat];
    if (!me) return;
    const toCall = Math.max(0, roomState.currentBet - me.bet);
    const max = me.chips + me.bet;
    if (val > max) val = max;   // 防御: 滑块值不得超过全下总额 (筹码不足跟注时强制全下)
    // 想加注但不足最小加注 → 自动吸附到最小合法加注额 (筹码不足时吸附为全下)
    const minRaiseTo = betMinRaiseTo(roomState, max);
    if (val > toCall && val < minRaiseTo) {
      val = minRaiseTo;
      slider.value = val;
      $('bet-input').value = val;
    }
    // 加注目标统一为 10 的整数倍 (全下除外)
    if (val > toCall && val < max) {
      val = snapTo10(val);
      if (val < minRaiseTo) { val = minRaiseTo; }  // snap 后不低于最小加注
      slider.value = val;
      $('bet-input').value = val;
    }
    if (val <= 0 && toCall === 0) {
      act('check');
    } else if (val >= max) {
      act('allin');
    } else if (val > toCall) {
      act('raise', val);
    } else {
      act('call');
    }
  });

  // 滑块实时更新按钮文案/颜色
  slider.addEventListener('input', () => {
    const me = roomState && roomState.players[mySeat];
    if (!me) return;
    const toCall = Math.max(0, roomState.currentBet - me.bet);
    const max = me.chips + me.bet;
    updateBetBtn(slider.value, toCall, max, betMinRaiseTo(roomState, max));
    $('bet-input').value = slider.value; // 同步数字输入框
  });

  // 数字输入框: 手动输入下注额, 与滑块双向同步
  // 注意: input 过程自由输入(不夹取最小值), 否则中间态被改写无法输入任意数字
  const betInput = $('bet-input');
  betInput.addEventListener('input', () => {
    _betEdited = true; // 用户手动编辑: render 不再重置输入框
    const me = roomState && roomState.players[mySeat];
    if (!me) return;
    const toCall = Math.max(0, roomState.currentBet - me.bet);
    const max = me.chips + me.bet;
    let v = Math.floor(Number(betInput.value));
    if (!isFinite(v) || v < 0) v = 0;
    // 仅当超过全下上限时才改写 (避免输入被干扰)
    if (v > max) { v = max; betInput.value = String(v); }
    slider.value = v;
    updateBetBtn(v, toCall, max, betMinRaiseTo(roomState, max));
  });
  // 失焦/回车: 规整输入 (此时已输入完成)
  betInput.addEventListener('change', () => {
    const me = roomState && roomState.players[mySeat];
    if (!me) return;
    const toCall = Math.max(0, roomState.currentBet - me.bet);
    const max = me.chips + me.bet;
    const minRaiseTo = betMinRaiseTo(roomState, max);
    let v = Math.floor(Number(betInput.value) || 0);
    if (toCall > max) {
      // 筹码不足跟注: 唯一动作是全下 (任何输入都按全下处理, 不再被改写为跟注额)
      v = max;
    } else {
      // 低于跟注额 → 规整为跟注
      if (v > 0 && v < toCall) { v = toCall; }
      // 想加注但不足最小加注 → 吸附到最小合法加注额
      if (v > toCall && v < minRaiseTo) { v = minRaiseTo; }
      // 加注目标统一为 10 的整数倍 (全下除外), snap 后仍不低于最小加注
      if (v > toCall && v < max) {
        v = snapTo10(v);
        if (v < minRaiseTo) v = minRaiseTo;
      }
    }
    if (v > max) v = max;
    betInput.value = String(v);
    slider.value = v;
    updateBetBtn(v, toCall, max, minRaiseTo);
  });

  // 自定义 ±10 步进按钮: 手机端(尤其 iOS)number 输入框无原生箭头, 统一用此按钮上下加注
  function stepBet(dir) {
    const me = roomState && roomState.players[mySeat];
    if (!me) return;
    const toCall = Math.max(0, roomState.currentBet - me.bet);
    const max = me.chips + me.bet;
    const minRaiseTo = betMinRaiseTo(roomState, max);
    let v = Math.floor(Number(betInput.value) || 0);
    if (!isFinite(v) || v < 0) v = 0;
    if (toCall > max) {
      v = max;                      // 筹码不足跟注: 步进即全下
    } else {
      v = snapTo10(v) + dir * 10;   // 以 10 为步长
      if (v < toCall) v = toCall;   // 不低于跟注额
      if (v > toCall && v < minRaiseTo) v = minRaiseTo; // 加注需达到最小加注额
    }
    if (v > max) v = max;           // 不超过全下
    if (v < 0) v = 0;
    betInput.value = String(v);
    slider.value = v;
    _betEdited = true;
    updateBetBtn(v, toCall, max, minRaiseTo);
  }
  const stepDown = $('bet-step-down');
  const stepUp = $('bet-step-up');
  if (stepDown) stepDown.addEventListener('click', () => stepBet(-1));
  if (stepUp) stepUp.addEventListener('click', () => stepBet(1));

  // ===== 聊天面板 =====
  const chatBtn = $('btn-chat');
  const chatPanel = $('chat-panel');
  const chatForm = $('chat-form');
  const chatInput = $('chat-input');
  if (chatBtn && chatPanel) {
    chatBtn.addEventListener('click', () => {
      chatPanel.classList.toggle('hidden');
      if (!chatPanel.classList.contains('hidden')) {
        _chatUnread = 0;
        const badge = $('chat-badge');
        if (badge) badge.classList.add('hidden');
        // 移动端: 面板折叠态, 点击输入框再展开消息列表
        chatPanel.classList.add('expanded');
        if (chatInput) chatInput.focus();
      }
    });
    // 点击面板 (桌面端点消息区 / 移动端点折叠条) 切换展开
    chatPanel.addEventListener('click', e => {
      if (e.target !== chatInput && e.target.tagName !== 'BUTTON') {
        chatPanel.classList.toggle('expanded');
      }
    });
    // 点击面板外自动收起 (与音乐面板交互一致)
    document.addEventListener('click', e => {
      if (chatPanel.classList.contains('hidden')) return;
      if (!chatPanel.contains(e.target) && !chatBtn.contains(e.target)) {
        chatPanel.classList.add('hidden');
      }
    });
  }
  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', e => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;
      socket.emit('chat:send', { text }, res => {
        if (res && !res.ok) toast(res.msg || '发送失败', 'err');
      });
      chatInput.value = '';
    });
    // 快捷表情: 点击即发送
    document.querySelectorAll('.chat-emoji').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const text = btn.dataset.text || '';
        if (!text) return;
        socket.emit('chat:send', { text }, res => {
          if (res && !res.ok) toast(res.msg || '发送失败', 'err');
        });
      });
    });
  }

  // ===== 快捷下注按钮 (固定金额 100/200/500/1000/全下) =====
  document.querySelectorAll('.bet-quick').forEach(qb => {
    qb.addEventListener('click', () => {
      const me = roomState && roomState.players[mySeat];
      if (!me) return;
      const s = roomState;
      const toCall = Math.max(0, s.currentBet - me.bet);
      const max = me.chips + me.bet;
      const minRaiseTo = betMinRaiseTo(s, max);
      const fixed = parseFloat(qb.dataset.fixed);
      let val;
      if (fixed < 0) {
        val = max; // 全下
      } else {
        // 固定金额: 若小于跟注额则至少跟注, 否则为固定金额 (吸附到合法范围)
        val = Math.max(fixed, toCall);
      }
      if (val > toCall && val < minRaiseTo) val = minRaiseTo; // 吸附到最小合法加注
      if (val > max) val = max;
      if (val < 0) val = 0;
      // 加注目标统一为 10 的整数倍 (全下除外)
      if (val > toCall && val < max) {
        val = snapTo10(val);
        if (val < minRaiseTo) val = minRaiseTo;
      }
      slider.value = val;
      $('bet-input').value = val;
      _betEdited = true;
      updateBetBtn(val, toCall, max, minRaiseTo);
    });
  });

  // ===== 桌面端快捷键 =====
  document.addEventListener('keydown', e => {
    // 输入框/表单聚焦时不拦截 (打字/聊天/下注输入)
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const me = roomState && roomState.players[mySeat];
    const inGame = me && !me.folded && !me.away && roomState.currentPlayerId === me.id
      && roomState.state !== 'waiting' && roomState.state !== 'showdown' && roomState.state !== 'settle';
    const k = e.key.toLowerCase();
    if (k === 'f') {
      e.preventDefault();
      if (inGame && !$('btn-fold').classList.contains('hidden')) act('fold');
    } else if (k === 'c') {
      e.preventDefault();
      if (inGame && !$('btn-bet').classList.contains('hidden')) $('btn-bet').click();
    } else if (k === 'r' || k === 'a') {
      e.preventDefault();
      if (inGame && !$('bet-quick-row').classList.contains('hidden')) {
        const target = k === 'a'
          ? $('bet-quick-row').querySelector('.bet-quick.allin')
          : $('bet-quick-row').querySelector('[data-fixed="500"]');
        if (target) target.click();
      }
    }
  });

  $('sd-close').addEventListener('click', () => {
    $('showdown-panel').classList.add('hidden');
  });

  // 横屏提示关闭
  $('rh-close-btn').addEventListener('click', () => {
    $('rotate-hint').classList.add('hidden');
    localStorage.setItem('pk_rotate_dismissed', '1');
  });
  // 横竖屏切换时自动隐藏提示
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      const isPortrait = window.matchMedia('(orientation: portrait)').matches;
      if (!isPortrait) $('rotate-hint').classList.add('hidden');
    }, 200);
  });
}

function act(action, amount) {
  // 操作音效 (v2: 按行动类型区分, 全部走事件化 API; 引擎缺失时静默)
  if (window.AudioEngine && AudioEngine.play) {
    const ev = action === 'fold' ? 'sfx:player:fold'
      : action === 'check' ? 'sfx:player:check'
      : action === 'allin' ? 'sfx:chips:allin'
      : action === 'raise' ? 'sfx:chips:raise'
      : 'sfx:chips:call';
    AudioEngine.play(ev);
  } else if (window.AudioEngine) {
    if (action === 'fold') AudioEngine.sfx.fold();
    else if (action === 'check') AudioEngine.sfx.click();
    else AudioEngine.sfx.chip();
  }
  socket.emit('game:action', { action, amount }, res => {
    if (res && !res.ok) toast(res.msg || '操作失败', 'err');
  });
}

/* 更新按钮文字, 保留图标结构 (按钮内是 <span class=btn-icon> + <span class=btn-text>) */
function setBtnText(btn, text) {
  if (!btn) return;
  const t = btn.querySelector('.btn-text');
  if (t) t.textContent = text;
  else btn.textContent = text;
}

/* ============ 渲染 ============ */
let _lastState = '';   // 记录上次阶段, 用于状态流转提示
let _lastAlertAt = 0;  // 出牌提醒防抖
let _betEdited = false; // 用户手动编辑过下注输入框 (render 不再重置)
let _lastCommRound = -1; // 公共牌已渲染的局数 (round 变化时清空, 防止残留上一局)
let myHandEval = null;   // 牌力评估结果 (按需请求, 避免每次广播计算)
let _chatUnread = 0;    // 聊天未读数 (面板隐藏时累计, 用于红点提醒)
let _pageBaseTitle = document.title; // 页面原始标题 (轮到行动提醒后恢复用)

/* 追加一条聊天消息到面板, 面板隐藏时累计未读数 */
function appendChatMsg(msg) {
  const list = $('chat-list');
  if (!list) return;
  const div = document.createElement('div');
  div.className = 'chat-msg' + (msg.sys ? ' sys' : '');
  // 自己发的消息: 按座位号匹配 (服务端只下发 from/seat/text)
  const isSelf = msg.seat === mySeat && !msg.sys;
  const who = isSelf ? `<span class="who me">${esc(msg.from || '我')}</span>` : `<span class="who">${esc(msg.from || '玩家')}</span>`;
  div.innerHTML = `${who}<span class="txt">${esc(msg.text)}</span>`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  // 面板隐藏时显示未读红点
  const panel = $('chat-panel');
  const badge = $('chat-badge');
  if (panel && panel.classList.contains('hidden') && badge && !isSelf && !msg.sys) {
    _chatUnread++;
    badge.textContent = _chatUnread > 9 ? '9+' : _chatUnread;
    badge.classList.remove('hidden');
  }
}

/* 离开房间时清理: 关闭聊天面板并清空消息 */
function resetChatUI() {
  const panel = $('chat-panel');
  if (panel) {
    panel.classList.add('hidden');
    panel.classList.remove('expanded');
  }
  const list = $('chat-list');
  if (list) list.innerHTML = '';
  const badge = $('chat-badge');
  if (badge) badge.classList.add('hidden');
  _chatUnread = 0;
  notifyMyTurn(false);
}

/* 轮到行动时的提醒: 标签页标题 + 浏览器通知 (仅后台时, 避免打扰) */
function notifyMyTurn(isTurn) {
  if (isTurn) {
    if (document.hidden) {
      document.title = '⏰ 轮到你行动!';
      // 浏览器通知 (需用户授权, 失败静默)
      try {
        if (window.Notification && Notification.permission === 'granted') {
          new Notification('德州扑克', { body: '轮到你行动了!', tag: 'pk-turn' });
        }
      } catch (e) { /* ignore */ }
    }
  } else if (document.title !== _pageBaseTitle) {
    document.title = _pageBaseTitle;
  }
}

/* 渲染牌力面板 (按需计算后渲染, 含同色/同花标签) */
function renderHandEval(he, me, s) {
  if (!he) return;
  const wrHtml = he.winrate !== null ? `<div class="he-wr">起手胜率 <b>${he.winrate}%</b> <span class="muted">(vs 随机)</span></div>` : '';
  // 同色(同花)标记: 两张底牌同一花色
  const suitedHtml = he.suited ? '<span class="he-suited">同色</span>' : '<span class="he-suited off">不同色</span>';
  $('he-handname').innerHTML = `${esc(he.name)} ${suitedHtml} ${wrHtml}`;

  // 牌型大小 9 档条
  if (he.rankList && he.rank >= 0) {
    const cells = he.rankList.map((n, i) =>
      `<div class="he-rank-cell ${i === he.rank ? 'mine' : ''}">${n}</div>`
    ).join('');
    $('he-rank-list').innerHTML = cells;
  }
  // vs 对手人数胜率柱状图 (1-9 人, 8 档色标)
  if (he.winratesByOpponents && he.winratesByOpponents.length === 9) {
    $('he-multi').innerHTML = renderWinRateBars(he.winratesByOpponents);
  } else {
    $('he-multi').innerHTML = '';
  }
  // 起手牌 13×13 网格 (gridTiers 已改为随 hand:eval 按需下发, 不再随每次房间广播)
  $('he-grid').innerHTML = renderHandGrid(me && me.cards ? me.cards : [], he.shortDeck, (he && he.gridTiers) || (s && s.gridTiers));
  const best5 = he.best5 || [];
  $('he-best5').innerHTML = best5.length === 5 ? best5.map(cardHTML).join('') : '<span class="muted">手牌不足</span>';
}
let _betInitKey = '';   // 下注输入框初始化键 (新轮次才重置)

/* 操作历史信息框: 顶部小条显示最新操作, 点击展开全部历史 */
let _ahExpanded = false;
function renderActionHistory(s) {
  const ah = $('action-history');
  const bar = $('ah-bar');
  const textEl = $('ah-text');
  const listEl = $('ah-list');
  if (!ah) return;
  const logs = s.actionLog || [];
  // 对局中/等待/结算 都显示; 仅开局前(waiting)无历史时隐藏
  if (logs.length === 0) {
    ah.classList.add('hidden');
    return;
  }
  ah.classList.remove('hidden');
  // 最新一条
  textEl.textContent = (s.lastAction && s.lastAction.text) || logs[logs.length - 1].text;
  // 展开历史列表 (倒序: 最新在上)
  const rows = logs.slice().reverse().map(l => `<div class="ah-row">${esc(l.text)}</div>`).join('');
  listEl.innerHTML = `<div class="ah-scroll">${rows}</div>`;
  listEl.classList.toggle('hidden', !_ahExpanded);
  bar.classList.toggle('ah-open', _ahExpanded);   // 历史面板标记; expanded 已专用于"加注条常驻展开"
  $('ah-toggle').textContent = _ahExpanded ? '⌃' : '⌄';
}

/* ===== 下注动作标签特效: 玩家框上方弹出 BET/2BET/3BET/ALL IN/跟注/加注 标签 ===== */
let _lastActionTagKey = '';    // 已处理的 lastAction 标识 (text|ts)
let _tagStreet = '';           // 当前 street, 变化时重置加注计数
let _raiseCount = 0;           // 本轮(街)加注次数

function triggerActionTag(s) {
  if (!s || !s.lastAction) return;
  const la = s.lastAction;
  const key = (la.text || '') + '|' + (la.ts || 0);
  if (key === _lastActionTagKey) return;
  _lastActionTagKey = key;
  // street 变化 → 加注计数清零 (每条街从 bet 重新数)
  const street = s.state || '';
  if (street !== _tagStreet) {
    _tagStreet = street;
    _raiseCount = 0;
  }
  const text = la.text || '';
  // 找动作玩家: 文本以玩家名开头
  const actor = (s.players || []).find(p => p && text.indexOf(p.name) === 0);
  if (!actor) return;
  // 解析动作类型
  let tag = null, cls = '';
  if (text.indexOf('全下') >= 0) {
    tag = 'ALL IN'; cls = 'allin';
  } else if (text.indexOf('加注到') >= 0) {
    // 区分 Bet(本轮首个下注) 与 Raise(有人下注后的加注):
    // currentBet 为 0 = 还没人主动下注 → BET; 否则 → RAISE (再按次数 2/3-RAISE)
    const isFirstBet = (s.currentBet || 0) === 0 && _raiseCount === 0;
    _raiseCount++;
    if (isFirstBet) { tag = 'BET'; cls = 'bet'; }
    else if (_raiseCount <= 2) { tag = 'RAISE'; cls = 'raise'; }
    else if (_raiseCount === 3) { tag = '2-RAISE'; cls = 'r2'; }
    else { tag = '3-RAISE'; cls = 'r3'; }
  } else if (text.indexOf('跟注') >= 0) {
    tag = 'CALL'; cls = 'call';
  } else if (text.indexOf('下盲注') >= 0) {
    tag = 'BLIND'; cls = 'blind';
  } else if (text.indexOf('弃牌') >= 0) {
    tag = 'FOLD'; cls = 'fold';
  }
  if (!tag) return; // 过牌等其他动作不弹标签 (太频繁)
  // 在玩家框上方弹出 (动画 2.2s 上浮淡出, 慢速便于看清)
  const el = document.querySelector(`.pcell[data-seat="${actor.seat}"]`) || document.querySelector(`.seat[data-seat="${actor.seat}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const tagEl = document.createElement('div');
  tagEl.className = 'action-tag ' + cls;
  tagEl.textContent = tag;
  tagEl.style.left = (r.left + r.width / 2) + 'px';
  tagEl.style.top = (r.top - 6) + 'px';
  document.body.appendChild(tagEl);
  setTimeout(() => tagEl.remove(), 2400);
}


let _lastCommentText = '';
let _commentTimer = null;
let _commentEl = null;

function commentaryFor(s, text) {
  const actor = (s.players || []).find(p => p && text.indexOf(p.name) === 0);
  if (!actor) return null;
  const name = (actor.name || '').trim();
  const persona = actor.persona || '';
  const r = Math.random();
  if (text.indexOf('全下') >= 0) {
    return persona.indexOf('诈') >= 0
      ? `【${name}】直接全下！虚张声势还是真有货？`
      : `【${name}】梭哈全下，拼了！`;
  }
  if (text.indexOf('加注到') >= 0) {
    const m = text.match(/加注到\s*(\d[\d,]*)/);
    const amt = m ? m[1] : '';
    return r < 0.5
      ? `【${name}】加注到 ${amt}，看来手里有货`
      : `【${name}】重锤 ${amt}${persona ? `，${persona}风格拉满` : '，气势汹汹'}`;
  }
  if (text.indexOf('跟注') >= 0) {
    const m = text.match(/跟注\s*(\d[\d,]*)/);
    const amt = m ? m[1] : '';
    return r < 0.4
      ? `【${name}】跟注 ${amt}，胆子不小`
      : `【${name}】稳稳跟注，还藏着一手`;
  }
  if (text.indexOf('弃牌') >= 0) {
    return r < 0.5
      ? `【${name}】这手弃了？太稳了吧`
      : `【${name}】果断弃牌，不恋战`;
  }
  return null;  // 过牌/其他: 太平常不解说
}

function showCommentary(msg) {
  if (!_commentEl) {
    _commentEl = document.createElement('div');
    _commentEl.id = 'commentary';
    document.body.appendChild(_commentEl);
  }
  _commentEl.textContent = msg;
  _commentEl.classList.remove('show');
  void _commentEl.offsetWidth;  // 强制重启动画
  _commentEl.classList.add('show');
  if (_commentTimer) clearTimeout(_commentTimer);
  _commentTimer = setTimeout(() => _commentEl.classList.remove('show'), 3200);
}

// 浏览器缩放/窗口变化: 防抖重渲染, 保证座位/牌尺寸立即对齐 (避免视觉错乱)
(function initResize() {
  let t = null;
  window.addEventListener('resize', () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { if (typeof render === 'function') render(); }, 120);
  });
  window.addEventListener('orientationchange', () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { if (typeof render === 'function') render(); }, 200);
  });
})();

// 点击切换展开 (script 在 body 末尾加载, DOM 已就绪)
(function initAh() {
  const bar = document.getElementById('ah-bar');
  if (bar) {
    bar.addEventListener('click', () => {
      _ahExpanded = !_ahExpanded;
      const listEl = document.getElementById('ah-list');
      if (listEl) listEl.classList.toggle('hidden', !_ahExpanded);
      const toggle = document.getElementById('ah-toggle');
      if (toggle) toggle.textContent = _ahExpanded ? '⌃' : '⌄';
      bar.classList.toggle('ah-open', _ahExpanded);
    });
  }
})();

/* 视口自适应: 用 visualViewport(真实可见区域, 排除浏览器地址栏/导航条) + 实测操作条高度,
   自动适配不同手机(浏览器工具栏/系统导航条高度各异, 固定让位值不准) */
function measureExpandedBarHeight() {
  /* 操作条折叠时只有一条信息栏(~60px), 轮到我展开后 ~220px;
     若按折叠高度预留, 展开的加注条会盖住桌子底部座位/手牌 → 必须按展开高度预留 */
  const bar = document.getElementById('action-bar');
  if (!bar) return 150;
  const wasMyTurn = bar.classList.contains('my-turn');
  if (!wasMyTurn) bar.classList.add('my-turn');   // 临时展开, 立即读取同步布局高度
  // 展开内容由 JS 的 .hidden 控制 (display:none !important, CSS 无法覆盖):
  // 临时去掉操作条内所有 hidden 元素再测, 得到"轮到我行动"时的真实展开高度
  const hiddenEls = Array.prototype.slice.call(bar.querySelectorAll('.hidden'));
  hiddenEls.forEach(el => el.classList.remove('hidden'));
  // 展开高度还取决于文字内容 (空内容时操作条更矮) → 填代表性文字再测, 测完还原
  const fills = [
    ['action-info', '轮到你行动 · 筹码 1000'],
    ['bet-range-hint', '最小加注到 200'],
    ['bet-amount', '1000'],
    ['bet-min-label', '跟注 100'],
    ['bet-max-label', '全下 10000']
  ];
  const savedTxt = fills.map(([id]) => {
    const el = document.getElementById(id);
    const t = el ? el.textContent : null;
    if (el) el.textContent = fills.find(f => f[0] === id)[1];
    return [el, t];
  });
  const h = bar.offsetHeight;
  savedTxt.forEach(([el, t]) => { if (el && t !== null) el.textContent = t; });
  hiddenEls.forEach(el => el.classList.add('hidden'));
  if (!wasMyTurn) bar.classList.remove('my-turn');
  return Math.max(h || 0, 150);
}
function updateViewportVars() {
  const vv = window.visualViewport;
  // 真实可见尺寸: 浏览器地址栏/导航条占的像素不算 (innerHeight/innerWidth 含浏览器条, 会算大)
  const vw = vv && vv.width > 0 ? vv.width : window.innerWidth;
  const vh = vv && vv.height > 0 ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--vh', vh + 'px');
  document.documentElement.style.setProperty('--vw', vw + 'px');
  // 操作条展开高度 (render 末尾缓存真实值, 初始化用模拟测量)
  let barH = _lastRealBarH || measureExpandedBarHeight();
  document.documentElement.style.setProperty('--actionbar-h', barH + 'px');
  const barH2 = _lastRealBarH || measureExpandedBarHeight();
  if (barH2 !== barH) document.documentElement.style.setProperty('--actionbar-h', barH2 + 'px');
  // 长方形桌: 不设固定比例, 宽高均铺满剩余空间 (table-wrap 内容区)
  // 竖屏时剩余空间天然竖长条, 横屏/桌面天然横长条 —— 一套逻辑通吃, 无需分屏分支
  document.documentElement.style.setProperty('--table-ar', 'auto');
  document.documentElement.style.setProperty('--table-h', '100%');
  document.documentElement.style.setProperty('--table-w', '100%');
}

/* 真实操作条展开高度缓存: render 末尾 (bar 常驻展开且内容真实渲染后) 更新,
   updateViewportVars 优先用它, 比模拟测量 (measureExpandedBarHeight) 更准 */
let _lastRealBarH = 0;
(function initViewport() {
  const apply = () => {
    updateViewportVars();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportVars);
      window.visualViewport.addEventListener('scroll', updateViewportVars);
    }
    window.addEventListener('resize', updateViewportVars);
    window.addEventListener('orientationchange', () => setTimeout(updateViewportVars, 250));
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();

function render() {
  if (!roomState) return;
  const s = roomState;
  updateTurnCountdown(s); // 行动倒计时 (轮到自己时显示剩余秒数)

  // 自检: 用 player id 重定位 mySeat (接管时 server 可能复用旧 player 但 seat 错位或我 seat 变化)
  //   避免旧 mySeat 指向别的玩家 → 误判"我已离开" → 回大厅 → 永不渲染
  if (myId && s.players) {
    const meIdx = s.players.findIndex(p => p && p.id === myId);
    if (meIdx >= 0) {
      if (meIdx !== mySeat) mySeat = meIdx;  // 接管/换座位时重定位
    } else if (mySeat >= 0) {
      // 我真的不在 players 里(被踢/超时清) → 回大厅
      roomState = null;
      mySeat = -1;
      $('room').classList.remove('active');
      $('lobby').classList.add('active');
      fetchRoomList();
      toast('你已离开房间，请重新加入', 'err');
      return;
    }
  }
  updateViewportVars(); // 每次渲染刷新视口/操作条测量 (操作条展开收起时高度变化)

  $('room-meta').textContent = `· ${s.players.filter(p => p).length}/${s.maxSeats} 人 · 盲注 ${s.sb}/${s.bb}`;

  // 底池 (含数字变化脉冲: 纯视觉, transform-only 合成路径)
  const potEl = $('pot-value');
  const newPot = s.pot || 0;
  if (potEl.textContent !== String(newPot)) {
    potEl.textContent = newPot;
    potEl.classList.remove('bump');
    void potEl.offsetWidth; // 强制回流重触发动画
    potEl.classList.add('bump');
  }
  // 最多可赢 (主池+我能参与的边池): 全下最多能拿回的金额
  const maxWinEl = $('pot-maxwin');
  if (maxWinEl) {
    const mw = (s.you && s.you.maxWin) || 0;
    const mwTxt = mw > 0 ? `最多可赢 ${mw}` : '';
    if (maxWinEl.textContent !== mwTxt) maxWinEl.textContent = mwTxt;
  }

  // 阶段 + 状态流转提示 (阶段文字显示在操作条 info, 不放在牌桌上避免压盖座位)
  const stageMap = { waiting: '等待开局', preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '结算', settle: '等待确认' };
  const stageBanner = $('stage-banner');
  const stageText = stageMap[s.state] || '';
  stageBanner.textContent = stageText;
  if (s.state !== _lastState) {
    stageBanner.classList.remove('big');
    // 强制重流动画
    void stageBanner.offsetWidth;
    stageBanner.classList.add('big');
    // 每个阶段都有显著提示 (含 发牌/翻牌/转牌/河牌/结算确认)
    if (s.state !== 'waiting') {
      toast(`→ ${stageText}`, 'ok');
      // 阶段音效
      if (window.AudioEngine) {
        const sfx = AudioEngine.sfx;
        if (s.state === 'flop') sfx.flop();
        else if (s.state === 'turn') sfx.turn();
        else if (s.state === 'river') sfx.river();
        else if (s.state === 'preflop') sfx.deal();
        else if (s.state === 'settle') sfx.chip();
      }
      // 全屏阶段提示层
      const overlay = $('stage-overlay');
      const overlayText = $('stage-overlay-text');
      overlayText.textContent = stageText;
      overlay.classList.remove('hidden');
      overlay.style.animation = 'none';
      void overlay.offsetWidth;
      overlay.style.animation = '';
      setTimeout(() => overlay.classList.add('hidden'), 2000);
    }
    _lastState = s.state;
  }

  // 操作历史信息框 (顶部小条 + 点击展开历史)
  renderActionHistory(s);

  // 解说说书: 关键行动弹解说气泡。轮到我行动时抑制 (避免口水文抢占"轮到你"的主次)
  if (s.lastAction && s.lastAction.text !== _lastCommentText) {
    _lastCommentText = s.lastAction.text;
    const isMyTurnNow2 = me && !me.folded && !me.away && s.currentPlayerId === me.id
      && (s.state === 'preflop' || s.state === 'flop' || s.state === 'turn' || s.state === 'river');
    // 平凡动作 (跟注/过牌/弃牌) 不弹解说, 只有加注/全下才弹 → 减少口水文刷屏
    const txt = s.lastAction.text || '';
    const isKeyAction = txt.indexOf('加注到') >= 0 || txt.indexOf('全下') >= 0;
    if (!isMyTurnNow2 && isKeyAction) {
      const msg = commentaryFor(s, txt);
      if (msg) showCommentary(msg);
    }
  }

  // 下注动作标签: 玩家框上方弹 BET/2BET/3BET/ALL IN/CALL/BLIND
  triggerActionTag(s);

  // 公共牌 (新一局 round 变化先清空, 避免残留上一局牌)
  if (s.round !== _lastCommRound) {
    _lastCommRound = s.round;
    $('community').innerHTML = '';
    myHandEval = null; // 新一局清空牌力缓存 (下次点开重新按需计算)
  }
  renderCommunity(s.community, s.state);

  // 边池列表
  const sidePotsEl = $('side-pots');
  if (sidePotsEl) {
    if (s.sidePots && s.sidePots.length > 1) {
      sidePotsEl.classList.remove('hidden');
      sidePotsEl.innerHTML = s.sidePots.map((sp, i) =>
        `<div class="sp">边池${i+1}: <b>${sp.amount}</b> <span class="muted">(${sp.players.length}人)</span></div>`
      ).join('');
    } else {
      sidePotsEl.classList.add('hidden');
    }
  }

  // 牌桌尺寸 CSS variable: 让牌/座位等元素跟着牌桌等比缩放
  const tableEl = document.getElementById('table');
  if (tableEl) {
    const tw = tableEl.offsetWidth;
    if (tw > 0) tableEl.style.setProperty('--t-size', tw + 'px');
  }

  // 座位 (行式布局: 玩家行 + 我的手牌行)
  renderSeats(s);

  // 下注飞筹动效: 某座位 bet 增加时, 筹码从座位飞向底池 (transform-only)
  triggerChipFlies(s);

  // 操作面板
  renderActions(s);

  const me = s.players[mySeat];

  // 出牌提醒: 轮到自己时 (托管离开观战期间不提醒)
  const isMyTurnNow = me && !me.folded && !me.away && s.currentPlayerId === me.id
    && (s.state === 'preflop' || s.state === 'flop' || s.state === 'turn' || s.state === 'river');
  const turnAlert = $('turn-alert');
  const now = Date.now();
  if (isMyTurnNow) {
    $('action-bar').classList.add('my-turn');
    if (now - _lastAlertAt > 3000) {
      _lastAlertAt = now;
      turnAlert.textContent = '轮到你行动！';
      turnAlert.classList.remove('hidden');
      setTimeout(() => turnAlert.classList.add('hidden'), 2600);
      // 手机震动提醒
      if (navigator.vibrate) navigator.vibrate(120);
      // 提示音
      if (window.AudioEngine) AudioEngine.sfx.yourTurn();
    }
    // 切到后台时: 标签页标题提示 + 浏览器通知
    notifyMyTurn(true);
  } else {
    $('action-bar').classList.remove('my-turn');
    notifyMyTurn(false);
  }

  // 结算面板（含完整排序 + 赢家高亮）
  renderShowdown(s);

  // 买筹码栏（筹码耗尽 + 等待局时显示）
  const buyinBar = $('buyin-bar');
  const buyinHint = buyinBar.querySelector('.buyin-hint');
  if (me && me.chips <= 0 && (s.state === 'waiting' || s.state === 'settle')) {
    buyinBar.classList.remove('hidden');
    buyinHint.textContent = `你已输光筹码${me.debt > 0 ? `，已欠款 ${me.debt}` : ''}。向银行买 1000 筹码继续游戏（记入欠款），或放弃退出`;
    $('btn-buyin').textContent = me.debt > 0 ? `买筹码并欠款（累计 ${me.debt + 1000}）` : '买 1000 筹码';
  } else {
    buyinBar.classList.add('hidden');
  }

  // 添加机器人按钮: 仅房主显示 (对局中也可加, 机器人下一局参与, 与真人坐下一致)
  const btnAddbot = $('btn-addbot');
  if (btnAddbot) {
    const isHost = s.hostId === myId;
    btnAddbot.classList.toggle('hidden', !isHost);
  }

  // 牌力评估按钮: 有手牌 + 非结算阶段显示
  const btnHandEval = $('btn-hand-eval');
  if (btnHandEval) {
    const hasCards = me && me.cards && me.cards.length === 2;
    const canShow = hasCards && s.state !== 'showdown' && s.state !== 'settle' && s.state !== 'waiting';
    btnHandEval.classList.toggle('hidden', !canShow);
    // 更新牌力面板内容 (仅面板展开时用缓存的 myHandEval, 不再依赖广播)
    const panel = $('hand-eval-panel');
    if (canShow && !panel.classList.contains('hidden')) {
      if (myHandEval) renderHandEval(myHandEval, me, s);
    }
  }

  // 中央操作浮层 (准备/开局/确认继续/放弃 - 点完消失), 底部状态按钮隐藏
  renderCenterAction(s, me);

  // 放弃按钮(底部) 已移至中央浮层, 底部不再显示
  $('btn-forfeit').classList.add('hidden');

  // 记录真实操作条展开高度 (常驻展开 + 内容真实渲染后), 供下次 updateViewportVars 精确让位
  const abEl = $('action-bar');
  if (abEl) _lastRealBarH = Math.max(_lastRealBarH, abEl.offsetHeight || 0);
  fitPcellSize(); // IOU 自适应: 玩家框尽量大, 但与公共牌/相邻框不重叠 (统一尺寸)
}

/* ============ 玩家框自适应放大 (v4: 先算框宽再排座位) ============
   诉求 (用户): ①头像外框完整容纳所有内容(头像+名字+手牌); ②放大时保持底边/顶边与桌面
   关系不变, 往中心长; ③每次自动算出"可用的最大头像框", 框和框的间距随框宽同步拉开,
   不是先摆固定位置再事后缩小框.
   实现: 二分搜索最大无碰撞框宽 W —— 对每个候选 W 按"贴桌边 + 排内对称展开(间距=W+gap)"
   重新计算所有槽位位置, 真实 reflow 后检测 (a) 两两框碰撞 (b) 与公共牌/底池区碰撞,
   取最大的无碰撞 W, 统一应用到全部玩家框. */
function fitPcellSize() {
  if (typeof window.__skipFitPcell === 'boolean' && window.__skipFitPcell) return;
  const seats = $('seats');
  const table = $('table');
  if (!seats || !table) return;
  const cells = Array.from(seats.querySelectorAll('.pcell'));
  if (!cells.length) return;
  const tr = table.getBoundingClientRect();
  const root = document.documentElement;
  const curCw = parseFloat(getComputedStyle(root).getPropertyValue('--card-w')) || 26;
  // 布局缓存: 人数/桌子位置尺寸/竖横屏不变时跳过 (每次下注都会 render, 避免重复二分+强制回流)
  // 必须包含 table.top/left: 表位置随 room-header/操作条真实高度校准而变化, 否则旧位置会错位
  const portrait = matchMedia('(orientation: portrait)').matches;
  const cacheKey = cells.length + '|' + Math.round(tr.left) + '|' + Math.round(tr.top) + '|' + Math.round(tr.width) + '|' + Math.round(tr.height) + '|' + (portrait ? 'p' : 'l');
  if (fitPcellSize._cacheKey === cacheKey && root.style.getPropertyValue('--pcell-w')) return;
  fitPcellSize._cacheKey = cacheKey;

  const MIN_W = 44, MAX_W = 170;          // 框宽搜索范围 (px)
  const GAP_RATIO = 0.15;                  // 排内间距 = 框宽 * 0.15
  const tw = tr.width, th = tr.height;

  /* 槽位 → 排/权重: 动态四边分配 (单桌, N 人自动算每边人数, 对称协调) */
  const dynLayout = buildDynamicLayout(cells.length, portrait);
  const SLOT_LAYOUT = dynLayout.layout;
  const sideTotal = dynLayout.left + dynLayout.right;
  const bottomCnt = dynLayout.bottom, topCnt = dynLayout.top;
  // 每框槽位号 (data-slot), 顺序可能与 SLOT_LAYOUT 的 key 一致 (0..N-1)
  const slotOf = cells.map(c => parseInt(c.dataset.slot || '0', 10));

  /* 应用候选框宽: 写 --card-w 等 + 重算每框位置 (贴桌边 + 排内对称展开) */
  function applyW(W) {
    const cw = W / 3.2;
    root.style.setProperty('--card-w', cw + 'px');
    root.style.setProperty('--card-h', (cw * 1.4) + 'px');
    root.style.setProperty('--avatar', Math.max(30, cw * 1.15) + 'px');
    root.style.setProperty('--pcell-w', W + 'px');
  }
  /* 重排: 按当前框宽算每排位置。排内: 含 me 的底排 me 恒居中, 其他槽 offset=w*(W+gap);
     不含 me 的排按实际框数对称展开 (count=2 → ±(W+gap)/2, count=3 → -1/0/+1)。 */
  function layoutCells(W) {
    const gap = Math.max(6, W * GAP_RATIO);
    // 先应用宽度 → reflow 读实际框高 (列排垂直分布需要 H)
    applyW(W);
    void table.offsetHeight; // 强制 reflow
    const rects = cells.map(c => c.getBoundingClientRect());
    const H = Math.max(...rects.map(r => r.height)); // 统一按最高框排列
    const gapV = Math.max(6, H * 0.12);
    // 每排收集存在的槽
    const bands = { bottom: [], top: [], right: [], left: [] };
    cells.forEach((c, i) => {
      const L = SLOT_LAYOUT[slotOf[i]];
      if (L) bands[L.band].push({ i, w: L.w, me: c.classList.contains('me') });
    });
    // 水平偏移: 底排 me 恒居中。
    // 横屏: 排内铺满 (扣除侧列空间, 顶/底排与左右列紧凑相连, 不再中央聚拢);
    // 竖屏: 紧凑对称 (W+gap), 9-10 人物理空间不足由二分兜底。
    function hOff(bandArr) {
      const res = {};
      if (!bandArr.length) return res;
      const cnt = bandArr.length;
      const hasMe = bandArr.some(x => x.me);
      // 横屏铺开: 排内可用范围 = 表宽 - 实际存在的侧列占位 (只扣有的那边)。
      // 9-10 人侧列双槽: 铺开但外侧框不超过"me 与侧列中点" (框保持较大, 左右列不再太远)
      const hasRight = bands.right.length > 0;
      const hasLeft = bands.left.length > 0;
      const sideSlots = bands.right.length + bands.left.length;
      if (!portrait && cnt > 1) {
        const innerL = hasLeft ? 12 + W : 12;                  // 左列存在则从列内侧开始
        const innerR = hasRight ? tw - 12 - W : tw - 12;       // 右列存在则到列内侧止
        const avail = Math.max(0, innerR - innerL);
        const meC = tw / 2;
        // 间距: 9-10 人统一用"me 到侧列中点" (上下完全对称); 6-8 人全铺满
        const stepFull = (avail - cnt * W) / (cnt - 1) + W;
        const step = sideSlots > 2 ? (innerR - meC) / 2 : stepFull;
        const sorted = bandArr.slice().sort((a, b) => a.w - b.w);
        if (hasMe) {
          // me 恒居中(表中心), 外侧框 = me + w*step (按 w 比例), 但不超过 innerL/innerR
          const maxAbs = Math.min(
            innerR - W / 2 - meC,
            meC - W / 2 - innerL
          );
          for (const x of sorted) {
            if (x.me) res[x.i] = 0;
            else {
              const off = x.w * step;
              res[x.i] = Math.max(-maxAbs, Math.min(maxAbs, off));
            }
          }
        } else {
          if (sideSlots > 2) {
            // 9-10 人顶排: 与底排完全对称 —— 外侧框偏移 = "me 到侧列中点" (同底排 step)
            const half = (innerR - meC) / 2;
            sorted.forEach((x, idx) => {
              const t = cnt === 1 ? 0 : (idx / (cnt - 1)) * 2 - 1;   // -1..1
              res[x.i] = t * half;
            });
          } else {
            // 6-8 人: 在 [innerL+W/2, innerR-W/2] 内铺满 (贴近侧列)
            const span = avail - W;
            sorted.forEach((x, idx) => {
              const t = cnt === 1 ? 0.5 : idx / (cnt - 1);
              res[x.i] = (innerL + W / 2 - tw / 2) + span * t;
            });
          }
        }
        return res;
      }
      // 竖屏: 无侧列时对称铺满表宽; 有侧列时紧凑 (底排/顶排铺开会与侧列垂直重叠)
      const hasSideP = bands.right.length + bands.left.length > 0;
      const maxAbsP = tw / 2 - W / 2 - 12;   // me 到表边界的最大偏移 (留 12px 边距)
      if (hasMe) {
        if (hasSideP) {
          // 有侧列: 紧凑 (W+gap), 但钳制在表宽内
          for (const x of bandArr) {
            if (x.me) res[x.i] = 0;
            else {
              const off = x.w * (W + gap);
              res[x.i] = Math.max(-maxAbsP, Math.min(maxAbsP, off));
            }
          }
        } else {
          // 无侧列: 铺满表宽 (防溢出 + 间距均匀)
          const availP = tw - 24;
          const stepP = cnt > 1 ? (availP - cnt * W) / (cnt - 1) + W : 0;
          for (const x of bandArr) {
            if (x.me) res[x.i] = 0;
            else {
              const off = x.w * stepP;
              res[x.i] = Math.max(-maxAbsP, Math.min(maxAbsP, off));
            }
          }
        }
      } else {
        // 顶排: 与底排同策略
        if (hasSideP) {
          const sorted = bandArr.slice().sort((a, b) => a.w - b.w);
          sorted.forEach((x, idx) => {
            const off = (idx - (cnt - 1) / 2) * (W + gap);
            res[x.i] = Math.max(-maxAbsP, Math.min(maxAbsP, off));
          });
        } else {
          const availP = tw - 24;
          const stepP = cnt > 1 ? (availP - cnt * W) / (cnt - 1) + W : 0;
          const sorted = bandArr.slice().sort((a, b) => a.w - b.w);
          sorted.forEach((x, idx) => {
            const t = cnt === 1 ? 0 : (idx / (cnt - 1)) * 2 - 1;   // -1..1
            const off = t * (availP - W) / 2;
            res[x.i] = Math.max(-maxAbsP, Math.min(maxAbsP, off));
          });
        }
      }
      return res;
    }
    function vOff(bandArr) {
      const res = {};
      if (!bandArr.length) return res;
      const cnt = bandArr.length;
      for (const x of bandArr) {
        if (cnt === 1) res[x.i] = 0;
        else if (cnt === 2) res[x.i] = x.w * (H + gapV) / 2;
        else res[x.i] = x.w * (H + gapV);
      }
      return res;
    }
    const hb = hOff(bands.bottom), ht = hOff(bands.top);
    const vr = vOff(bands.right), vl = vOff(bands.left);
    cells.forEach((c, i) => {
      const L = SLOT_LAYOUT[slotOf[i]];
      if (!L) return;
      const cx = tw / 2 + (L.band === 'bottom' ? (hb[i] || 0) : L.band === 'top' ? (ht[i] || 0) : 0);
      const cy = th / 2 + (L.band === 'right' ? (vr[i] || 0) : L.band === 'left' ? (vl[i] || 0) : 0);
      // 左右列贴边距离: 竖屏留安全边距 (20px 不贴屏缘), 横屏 12px
      const sideInset = portrait ? 20 : 12;
      // transition:none: 位置重排必须立即生效 (否则 0.15s 过渡会让每次 render 后框滑动/错位,
      // headless 与真实设备都会读到过渡中间态)
      if (L.band === 'bottom') c.style.cssText = `left:${cx.toFixed(1)}px;bottom:12px;transform:translateX(-50%);transition:none`;
      else if (L.band === 'top') c.style.cssText = `left:${cx.toFixed(1)}px;top:12px;transform:translateX(-50%);transition:none`;
      else if (L.band === 'right') c.style.cssText = `right:${sideInset}px;top:${cy.toFixed(1)}px;transform:translateY(-50%);transition:none`;
      else c.style.cssText = `left:${sideInset}px;top:${cy.toFixed(1)}px;transform:translateY(-50%);transition:none`;
    });
    void table.offsetHeight; // 强制 reflow (读真实 rect 检测碰撞)
  }
  /* 碰撞检测: 两两 AABB + 与公共牌区 (#community) 碰撞。
     只检测公共牌而非整个 top-row: 底池是公共牌下方的小标签, 与桌底边缘的玩家框
     轻微视觉重叠可接受, 若连底池一起算会把玩家框压到最小 (me 框内容高, 顶部会伸到中央) */
  function collides() {
    const rects = cells.map(c => c.getBoundingClientRect());
    const comm = document.getElementById('community');
    let cr = null;
    if (comm) {
      const r = comm.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) cr = r;
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) return true;
      }
      if (cr) {
        const a = rects[i];
        if (a.left < cr.right && cr.left < a.right && a.top < cr.bottom && cr.top < a.bottom) return true;
      }
    }
    return false;
  }

  // 二分: 找最大无碰撞框宽
  let lo = MIN_W, hi = MAX_W, best = MIN_W;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    layoutCells(mid);
    if (collides()) hi = mid - 1;
    else { best = mid; lo = mid + 1; }
  }
  layoutCells(best);
  // 兜底: 极端窄屏即使 MIN_W 也碰撞 → 保持 MIN_W (内容完整优先, 允许轻微贴靠)
  const finalW = parseFloat(root.style.getPropertyValue('--pcell-w')) || 0;
  if (Math.abs(finalW - curCw * 3.2) < 0.5 && finalW !== best) {
    applyW(best);
    layoutCells(best);
  }
}

/** 中央操作浮层: 卡流程的操作放牌桌中间, 点完消失 */
function renderCenterAction(s, me) {
  const wrap = $('center-action');
  const inner = $('center-action-inner');
  if (!wrap || !inner) return;
  const btnState = $('btn-state-action');
  if (btnState) btnState.classList.add('hidden'); // 底部状态按钮不再使用

  const escName = esc; // 复用转义

  // 对局中/其他阶段: 中央不显示
  if (s.state !== 'waiting' && s.state !== 'settle') {
    wrap.classList.add('hidden');
    return;
  }

  if (s.state === 'settle') {
    // 结算确认阶段
    if (me && me.chips <= 0) {
      // 输光: 借钱或放弃 (大按钮)
      inner.innerHTML = `
        <div class="ca-title">筹码已输光</div>
        <div class="ca-btns">
          <button class="btn primary big ca-btn" id="ca-buyin">💰 买 1000 筹码</button>
          <button class="btn danger ca-btn" id="ca-forfeit">放弃退出</button>
        </div>
        <div class="ca-hint">输光需向银行买筹码（记入欠款）才能继续</div>`;
      wrap.classList.remove('hidden');
      $('ca-buyin').onclick = () => socket.emit('player:buyin', { amount: 1000 }, res => {
        if (!res || !res.ok) toast((res && res.msg) || '买入失败', 'err');
      });
      $('ca-forfeit').onclick = () => {
        if (!confirm('确定放弃本局并退出游戏吗？')) return;
        socket.emit('player:forfeit', {}, res => {
          if (res && !res.ok) toast(res.msg || '操作失败', 'err');
        });
      };
      return;
    }
    if (me && !me.ready) {
      // 未确认: 大按钮"确认继续"
      inner.innerHTML = `
        <div class="ca-title">本局结束</div>
        <button class="btn primary big ca-btn ca-big" id="ca-ready">✔ 确认继续</button>
        <div class="ca-hint">全部确认后自动进入下一局</div>`;
      wrap.classList.remove('hidden');
      $('ca-ready').onclick = () => socket.emit('player:ready', res => {
        if (res && !res.ok) toast(res.msg || '操作失败', 'err');
      });
    } else if (me && me.ready) {
      // 已确认: 按钮消失, 只留小字提示
      inner.innerHTML = `<div class="ca-done">已确认 ✔ 等待其他玩家…</div>`;
      wrap.classList.remove('hidden');
    }
    return;
  }

  // waiting 阶段
  if (me && !me.ready) {
    // 未准备: 大按钮"准备"
    inner.innerHTML = `
      <div class="ca-title">点击下方按钮开始游戏</div>
      <button class="btn primary big ca-btn ca-big" id="ca-ready">▶ 准备开始</button>
      <div class="ca-hint">所有玩家准备后由房主开局</div>`;
    wrap.classList.remove('hidden');
    $('ca-ready').onclick = () => socket.emit('player:ready', res => {
      if (res && !res.ok) toast(res.msg || '操作失败', 'err');
    });
  } else {
    // 已准备: 判断是否显示开局
    const seated = s.players.filter(p => p);
    // 有效玩家 = 在线且非托管离开 (离开置灰/断线未回的玩家下一局不参与, 无需等其准备)
    const active = seated.filter(p => !p.away && p.connected);
    const allReady = active.length > 0 && active.every(p => p.ready);
    const isHost = s.hostId === myId;
    const enoughPlayers = active.length >= 2;
    if (isHost && allReady && enoughPlayers) {
      inner.innerHTML = `
        <div class="ca-title">所有玩家已准备</div>
        <button class="btn primary big ca-btn ca-big" id="ca-start">🚀 开始游戏</button>
        <div class="ca-hint">仅房主可开局</div>`;
      wrap.classList.remove('hidden');
      $('ca-start').onclick = () => socket.emit('game:start', res => {
        if (res && !res.ok) toast(res.msg || '无法开局', 'err');
      });
    } else if (me && me.ready) {
      // 已准备, 等其他人 (置灰离开者不阻塞)
      const waiting = active.filter(p => !p.ready).map(p => p.name).join('、');
      inner.innerHTML = `<div class="ca-done">已准备 ✔ 等待 ${escName(waiting || '其他玩家')}…</div>`;
      wrap.classList.remove('hidden');
    }
  }
}

/* 结算面板: 显示完整排序 + 高亮赢家 */
let _sdShownFor = ''; // 记录已展示的局(避免重复弹)
function renderShowdown(s) {
  const panel = $('showdown-panel');
  const list = $('sd-list');
  const winBanner = $('sd-winner-banner');
  // 展示条件: 摊牌或结算确认阶段(settle) 都保持显示
  // 只有进入下一局(preflop)或回到等待(waiting)时才隐藏
  const shouldShow = (s.state === 'showdown' || s.state === 'settle')
    && (s.showdownResult || s.lastWinnerText);

  if (!shouldShow) {
    if (!panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
    }
    const cEl = $('sd-community');
    if (cEl) cEl.classList.add('hidden');
    _sdShownFor = '';
    return;
  }

  // 同一局只弹一次 (结算完成前 state=showdown 但无 result, 完成后有 result)
  if (s.showdownResult) {
    const key = s.round + '|' + s.lastWinnerText;
    if (_sdShownFor === key) return; // 已展示过, 保持显示不重新渲染
    _sdShownFor = key;
    // 结算音效: 我是赢家→胜利音, 否则→低沉音
    if (window.AudioEngine) {
      const meWin = s.showdownResult.some(r => r.winner && r.seat === mySeat);
      if (meWin) AudioEngine.sfx.win();
      else AudioEngine.sfx.lose();
    }

    // 自己排第一位, 其余按牌力排名 (沉浸感: 结算先看自己的牌)
    const myResult = s.showdownResult.filter(r => r.seat === mySeat);
    const otherResults = s.showdownResult.filter(r => r.seat !== mySeat);
    const orderedResults = [...myResult, ...otherResults];

    const rows = orderedResults.map(r => {
      const isMe = r.seat === mySeat;
      const communityCards = (s.showdownCommunity || []);
      // 7 张全部展示: 2 手牌 + 5 公共牌; 属于"最大 5 张组合"的高亮 (in-best), 其余 2 张暗显 (not-best)
      const bestSet = new Set((r.best5 || []).map(c => c.rank + '_' + c.suit));
      const mkCard = (c, extra) => {
        const inBest = bestSet.has(c.rank + '_' + c.suit);
        const cls = 'card' + (inBest ? ' in-best' : ' not-best') + (extra ? ' ' + extra : '');
        return cardHTML(c).replace('class="card', `class="${cls}`);
      };
      // 底牌 2 张 (完整展示, 高亮/暗显)
      const holeHtml = (r.cards && r.cards.length === 2)
        ? r.cards.map(c => mkCard(c)).join('')
        : '<span class="muted">未亮牌</span>';
      // 公共牌 5 张 (完整展示, 高亮/暗显), 未发出的补卡背
      let comm7Html = communityCards.map(c => mkCard(c, 'comm')).join('');
      const unDealt = 5 - communityCards.length;
      for (let i = 0; i < unDealt; i++) comm7Html += '<div class="card back comm-back"></div>';
      // 行结构: 上排(名次/昵称/牌型/赢家标签) + 下排(底牌2张 + 公共牌5张), 两行紧凑布局,
      // 配合 #sd-list.sd-grid 两列网格, 满桌也能一屏完整展示无需滚动
      return `
        <div class="sd-row ${r.winner ? 'winner' : ''}">
          <div class="sd-meta">
            <span class="sd-rank">${r.rank}</span>
            <span class="sd-seat" title="座位号">${r.seat + 1}号</span>
            <span class="sd-name">${esc(r.name)}${isMe ? ' (我)' : ''}</span>
            <span class="sd-handname">${esc(r.handName || '')}</span>
            ${r.winner ? '<span class="sd-tag">赢家</span>' : ''}
          </div>
          <div class="sd-cards">
            <div class="sd-hand hole">${holeHtml}</div>
            <div class="sd-hand best5">${comm7Html}</div>
          </div>
        </div>`;
    }).join('');

    // 弃牌玩家也列出（显示在最后, 标记弃牌）
    const folded = s.players.filter(p => p && p.folded && !s.showdownResult.some(r => r.seat === p.seat));
    const foldedRows = folded.map(p => `
      <div class="sd-row fold">
        <div class="sd-meta">
          <span class="sd-rank">-</span>
          <span class="sd-seat">${p.seat + 1}号</span>
          <span class="sd-name">${esc(p.name)}</span>
          <span class="sd-handname">弃牌</span>
        </div>
      </div>`).join('');

    list.innerHTML = rows + foldedRows;
    // 玩家 ≥4 时切换两列网格: 行高减半, 满桌(10人)也能一屏完整展示, 无需拖动
    list.classList.toggle('sd-grid', (orderedResults.length + folded.length) > 3);
    // 公共牌区: 完整展示本局所有公共牌 (2底牌 + 5公共 = 7张全可见)
    const commEl = $('sd-community');
    if (s.showdownCommunity && s.showdownCommunity.length) {
      const unDealt = 5 - s.showdownCommunity.length; // 提前结束未发的公共牌
      let commCards = s.showdownCommunity.map(cardHTML).map(h => h.replace('class="card', 'class="card comm'));
      for (let i = 0; i < unDealt; i++) commCards.push('<div class="card back comm-back"></div>');
      commEl.innerHTML = `
        <div class="sd-community-inner">
          <span class="sd-col-label">公共牌 ${s.showdownCommunity.length}/5</span>
          ${commCards.join('')}
        </div>`;
      commEl.classList.remove('hidden');
    } else {
      commEl.classList.add('hidden');
    }
    winBanner.textContent = '🏆 ' + s.lastWinnerText;
    winBanner.classList.remove('hidden');
    panel.classList.remove('hidden');
  } else if (s.lastWinnerText && !s.showdownResult) {
    // 提前结束(有人全弃牌)时无排序, 只显示结果横幅
    winBanner.textContent = '🏆 ' + s.lastWinnerText;
    winBanner.classList.remove('hidden');
    list.innerHTML = '';
    $('sd-community').classList.add('hidden');
    panel.classList.remove('hidden');
    _sdShownFor = s.round + '|' + s.lastWinnerText;
  }
}

/* 公共牌: 固定 5 个卡位 (等待/翻牌前都是卡背占位, 随游戏进行翻开)
   增量渲染: 补卡位 + 翻牌时单张替换, 绝不整组重建(避免闪烁) */
function renderCommunity(community, state) {
  const el = $('community');
  const TOTAL = 5;
  // 确保 5 个卡位
  while (el.children.length < TOTAL) {
    const tmp = document.createElement('div');
    tmp.innerHTML = '<div class="card back"></div>';
    el.appendChild(tmp.firstElementChild);
  }
  // 每张: i < community.length → 正面 (首次翻开发 deal-in 动画), 否则卡背
  for (let i = 0; i < TOTAL; i++) {
    const kid = el.children[i];
    const revealed = i < community.length && !!community[i];
    if (revealed) {
      if (kid.classList.contains('back')) {
        const tmp = document.createElement('div');
        tmp.innerHTML = buildCardHTML(community[i], 'deal-in'); // 翻牌动画
        kid.replaceWith(tmp.firstElementChild);
      }
    } else {
      if (!kid.classList.contains('back')) {
        const tmp = document.createElement('div');
        tmp.innerHTML = '<div class="card back"></div>';
        kid.replaceWith(tmp.firstElementChild);
      }
    }
  }
  // 清理多余
  while (el.children.length > TOTAL) el.removeChild(el.lastChild);
}

/* 卡片 HTML 构造 (技术美术: 用 SVG 绘制花色 + 双角标 + 中央 face)
   extraClass: 可附加 class (如 'deal-in') */
function buildCardHTML(c, extraClass) {
  const red = c.suit === 1 || c.suit === 2;
  const r = RANK_CHAR[c.rank];
  const cls = 'card ' + (red ? 'red' : 'black') + (extraClass ? ' ' + extraClass : '');
  // 统一格式: 中央数字(上) + 花色(下), 都大几乎充满牌, 无角标, 所有牌完全一致
  return `<div class="${cls}" data-r="${r}" data-s="${SUIT_CHAR[c.suit]}">`
    + `<span class="big">${r}</span><span class="suit">${SUIT_CHAR[c.suit]}</span>`
    + `</div>`;
}

function cardHTML(c) {
  return buildCardHTML(c, '');
}

/* 根据总人数动态计算座位位置: 均匀分布在椭圆牌桌周围
   N 人时, 每人间隔 360/N 度, 从顶部(-90°)开始顺时针 */
function layoutPos(idx, total) {
  // 直接返回动态计算的样式, 不再用固定 9 宫格 class
  return '';  // 实际位置在 renderSeats 里用 style 内联设置
}

/* ============ 固定 10 槽 + 同心圆环布局 (参考经典德州 racetrack 10 人桌) ============
   槽位角度: 槽 6 = 90° = 底部中央 (自己); 10 槽 36° 间隔
   角度分配: [234, -90, -54, -18, 18, 54, 90, 126, 162, 198]
   对应参考图编号位置: [4, 5(顶), 6, 7, 8, 9, 10(底=me), 1, 2, 3] */
const SLOT_DEG = [234, -90, -54, -18, 18, 54, 90, 126, 162, 198];
const ME_SLOT = 6;   // 自己槽位 (90° 正下方, 每客户端以自己为参照重新排列)
/* 子集分配顺序: 自己槽6 + 先填正对面(顶)/左右中, 再填对角 (保证 2-10 人局对称)
   3 人 = [6, 1(顶), 7(左中), 3(右中)] = 底+顶+左+右 (对称) ✓
   5 人 = +4(右下)+6... 实际 +4(右下1)+2(右上1) 对称 */
// 行动顺序 = 几何顺时针顺序 (me 槽6 底部, 从 me 下家槽7 开始顺时针绕桌):
//   槽位角度: 6(90°底) → 7(126°) → 8(162°) → 9(198°) → 0(234°) → 1(-90°顶) → 2(-54°) → 3(-18°) → 4(18°) → 5(54°)
//   这样加入顺序=桌上顺时针, dealer→SB→BB 视觉连续, 加注顺序不乱
const OTHER_SLOTS = [7, 8, 9, 0, 1, 2, 3, 4, 5];

/* idx = 玩家加入顺序 (在 seated 中的下标), 返回其固定槽位; 自己 → ME_SLOT (底部中央)
   防御: myIdx<0 (自己不在玩家列表, 如观战/数据异常) 时按加入顺序直接填槽, 避免 OTHER_SLOTS[-1]=undefined → NaN 坐标 */
function slotOf(idx, myIdx) {
  if (myIdx < 0) return OTHER_SLOTS[Math.min(idx, OTHER_SLOTS.length - 1)];
  if (idx === myIdx) return ME_SLOT;
  const k = idx < myIdx ? idx : idx - 1;   // 自己不算, 其他玩家按加入顺序编号
  return OTHER_SLOTS[Math.min(k, OTHER_SLOTS.length - 1)];
}

/* ============ 同心圆环布局 (第九轮: 用户方案"牌最外环切着放 / 头像次外环 / 中心环放公共牌+筹码") ============
   百分比坐标系里桌子边界 = 圆心(50,50) 半径50 的正圆 (border-radius 50% 在%空间归一)。
   环半径由元素高度推导 (环距 = 相邻两环元素高度和/2 + 边距), 所有槽位同规则:
   - 牌环  r_card = 50 - 牌高/2 - 边距           (他人手牌切着桌沿)
   - 头像环 r_av  = r_card - 牌高/2 - 头像集合体高/2 - 边距
   - 中心区   ≤ r_av - 头像集合体高/2            (公共牌 + 底池)
   特例: 槽5 (自己, 底部) 的手牌放头像内侧上方 (y=66 桌面 / 59 竖屏), 因为屏底有操作条
   同心圆两环上同角度点距离恒 = 半径差, 斜槽位天然不挤 */
/* ============ 同心圆环布局 (第十轮, 参考抖音德州设计: 头像在外环/手牌在次外环) ============
   三层环 + 中心区 (外→内):
   - 头像环 r_avatar: 玩家"坐在桌外椅子上", 头像圆心在桌子边界外 (r>50), 切着桌沿
   - 手牌环 r_hand:   手牌放在玩家面前桌沿朝中心方向 (桌内)
   - 中心区:         公共牌 + 底池
   环距公式: r_avatar = 50 + 头像半径 + 边距 (头像在桌外);
             r_hand = 50 - 牌半高 - 边距 (牌在桌内贴沿)
   特例: 自己 (底部) 头像/手牌放桌内 (出桌会撞操作条), y=72/78 */
const RING = {                     // 圆环半径 (% 空间)
  avatar: { desk: 53.7, port: 46 },  // 头像环 (圆心在桌外, 切着桌沿)
  hand:   { desk: 44,   port: 40 },  // 手牌环 (桌内贴沿, 朝中心)
};

/* racetrack 外圈排布 (行/列固定): 顶部一排/底部一排/左右两列 → 同一排 y 完全相同 (视觉对齐)
   头像外圈: 顶排 y=-4 / 底排 y=104 / 左列 x=-4 / 右列 x=104 (桌面 r=53.7 外扩)
   手牌桌内贴沿: 顶排 y=8 / 底排 y=90 / 左列 x=10 / 右列 x=90 (r=44)
   竖屏 me 头像桌内 y=80 / 手牌 y=90 (避开操作条) */
const RING_POS = {
  avatar: { topY: 8, botY: 98, leftX: 6, rightX: 94, r: 53.7,
            pTopY: 13, pBotY: 98, pLeftX: 3, pRightX: 97, portR: 42 },
  hand:   { topY: 21, botY: 78, leftX: 18, rightX: 82, r: 44,
            pTopY: 22, pBotY: 76, pLeftX: 22, pRightX: 78, portR: 40 }
};
/* 横屏矮屏 (手机横屏, 高度 < 500): 桌子很矮, 头像/手牌必须更靠边+更小才能不互相压盖 */
const RING_POS_LAND = {
  avatar: { topY: 10, botY: 98, leftX: 6, rightX: 94, r: 53.7 },
  hand:   { topY: 26, botY: 74, leftX: 18, rightX: 82, r: 44 }
};
function ringPos(slot, ring, portrait) {
  const rad = SLOT_DEG[slot] * Math.PI / 180;
  const sin = Math.sin(rad), cos = Math.cos(rad);
  const shortLand = !portrait && window.innerHeight < 500 && window.innerHeight <= window.innerWidth;
  const cfg = shortLand ? RING_POS_LAND[ring] : RING_POS[ring];
  const r = portrait ? cfg.portR : cfg.r;
  if (portrait) {
    // 竖屏: 行/列内缩 (头像在表内, 不会被挤出屏)
    if (sin < -0.5) return { x: 50 + r * cos, y: cfg.pTopY };
    if (sin > 0.5) return { x: 50 + r * cos, y: cfg.pBotY };
    if (cos > 0) return { x: cfg.pRightX, y: 50 + r * sin };
    return { x: cfg.pLeftX, y: 50 + r * sin };
  }
  if (sin < -0.5) return { x: 50 + r * cos, y: cfg.topY };          // 顶部排 (同 y)
  if (sin > 0.5) return { x: 50 + r * cos, y: cfg.botY };           // 底部排 (同 y)
  if (cos > 0) return { x: cfg.rightX, y: 50 + r * sin };           // 右侧列 (同 x)
  return { x: cfg.leftX, y: 50 + r * sin };                          // 左侧列 (同 x)
}
/* ===== 动态四边分配: 单桌, N 个人自动算每边人数 (底/顶/左/右), 尽量对称协调 =====
   原则: 底排含 me (尽量居中); 上下对称优先; 左右对称其次.
   横屏(宽): 上下排为主 (水平铺开) — 10人→底5顶5; 竖屏(窄): 侧列为主 (垂直利用) — 10人→底3顶3左2右2 */
function distributeSides(N, portrait) {
  // 枚举底排人数 b (含 me, 奇数保证 me 居中), 顶排 t, 左右 r/l
  let best = null, bestScore = Infinity;
  for (let b = 1; b <= 7; b += 2) {          // 底排人数 (奇数, me 居中)
    if (b > N) break;
    const rest = N - b;
    if (rest < 0) continue;
    // 顶排尽量接近底排; 左右平分剩余
    for (let t = Math.max(1, b - 2); t <= Math.min(7, b + 2); t++) {
      if (t > rest + 1) break;
      const side = rest - t;                  // 左右合计
      if (side < 0) continue;
      // 左右各分配, 尽量相等; 垂直列上限 2 (桌高限制)
      for (let l = 0; l <= Math.min(2, side); l++) {
        const r = side - l;
        if (r < 0 || r > 2) continue;
        // 评分: 上下对称最重要 (t==b), 左右对称其次
        const symScore = Math.abs(t - b) * 10 + Math.abs(r - l) * 3;
        if (portrait) {
          // 竖屏(窄): 人数少(≤6)时上下排为主 (框可更大); 人多时偏好侧列 (利用垂直空间)
          const sidePrefer = (r + l) * 2;          // 侧列越多越好
          const rowPenalty = (b + t) * 1;          // 上下排人多扣分
          const smallGame = N <= 6;
          const score = symScore + (smallGame ? -rowPenalty : rowPenalty - sidePrefer);
          if (score < bestScore) { bestScore = score; best = { bottom: b, top: t, left: l, right: r }; }
        } else {
          // 横屏(宽): 偏好上下排 (水平铺开), 底排常 3-5 人
          const sidePenalty = (r + l) * 2;         // 少用侧列
          const bottomPref = b >= 3 ? 0 : 2;
          const score = symScore + sidePenalty + bottomPref;
          if (score < bestScore) { bestScore = score; best = { bottom: b, top: t, left: l, right: r }; }
        }
      }
    }
  }
  return best || { bottom: Math.min(N, portrait ? 3 : 5), top: Math.max(1, N - Math.min(N, portrait ? 3 : 5)), left: 0, right: 0 };
}
/* 动态槽位布局: 按四边人数生成每边槽位 (顺时针, 0=me 底中) */
function buildDynamicLayout(N, portrait) {
  const { bottom, top, left, right } = distributeSides(N, portrait);
  const layout = {};   // 槽位号 → {band, w}
  let idx = 0;
  layout[idx] = { band: 'bottom', w: 0 }; idx++;          // 0: me 底中
  // 底排 me 右侧: w=1..k (me 居中, 两侧各 (bottom-1)/2)
  const bk = (bottom - 1) / 2;
  for (let i = 1; i <= bk; i++) { layout[idx] = { band: 'bottom', w: i }; idx++; }
  // 右列: 垂直均匀 (w: -1 上 / +1 下, 单列 w=0)
  for (let i = 0; i < right; i++) {
    layout[idx] = { band: 'right', w: right === 1 ? 0 : (i === 0 ? -1 : 1) }; idx++;
  }
  // 顶排: 从右到左 (镜像底排)
  const tk = (top - 1) / 2;
  for (let i = tk; i >= -tk; i--) { layout[idx] = { band: 'top', w: i }; idx++; }
  // 左列: 垂直均匀
  for (let i = 0; i < left; i++) {
    layout[idx] = { band: 'left', w: left === 1 ? 0 : (i === 0 ? -1 : 1) }; idx++;
  }
  // 底排 me 左侧: w=-k..-1 (从最远向 me, 保持顺时针座位号连续: 顶左→底左最远→…→me)
  for (let i = bk; i >= 1; i--) { layout[idx] = { band: 'bottom', w: -i }; idx++; }
  return { layout, bottom, top, left, right };
}

function levelBadgeHTML(p) {
  const lv = p.level;
  if (!lv) return '';
  const delta = p.lastDelta || 0;
  const deltaTxt = delta > 0
    ? `<span class="d-delta win">+${delta}</span>`
    : delta < 0
      ? `<span class="d-delta lose">${delta}</span>`
      : '';
  return `
    <div class="lv-badge" title="积分 ${p.score} · 累计胜 ${p.wins} 负 ${p.losses}">
      <span class="lv-icon">${lv.icon}</span>
      <span class="lv-name">${lv.name}</span>
      <span class="lv-lv">Lv.${lv.level}</span>
      ${deltaTxt}
    </div>`;
}

/* 长方形桌 + 玩家围四边 (我固定底部中央): 顶部/底部排水平排开, 左右列垂直排开 */
function renderSeats(s) {
  const wrap = $('seats');
  const seated = s.players.filter(p => p);
  if (!seated.length) { wrap.innerHTML = ''; return; }
  const me = seated.find(p => p.id === myId) || seated[0];
  const isHost = s.hostId === myId;
  const N = seated.length;
  // 单桌动态槽位: N 人自动算每边人数 (底/顶/左/右对称协调), me 恒槽 0 底中
  const SLOTS = Array.from({ length: N }, (_, i) => i);
  // 座位顺序顺时针填槽: me 在槽 0, 其后按座位顺序绕
  const meIdx = seated.findIndex(p => p.id === myId);
  const ordered = [];   // [{p, slot}]
  for (let i = 0; i < N; i++) {
    const p = seated[(meIdx + i) % N];
    ordered.push({ p, slot: SLOTS[i] });
  }
  const cells = [];
  for (const { p, slot } of ordered) {
    const isMe = p.id === myId;
    const isDealer = p.seat === s.dealerSeat;
    const isSB = p.seat === s.sbSeat;
    const isBB = p.seat === s.bbSeat;
    const isActive = s.currentPlayerId === p.id;
    const isMyTurn = isMe && isActive && !p.folded && !p.away
      && (s.state === 'preflop' || s.state === 'flop' || s.state === 'turn' || s.state === 'river');
    const posTag = (isSB ? '<span class="pos-tag sb">SB</span>' : '')
      + (isBB ? '<span class="pos-tag bb">BB</span>' : '')
      + (isDealer && !isSB ? '<span class="pos-tag dealer">D</span>' : '');
    let status = '';
    if (p.sitNext) status = '下一局加入';
    else if (p.away) status = p.connected ? '观战中' : '托管离开';
    else if (p.folded) status = '弃牌';
    else if (p.allIn) status = '全下';
    else if (!p.connected) status = '离线';
    else if (s.state === 'waiting') status = p.ready ? '已准备' : '未准备';
    else if (isMyTurn) status = '轮到你';
    const debt = p.debt > 0 ? `<span class="p-debt-val">欠${p.debt}</span>` : '';
    const kickBtn = (isHost && !isMe)
      ? `<button class="kick-btn" data-kick="${p.id}" title="移出 ${esc(p.name)}">✕</button>` : '';
    const name = p.name && p.name.length > 9 ? p.name.slice(0, 9) + '…' : (p.name || '?');
    // 手牌小牌: 所有玩家统一显示 (自己正面, 别人牌背/摊牌正, 弃牌置灰); 我的听牌徽章挂手牌上方
    let pHand = '';
    if (isMe) {
      const hp = (s.you && s.you.handName && !p.folded && !p.away
        && (s.state === 'flop' || s.state === 'turn' || s.state === 'river'))
        ? `<span class="hand-power">${esc(s.you.handName)}${s.you.drawDesc ? ` · ${esc(s.you.drawDesc)}` : (s.you.handOuts > 0 ? ` · 听${s.you.handOuts}` : '')}${s.you.winrate != null ? ` · 胜率 <b>${s.you.winrate}%</b>` : ''}</span>` : '';
      pHand = `<div class="p-hand">${(p.cards && p.cards.length === 2) ? p.cards.map(cardHTML).join('') : '<div class="card back"></div><div class="card back"></div>'}${hp}</div>`;
    } else {
      const reveal = (s.state === 'showdown' || s.lastWinnerText) && p.cards && p.cards.length === 2;
      pHand = `<div class="p-hand${p.folded ? ' folded' : ''}">${reveal ? p.cards.map(cardHTML).join('') : '<div class="card back"></div><div class="card back"></div>'}</div>`;
    }
    cells.push(`<div class="pcell ${isMe ? 'me' : ''} ${isActive ? 'active' : ''} ${p.folded ? 'folded' : ''} ${p.away ? 'away' : ''}" data-seat="${p.seat}" data-slot="${slot}" style="left:50%;top:50%;transform:translate(-50%,-50%)">
      ${kickBtn}
      <span class="p-no">${(p.seat ?? 0) + 1}</span>
      <div class="p-avatar">${esc(name.charAt(0))}<span class="chips">${p.chips}</span>${posTag}</div>
      <div class="p-debt">${debt}</div>
      <div class="p-info">
        <div class="p-name">${p.isBot ? '🤖 ' : ''}${esc(name)}${p.persona ? `<span class="persona" style="background:${p.personaColor}">${esc(p.persona)}</span>` : ''}</div>
        <div class="p-bet">${p.bet ? '下注 ' + p.bet : ''}</div>
        <div class="p-status">${status}</div>
      </div>
      ${pHand}
    </div>`);
  }
  const htmlStr = cells.join('');
  // 结构键: 座位序列 + 名字 + 手牌 + 槽位 (变化才整组重建; 下注/筹码/状态变化只增量更新,
  // 避免整组重建导致 .pcell.active 脉冲动画重启闪烁)
  const structKey = N + '|' + ordered.map(o => {
    const q = o.p;
    return `${q.seat}:${q.name}:${q.isBot ? 1 : 0}:${o.slot}:${(q.cards || []).map(c => c.rank + '_' + c.suit).join(',')}`;
  }).join('|');
  if (wrap._lastStruct === structKey) {
    updatePcellDynamic(wrap, ordered, s, isHost);
    return;
  }
  wrap._lastStruct = structKey;
  wrap.innerHTML = htmlStr;
  // 整组重建后 pcell 位置回到初始 (居中堆叠), 必须让 fitPcellSize 重新布局:
  // 清缓存强制重排 (否则结算 reveal 手牌导致 structKey 变化时, cacheKey 未变会跳过 → 框全堆中心)
  if (typeof fitPcellSize === 'function') fitPcellSize._cacheKey = null;
  // 人数标记: 9-10 人竖屏空间极限, CSS 据此隐藏手牌小牌避免左右列上下槽重叠
  wrap.classList.toggle('crowded', N >= 9);
  // 踢人按钮事件（事件委托）
  wrap.querySelectorAll('.kick-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pid = btn.dataset.kick;
      const name = btn.title.replace('移出 ', '');
      if (!confirm(`确定将 ${name} 移出房间吗？`)) return;
      socket.emit('player:kick', { playerId: pid }, res => {
        if (res && !res.ok) toast(res.msg || '踢人失败', 'err');
      });
    });
  });
}

/* 增量更新玩家框: 下注/筹码/状态/行动者变化时只改文本和类, 不重建 DOM (避免脉冲动画重启闪烁) */
function updatePcellDynamic(wrap, ordered, s, isHost) {
  for (const { p } of ordered) {
    const el = wrap.querySelector(`.pcell[data-seat="${p.seat}"]`);
    if (!el) continue;
    const isMe = p.id === myId;
    const isActive = s.currentPlayerId === p.id;
    el.classList.toggle('active', isActive);
    el.classList.toggle('folded', !!p.folded);
    el.classList.toggle('away', !!p.away);
    // 头像行 (首字 + 筹码 + 庄/盲标记): 小范围重建无动画, 安全
    const av = el.querySelector('.p-avatar');
    if (av) {
      const isSB = p.seat === s.sbSeat, isBB = p.seat === s.bbSeat, isDealer = p.seat === s.dealerSeat;
      const posTag = (isSB ? '<span class="pos-tag sb">SB</span>' : '')
        + (isBB ? '<span class="pos-tag bb">BB</span>' : '')
        + (isDealer && !isSB ? '<span class="pos-tag dealer">D</span>' : '');
      const first = (p.name || '?').charAt(0);
      av.innerHTML = `${esc(first)}<span class="chips">${p.chips}</span>${posTag}`;
    }
    // 欠款行 (独立固定位置, 买筹码前后框尺寸一致)
    const debtEl = el.querySelector('.p-debt');
    if (debtEl) {
      const d = p.debt > 0 ? `<span class="p-debt-val">欠${p.debt}</span>` : '';
      if (debtEl.innerHTML !== d) debtEl.innerHTML = d;
    }
    // 下注行
    const bet = el.querySelector('.p-bet');
    if (bet) {
      bet.innerHTML = (p.bet ? '下注 ' + p.bet : '');
    }
    // 状态行
    const st = el.querySelector('.p-status');
    if (st) {
      let status = '';
      if (p.sitNext) status = '下一局加入';
      else if (p.away) status = p.connected ? '观战中' : '托管离开';
      else if (p.folded) status = '弃牌';
      else if (p.allIn) status = '全下';
      else if (!p.connected) status = '离线';
      else if (s.state === 'waiting') status = p.ready ? '已准备' : '未准备';
      else if (isMe && isActive && !p.folded && !p.away
        && (s.state === 'preflop' || s.state === 'flop' || s.state === 'turn' || s.state === 'river')) status = '轮到你';
      st.textContent = status;
    }
    // 我的听牌徽章 (翻牌后每步变化)
    if (isMe) {
      const hp = el.querySelector('.p-hand .hand-power');
      if (hp) {
        const show = (s.you && s.you.handName && !p.folded && !p.away
          && (s.state === 'flop' || s.state === 'turn' || s.state === 'river'));
        if (show) hp.innerHTML = `${esc(s.you.handName)}${s.you.drawDesc ? ` · ${esc(s.you.drawDesc)}` : (s.you.handOuts > 0 ? ` · 听${s.you.handOuts}` : '')}${s.you.winrate != null ? ` · 胜率 <b>${s.you.winrate}%</b>` : ''}`;
        else hp.innerHTML = '';
      }
    }
    // 踢人按钮显隐
    const kb = el.querySelector('.kick-btn');
    const wantKb = isHost && !isMe;
    if (wantKb && !kb) {
      const b = document.createElement('button');
      b.className = 'kick-btn';
      b.dataset.kick = p.id;
      b.title = `移出 ${p.name}`;
      b.textContent = '✕';
      b.addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm(`确定将 ${p.name} 移出房间吗？`)) return;
        socket.emit('player:kick', { playerId: p.id }, res => {
          if (res && !res.ok) toast(res.msg || '踢人失败', 'err');
        });
      });
      el.insertBefore(b, el.firstChild);
    } else if (!wantKb && kb) {
      kb.remove();
    }
  }
}

/* ============ 下注飞筹动效 ============
   预算: 单座位最多 2 枚 / 全桌同时 ≤6 枚, transform+opacity 合成路径, 550ms 后自毁 */
let _flyStreet = -1;   // 当前飞筹追踪的街 (community 张数): 新街时重置, 保证每条街第一次下注都飞筹
function triggerChipFlies(s) {
  if (!s || !s.players) return;
  // 新街 (公共牌张数变化) → 清空追踪: 每条街的第一注都触发飞筹
  const street = (s.community || []).length;
  if (street !== _flyStreet) {
    _flyStreet = street;
    _lastBets = {};
  }
  const bets = {};
  // 按座位号记录下注 (行式布局: 玩家块 .pcell[data-seat=座位号])
  // 跳过已弃牌玩家: 弃牌不该有筹码入池动画 (用户明确要求)
  s.players.forEach(p => { if (p && !p.folded && p.bet > 0) bets[p.seat] = p.bet; });
  for (const seat in bets) {
    const prev = _lastBets[seat] || 0;
    if (bets[seat] > prev) {
      const count = (bets[seat] - prev) >= 200 ? 2 : 1;
      for (let k = 0; k < count; k++) {
        setTimeout(() => spawnChipFly(Number(seat)), k * 90);
      }
    }
  }
  _lastBets = bets;
}

function spawnChipFly(seatIdx) {
  const seatEl = document.querySelector(`.pcell[data-seat="${seatIdx}"]`) || document.querySelector(`.seat[data-seat="${seatIdx}"]`);
  const potEl = $('pot-display');
  if (!seatEl || !potEl) return;
  const start = seatEl.getBoundingClientRect();
  const end = potEl.getBoundingClientRect();
  const sx = start.left + start.width / 2;
  const sy = start.top + start.height / 2;
  const ex = end.left + end.width / 2;
  const ey = end.top + end.height / 2;
  const chip = document.createElement('div');
  chip.className = 'fly-chip';
  chip.style.left = sx + 'px';
  chip.style.top = sy + 'px';
  chip.style.setProperty('--tx', (ex - sx) + 'px');
  chip.style.setProperty('--ty', (ey - sy) + 'px');
  document.body.appendChild(chip);
  void chip.offsetWidth; // 强制回流: 确保过渡从起点开始
  chip.classList.add('flying');
  setTimeout(() => {
    chip.classList.add('fade-out');
    setTimeout(() => chip.remove(), 300);
  }, 560);
}

function renderActions(s) {
  const me = s.players[mySeat];
  const info = $('action-info');
  // 阶段色块徽章 (CSS ::before 圆点, 颜色随 data-stage 变化) — 纯视觉, 无功能影响
  info.dataset.stage = s.state;
  // 阶段文字 (显示在操作条, 不在牌桌上)
  const stageMap2 = { waiting: '等待开局', preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '结算', settle: '等待确认' };
  const stageTag = stageMap2[s.state] || '';
  const infoText = (t) => stageTag ? `[${stageTag}] ${t}` : t;

  const foldBtn = $('btn-fold');
  const betBtn = $('btn-bet');
  const betWrap = $('bet-slider-wrap');
  const slider = $('bet-slider');
  const betAmount = $('bet-amount');
  const minLabel = $('bet-min-label');
  const maxLabel = $('bet-max-label');

  const isMyTurn = me && !me.folded && !me.away && s.currentPlayerId === me.id && s.state !== 'waiting' && s.state !== 'showdown' && s.state !== 'settle';
  const toCall = me ? Math.max(0, s.currentBet - me.bet) : 0;

  // 操作条常驻展开: 组件始终显示(高度恒定→桌子尺寸不跳变), 仅按状态禁用/激活;
  // 非我回合/观战/等待/结算时整块淡显禁用, 轮到自己直接可加注
  foldBtn.classList.remove('hidden');
  betWrap.classList.remove('hidden');
  betBtn.classList.remove('hidden');
  $('bet-quick-row').classList.remove('hidden');
  const canAct = !!isMyTurn && !spectating;
  foldBtn.disabled = !canAct;
  betBtn.disabled = !canAct;
  slider.disabled = !canAct;
  $('bet-input').disabled = !canAct;
  $('bet-step-down').disabled = !canAct;
  $('bet-step-up').disabled = !canAct;
  $('bet-quick-row').querySelectorAll('button').forEach(b => { b.disabled = !canAct; });

  // 观战模式: 只显示提示, 组件禁用
  if (spectating) {
    info.textContent = infoText('🔭 观战模式 · 仅观看');
    return;
  }

  // waiting/settle 阶段: 组件禁用, 只显示状态提示 (准备/确认继续在牌桌中央)
  if (s.state === 'waiting' || s.state === 'settle') {
    info.textContent = infoText(s.state === 'settle'
      ? '本局结束，请确认继续'
      : (me && me.ready ? '已准备，等待其他玩家' : '点击下方按钮准备'));
    return;
  }
  // showdown 阶段: 结算中, 组件禁用 (结算面板会显示)
  if (s.state === 'showdown') {
    info.textContent = infoText('本局结算中…');
    return;
  }
  // 游戏中: 轮到我则激活并初始化滑块/文案 (禁用状态已在上方统一设置)
  if (isMyTurn) {
    const max = me.chips + me.bet; // 全下总额
    // 筹码不足跟注 (toCall > max): 唯一动作是全下 → min 不再取 toCall (min>max 会让滑块/输入失效)
    const minBet = Math.min(toCall > 0 ? toCall : 0, max);
    const minRaiseTo = betMinRaiseTo(s, max); // 最小合法加注目标额
    slider.min = minBet;
    slider.max = max;
    slider.step = 10; // 下注额统一为 10 的整数倍 (盲注默认 20/10)
    $('bet-input').min = minBet;
    $('bet-input').max = max;
    $('bet-input').step = 10; // 步进按钮 ±10, 不再出现"±1 后被强行改"的错乱
    // 仅"新轮次轮到行动"时初始化输入框 (用户手动输入后不覆盖, 否则删 0 重写会被重置)
    const betKey = s.round + '|' + s.state + '|' + s.currentBet;
    if (betKey !== _betInitKey) {
      _betInitKey = betKey;
      _betEdited = false;
      slider.value = minBet;
      $('bet-input').value = minBet;
    }
    minLabel.textContent = toCall > max ? `全下 ${max}` : (toCall > 0 ? `跟注 ${toCall}` : '过牌');
    maxLabel.textContent = `全下 ${max}`;
    // 提示最小合法加注额, 帮助理解滑块吸附规则
    $('bet-range-hint').textContent = toCall > max
      ? '筹码不足跟注，将全下'
      : (toCall > 0
        ? `最小加注到 ${minRaiseTo}${minRaiseTo >= max ? ' (全下)' : ''}`
        : `最小下注 ${minRaiseTo}`);
    info.textContent = infoText(`轮到你行动 · 筹码 ${me.chips}`);
    setBtnText(foldBtn, '弃牌');
    updateBetBtn(_betEdited ? $('bet-input').value : slider.value, toCall, max, minRaiseTo);
  } else {
    // 游戏中但不是我的回合: 显示等待提示
    info.textContent = infoText('等待其他玩家行动…');
  }
}

/* 根据滑块位置更新主按钮文案/颜色: 跟注 → 加注到X → 全下
   想加注但不足最小加注时, 吸附展示为最小合法加注额, 保证提交值合法 */
function updateBetBtn(val, toCall, max, minRaiseTo) {
  const betBtn = $('btn-bet');
  const betAmount = $('bet-amount');
  val = Number(val);
  if (isNaN(val)) val = 0;
  // 想加注但不足最小加注 → 吸附展示为最小合法加注额 (吸附后可能为全下)
  if (val > toCall && val < minRaiseTo) {
    val = minRaiseTo;
  }
  betAmount.textContent = val;
  betBtn.classList.remove('allin-mode', 'raise-mode');
  if (val <= 0) {
    setBtnText(betBtn, '过牌');
  } else if (val >= max) {
    setBtnText(betBtn, '全下');
    betBtn.classList.add('allin-mode');
  } else if (val > toCall) {
    setBtnText(betBtn, `加注到 ${val}`);
    betBtn.classList.add('raise-mode');
  } else {
    setBtnText(betBtn, `跟注 ${val}`);
  }
}

function esc(t) {
  const div = document.createElement('div');
  div.textContent = t;
  return div.innerHTML;
}

/* ============ 起手牌 13×13 网格 (从服务端读取预计算的 tier 热图) ============ */
const RANK_GRID_ORDER = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const RANK_CHAR2 = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'T',11:'J',12:'Q',13:'K',14:'A' };

/* ============ vs 对手人数柱状图渲染 ============ */
const WR_TIERS = [
  { min: 80, color: '#ef4444' },  // 红 80%+
  { min: 70, color: '#f97316' },  // 橙 70%+
  { min: 60, color: '#eab308' },  // 黄 60%+
  { min: 50, color: '#22c55e' },  // 绿 50%+
  { min: 40, color: '#84cc16' },  // 浅绿 40%+
  { min: 30, color: '#3b82f6' },  // 蓝 30%+
  { min: 20, color: '#06b6d4' },  // 青 20%+
  { min: 0,  color: '#1e40af' }   // 深蓝 10%以下
];
function wrColor(pct) {
  for (const t of WR_TIERS) { if (pct >= t.min) return t.color; }
  return WR_TIERS[WR_TIERS.length - 1].color;
}

function renderWinRateBars(arr) {
  // arr 长度 9, 对手数 1-9
  const maxPct = Math.max(...arr, 1);
  const bars = arr.map((pct, i) => {
    const n = i + 1;
    const color = wrColor(pct);
    // 高度按最大胜率归一化 (让最强柱子更高, 弱柱子更矮, 视觉更明显)
    const h = Math.max(8, Math.round((pct / Math.max(maxPct, 50)) * 50));
    return `
      <div class="wr-bar-col" title="vs ${n} 个对手: ${pct}%">
        <div class="wr-bar-val">${pct}</div>
        <div class="wr-bar" style="height:${h}px;background:${color}"></div>
        <div class="wr-bar-label">${n}</div>
      </div>`;
  }).join('');
  return `
    <div class="wr-title">VS 对手人数 <span class="wr-sub">% 胜率</span></div>
    <div class="wr-chart">${bars}</div>
    <div class="wr-legend">1 人 <span class="muted">·</span> 多人</div>`;
}

function renderHandGrid(myCards, shortDeck, gridTiers) {
  const grid = gridTiers || [];
  let mineRow = -1, mineCol = -1;
  if (myCards && myCards.length === 2) {
    mineRow = RANK_GRID_ORDER.indexOf(myCards[0].rank);
    mineCol = RANK_GRID_ORDER.indexOf(myCards[1].rank);
  }
  const html = [];
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      const t = (grid[i] && grid[i][j]) || { tier: 5, color: '#6b7280' };
      let label = '';
      if (i === j) label = RANK_CHAR2[RANK_GRID_ORDER[i]] + RANK_CHAR2[RANK_GRID_ORDER[j]];
      else if (i < j) label = RANK_CHAR2[RANK_GRID_ORDER[i]] + RANK_CHAR2[RANK_GRID_ORDER[j]] + 's';
      else label = RANK_CHAR2[RANK_GRID_ORDER[i]] + RANK_CHAR2[RANK_GRID_ORDER[j]] + 'o';
      const isMine = (i === mineRow && j === mineCol) || (i === mineCol && j === mineRow);
      const bgColor = isMine ? t.color + '50' : 'rgba(255,255,255,0.05)';
      html.push(`<div class="he-cell ${isMine ? 'mine' : ''}" style="background:${bgColor};color:${isMine ? '#fff' : t.color}">${label}</div>`);
    }
  }
  return html.join('');
}

/* ============ 登录 / 注册 ============ */
/* 记住账号密码 (localStorage): 登录过之后自动填好, 减少重复输入操作。
   注: 明文存于本机浏览器, 适合朋友间娱乐场景; 若在意隐私可改为只记用户名。 */
const REMEMBER_USER_KEY = 'pk_remember_username';
const REMEMBER_PASS_KEY = 'pk_remember_password';
function rememberAuth(username, password) {
  try {
    if (username) localStorage.setItem(REMEMBER_USER_KEY, username);
    if (password) localStorage.setItem(REMEMBER_PASS_KEY, password);
  } catch (e) { /* 隐私模式等可能拒绝存储 */ }
}
function prefillAuth() {
  try {
    const u = localStorage.getItem(REMEMBER_USER_KEY) || '';
    const p = localStorage.getItem(REMEMBER_PASS_KEY) || '';
    if (u) $('login-username').value = u;
    if (p) $('login-password').value = p;
  } catch (e) { /* ignore */ }
}
/** 切换登录/注册页签 (统一入口: 点击页签 / 显示登录界面时调用) */
function switchAuthMode(mode) {
  document.querySelectorAll('.auth-tab').forEach(x => x.classList.toggle('active', x.dataset.auth === mode));
  $('form-login').classList.toggle('hidden', mode !== 'login');
  $('form-register').classList.toggle('hidden', mode !== 'register');
}

function showAuthScreen() {
  const a = $('auth-screen');
  a.classList.remove('hidden');
  a.classList.add('active');   // 兼容旧 CSS
  $('lobby').classList.remove('active');
  $('room').classList.remove('active');
  // 兜底: 内联样式强制隐藏 lobby
  try { $('lobby').style.display = 'none'; } catch (e) {}
  // 回到登录界面: 默认停在"登录"页签, 并预填上次登录的账号密码 (减少操作)
  switchAuthMode('login');
  prefillAuth();
}
function hideAuthScreen() {
  const a = $('auth-screen');
  a.classList.add('hidden');           // 新方案: hidden 类强制 display:none
  a.classList.remove('active');        // 兼容旧 CSS
  try { $('lobby').style.display = ''; } catch (e) {}
}
function showLobby() {
  $('auth-screen').classList.add('hidden');
  $('auth-screen').classList.remove('active');
  $('room').classList.remove('active');
  $('lobby').classList.add('active');
  try { $('lobby').style.display = ''; } catch (e) {}
  notifyMyTurn(false); // 回到大厅: 恢复标题
  updateAccountBar();
}

// 登录/注册成功后的统一入口:
// 若该账号正在某房间游戏中(顶号场景) → 自动 rejoin 直接进房间;
// 否则正常进入大厅。
let _pendingTakeover = false;   // 顶号接管进行中: room:state:me 先于 rejoin ack 到达时也要缓存
function afterAuth() {
  const username = (getAuth() || {}).username;
  if (!username) return showLobby();
  _pendingTakeover = true;   // 标记接管中, 使 room:state:me 在界面未激活时也被缓存
  socket.emit('room:rejoin', {
    clientId: getClientId(),
    oldSocketId: '',
    name: username,
    accountId: getAccountId(),
    username
  }, res => {
    _pendingTakeover = false;
    if (res && res.ok) {
      localStorage.setItem('pk_in_room', res.roomId || '1');
      showRoom(res.roomId || (roomState && roomState.id) || '');
      toast('已接管该账号的牌局', 'ok');
    } else {
      showLobby();
    }
  });
}

function setupAuth() {
  const tabs = document.querySelectorAll('.auth-tab');
  tabs.forEach(t => t.addEventListener('click', () => {
    switchAuthMode(t.dataset.auth);
  }));

  // 登录
  $('form-login').addEventListener('submit', e => {
    e.preventDefault();
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    if (!username || !password) return toast('请输入用户名和密码', 'err');
    socket.emit('auth:login', { username, password }, res => {
      if (res && res.ok) {
        rememberAuth(username, password);   // 记住, 下次自动填好
        setAuth(res.token, res.username, res.nickname);
        hideAuthScreen();
        toast('登录成功', 'ok');
        updateAccountBar();
        afterAuth();   // 顶号进房间(若该账号在游戏中) 或 进大厅
      } else {
        toast((res && res.msg) || '登录失败', 'err');
      }
    });
  });

  // 注册
  $('form-register').addEventListener('submit', e => {
    e.preventDefault();
    const username = $('reg-username').value.trim();
    const nickname = $('reg-nickname').value.trim();
    const password = $('reg-password').value;
    const password2 = $('reg-password2').value;
    if (!username || !nickname || !password) return toast('请填完整信息', 'err');
    if (password !== password2) return toast('两次密码不一致', 'err');
    socket.emit('auth:register', { username, password, nickname, accountId: getAccountId() }, res => {
      if (res && res.ok) {
        rememberAuth(username, password);   // 注册即记住, 下次直接登录
        setAuth(res.token, res.username, res.nickname);
        hideAuthScreen();
        toast('注册成功，欢迎！', 'ok');
        updateAccountBar();
        afterAuth();
      } else {
        toast((res && res.msg) || '注册失败', 'err');
      }
    });
  });

  // 游客
  $('btn-guest').addEventListener('click', () => {
    hideAuthScreen();
    showLobby();
  });
}

/* ============ 初始化 ============ */
window.addEventListener('DOMContentLoaded', () => {
  initLobby();
  setupActions();
  setupAuth();
  updateAccountBar(); // 初始渲染账号面板
  connect();

  // 未登录 → 先显示登录/注册界面; 已登录 → 直接进入大厅
  if (!getAuth()) {
    showAuthScreen();
  } else {
    showLobby();
  }

  // 连接后请求房间列表（连接成功回调里也会请求, 这里做兜底）
  setTimeout(fetchRoomList, 1000);

  // URL 带 room 参数 → 自动加入 (URL 的 name 参数优先, 避免被 localStorage 旧名字覆盖导致接管错乱)
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    const urlName = params.get('name');
    const name = urlName || displayName();
    if (!getAuth()) myName = name;
    socket.emit('room:join', { roomId: room.toUpperCase(), name, accountId: getAccountId(), username: (getAuth() || {}).username }, res => {
      if (res && res.ok) showRoom(res.roomId);
    });
  }
});
