'use strict';
/**
 * 德州扑克游戏引擎（服务端权威）
 * 职责: 房间管理 / 状态机 / 行动校验 / 底池边池 / 结算
 */
const { evaluateBest, compareScore, shuffle, createDeck, handTier, getWinRate, getWinRateMulti } = require('./poker');
const accounts = require('./accounts'); // 轻量游客账号 (accountId)
const auth = require('./auth'); // 正式账号 (username + password)

const MAX_PLAYERS = 10;   /* 经典德州 10 人桌 (server.js seats=10 需与此一致) */
const ACTION_TIMEOUT_MS = 45 * 1000; // 玩家行动超时 45s，超时后自动过牌/弃牌 (断线玩家同样适用)

const STAGE_NAMES = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌', settle: '结算确认' };

/* ===== 等级机制: 根据玩家累计积分(score)划分段位 =====
   score 初始为 1000, 每局结算 = 本局净筹码变化(delta = 结算后筹码 - 开局筹码, 即净赢/输的点数) 累加。
   等级表从低到高, 每个等级有: 名称、所需最低积分、表情图标。 */
const LEVELS = [
  { name: '新手',     min: -Infinity, icon: '🌱' },
  { name: '菜鸟',     min: 0,         icon: '🐣' },
  { name: '学徒',     min: 500,       icon: '🃏' },
  { name: '牌手',     min: 1200,      icon: '🎴' },
  { name: '老练',     min: 2500,      icon: '🔥' },
  { name: '高手',     min: 5000,      icon: '💎' },
  { name: '专家',     min: 10000,     icon: '👑' },
  { name: '宗师',     min: 20000,     icon: '🏆' },
  { name: '传奇',     min: 50000,     icon: '🌟' }
];

/** 根据累计积分返回段位信息 { level(1-based), name, icon, next(下一段位或null), toNext(距下一段所需) } */
function getLevelByScore(score) {
  // 二分查找最后一个 min <= score 的段位 (LEVELS 按 min 严格递增)
  let lo = 0, hi = LEVELS.length - 1, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (score >= LEVELS[mid].min) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const cur = LEVELS[idx];
  const next = idx + 1 < LEVELS.length ? LEVELS[idx + 1] : null;
  return {
    level: idx + 1,
    name: cur.name,
    icon: cur.icon,
    nextName: next ? next.name : null,
    nextMin: next ? next.min : null,
    toNext: next ? next.min - score : 0
  };
}

/* ===== 翻牌后牌型强度映射 (score[0] 0-8), 长短牌规则不同 =====
   长牌 (标准): 高牌<一对<两对<三条<顺子<同花<葫芦<四条<同花顺
   短牌 (6+):   高牌<一对<两对<顺子<三条<葫芦<同花<四条<同花顺 (同花>葫芦, 三条>顺子)
   短牌成牌率更高 → 高牌/对子更弱, 同花更罕见更强 */
const STRENGTH_LONG = [0.12, 0.26, 0.42, 0.58, 0.68, 0.76, 0.84, 0.92, 0.98];
const STRENGTH_SHORT = [0.10, 0.24, 0.38, 0.62, 0.72, 0.80, 0.86, 0.93, 0.98];

class Player {
  constructor(id, name, socketId) {
    this.id = id;
    this.name = name;
    this.socketId = socketId;
    this.seat = -1;
    this.chips = 1000;
    this.debt = 0;          // 向银行欠款（买筹码记账）
    this.cards = [];        // 手牌
    this.bet = 0;           // 本轮下注额
    this.totalBet = 0;      // 本局总投入
    this.folded = false;
    this.allIn = false;
    this.ready = false;
    this.connected = true;
    this.isBot = false;     // 是否为 AI 机器人
    this.disconnectedAt = 0;
    this.away = false;      // 托管离开: 当前局 AI 代打, 当局结束后保留座位但不参与后续局
    this.sitNext = false;   // 观战坐下: 对局中加入, 本局观战, 下一局正式参与
    // ===== 账号机制 (v3): username 正式账号优先, accountId 游客兜底 =====
    this.username = null;    // 正式账号用户名(登录后绑定)
    this.accountId = null;   // 轻量游客ID (UUID, 未登录时兜底)
    // ===== 等级机制 =====
    this.score = 1000;       // 累计积分 (初始 1000)
    this.startChips = 1000;  // 本局开局时的筹码快照 (用于计算本局净赢/输点数)
    this.lastDelta = 0;      // 最近一局的净赢/输点数
    this.wins = 0;           // 累计赢局数
    this.losses = 0;         // 累计输局数
  }
}

class GameRoom {
  constructor(id, opts = {}) {
    this.id = id;
    this.name = opts.name || `房间 ${id}`;
    this.sb = opts.sb || 5;
    this.bb = opts.bb || 10;
    this.shortDeck = !!opts.shortDeck;  // 短牌(6+ Hold'em)
    this.gridTiers = this.computeGridTiers();
    this.maxSeats = Math.min(opts.seats || 6, MAX_PLAYERS);
    this.hostId = null;
    this.players = new Array(this.maxSeats).fill(null); // 按座位索引, 空位 null
    this.playersById = new Map();
    this.state = 'waiting';  // waiting | preflop | flop | turn | river | showdown
    this.dealerSeat = -1;
    this.community = [];
    this.awayTimers = new Map(); // playerId -> timer: (自动移除已停用) away 座位永久保留等待回来
    this.deck = [];
    this.currentPlayerId = null;
    this.currentBet = 0;     // 当前最高下注（本轮）
    this.minRaise = 0;
    this.actedSet = new Set(); // 本轮已行动过的玩家
    this.raiseReopened = false; // 本轮是否出现过完整加注 (TDA: 短全下不重开加注权)
    this.pot = 0;
    this.orphanBets = 0; // 对局中被移除玩家遗留的注 (断线移除时其 bet 仍在 pot 中)
    this.sidePots = [];
    this.lastAction = null;  // { text, ts }
    this.actionLog = [];
    this.timer = null;
    this.round = 0;
    this.lastWinnerText = '';
    this.currentSbSeat = -1;
    this.currentBbSeat = -1;
    this.lastActivity = Date.now(); // 用于房间自动清理
  }

  /** 预计算 13×13 起手牌档位热图 (一次性, 用于前端牌力面板展示) */
  computeGridTiers() {
    const ranks = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
    const grid = [];
    for (let i = 0; i < 13; i++) {
      const row = [];
      for (let j = 0; j < 13; j++) {
        const cards = i <= j
          ? [{ rank: ranks[i], suit: 0 }, { rank: ranks[j], suit: 0 }]   // 上三角: 同花
          : [{ rank: ranks[i], suit: 0 }, { rank: ranks[j], suit: 1 }];   // 下三角: 非同花
        row.push(handTier(cards, this.shortDeck));
      }
      grid.push(row);
    }
    return grid;
  }

  // ---------- 房间与玩家 ----------
  // username: 正式账号用户名(登录后传入, 优先绑定积分); accountId: 轻量游客ID(兜底)
  addPlayer(socketId, name, clientId, accountId, username) {
    // 同一 socket 已在房间 → 直接复用该玩家 (防止"托管离开"后同 socket 重新加入被误判为失败)
    const sameSid = [...this.playersById.values()].find(p => p.socketId === socketId);
    if (sameSid) {
      sameSid.connected = true;
      this.clearSuspend(sameSid); // 等待中清 away 恢复参与
      return sameSid;
    }
    const cleanName = (name || '玩家').trim() || '玩家';
    // 同一浏览器(clientId)已在该房间 → 返回原玩家 (防止断线重连后创建重复玩家)
    const existing = clientId ? [...this.playersById.values()].find(p => p.clientId === clientId) : null;
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      if (existing.name !== cleanName && cleanName) existing.name = cleanName;
      if (username && existing.username !== username) {
        existing.username = username;
        try {
          const acc = auth.getAccountByUsername(username) || accounts.getOrCreateAccount(accountId, cleanName);
          existing.score = acc.score; existing.wins = acc.wins; existing.losses = acc.losses;
        } catch (e) { /* ignore */ }
      } else if (accountId && existing.accountId !== accountId) {
        existing.accountId = accountId;
        try {
          const acc = accounts.getOrCreateAccount(accountId, cleanName);
          existing.score = acc.score; existing.wins = acc.wins; existing.losses = acc.losses;
        } catch (e) { /* ignore */ }
      }
      this.clearSuspend(existing); // 重连/再入: 等待中清 away 恢复参与
      return existing;
    }
    // 同一 username (已离线) → 顶替/换设备重连, 接管身份并刷新积分
    const sameUserOffline = username
      ? [...this.playersById.values()].find(p => p.username === username && !p.connected)
      : null;
    if (sameUserOffline) {
      sameUserOffline.socketId = socketId;
      sameUserOffline.connected = true;
      if (clientId) sameUserOffline.clientId = clientId;
      if (sameUserOffline.name !== cleanName) sameUserOffline.name = cleanName;
      try {
        const acc = accounts.getAccountByUsername(username) || accounts.getOrCreateAccount(accountId, cleanName);
        sameUserOffline.score = acc.score; sameUserOffline.wins = acc.wins; sameUserOffline.losses = acc.losses;
      } catch (e) { /* ignore */ }
      this.log(`${cleanName} 重新加入 (接管离线账号)`);
      this.clearSuspend(sameUserOffline); // 等待中清 away 恢复参与
      return sameUserOffline;
    }
    // 同一 accountId (已离线) → 兜底接管
    const sameAccOffline = accountId
      ? [...this.playersById.values()].find(p => p.accountId === accountId && !p.connected)
      : null;
    if (sameAccOffline) {
      sameAccOffline.socketId = socketId;
      sameAccOffline.connected = true;
      if (clientId) sameAccOffline.clientId = clientId;
      if (sameAccOffline.name !== cleanName) sameAccOffline.name = cleanName;
      try {
        const acc = accounts.getOrCreateAccount(accountId, cleanName);
        sameAccOffline.score = acc.score; sameAccOffline.wins = acc.wins; sameAccOffline.losses = acc.losses;
      } catch (e) { /* ignore */ }
      this.log(`${cleanName} 重新加入 (接管离线账号)`);
      this.clearSuspend(sameAccOffline); // 等待中清 away 恢复参与
      return sameAccOffline;
    }
    // 同名且在线 → 拒绝 (防止两个真人同名顶替显示冲突)
    const sameNameOnline = [...this.playersById.values()].find(p => p.name === cleanName && !p.isBot && p.connected);
    if (sameNameOnline) return null;
    // 真正创建新玩家前才检查满员 (existing/离线接管复用原座位, 不受满员限制)
    if (this.players.filter(p => p).length >= this.maxSeats) return null;
    const id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const p = new Player(id, cleanName, socketId);
    if (clientId) p.clientId = clientId;
    // ===== 账号联动 (v3): 正式 username 优先; 否则轻量 accountId 兜底 =====
    try {
      let acc;
      if (username) { p.username = username; acc = auth.getAccountByUsername(username); }
      if (!acc) { acc = accounts.getOrCreateAccount(accountId, cleanName); p.accountId = acc.accountId; }
      p.score = acc.score;
      p.wins = acc.wins;
      p.losses = acc.losses;
    } catch (e) {
      console.error('[addPlayer] 加载账号失败:', e && e.message);
    }
    // 自动落座第一个空位
    const seat = this.players.findIndex(x => !x);
    if (seat === -1) return null;
    this.players[seat] = p;
    p.seat = seat;
    this.playersById.set(id, p);
    if (!this.hostId) this.hostId = id;
    return p;
  }

  /** 添加 AI 机器人 (房主调用); 对局进行中添加 → 本局观战, 下一局参与 (与真人坐下一致) */
  addBot(botName) {
    if (this.players.filter(p => p).length >= this.maxSeats) return { ok: false, msg: '房间已满' };
    const id = 'bot_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    // 机器人名字按座位编号命名: 机器人1号/机器人2号... (先找空位, 座位号=seat+1, 天然唯一且与座位对应)
    const seat = this.players.findIndex(x => !x);
    let name = botName;
    if (!name) {
      name = '机器人' + (seat + 1) + '号';
      const taken = new Set(this.players.filter(p => p).map(p => p.name));
      if (taken.has(name)) name = '机器人' + (seat + 1) + '号_' + Math.floor(Math.random() * 1e4);  // 极端兜底
    }
    const p = new Player(id, name, 'bot_socket_' + id);
    p.isBot = true;
    p.ready = true; // 机器人自动准备
    // 对局进行中: 本局不参与行动 (与真人观战坐下一致), 下一局正式参与
    const midGame = this.state !== 'waiting' && this.state !== 'settle';
    if (midGame) {
      p.sitNext = true;
      p.ready = false;
    }
    // AI 性格 (每个机器人独特): aggr=加注倾向, loose=跟注松紧, bluff=诈唬率
    p.style = {
      aggr: +(0.35 + Math.random() * 0.5).toFixed(2),
      loose: +(0.25 + Math.random() * 0.5).toFixed(2),
      bluff: +(0.05 + Math.random() * 0.2).toFixed(2)
    };
    // AI 人设标签: 由性格三围映射成玩家能读懂的牌风 (紧凶/松凶/紧弱/松弱 + 诈唬倾向)
    const { aggr, loose, bluff } = p.style;
    if (aggr >= 0.62 && loose >= 0.55) { p.persona = '松凶'; p.personaColor = '#ef4444'; }
    else if (aggr >= 0.62) { p.persona = '紧凶'; p.personaColor = '#3b82f6'; }
    else if (loose >= 0.55) { p.persona = '松弱'; p.personaColor = '#22c55e'; }
    else { p.persona = '紧弱'; p.personaColor = '#9ca3af'; }
    if (bluff >= 0.18) p.persona = '诈·' + p.persona;   // 爱诈唬的机器人特别标注
    p.personaLabel = p.persona;
    if (seat === -1) return { ok: false, msg: '无空位' };
    this.players[seat] = p;
    p.seat = seat;
    this.playersById.set(id, p);
    this.log(`${name} (AI) 加入房间`);
    this.broadcast();
    return { ok: true, name };
  }

  /** AI 决策: 智能版 — 真实胜率(preflop查表) + 底池赔率 + 位置 + 筹码深度 + 个人风格 + 半诈唬 */
  botDecide(bot) {
    const st = bot.style || { aggr: 0.6, loose: 0.5, bluff: 0.12 };
    const toCall = this.currentBet - bot.bet;
    const pot = this.pot;
    const n = this.players.filter(p => p && !p.folded && p.cards.length).length || 1;
    const pos = this.botPosition(bot, n);   // 0=SB 最前 ... n-1=BTN 最后(最好)
    const latePos = pos >= n - 2;
    const m = bot.chips / Math.max(1, this.bb);   // 筹码深度 (相对大盲)

    // 胜率估计 (vs N 对手, 供底池赔率决策) + 单挑牌力 (供价值加注决策)
    let win = this.botWinEstimate(bot, n);
    const power = this.botPower(bot);
    if (latePos) win += 0.05;
    if (this.state === 'preflop' && bot.seat === this.bbSeat) win += 0.04;  // BB 便宜看牌
    win = Math.max(0.03, Math.min(0.97, win));

    // 加注到 Nbb 大小 (自动钳制合法区间)
    const raiseTo = mult => {
      const base = this.currentBet + this.bb * mult;
      return Math.min(bot.chips + bot.bet, Math.max(base, this.currentBet + this.minRaise));
    };

    if (toCall === 0) {
      // 可过牌: 强牌价值下注 / 后位保护下注 / 偶尔诈唬
      if (power > 0.72) return { action: 'raise', amount: raiseTo(2 + Math.random() * 2) };
      if (power > 0.5 && (latePos || Math.random() < st.aggr)) return { action: 'raise', amount: raiseTo(2 + Math.random()) };
      if (power < 0.2 && Math.random() < st.bluff * 0.22) return { action: 'raise', amount: raiseTo(1 + Math.random()) };
      return { action: 'check' };
    }

    // 需要跟注: 底池赔率比较 (edge = 胜率 - 所需胜率)
    const potOdds = toCall / (pot + toCall);
    const edge = win - potOdds;
    // 强牌价值加注 (单挑牌力高, 多人局也照打)
    if (power > 0.72 || (power > 0.6 && Math.random() < st.aggr * 0.8)) {
      return { action: 'raise', amount: raiseTo(power > 0.82 ? 3 + Math.random() * 3 : 2 + Math.random() * 2) };
    }
    if (edge > 0.08) return { action: 'call' };   // 明显 +EV 跟注
    // 接近临界: 松的风格偶尔也跟
    if (edge > -0.04 && Math.random() < st.loose) return { action: 'call' };
    // 短筹码 push/fold (M < 6)
    if (m < 6 && (win > 0.4 || power > 0.5)) return { action: 'raise', amount: bot.chips + bot.bet };
    // 半诈唬: 有点胜率 + 诈唬倾向
    if (power > 0.35 && Math.random() < st.bluff * 0.18) return { action: 'raise', amount: raiseTo(2 + Math.random() * 2) };
    return { action: 'fold' };
  }

  /** 位置: 行动顺序号 (0=SB 最先行动 ... n-1=BTN 最后行动=最好) */
  botPosition(bot, n) {
    if (n <= 2) return bot.seat === this.dealerSeat ? 1 : 0;
    return (bot.seat - this.dealerSeat - 1 + this.maxSeats) % this.maxSeats;
  }

  /** 胜率估计 (0-1): preflop 用真实查表胜率 (vs N 对手), postflop 牌型+听牌+对手数修正 */
  botWinEstimate(bot, n) {
    if (this.community.length === 0) {
      return getWinRateMulti(bot.cards, n - 1, this.shortDeck);
    }
    const ev = evaluateBest([...bot.cards, ...this.community], { shortDeck: this.shortDeck });
    const score = ev.score || [0, 0, 0, 0, 0];
    const rank = score[0];   // 0=高牌 ~ 8=同花顺
    let base = (this.shortDeck ? STRENGTH_SHORT : STRENGTH_LONG)[rank] ?? 0.3;
    // 同牌型内踢脚细化 (与 botPower 一致): 顶对 A 踢脚比 2 踢脚强
    base += (score[1] || 0) * 0.004 + (score[2] || 0) * 0.002 + (score[3] || 0) * 0.001;
    let win = Math.min(0.97, base);
    // 听牌补牌加成 (flop: outs*4%, turn: outs*2%)
    if (this.state === 'flop' || this.state === 'turn') {
      const outs = this.countOuts(bot);
      if (outs > 0) win += Math.min(outs * (this.state === 'flop' ? 4 : 2) / 100, 0.3);
    }
    // 对手数修正 (放宽: 0.35→0.15, 6人桌同花≈0.43 更接近实际, 避免强牌多人局全弃)
    win /= 1 + (n - 1) * 0.15;
    return Math.max(0.04, Math.min(0.95, win));
  }

  /** 单挑牌力 (0-1): preflop 单挑胜率, postflop 牌型+踢脚细化 — 用于"价值加注"判定 (不受对手数稀释) */
  botPower(bot) {
    if (this.community.length === 0) {
      return getWinRate(bot.cards, this.shortDeck).win;
    }
    const ev = evaluateBest([...bot.cards, ...this.community], { shortDeck: this.shortDeck });
    const score = ev.score || [0, 0, 0, 0, 0];
    const rank = score[0];
    const base = (this.shortDeck ? STRENGTH_SHORT : STRENGTH_LONG)[rank] ?? 0.3;
    // 同牌型内细化: score[1..] 是踢脚/牌对 (rank 2-14), 归一化叠加
    //   顶对 A 踢脚 vs 顶对 2 踢脚: 差 (14-2)*0.004 ≈ 0.05, 同花顺/四条等顶级不受影响
    const kicker = (score[1] || 0) * 0.004 + (score[2] || 0) * 0.002 + (score[3] || 0) * 0.001;
    return Math.min(0.98, base + kicker);
  }

  /** 粗略听牌补牌数: 同花听 / 顺子听 (长短牌不同: 短牌每花色 9 张 → 同花听 5 outs; 顺子窗口小 → 顺子听减半) */
  countOuts(bot) {
    const short = this.shortDeck;
    const cards = [...bot.cards, ...this.community];
    const suits = {};
    let outs = 0;
    cards.forEach(c => { suits[c.suit] = (suits[c.suit] || 0) + 1; });
    // 同花听: 恰好 4 张同花 (未成同花); 长牌剩 9 张, 短牌剩 5 张
    if (this.community.length >= 3 && Object.values(suits).some(v => v === 4)) outs += short ? 5 : 9;
    // 顺子听: 去重后最长连续 rank 长度; 短牌顺子补牌窗口小 (6-A), outs 减半
    const ranks = [...new Set(cards.map(c => c.rank))].sort((a, b) => a - b);
    let best = 1, cur = 1;
    for (let i = 1; i < ranks.length; i++) {
      cur = ranks[i] - ranks[i - 1] === 1 ? cur + 1 : 1;
      best = Math.max(best, cur);
    }
    if (best >= 4) outs += short ? 4 : 8;
    else if (best === 3) outs += short ? 2 : 4;
    return Math.min(outs, 12);
  }

  /** 听牌明细 (用户: 想要听牌功能) — 返回 { outs, desc, draws[] } */
  drawInfo(bot) {
    const short = this.shortDeck;
    const cards = [...bot.cards, ...(this.community || [])];
    if (cards.length < 5 || this.state === 'waiting' || this.state === 'showdown' || this.state === 'settle') {
      return { outs: 0, desc: '', draws: [] };
    }
    // 当前已成牌型: 已成牌不叫"听牌"
    const cur = evaluateBest(cards, { shortDeck: short });
    if (cur.type >= 4) return { outs: 0, desc: '已成 ' + cur.name, draws: [] };  // 三条以上不显示听牌
    const suits = {};
    cards.forEach(c => { suits[c.suit] = (suits[c.suit] || 0) + 1; });
    const draws = [];
    let total = 0;
    // 同花听: 4 张同花
    for (const s in suits) {
      if (suits[s] === 4 && this.community.length >= 3) {
        const n = short ? 5 : 9;
        draws.push(`听同花(${n})`);
        total += n;
      }
    }
    // 顺子听: 最长连续 3-4 张, 缺 1-2 张成顺
    const ranks = [...new Set(cards.map(c => c.rank))].sort((a, b) => a - b);
    let best = 1, bestEnd = ranks[0];
    let cur2 = 1, curEnd = ranks[0];
    for (let i = 1; i < ranks.length; i++) {
      cur2 = ranks[i] - ranks[i - 1] === 1 ? cur2 + 1 : 1;
      curEnd = ranks[i];
      if (cur2 > best) { best = cur2; bestEnd = curEnd; }
    }
    if (best >= 4) {
      const n = short ? 4 : 8;
      draws.push(`听顺子(${n})`);
      total += n;
    } else if (best === 3) {
      const n = short ? 2 : 4;
      draws.push(`两头听顺(${n})`);
      total += n;
    }
    if (!draws.length) return { outs: 0, desc: '', draws: [] };
    return { outs: Math.min(total, 12), desc: draws.join(' / '), draws };
  }

  removePlayer(socketId) {
    const p = [...this.playersById.values()].find(x => x.socketId === socketId);
    if (!p) return;
    // 中途移除前结算当局积分: 断线超时/被踢/主动离开时, 已投入的筹码即本局净损,
    // 否则该局投入永远不进入个人积分 (原机制只在当局正常结束时结算)
    this.settlePlayerScore(p);
    // 对局中移除: 其投入已进入 pot, 记录为"残余注"供结算时分给赢家 (避免钱蒸发)
    // 注意: 必须用 totalBet (本局全部投入) 而非当前街 bet —— 若玩家在非行动轮被移除,
    // 当前街 bet 为 0, 但前几街投入仍留在底池且不在剩余玩家的层级计算中, 漏记会直接蒸发筹码
    // (settle 阶段已分发完毕, 不再记残余注)
    if (this.state !== 'waiting' && this.state !== 'settle' && p.totalBet > 0) {
      this.orphanBets += p.totalBet;
      p.bet = 0;
    }
    // 清理该玩家的挂起状态 (若正挂起等重连, 移除后定时器不得再推进对局)
    if (p.suspended) {
      p.suspended = false;
    }
    this.players[p.seat] = null;
    this.playersById.delete(p.id);
    if (this.hostId === p.id) {
      // 房主离开: 优先转让给真人玩家 (机器人无法开局)
      const next = [...this.playersById.values()].find(x => !x.isBot) || [...this.playersById.values()][0];
      this.hostId = next ? next.id : null;
    }
    // 游戏中离开 → 视为弃牌
    if (this.state !== 'waiting') {
      p.folded = true;
      this.afterAction();
    } else {
      this.broadcast();
    }
  }

  /** 房主踢人: 按玩家 id 移除（同 removePlayer, 返回被踢玩家信息用于通知） */
  kickPlayer(hostSocketId, targetPlayerId) {
    const host = this.bySocket(hostSocketId);
    if (!host || host.id !== this.hostId) return { ok: false, msg: '只有房主可以踢人' };
    const target = this.playersById.get(targetPlayerId);
    if (!target) return { ok: false, msg: '该玩家不存在' };
    if (target.id === host.id) return { ok: false, msg: '不能踢自己' };
    // 先记录被踢者 socketId 再移除（移除后 playersById 里就找不到了）
    const targetSocketId = target.socketId;
    const targetName = target.name;
    this.removePlayer(target.socketId);
    this.log(`${host.name} 踢出了 ${targetName}`);
    this.broadcast();
    return { ok: true, targetId: target.id, name: targetName, targetSocketId, targetClientId: target.clientId || '' };
  }

  reconnectPlayer(oldSocketId, newSocketId, name) {
    const p = [...this.playersById.values()].find(x => x.socketId === oldSocketId);
    if (!p) return null;
    p.socketId = newSocketId;
    p.connected = true;
    if (name) p.name = name;
    return p;
  }

  /** 按浏览器唯一标识(clientId)重连: socketId 每次断线都变, clientId 稳定 */
  reconnectByClientId(clientId, newSocketId, name) {
    if (!clientId) return null;
    const p = [...this.playersById.values()].find(x => x.clientId === clientId);
    if (!p) return null;
    p.socketId = newSocketId;
    p.connected = true;
    if (name) p.name = name;
    return p;
  }

  /** 换设备重连: 优先 username → accountId → 昵称兜底 */
  reconnectByName(name, newSocketId, clientId, accountId, username) {
    if (!name && !accountId && !username) return null;
    // 优先: username 匹配 (正式账号唯一)
    let p = username
      ? [...this.playersById.values()].find(x => x.username === username && !x.isBot)
      : null;
    // 其次: accountId 匹配 (轻量游客唯一)
    if (!p && accountId) p = [...this.playersById.values()].find(x => x.accountId === accountId && !x.isBot);
    // 兜底: 同名离线玩家
    if (!p && name) p = [...this.playersById.values()].find(x => x.name === name && !x.isBot);
    if (!p) return null;
    p.socketId = newSocketId;
    p.connected = true;
    if (clientId) p.clientId = clientId; // 更新为新设备的 clientId, 后续用新标识
    return p;
  }

  /** 玩家掉线: 标记断开; 若正轮到该玩家行动 → 按行动超时处理(45s), 不阻塞牌局:
   *  重启行动计时器, 超时后自动免费过牌/需跟注弃牌; 重连回来(clearSuspend)立即恢复自主行动 */
  handleDisconnect(socketId) {
    const p = this.bySocket(socketId);
    if (!p) return;
    // 玩家已被新连接接管(单点登录顶号) → 跳过, 避免覆盖新连接的 connected=true
    if (p.socketId !== socketId) return;
    p.connected = false;
    p.disconnectedAt = Date.now();
    if (this.state !== 'waiting' && this.currentPlayerId === p.id && !p.folded && !p.allIn) {
      // 正轮到行动: 保留行动权, 重启 45s 行动计时器, 超时后免费过牌/需跟注弃牌
      p.suspended = true;
      p.suspendedAt = Date.now();
      this.log(`${p.name} 离线, 按行动超时处理 (45秒), 回来即可继续操作`);
      this.startTimer();
    }
  }

  /** 玩家重连/回来: 清除挂起状态, 恢复行动计时器 (由 server 在重连成功后调用)。
   *  未在对局中(等待) → 直接恢复参与;
   *  对局中且牌还在(未被 AI 托管弃掉) → 立即恢复参与, 本局继续打;
   *  对局中但已托管弃牌(folded) → 保持观战, 下把恢复。 */
  clearSuspend(p) {
    if (p) {
      if (this.awayTimers.has(p.id)) { clearTimeout(this.awayTimers.get(p.id)); this.awayTimers.delete(p.id); }
      // 回来处理:
      //   - 未在对局中(等待/结算) → 直接恢复参与
      //   - 对局中且牌还在(未被 AI 托管弃掉) → 恢复参与, 本局继续打
      //   - 对局中但牌已托管弃牌(folded) → 本局观战, 下把恢复
      if (p.away && this.state === 'waiting') {
        p.away = false;
        this.log(`${p.name} 回来了, 恢复参与`);
      } else if (p.away && !p.folded) {
        p.away = false;
        p._managedCheck = false; // 清除托管过牌标记, 恢复自主行动
        this.log(`${p.name} 回来了, 本局继续参与`);
        // 防御: 若当前正轮到他行动 → 重启行动计时器
        if (this.currentPlayerId === p.id && !p.allIn) this.startTimer();
      } else if (p.away) {
        this.log(`${p.name} 已回来, 本局观战, 下把恢复`);
      }
      if (p.suspended) {
        p.suspended = false;
        p.suspendedAt = null;
        p._managedCheck = false; // 重连后恢复自主行动, 清除托管标记
        this.log(`${p.name} 重连回来了, 牌还在`);
        // 重启行动计时器 (45 秒行动窗口)
        if (this.currentPlayerId === p.id && !p.folded && !p.allIn) this.startTimer();
      }
    }
  }

  /** 主动离开(托管离开): 标记为"本局托管、之后不参与"。
   *  AI 只代打当前这一手牌(免费过牌, 需跟注则弃牌); 座位永久保留置灰等待回来,
   *  不参与后续局, 也不会自动移除。玩家回来(rejoin/接管)即恢复正常参与。 */
  markAway(socketId) {
    const p = this.bySocket(socketId);
    if (!p) return;
    p.away = true;
    p.connected = false;
    p.disconnectedAt = Date.now();
    this.log(`${p.name} 离开, 本局由 AI 托管, 之后不参与`);
    // 若正轮到该玩家行动 → 立即托管 (不等待行动超时, 主动离开应马上由AI接管)
    if (this.state !== 'waiting' && this.currentPlayerId === p.id && !p.folded && !p.allIn) {
      this.clearTimer();
      p.suspended = false;
      p.suspendedAt = null;
      this.afterAction();
    } else if (this.state === 'waiting') {
      // 未开局即离开: 直接进入"不参与"置灰状态
      this.broadcast();
    }
    // 对局中且非行动轮: 轮到该玩家时 afterAction 的托管循环会按策略代打(check/fold)
  }

  /** 断线超时被移除后重连: 尝试恢复原座位与筹码 (快照来自 server 的 pendingJoin) */
  restorePlayer(snap, newSocketId) {
    if (!snap || !snap.id) return null;
    const emptySeat = this.players.findIndex(x => !x);
    if (emptySeat === -1) return null; // 房间满员, 无法恢复
    const p = new Player(snap.id, snap.name || '玩家', newSocketId);
    p.seat = emptySeat;
    p.chips = (typeof snap.chips === 'number') ? snap.chips : 1000;
    p.debt = (typeof snap.debt === 'number') ? snap.debt : 0;
    if (snap.clientId) p.clientId = snap.clientId;
    if (snap.accountId) p.accountId = snap.accountId;
    if (snap.username) p.username = snap.username;
    p.connected = true;
    // 用正式 username 优先恢复积分, 否则 accountId 兜底
    try {
      let acc = null;
      if (p.username) acc = accounts.getAccountByUsername(p.username);
      if (!acc && p.accountId) acc = accounts.getOrCreateAccount(p.accountId, p.name);
      if (acc) { p.score = acc.score; p.wins = acc.wins; p.losses = acc.losses; }
    } catch (e) { /* ignore */ }
    this.players[emptySeat] = p;
    this.playersById.set(p.id, p);
    this.log(`${p.name} 重连恢复座位 (筹码 ${p.chips})`);
    return p;
  }

  setReady(socketId) {
    const p = this.bySocket(socketId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.state === 'waiting') {
      p.ready = !p.ready;
      this.broadcast();
      return { ok: true };
    }
    if (this.state === 'settle') {
      // 结算确认阶段: 输光者必须先借钱或放弃才能确认
      if (p.chips <= 0) return { ok: false, msg: '你已输光，请借钱或放弃' };
      p.ready = true;
      this.broadcast();
      this.maybeAutoStartNext();
      return { ok: true };
    }
    return { ok: false, msg: '当前状态不可准备' };
  }

  setReadyForce(socketId, v) {
    const p = this.bySocket(socketId);
    if (!p) return;
    p.ready = v;
    this.broadcast();
  }

  /**
   * 向银行买筹码（结算确认阶段/等待开局时, 筹码耗尽时允许）
   * amount: 买入额（默认 1000）, 记入欠款 debt
   */
  buyIn(socketId, amount = 1000) {
    const p = this.bySocket(socketId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.state !== 'waiting' && this.state !== 'settle') {
      return { ok: false, msg: '仅在本局结束后可买入' };
    }
    if (p.chips > 0) return { ok: false, msg: '你还有筹码，无需买入' };
    const amt = Math.max(1, Math.floor(Number(amount) || 1000));
    p.chips += amt;
    p.debt += amt;
    // 买入同步上移开局基准: 避免"异常中断未结算 + 买入后离开"时把买入额误算成当局净赢
    if (!p._scoreSettled) p.startChips += amt;
    this.log(`${p.name} 向银行买入 ${amt} 筹码（欠款 ${p.debt}）`);
    this.broadcast();
    // settle 阶段借钱后若全员就绪可自动开局
    if (this.state === 'settle') this.maybeAutoStartNext();
    return { ok: true, msg: `已买入 ${amt} 筹码，累计欠款 ${p.debt}` };
  }

  /**
   * 放弃游戏（结算阶段输光者退出, 或对局中主动弃权）
   * 移除玩家座位, 交给服务器处理房间清理
   */
  forfeit(socketId) {
    const p = this.bySocket(socketId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    const name = p.name;
    // 对局中退出: 其投入已入池, 残余注并入 orphanBets 避免钱蒸发 (须记 totalBet, 见 removePlayer 说明;
    // settle 阶段已分发完毕, 不再记残余注)
    if (this.state !== 'waiting' && this.state !== 'settle' && p.totalBet > 0) {
      this.orphanBets += p.totalBet;
      p.bet = 0;
    }
    // 清理该玩家的托管离开/挂起定时器
    if (this.awayTimers.has(p.id)) { clearTimeout(this.awayTimers.get(p.id)); this.awayTimers.delete(p.id); }
    if (p.suspended) {
      p.suspended = false;
    }
    this.players[p.seat] = null;
    this.playersById.delete(p.id);
    if (this.hostId === p.id) {
      // 房主离开: 优先转让给真人玩家 (机器人无法开局)
      const next = [...this.playersById.values()].find(x => !x.isBot) || [...this.playersById.values()][0];
      this.hostId = next ? next.id : null;
    }
    this.log(`${name} 选择退出游戏`);
    // 对局中退出 → 视为弃牌并推进对局; 否则广播等待状态
    if (this.state !== 'waiting') {
      this.afterAction();
    } else {
      this.broadcast();
    }
    if (this.state === 'settle') this.maybeAutoStartNext();
    return { ok: true, removed: true, name };
  }

  /** 结算阶段: 剩余玩家全部确认后自动开局 */
  maybeAutoStartNext() {
    if (this.state !== 'settle') return;
    const seated = this.players.filter(p => p);
    // 有效玩家 = 在线且非托管离开 (离开置灰/断线未回的玩家下一局不参与)
    const active = seated.filter(p => !p.away && p.connected);
    if (active.length < 2 || !active.some(p => !p.isBot)) {
      // 有效人数不足, 或无真人参与(真人全退只剩 bot): 回到等待状态, 房间随后会被清理
      this.resetToWaiting();
      return;
    }
    const broke = active.filter(p => p.chips <= 0);
    if (broke.length > 0) return; // 还有人输光未解决
    if (!active.every(p => p.ready)) return; // 未全员确认
    this.log('全员确认，自动进入下一局');
    this.startHand();
  }

  /** 当前筹码不足开局的玩家名单（需先买入才能开局） */
  brokePlayers() {
    return this.players.filter(p => p && p.chips <= 0);
  }

  bySocket(socketId) {
    return [...this.playersById.values()].find(x => x.socketId === socketId);
  }

  // ---------- 开局 ----------
  maybeAutoStart() {
    if (this.state !== 'waiting') return;
    const seated = this.players.filter(p => p);
    if (seated.length < 2) return;
    // 房主点开始 或 所有人准备
    // 由客户端触发 start 事件，这里只处理全部准备时自动开始
  }

  tryStart() {
    const seated = this.players.filter(p => p);
    if (seated.length < 2) return { ok: false, msg: '至少需要 2 名玩家' };
    if (this.state !== 'waiting') return { ok: false, msg: '对局已在进行' };
    // 有效玩家 = 在线且非托管离开 (离开置灰/断线未回的玩家下一局不参与)
    const active = seated.filter(p => !p.away && p.connected);
    if (active.length < 2 || !active.some(p => !p.isBot)) return { ok: false, msg: '至少需要 2 名有效玩家' };
    const broke = active.filter(p => p.chips <= 0);
    if (broke.length > 0) {
      return { ok: false, msg: `${broke.map(p => p.name).join('、')} 筹码已耗尽，需向银行买入` };
    }
    this.startHand();
    return { ok: true };
  }

  startHand() {
    this.round++;
    this.state = 'preflop';
    this._settlePending = false; // 重置结算防重入标记
    this.orphanBets = 0; // 重置残余注
    this.community = [];
    this.currentBet = 0;
    this.pot = 0;
    this.sidePots = [];
    this.actionLog = [];
    this.lastWinnerText = '';
    this.showdownResult = null;
    this.showdownCommunity = null;
    this.actedSet = new Set();
    this.raiseReopened = false; // 新一局: 加注权未重开

    const seated = this.players.filter(p => p);
    seated.forEach(p => {
      p.cards = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = false;
      p.allIn = false;
      p.ready = p.isBot; // AI 自动准备
      p.startChips = p.chips; // 记录本局起始筹码, 结算时用于计算净赢/输点数
      p._scoreSettled = false; // 重置当局积分结算标记 (每局最多结算一次)
      p._managedCheck = false; // 重置托管过牌标记
    });
    // 托管离开(away)的玩家处理:
    //  - 已回来观战(connected=true) → 下把恢复参与(清除 away)
    //  - 仍未回来(connected=false) → 继续不参与, 座位置灰
    seated.forEach(p => {
      if (p.away) {
        if (p.connected) {
          p.away = false;
          this.log(`${p.name} 观战完毕, 本局恢复参与`);
        } else {
          p.folded = true; p.ready = false;
        }
      }
      // 观战坐下(sitNext): 新一局正式开始参与
      if (p.sitNext) {
        p.sitNext = false;
        this.log(`${p.name} 本局正式参与`);
      }
    });

    // 仅"参与本局"的玩家 (排除仍在 away 的): 庄家轮转/发牌/盲注都基于他们
    const active = seated.filter(p => !p.away);
    // 庄家轮转: 从第一个座位开始, 每次 +1
    if (this.dealerSeat === -1) {
      // 从有玩家的最小座位开始做庄
      const minSeat = Math.min(...active.map(p => p.seat));
      this.dealerSeat = minSeat;
    } else {
      const seats = active.map(p => p.seat).sort((a, b) => a - b);
      const cur = seats.findIndex(s => s === this.dealerSeat);
      this.dealerSeat = seats[(cur + 1) % seats.length];
    }

    // 确定 SB / BB 座位 (标准规则: 庄家下家=SB, 下下家=BB; 2人局庄家=SB)
    // 注意: order 为座位升序, dealerSeat 必在其中; 不能用 order[0]/order[1] 直接取 SB/BB,
    // 否则 2 人局会出现 SB===BB 同人, 3+ 人局盲注错位 (与 advanceTurn 的 seatOrder 语义对齐)
    const order = active.map(p => p.seat);
    const dealerIdx = order.indexOf(this.dealerSeat);
    let sbSeat, bbSeat;
    if (order.length === 2) {
      // heads-up: 庄家兼小盲, 唯一对手为大盲
      sbSeat = this.dealerSeat;
      bbSeat = order.find(s => s !== this.dealerSeat);
    } else {
      sbSeat = order[(dealerIdx + 1) % order.length]; // 庄家下家
      bbSeat = order[(dealerIdx + 2) % order.length]; // 庄家下下家
    }
    const sb = this.players[sbSeat];
    const bb = this.players[bbSeat];
    this.currentSbSeat = sbSeat;
    this.currentBbSeat = bbSeat;

    // 发牌
    this.deck = shuffle(createDeck(this.shortDeck));
    for (let i = 0; i < 2; i++) {
      for (const p of order.map(s => this.players[s])) {
        if (p) p.cards.push(this.deck.pop());
      }
    }

    // 盲注
    this.placeBlind(sb, this.sb);
    this.placeBlind(bb, this.bb);
    this.minRaise = this.bb;
    // 盲注玩家筹码不足时(短全下), currentBet 以实际投入为上限:
    // 例: BB 只剩 3 筹码(bb=10) → 本街最高有效注为 3, 后续玩家只需跟 3;
    // 修复前固定 currentBet=bb, 会强迫其他玩家跟完整大盲 (SB 甚至要多跟已超过 BB 全下额的差价)
    this.currentBet = Math.min(this.bb, bb.bet);

    // 第一个行动者: preflop 是 BB 下一位, 之后是庄家下家
    this.currentPlayerId = null;
    this.advanceTurn(true);
    this.log(`第 ${this.round} 局开始，庄家 ${sb.name}，大盲 ${bb.name}（${this.bb}）`);
    this.broadcast();
  }

  placeBlind(p, amt) {
    if (!p) return;
    const real = Math.min(amt, p.chips);
    p.chips -= real;
    p.bet += real;
    p.totalBet += real;
    this.pot += real;
    if (p.chips === 0) p.allIn = true;
    this.log(`${p.name} 下盲注 ${real}`);
  }

  /** 座位顺序（从庄家下家开始; 排除观战坐下 sitNext, 他们本局不参与行动/盲注） */
  seatOrder() {
    const seated = this.players.map((p, i) => p && !p.sitNext ? i : -1).filter(i => i >= 0);
    if (this.dealerSeat === -1) return seated;
    const idx = seated.indexOf(this.dealerSeat);
    if (idx === -1) return seated;
    return [...seated.slice(idx + 1), ...seated.slice(0, idx + 1)];
  }

  /** 从指定座位(不含)之后找第一个活跃玩家座位 (排除 sitNext) */
  nextActiveSeatAfter(seat) {
    const order = this.seatOrder();
    const idx = order.indexOf(seat);
    for (let i = 1; i <= order.length; i++) {
      const s = order[(idx + i) % order.length];
      const p = this.players[s];
      if (p && !p.folded && !p.allIn && !p.sitNext) return s;
    }
    return -1;
  }

  /** 下一个要行动的玩家座位（含全下检查; 离线玩家也视为可行动, 由 advanceTurn 自动处理） */
  nextToActSeat() {
    const order = this.seatOrder();
    // 防御: currentPlayerId 的玩家可能刚被移除 (removePlayer 对局中离开), get 可能 undefined
    const cur = this.currentPlayerId ? this.playersById.get(this.currentPlayerId) : null;
    const curIdx = cur ? order.indexOf(cur.seat) : -1;
    for (let i = 1; i <= order.length; i++) {
      const s = order[(curIdx + i) % order.length];
      const p = this.players[s];
      if (p && !p.folded && !p.allIn && !p.sitNext) return s;
    }
    return -1;
  }

  // ---------- 行动 ----------
  doAction(socketId, action, amount = 0) {
    const p = this.bySocket(socketId);
    if (!p) return { ok: false, msg: '玩家不存在' };
    if (this.state === 'waiting') return { ok: false, msg: '对局尚未开始' };
    if (p.away) return { ok: false, msg: '你已托管离开，本局观战中，下局恢复参与' };
    if (p.folded) return { ok: false, msg: '你已经弃牌' };
    if (p.allIn) return { ok: false, msg: '你已经全下' };
    if (p.id !== this.currentPlayerId) return { ok: false, msg: '还没轮到你行动' };

    amount = Math.floor(Number(amount) || 0);
    const toCall = this.currentBet - p.bet;

    switch (action) {
      case 'fold': {
        p.folded = true;
        this.log(`${p.name} 弃牌`);
        this.markActed(p);
        this.afterAction();
        this.broadcast();
        return { ok: true };
      }
      case 'check': {
        if (toCall > 0) return { ok: false, msg: '不能过牌，请跟注或弃牌' };
        this.log(`${p.name} 过牌`);
        this.markActed(p);
        this.afterAction();
        this.broadcast();
        return { ok: true };
      }
      case 'call': {
        if (toCall <= 0) return { ok: false, msg: '无需跟注，可以选择过牌' };
        const real = Math.min(toCall, p.chips);
        p.chips -= real;
        p.bet += real;
        p.totalBet += real;
        this.pot += real;
        if (p.chips === 0) p.allIn = true;
        this.log(p.allIn ? `${p.name} 全下跟注 ${real}` : `${p.name} 跟注 ${real}`);
        this.markActed(p);
        this.afterAction();
        this.broadcast();
        return { ok: true };
      }
      case 'raise': {
        // TDA 严格规则: 本轮尚无完整加注(只有短全下)时, 已行动过的玩家不得再加注 (只能跟/弃)
        if (this.actedSet.has(p.id) && !this.raiseReopened) {
          return { ok: false, msg: '对方短全下，你只能跟注或弃牌' };
        }
        const minRaiseAmount = this.minRaise;
        const raiseTo = amount; // 目标总额（含此前投入）
        if (raiseTo <= this.currentBet) return { ok: false, msg: `加注需大于 ${this.currentBet}` };
        // 下注额统一为 10 的整数倍 (盲注 10 倍数 → 跟注/加注链均 10 倍数, 前端滑块 step=10 + 吸附);
        // 全下(付不起目标额)豁免, 允许任意筹码
        if (raiseTo % 10 !== 0 && p.chips + p.bet > raiseTo) return { ok: false, msg: '下注需为 10 的整数倍' };
        if (raiseTo - this.currentBet < minRaiseAmount && p.chips + p.bet > raiseTo) {
          return { ok: false, msg: `最小加注额为 ${minRaiseAmount}` };
        }
        const real = Math.min(raiseTo - p.bet, p.chips);
        if (real <= 0) return { ok: false, msg: '无效加注' };
        // 若全下不足最小加注，按全下处理
        const isAllIn = p.chips - real <= 0;
        p.chips -= real;
        p.bet += real;
        p.totalBet += real;
        this.pot += real;
        const delta = p.bet - this.currentBet;
        if (delta > 0) {
          this.currentBet = p.bet;
          // 仅"完整加注"(增量 >= 当前最小加注)才更新加注门槛并重开加注权;
          // 短全下(筹码不足, 增量 < minRaise)不得降低门槛, 也不重开已行动玩家的加注权 (TDA)
          if (delta >= this.minRaise) {
            this.minRaise = delta;
            this.raiseReopened = true;
          }
        }
        if (isAllIn) p.allIn = true;
        this.log(isAllIn
          ? `${p.name} 全下 ${p.totalBet}`
          : `${p.name} 加注到 ${p.bet}`);
        this.markActed(p);
        this.afterAction();
        this.broadcast();
        return { ok: true };
      }
      case 'allin': {
        // TDA: 已行动玩家在本轮无完整加注时, 只能以跟注额全下 (不能全下加注)
        if (this.actedSet.has(p.id) && !this.raiseReopened && p.chips + p.bet > this.currentBet) {
          return { ok: false, msg: '对方短全下，你只能跟注或弃牌' };
        }
        const real = p.chips;
        p.chips = 0;
        p.bet += real;
        p.totalBet += real;
        this.pot += real;
        p.allIn = true;
        const delta = p.bet - this.currentBet;
        if (delta > 0) {
          this.currentBet = p.bet;
          // 完整全下加注才重开加注权; 短全下不得降低最小加注额 (见 raise 分支说明)
          if (delta >= this.minRaise) {
            this.minRaise = delta;
            this.raiseReopened = true;
          }
        }
        this.log(`${p.name} 全下 ${p.totalBet}`);
        this.markActed(p);
        this.afterAction();
        this.broadcast();
        return { ok: true };
      }
      default:
        return { ok: false, msg: '未知操作' };
    }
  }

  markActed(p) {
    this.actedSet.add(p.id);
    this.clearTimer();
  }

  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    if (this.botWatchdog) { clearTimeout(this.botWatchdog); this.botWatchdog = null; }
    this.actionDeadline = null; // 倒计时截止时间戳 (前端据此显示剩余秒数)
  }

  /** 发完剩余公共牌到 5 张 (按街推进, 每街发牌前烧一张牌, 贴合标准规则) */
  runOutBoard() {
    while (this.community.length < 5) {
      this.deck.pop(); // 标准烧牌 (burn card): 不进任何池
      const need = this.state === 'preflop' ? 3 : 1;
      for (let i = 0; i < need && this.community.length < 5; i++) {
        this.community.push(this.deck.pop());
      }
      if (this.state === 'preflop') this.state = 'flop';
      else if (this.state === 'flop') this.state = 'turn';
      else if (this.state === 'turn') this.state = 'river';
    }
  }

  afterAction() {
    // 只剩一人未弃牌 → 直接赢 (排除 sitNext 观战坐下的玩家, 他们本局不参与)
    const alive = this.players.filter(p => p && !p.folded && !p.sitNext);
    if (alive.length === 1) {
      this.finishHand(alive[0]);
      return;
    }
    // 全员托管离开(away) → 无真人参与, 直接结算本局底池(按现有牌力分配), 避免无限托管过牌
    const hasActiveHuman = alive.some(p => !p.isBot && !p.away);
    if (!hasActiveHuman) {
      this.log('全员托管离开, 本局直接结算');
      this.runOutBoard(); // 发完剩余公共牌 (每街前烧牌)
      this.state = 'showdown';
      this.doShowdown();
      return;
    }
    // 是否所有活人已全下 → 自动发完剩余公共牌后摊牌 (run it out)
    const notAllIn = alive.filter(p => !p.allIn);
    if (notAllIn.length === 0) {
      this.log('全员全下，自动发完公共牌');
      this.runOutBoard(); // 发完剩余公共牌 (每街前烧牌)
      this.state = 'showdown';
      this.doShowdown();
      return;
    }
    // 本轮是否结束 (away 托管玩家与 45 秒行动超时内的断线玩家视为已完成本轮, 避免卡轮等待)
    const roundDone = alive.every(p =>
      p.away
      || p.allIn
      || (p.disconnectedAt && Date.now() - p.disconnectedAt < ACTION_TIMEOUT_MS)
      || (this.actedSet.has(p.id) && p.bet === this.currentBet)
    );
    if (roundDone) {
      this.advanceStage();
      return;
    }
    // 推进到下一个行动者
    this.advanceTurn();
  }

  advanceTurn(forceFirst = false) {
    let seat;
    if (forceFirst) {
      const order = this.seatOrder();
      if (this.state === 'preflop') {
        // preflop: BB 下一位先行动 (2人局 BB=order[0], 3+人局 BB=order[1])
        const bbSeat = order.length === 2 ? order[0] : order[1];
        seat = this.nextActiveSeatAfter(bbSeat);
      } else {
        // flop 之后: 3+ 人局庄家下家先行动 (order[0]); 若弃牌/全下则顺延
        // 2 人局(单挑): 标准规则 = 按钮(庄家, 兼 SB)先行动 (修复前错误地让 BB 先手)
        let first = order.length === 2 ? this.dealerSeat : order[0];
        const p0 = this.players[first];
        if (!p0 || p0.folded || p0.allIn) {
          first = this.nextActiveSeatAfter(first);
        }
        seat = first;
      }
    } else {
      seat = this.nextToActSeat();
    }

    // 处理离线/托管玩家 (用循环迭代, 避免递归栈溢出)
    //   - 主动托管离开(away=true): 立即 AI 托管(不等行动超时), 无论是否已回来观战
    //     → 免费过牌(toCall<=0) / 需花钱跟注则自动弃牌(fold); 座位永久保留置灰, 牌不再参与本局
    //   - 被动断线: 45 秒行动超时内(或挂起等待重连)跳过不行动, 给重连机会; 超过超时才托管
    //   - 在线非 away 玩家: 结束循环, 成为当前行动者
    //   - 为防止全员托管过牌时无限循环, 对托管玩家标记 _managedCheck 后跳过(本轮不再重复触发)
    let guard = 0;
    while (seat !== -1 && guard++ < 50) {
      const cur = this.players[seat];
      if (!cur || cur.sitNext) {
        // sitNext(观战坐下): 本局不参与行动, 直接跳过
        seat = forceFirst
          ? this.nextActiveSeatAfter(seat)
          : this.nextToActSeat();
        continue;
      }
      if (cur.away) {
        // 主动托管离开: 立即代打(不等待宽限期), 回来观战也同样托管, 牌不再参与本局
        const toCall = this.currentBet - cur.bet;
        if (toCall > 0) {
          if (!cur.folded) {
            cur.folded = true;
            this.log(`${cur.name} 托管离开: 需跟注 ${toCall}, 自动弃牌`);
          }
        } else if (!cur._managedCheck) {
          cur._managedCheck = true; // 本轮托管过牌(免费), 标记后跳过
          this.actedSet.add(cur.id); // 记录已行动: 玩家回来后本轮不再重复轮到他
          this.log(`${cur.name} 托管离开: 免费过牌`);
        }
        seat = forceFirst
          ? this.nextActiveSeatAfter(seat)
          : this.nextToActSeat();
        continue;
      }
      if (!cur.connected) {
        const justLeft = cur.disconnectedAt && (Date.now() - cur.disconnectedAt < ACTION_TIMEOUT_MS);
        if (cur.suspended || justLeft) {
          // 被动断线宽限期内: 跳过, 不行动
        } else {
          // 托管生效: 免费过牌 / 需花钱则弃牌
          const toCall = this.currentBet - cur.bet;
          if (toCall > 0) {
            if (!cur.folded) {
              cur.folded = true;
              this.log(`${cur.name} 离线托管: 需跟注 ${toCall}, 自动弃牌`);
            }
          } else if (!cur._managedCheck) {
            cur._managedCheck = true; // 本轮托管过牌(免费), 标记后跳过
            this.actedSet.add(cur.id); // 记录已行动: 玩家回来后本轮不再重复轮到他
            this.log(`${cur.name} 离线托管: 免费过牌`);
          }
        }
        // 继续找下一个行动者
        seat = forceFirst
          ? this.nextActiveSeatAfter(seat)
          : this.nextToActSeat();
      } else {
        cur._managedCheck = false; // 在线玩家: 清除托管标记
        break; // 找到在线玩家
      }
    }

    if (seat === -1) {
      // 没有人能行动（全员全下/弃牌/离线）→ 自动发完公共牌后摊牌
      const alive = this.players.filter(p => p && !p.folded && !p.sitNext);
      if (alive.length === 1) { this.finishHand(alive[0]); return; }
      if (alive.length === 0) { this.resetToWaiting(); return; }
      // run it out: 发完剩余公共牌 (每街前烧牌)
      this.runOutBoard();
      this.log('无人可行动，自动发完公共牌');
      this.state = 'showdown';
      this.doShowdown();
      return;
    }
    this.currentPlayerId = this.players[seat].id;
    // AI 机器人自动行动 (延迟 1.5s 模拟思考: 不拖沓也不连过好几回合, 特效可看清)
    if (this.players[seat].isBot) {
      const bot = this.players[seat];
      const delay = 1500;
      this.clearTimer();
      // bot 行动: 任何失败/异常都兜底为 call/check, 绝不死锁
      this.botTimer = setTimeout(() => {
        if (this.state === 'showdown' || this.state === 'settle' || bot.folded || !bot.connected) return;
        const fallback = () => {
          const toCall = this.currentBet - bot.bet;
          this.doAction(bot.socketId, toCall > 0 ? 'call' : 'check');
        };
        try {
          const decision = this.botDecide(bot);
          const r = this.doAction(bot.socketId, decision.action, decision.amount || 0);
          if (!r || !r.ok) {
            // 决策动作被拒(如筹码不足的非法加注) → 退化为跟注/过牌 (日志降噪: 仅记录一次)
            if (process.env.DEBUG_BOT) console.log(`[bot兜底] ${bot.name}: ${r && r.msg}`);
            fallback();
          }
        } catch (e) {
          console.error(`bot ${bot.name} 行动异常，兜底处理:`, e && e.message);
          fallback();
        }
      }, delay);
      // 独立看门狗: 无论 botTimer 是否被意外清除/失效, 超时未行动就强制兜底
      if (this.botWatchdog) clearTimeout(this.botWatchdog);
      this.botWatchdog = setTimeout(() => {
        const cur = this.currentPlayerId ? this.playersById.get(this.currentPlayerId) : null;
        if (cur && cur.isBot && cur === bot && !cur.folded && cur.connected
          && this.state !== 'showdown' && this.state !== 'settle' && this.state !== 'waiting') {
          console.error(`bot ${bot.name} 看门狗触发: 超时未行动, 强制兜底`);
          const toCall = this.currentBet - bot.bet;
          this.doAction(bot.socketId, toCall > 0 ? 'call' : 'check');
        }
      }, delay + 6000);
      return;
    }
    this.startTimer();
  }

  advanceStage() {
    const alive = this.players.filter(p => p && !p.folded && !p.sitNext);
    if (alive.length <= 1) { if (alive[0]) this.finishHand(alive[0]); return; }

    switch (this.state) {
      case 'preflop': {
        this.state = 'flop';
        this.deck.pop(); // 烧牌
        this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        this.log('翻牌: ' + this.community.map(c => `${['♠','♥','♦','♣'][c.suit]}${[0,'','','','','','','','','','J','Q','K','A'][c.rank]}`).join(' '));
        break;
      }
      case 'flop': {
        this.state = 'turn';
        this.deck.pop(); // 烧牌
        this.community.push(this.deck.pop());
        this.log('转牌发出');
        break;
      }
      case 'turn': {
        this.state = 'river';
        this.deck.pop(); // 烧牌
        this.community.push(this.deck.pop());
        this.log('河牌发出');
        break;
      }
      case 'river': {
        this.state = 'showdown';
        this.doShowdown();
        return;
      }
    }
    // 新一轮: 重置本轮下注
    this.newBettingRound();
    this.broadcast();
  }

  newBettingRound() {
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.actedSet.clear();
    this.raiseReopened = false; // 新街重置: 首个完整加注才重开加注权
    for (const p of this.players) {
      if (p && !p.folded) { p.bet = 0; p._managedCheck = false; }
    }
    this.advanceTurn(true);
  }

  // ---------- 摊牌与结算 ----------
  doShowdown() {
    const alive = this.players.filter(p => p && !p.folded && !p.sitNext);
    if (alive.length === 0) { this.resetToWaiting(); return; }
    if (alive.length === 1) { this.finishHand(alive[0]); return; }
    this.log('摊牌');
    this.finishHand(null, alive);
  }

  /** 无人继续对局时回到等待状态 */
  resetToWaiting() {
    this.clearTimer();
    this.state = 'waiting';
    this._settlePending = false;
    this.currentPlayerId = null;
    this.community = [];
    for (const p of this.players) {
      if (p) { p.ready = p.isBot; p.allIn = false; }  // bot 自动准备
    }
    this.broadcast();
  }

  /** 补全 best5 为完整组合: 手牌 + 已发公共牌凑够 5 张 (按牌力最优在前)。
      关键: 提前结束/公共牌不足时, 所有已发牌都算作组合 (前端结算面板高亮它们,
      未发的卡背不参与) — 修复"手牌高亮但公共牌全灰" */
  completeBest5(holeCards, evCards) {
    const combo = (evCards || []).slice();
    const seen = new Set(combo.map(c => c.rank + '_' + c.suit));
    const pool = [...(holeCards || []), ...(this.community || [])];
    for (const c of pool) {
      if (combo.length >= 5) break;
      const key = c.rank + '_' + c.suit;
      if (!seen.has(key)) {
        seen.add(key);
        combo.push(c);
      }
    }
    return combo; // 不足 5 张如实返回 (公共牌没发完, 前端卡背不参与高亮)
  }

  finishHand(soleWinner, showdownPlayers) {
    // 防重入: 从进入结算到进入 settle 的整个窗口 (约 5.3s) 内忽略重复调用。
    // 修复前仅当 state==='showdown' 且 _settlePending 时拦截, 而 _settlePending 在 2.8s 分发时即被重置,
    // 2.8s~5.3s 窗口内再入 (如断线玩家 2 分钟移除计时器恰好触发 removePlayer→afterAction→finishHand)
    // 会二次分发底池 → 筹码凭空翻倍。现在 _settlePending 覆盖完整结算窗口, 窗口内一律拦截。
    if (this._settlePending) return;
    this._settlePending = true;
    this.clearTimer();
    this.state = 'showdown';
    this.currentPlayerId = null;
    this.showdownResult = null; // 结算排序结果
    this.broadcast();

    // 等待前端展示 ~3s 后结算，让所有人看到结果
    setTimeout(() => {
      let goSettle = true;
      try {
        // 结算期间可能所有玩家都离开了
        const stillPlayers = this.players.some(p => p && p.connected);
        let winners;
        if (!stillPlayers && !soleWinner) {
          this.resetToWaiting();
          goSettle = false;
        } else if (soleWinner) {
          if (!this.players.includes(soleWinner)) {
            this.resetToWaiting();
            goSettle = false;
          } else {
            const ev = evaluateBest([...soleWinner.cards, ...this.community], { shortDeck: this.shortDeck });
            winners = [{ player: soleWinner, score: null, cards: [] }];
            this.lastWinnerText = `${soleWinner.name} 赢走底池 ${this.pot}`;
            this.showdownResult = [{
              player: soleWinner,
              cards: soleWinner.cards,
              best5: this.completeBest5(soleWinner.cards, ev.cards),
              handName: ev.name,
              rank: 1,
              winner: true
            }];
            // 提前结束也要保存本局公共牌 (结算面板展示需要)
            this.showdownCommunity = this.community.slice();
          }
        } else {
          // 评估所有人并排序
          const evals = showdownPlayers.map(p => ({
            player: p,
            ev: evaluateBest([...p.cards, ...this.community], { shortDeck: this.shortDeck }),
            cards: p.cards
          }));
          evals.sort((a, b) => compareScore(a.ev.score, b.ev.score));
          const bestScore = evals[evals.length - 1].ev.score;
          const tied = evals.filter(e => compareScore(e.ev.score, bestScore) === 0);
          winners = tied.map(e => ({ player: e.player, score: e.ev.score, cards: e.cards }));
          const wNames = winners.map(w => w.player.name).join('、');
          const handName = tied[0] ? tied[0].ev.name : '';
          this.lastWinnerText = `${wNames} 以 ${handName} 赢走底池 ${this.pot}`;

          // 生成完整排序（从强到弱, 名次相同=平局）
          const ranked = [];
          let rank = 1;
          for (let i = evals.length - 1; i >= 0; i--) {
            const e = evals[i];
            const isWinner = compareScore(e.ev.score, bestScore) === 0;
            ranked.push({
              player: e.player,
              cards: e.cards,
              best5: this.completeBest5(e.cards, e.ev.cards),   // 最佳 5 张牌组合 (含公共牌, 每行独立)
              handName: e.ev.name,
              rank,
              winner: isWinner
            });
            // 同分并列名次
            if (i > 0 && compareScore(e.ev.score, evals[i - 1].ev.score) !== 0) rank++;
          }
          this.showdownResult = ranked;
          // 保存本局公共牌 (settle 阶段 community 会被清空, 结算面板需要展示完整 7 张)
          this.showdownCommunity = this.community.slice();
        }
        if (goSettle) {
          this.distributePot(winners);
          this.updateScores();   // 结算积分与等级
          this.log(this.lastWinnerText);
          this.broadcast();
        }
      } catch (e) {
        // 任何异常都不能让房间卡死在 showdown: 记录现场后仍进入结算确认阶段
        console.error('[结算] 异常, 强制进入结算确认:', e && e.stack || e);
        try {
          this.distributePot([]); // 兜底: 按现有投入分配, 底池清零
        } catch (e2) { console.error('[结算] 兜底分配失败:', e2 && e2.message); }
        goSettle = true;
      }

      // 进入结算确认阶段: 全员确认后才自动进入下一局
      if (goSettle) {
        setTimeout(() => {
          this.state = 'settle';
          this._settlePending = false; // 结算窗口结束, 允许下一局正常结算
          this.community = [];
          for (const p of this.players) {
            if (p) { p.ready = false; p.allIn = false; }
          }
          // AI 机器人自动处理: 输光自动买筹码(欠款), 欠款太多才放弃退出
          let botReadyAny = false;
          for (const p of this.players) {
            if (p && p.isBot) {
              if (p.chips <= 0) {
                if (p.debt < 5000) {
                  p.chips = 1000;
                  p.debt += 1000;
                  p.ready = true;
                  botReadyAny = true;
                  this.log(`${p.name}(AI) 输光，向银行买 1000 筹码（欠款 ${p.debt}）`);
                } else {
                  // 欠款太多 → 放弃退出
                  p.ready = false;
                  this.players[p.seat] = null;
                  this.playersById.delete(p.id);
                  this.log(`${p.name}(AI) 欠款过多，自动退出`);
                }
              } else {
                p.ready = true;
                botReadyAny = true;
              }
            }
          }
          this.log('本局结束，等待玩家确认');
          this.broadcast();
          if (botReadyAny) this.maybeAutoStartNext();
        }, 2500);
      }
    }, 2800);
  }

  /** 我(某座位)最多可赢: 假设全下(或跟注到顶), 能参与的所有池子总和 (主池+边池) */
  maxWinFor(seat) {
    const me = this.players[seat];
    if (!me) return 0;
    // 我的最终投入 = 已投入 + 剩余筹码 (全下上限; 也可理解为我能匹配的最高层级)
    const myFinal = me.totalBet + me.chips;
    const levels = [...new Set(this.players.filter(p => p).map(p => Math.min(p.totalBet, myFinal)))].sort((a, b) => a - b);
    let prev = 0, total = 0;
    for (const lv of levels) {
      const contrib = lv - prev;
      const participants = this.players.filter(p => p && Math.min(p.totalBet, myFinal) >= lv);
      if (contrib > 0 && participants.length > 0) {
        total += contrib * participants.length;
      }
      prev = lv;
    }
    return total;
  }

  /** 边池分配 */
  distributePot(winners) {
    try {
    const levels = [...new Set(this.players.filter(p => p).map(p => p.totalBet))].sort((a, b) => a - b);
    let prev = 0;
    const pots = [];
    for (const lv of levels) {
      const contrib = lv - prev;
      const participants = this.players.filter(p => p && p.totalBet >= lv);
      if (contrib > 0 && participants.length > 0) {
        pots.push({ amount: contrib * participants.length, players: participants });
      }
      prev = lv;
    }
    this.sidePots = pots.map(p => ({ amount: p.amount, players: p.players.map(pl => pl.name) }));
    // 被移除玩家的残余注: 追加为一个池, 分给所有未弃牌玩家 (避免钱蒸发)
    if (this.orphanBets > 0) {
      const aliveAll = this.players.filter(p => p && !p.folded);
      if (aliveAll.length > 0) {
        pots.push({ amount: this.orphanBets, players: aliveAll });
        this.sidePots.push({ amount: this.orphanBets, players: aliveAll.map(pl => pl.name) });
      }
      this.orphanBets = 0;
    }
    // 从高到低分配
    for (let i = pots.length - 1; i >= 0; i--) {
      const pot = pots[i];
      const eligible = pot.players.filter(p => !p.folded);
      if (eligible.length === 0) continue;
      const evals = eligible.map(p => ({
        p,
        ev: evaluateBest([...p.cards, ...this.community], { shortDeck: this.shortDeck })
      }));
      evals.sort((a, b) => compareScore(a.ev.score, b.ev.score));
      const best = evals[evals.length - 1].ev.score;
      const tied = evals.filter(e => compareScore(e.ev.score, best) === 0);
      const share = Math.floor(pot.amount / tied.length);
      let rem = pot.amount - share * tied.length;
      tied.forEach((w, idx) => {
        w.p.chips += share + (idx === 0 ? rem : 0);
        rem = 0;
      });
    }
    } catch (e) {
      console.error('distributePot 错误:', e && e.message);
    } finally {
      // 无论分配是否成功, 都清零底池和 bet
      this.pot = 0;
      for (const p of this.players) {
        if (p) p.bet = 0;
      }
    }
  }

  /** 一局结束后更新每位玩家的累计积分(score)与等级相关统计, 并写回账号持久化 */
  updateScores() {
    try {
      for (const p of this.players) {
        if (p) this.settlePlayerScore(p);
      }
    } catch (e) {
      console.error('updateScores 错误:', e && e.message);
    }
  }

  /** 单个玩家当局积分结算 (幂等: 每局最多结算一次, 防止中途离开/房间清理重复累加)
   *  delta = 结算后筹码 - 开局筹码 = 本局净赢/输点数 */
  settlePlayerScore(p) {
    if (!p || p.isBot || p._scoreSettled) return;
    p._scoreSettled = true;
    const delta = p.chips - p.startChips;
    p.lastDelta = delta;
    p.score = Math.max(0, p.score + delta);  // 积分下限 0, 不会变负
    if (delta > 0) p.wins++;
    else if (delta < 0) p.losses++;
    // ===== 账号持久化: 正式 username 走 auth(users.json); 游客 accountId 走 accounts(accounts.json) =====
    try {
      if (p.username) {
        auth.saveAccount(p.username, { score: p.score, wins: p.wins, losses: p.losses });
      } else if (p.accountId) {
        accounts.saveAccount(p.accountId, { score: p.score, wins: p.wins, losses: p.losses, name: p.name });
      }
    } catch (e) { /* ignore 持久化失败不影响牌局 */ }
  }

  /** 房间被清理/删除前结算所有仍在座真人玩家的当局积分 (断线超时、托管离开未等到当局结束) */
  settleAllScores() {
    for (const p of this.players) {
      if (p) this.settlePlayerScore(p);
    }
  }

  // ---------- 工具 ----------
  startTimer() {
    this.clearTimer();
    this.actionDeadline = Date.now() + ACTION_TIMEOUT_MS; // 前端倒计时展示
    this.timer = setTimeout(() => {
      const p = this.currentPlayerId ? this.playersById.get(this.currentPlayerId) : null;
      if (!p) return;
      // 断线挂起的玩家被超时托管后, 清除挂起标记; 之后重连按"已托管"处理
      if (p.suspended) { p.suspended = false; p.suspendedAt = null; }
      // 超时: 能过牌则过牌，否则弃牌 (在线与断线玩家一致)
      const toCall = this.currentBet - p.bet;
      this.doAction(p.socketId, toCall > 0 ? 'fold' : 'check');
      this.log(`${p.name} 行动超时，${toCall > 0 ? '自动弃牌' : '自动过牌'}`);
    }, ACTION_TIMEOUT_MS);
  }

  log(text) {
    const entry = { text, ts: Date.now() };
    this.actionLog.push(entry);
    this.lastAction = entry;
    if (this.actionLog.length > 60) this.actionLog.shift();
  }

  /** 广播完整状态 */
  broadcast() {
    if (this.broadcastFn) this.broadcastFn(this.toState());
  }

  toState() {
    return {
      id: this.id,
      name: this.name,
      sb: this.sb,
      bb: this.bb,
      shortDeck: this.shortDeck,
      maxSeats: this.maxSeats,
      hostId: this.hostId,
      state: this.state,
      stageName: STAGE_NAMES[this.state] || '',
      dealerSeat: this.dealerSeat,
      sbSeat: this.currentSbSeat,   // 当前小盲座位
      bbSeat: this.currentBbSeat,   // 当前大盲座位
      community: this.community,
      showdownCommunity: this.showdownCommunity || [],
      currentBet: this.currentBet,
      minRaise: this.minRaise, // 最小加注增量, 前端据此计算合法加注下限
      currentPlayerId: this.currentPlayerId,
      actionDeadline: this.actionDeadline || null, // 行动截止时间戳(ms), 前端倒计时
      pot: this.pot,
      sidePots: this.sidePots,
      lastAction: this.lastAction,
      actionLog: this.actionLog.slice(-8),
      lastWinnerText: this.lastWinnerText,
      showdownResult: this.showdownResult ? this.showdownResult.map(r => ({
        id: r.player.id,
        name: r.player.name,
        seat: r.player.seat,
        cards: r.cards,
        best5: r.best5 || [],
        handName: r.handName,
        rank: r.rank,
        winner: r.winner
      })) : null,
      round: this.round,
      players: this.players.map(p => p ? {
        id: p.id, name: p.name, seat: p.seat, chips: p.chips, debt: p.debt,
        bet: p.bet, folded: p.folded, allIn: p.allIn, ready: p.ready,
        connected: p.connected, away: !!p.away, sitNext: !!p.sitNext, cardCount: p.cards.length, isBot: p.isBot,
        persona: p.isBot ? (p.persona || '') : '', personaColor: p.isBot ? (p.personaColor || '') : '',
        accountId: p.accountId,
        score: p.score, level: getLevelByScore(p.score), lastDelta: p.lastDelta,
        wins: p.wins, losses: p.losses
      } : null),
      brokeCount: this.brokePlayers().length
    };
  }

  /** 按需计算牌力评估 (点开面板时调用, 避免每次广播算 9 次胜率拖慢服务器) */
  evalHand(socketId) {
    const p = this.bySocket(socketId);
    if (!p || p.cards.length !== 2 || this.state === 'waiting') return null;
    try {
      const ev = evaluateBest([...p.cards, ...this.community], { shortDeck: this.shortDeck });
      let winrate = null;
      let winratesByOpponents = null;  // 9 个胜率: vs 1, 2, ..., 9 个对手
      // 翻牌前: 起手牌胜率 (预计算表查表, O(1))
      if (this.community.length === 0) {
        const wr = getWinRate(p.cards, this.shortDeck);
        winrate = Math.round(wr.win * 100);
        winratesByOpponents = [];
        for (let n = 1; n <= 9; n++) {
          winratesByOpponents.push(Math.round(getWinRateMulti(p.cards, n, this.shortDeck) * 100));
        }
      }
      return {
        name: ev.name,
        best5: ev.cards,
        score: ev.score,
        winrate,
        winratesByOpponents,
        shortDeck: this.shortDeck,
        // 起手牌 13×13 档位热图: 静态数据(房间级一次性计算), 随牌力面板按需下发,
        // 不随每次 room:state 广播 (原实现占广播负载 ~69%, 是弱网"卡"的主因之一)
        gridTiers: this.gridTiers,
        // 同色(同花)标记: 两张底牌同一花色
        suited: p.cards[0].suit === p.cards[1].suit,
        // 牌型大小等级 (短牌排名不同: 同花>葫芦, 三条>顺子)
        rank: ev.type,
        rankList: this.shortDeck
          ? ['高牌', '一对', '两对', '顺子', '三条', '葫芦', '同花', '四条', '同花顺']
          : ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺']
      };
    } catch { return null; }
  }

  /** 单个玩家视角（含自己的牌）
   *  baseState 可选: 传入已构建的公共状态(room:state 复用), 避免每次广播为每个玩家重复构建完整状态 */
  toStateFor(socketId, baseState) {
    const s = baseState ? Object.assign({}, baseState) : this.toState();
    const p = this.bySocket(socketId);
    s.you = p ? {
      id: p.id, seat: p.seat, chips: p.chips, cards: p.cards, bet: p.bet, totalBet: p.totalBet,
      // 牌力评估改为按需计算 (hand:eval 事件, 不再每次广播算, 避免卡顿)
      handEval: null,
      tier: (p.cards.length === 2 && this.state !== 'waiting') ? handTier(p.cards, this.shortDeck) : null,
      // 实时牌型提示: 翻牌后每步广播为当前玩家算一次 (7 选 5 微秒级, 仅 1 人)
      handName: null,
      handOuts: 0,
      // 我最多可赢 (主池+边池): 全下能拿回的最大金额
      maxWin: (this.state !== 'waiting' && this.state !== 'settle') ? this.maxWinFor(p.seat) : 0,
      // 当局结算后的积分信息: 随状态广播下发, 前端账号面板即时刷新 (否则结算进积分却显示不出来)
      score: p.score, wins: p.wins, losses: p.losses, lastDelta: p.lastDelta,
      level: getLevelByScore(p.score)
    } : null;
    // 翻牌后: 当前玩家实时牌型 + 听牌补牌数 + 实时胜率 (flop/turn/river)
    if (s.you && !p.folded && p.cards.length === 2 && this.community.length >= 3
      && this.state !== 'waiting' && this.state !== 'showdown' && this.state !== 'settle') {
      try {
        const ev = evaluateBest([...p.cards, ...this.community], { shortDeck: this.shortDeck });
        s.you.handName = ev.name || null;
        // 实时胜率: 翻牌后按当前未弃牌对手数粗略估算 (outs 法: 补牌后大概率领先)
        const alive = this.players.filter(x => x && !x.folded && x.id !== p.id && x.sitNext !== true).length;
        const di = this.drawInfo(p);
        s.you.winrate = Math.round(Math.min(95, Math.max(5, (ev.type >= 4 ? 75 : 35) + di.outs * 3 - alive * 4)));
        if (this.state === 'flop' || this.state === 'turn') {
          s.you.handOuts = di.outs;
          s.you.drawDesc = di.desc;      // 听牌明细: "听同花(9) / 两头听顺(8)"
        }
      } catch (e) { /* 牌型计算失败不阻塞 */ }
    }
    // 摊牌时只公开"未弃牌"玩家的牌; 弃牌者不亮牌 (可 muck)
    // 自己的牌始终可见
    const reveal = this.state === 'showdown';
    s.players = s.players.map(ps => {
      if (!ps) return ps;
      const pp = this.playersById.get(ps.id);
      if (!pp) return ps;
      const isSelf = p && pp.id === p.id;
      const shouldReveal = reveal && !pp.folded && !(pp.allIn && pp.folded);
      return { ...ps, cards: shouldReveal || isSelf ? pp.cards : [] };
    });
    return s;
  }
}

module.exports = { GameRoom, MAX_PLAYERS, ACTION_TIMEOUT_MS, getLevelByScore, LEVELS };
