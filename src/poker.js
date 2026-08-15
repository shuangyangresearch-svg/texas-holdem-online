'use strict';
/**
 * 德州扑克牌型评估器
 * 支持 2~7 张牌中选出最佳 5 张组合并比较大小
 * 返回值为可比较数组: [牌型等级, 主牌..., 踢脚...]
 */

// 牌面编码: rank 2-14 (11=J,12=Q,13=K,14=A), suit 0-3 (s,h,d,c)
// 单张牌对象 { rank, suit }

const RANK_NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_CHARS = ['♠', '♥', '♦', '♣'];

function rankName(r) {
  return RANK_NAMES[r] || String(r);
}

function cardLabel(c) {
  return rankName(c.rank) + SUIT_CHARS[c.suit];
}

/**
 * 从 7 张（或更少）牌中评估最佳 5 张牌型
 * 返回 { type, name, score, cards }
 * score 是用于比较的数组 [type, ...tiebreakers]
 * opts.shortDeck: 短牌(6+ Hold'em) 规则
 */
function evaluateBest(cards, opts) {
  const shortDeck = !!(opts && opts.shortDeck);
  const best = { type: 0, name: '', score: null, cards: [] };
  // 防御: 过滤无效牌, 牌不足时不崩溃 (结算竞态下可能收到空数组)
  const valid = (cards || []).filter(c => c && typeof c.rank === 'number' && typeof c.suit === 'number');
  if (valid.length < 2) {
    return { type: 0, name: '', score: [0, 0, 0, 0, 0], cards: valid };
  }
  cards = valid;
  if (cards.length <= 5) {
    best.cards = cards.slice().sort((a, b) => b.rank - a.rank);
    const ev = evaluateExact5(best.cards, shortDeck);
    best.type = ev.type;
    best.name = ev.name;
    best.score = ev.score;
    return best;
  }
  // 6 或 7 张: 枚举所有 5 张组合
  const n = cards.length;
  const idx = [];
  for (let i = 0; i < 5; i++) idx.push(i);
  let bestScore = null;
  while (true) {
    const combo = idx.map(i => cards[i]);
    const ev = evaluateExact5(combo, shortDeck);
    if (!bestScore || compareScore(ev.score, bestScore) > 0) {
      bestScore = ev.score;
      best.type = ev.type;
      best.name = ev.name;
      best.cards = combo;
    }
    // 下一个组合
    let p = 4;
    while (p >= 0 && idx[p] === n - 5 + p) p--;
    if (p < 0) break;
    idx[p]++;
    for (let q = p + 1; q < 5; q++) idx[q] = idx[q - 1] + 1;
  }
  best.score = bestScore;
  return best;
}

/** 精确 5 张评估 (shortDeck: 短牌规则) */
function evaluateExact5(cards, shortDeck) {
  // 防御: 不足 5 张有效牌时降级为高牌 (不崩溃)
  const valid = (cards || []).filter(c => c && typeof c.rank === 'number' && typeof c.suit === 'number');
  if (valid.length < 5) {
    const r = valid.map(c => c.rank).sort((a, b) => b - a);
    while (r.length < 5) r.push(0);
    return { type: 0, name: '高牌', score: [0, ...r] };
  }
  cards = valid;
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const flush = suits.every(s => s === suits[0]);
  const count = {};
  ranks.forEach(r => { count[r] = (count[r] || 0) + 1; });
  const groups = Object.entries(count).map(([r, c]) => ({ rank: +r, count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  let straight = false;
  let straightHigh = 0;
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) { straight = true; straightHigh = uniq[0]; }
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) { straight = true; straightHigh = 5; } // A2345 (长牌)
    else if (shortDeck && uniq[0] === 14 && uniq[1] === 9 && uniq[4] === 6) { straight = true; straightHigh = 6; } // A6789 (短牌)
  }

  if (flush && straight) {
    return { type: 8, name: '同花顺', score: [8, straightHigh] };
  }
  if (groups[0].count === 4) {
    const kicker = groups.find(g => g.count === 1).rank;
    return { type: 7, name: '四条', score: [7, groups[0].rank, kicker] };
  }
  if (shortDeck) {
    // 短牌 6+: 同花 > 葫芦, 三条 > 顺子
    if (flush) {
      return { type: 6, name: '同花', score: [6, ...ranks] };
    }
    if (groups[0].count === 3 && groups[1].count === 2) {
      return { type: 5, name: '葫芦', score: [5, groups[0].rank, groups[1].rank] };
    }
    if (groups[0].count === 3) {
      const kickers = groups.filter(g => g.count === 1).map(g => g.rank).sort((a, b) => b - a);
      return { type: 4, name: '三条', score: [4, groups[0].rank, ...kickers] };
    }
    if (straight) {
      return { type: 3, name: '顺子', score: [3, straightHigh] };
    }
  } else {
    // 长牌标准规则
    if (groups[0].count === 3 && groups[1].count === 2) {
      return { type: 6, name: '葫芦', score: [6, groups[0].rank, groups[1].rank] };
    }
    if (flush) {
      return { type: 5, name: '同花', score: [5, ...ranks] };
    }
    if (straight) {
      return { type: 4, name: '顺子', score: [4, straightHigh] };
    }
    if (groups[0].count === 3) {
      const kickers = groups.filter(g => g.count === 1).map(g => g.rank).sort((a, b) => b - a);
      return { type: 3, name: '三条', score: [3, groups[0].rank, ...kickers] };
    }
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairHigh = Math.max(groups[0].rank, groups[1].rank);
    const pairLow = Math.min(groups[0].rank, groups[1].rank);
    const kicker = groups.find(g => g.count === 1).rank;
    return { type: 2, name: '两对', score: [2, pairHigh, pairLow, kicker] };
  }
  if (groups[0].count === 2) {
    const kickers = groups.filter(g => g.count === 1).map(g => g.rank).sort((a, b) => b - a);
    return { type: 1, name: '一对', score: [1, groups[0].rank, ...kickers] };
  }
  return { type: 0, name: '高牌', score: [0, ...ranks] };
}

/** 比较两个 score 数组, 返回 1/0/-1 */
function compareScore(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 洗牌 */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 生成一副牌 (shortDeck: 短牌 6+ 去掉 2-5) */
function createDeck(shortDeck) {
  const deck = [];
  const minRank = shortDeck ? 6 : 2;
  for (let rank = minRank; rank <= 14; rank++) {
    for (let suit = 0; suit < 4; suit++) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/** 起手牌胜率: 蒙特卡洛模拟 vs 随机对手 (N 次) */
function winRate(hole, shortDeck, N) {
  const deck = createDeck(shortDeck);
  const used = new Set(hole.map(c => c.rank * 10 + c.suit));
  const available = deck.filter(c => !used.has(c.rank * 10 + c.suit));
  let wins = 0, ties = 0;
  for (let i = 0; i < N; i++) {
    const others = shuffle(available).slice(0, 7);
    const opp = others.slice(0, 2);
    const board = others.slice(2);
    const myEv = evaluateBest([...hole, ...board], { shortDeck });
    const oppEv = evaluateBest([...opp, ...board], { shortDeck });
    const cmp = compareScore(myEv.score, oppEv.score);
    if (cmp > 0) wins++;
    else if (cmp === 0) ties++;
  }
  return { win: wins / N, tie: ties / N };
}

/* ============ 起手牌胜率查表 (预计算一次, 避免每次广播都跑蒙特卡洛) ============ */
const WIN_RATE_CACHE = { 0: null, 1: null };
const WIN_RATE_SIMS = 600;
// 胜率表磁盘缓存: 首次构建 ~7s, 落盘后后续启动直接加载 (<10ms), 消除每次重启的事件循环阻塞
const WIN_RATE_CACHE_VERSION = 1; // 算法/口径变化时 +1 强制重建

const fs = require('fs');
const path = require('path');

function winrateCacheFile(shortDeck) {
  return path.join(__dirname, '..', 'data', shortDeck ? 'winrate-short.json' : 'winrate-long.json');
}

/** 加载磁盘缓存 (带版本与模拟次数校验, 不匹配则视为无效) */
function loadWinRateTable(shortDeck) {
  try {
    const raw = fs.readFileSync(winrateCacheFile(shortDeck), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && obj.v === WIN_RATE_CACHE_VERSION && obj.sims === WIN_RATE_SIMS && obj.table && typeof obj.table === 'object') {
      return obj.table;
    }
  } catch (e) { /* 无缓存或损坏: 重新构建 */ }
  return null;
}

function saveWinRateTable(shortDeck, table) {
  try {
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(winrateCacheFile(shortDeck), JSON.stringify({ v: WIN_RATE_CACHE_VERSION, sims: WIN_RATE_SIMS, table }));
  } catch (e) { /* 写缓存失败不影响运行 */ }
}

/** 生成 169 种起手牌的胜率表
    key 编码 (唯一): high*13 + low + (suited?169:0)
    - 非同花/对子: 0..168, 同花: 169..337
    - 唯一性: (h1-h2)*13 = l2-l1, |l2-l1|<=12<13 → h1=h2 → l1=l2
    (旧编码 high*100+low*10 冲突: KK(13,13)=1430 与 A3o(14,3)=1430 互相覆盖 → 胜率表大面积错误!) */
function buildWinRateTable(shortDeck) {
  const table = {};
  const minR = shortDeck ? 6 : 2;
  for (let r1 = minR; r1 <= 14; r1++) {
    for (let r2 = minR; r2 <= 14; r2++) {
      if (r1 === r2) {
        const key = r1 * 13 + r2;
        table[key] = winRate([{ rank: r1, suit: 0 }, { rank: r2, suit: 1 }], shortDeck, WIN_RATE_SIMS);
      } else if (r1 > r2) {
        table[r1 * 13 + r2 + 169] = winRate([{ rank: r1, suit: 0 }, { rank: r2, suit: 0 }], shortDeck, WIN_RATE_SIMS);
        table[r1 * 13 + r2] = winRate([{ rank: r1, suit: 0 }, { rank: r2, suit: 1 }], shortDeck, WIN_RATE_SIMS);
      }
    }
  }
  return table;
}

/** 查表获取起手牌胜率 (O(1), 无实时模拟; 表缺失时构建并落盘缓存) */
function getWinRate(hole, shortDeck) {
  const k = shortDeck ? 1 : 0;
  if (!WIN_RATE_CACHE[k]) {
    WIN_RATE_CACHE[k] = loadWinRateTable(shortDeck) || (() => {
      const t = buildWinRateTable(shortDeck);
      saveWinRateTable(shortDeck, t);
      return t;
    })();
  }
  const c1 = hole[0], c2 = hole[1];
  if (!c1 || !c2) return { win: 0.5, tie: 0 };
  const high = Math.max(c1.rank, c2.rank);
  const low = Math.min(c1.rank, c2.rank);
  const key = high * 13 + low + (c1.suit === c2.suit ? 169 : 0);   // 与 buildWinRateTable 一致 (唯一编码)
  return WIN_RATE_CACHE[k][key] || { win: 0.5, tie: 0 };
}

/* ============ vs N 个对手胜率表 (预计算 + 磁盘缓存) ============
   取代旧的"vs 1 胜率 × 衰减系数"近似: 直接模拟 vs 1~9 个随机对手, 更贴近真实。
   构建成本 ~40-60s, 后台异步分批构建(不阻塞事件循环), 构建期间回退旧近似。
   首次构建后落盘 data/winrate-multi-*.json, 后续启动直接加载。 */
const WINRATE_MULTI_SIMS = 150;
const WIN_RATE_MULTI_CACHE = { 0: null, 1: null };   // {opp: {key: {win, tie}}}
const _multiBuilding = { 0: false, 1: false };

function multiCacheFile(shortDeck) {
  return path.join(__dirname, '..', 'data', shortDeck ? 'winrate-multi-short.json' : 'winrate-multi-long.json');
}

function loadWinRateTableMulti(shortDeck) {
  try {
    const raw = fs.readFileSync(multiCacheFile(shortDeck), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && obj.v === 1 && obj.sims === WINRATE_MULTI_SIMS && obj.table) return obj.table;
  } catch (e) { /* 无缓存/损坏 */ }
  return null;
}

function saveWinRateTableMulti(shortDeck, table) {
  try {
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(multiCacheFile(shortDeck), JSON.stringify({ v: 1, sims: WINRATE_MULTI_SIMS, table }));
  } catch (e) { /* 写失败不影响运行 */ }
}

/** 单手牌 vs N 随机对手的蒙特卡洛胜率 (赢 = 牌力强于所有对手) */
function winRateMulti(hole, numOpp, shortDeck, N) {
  const deck = createDeck(shortDeck);
  const used = new Set(hole.map(c => c.rank * 10 + c.suit));
  const available = deck.filter(c => !used.has(c.rank * 10 + c.suit));
  const need = 2 * numOpp + 5;
  let wins = 0, ties = 0;
  for (let i = 0; i < N; i++) {
    const cards = shuffle(available).slice(0, need);
    const board = cards.slice(2 * numOpp);
    const myEv = evaluateBest([...hole, ...board], { shortDeck });
    // 取最强对手作为比较基准
    let bestScore = null;
    for (let o = 0; o < numOpp; o++) {
      const opp = cards.slice(o * 2, o * 2 + 2);
      const ev = evaluateBest([...opp, ...board], { shortDeck });
      if (!bestScore || compareScore(ev.score, bestScore) > 0) bestScore = ev.score;
    }
    const cmp = compareScore(myEv.score, bestScore);
    if (cmp > 0) wins++;
    else if (cmp === 0) ties++;
  }
  return { win: wins / N, tie: ties / N };
}

/** 同步构建完整 vs 1~9 对手表 (启动兜底用, 一般走异步+缓存) */
function buildWinRateTableMulti(shortDeck) {
  const table = {};
  const minR = shortDeck ? 6 : 2;
  const hands = [];
  for (let r1 = minR; r1 <= 14; r1++) {
    for (let r2 = minR; r2 <= 14; r2++) {
      if (r1 === r2) hands.push({ cards: [{ rank: r1, suit: 0 }, { rank: r2, suit: 1 }], key: r1 * 13 + r2 });
      else if (r1 > r2) {
        hands.push({ cards: [{ rank: r1, suit: 0 }, { rank: r2, suit: 0 }], key: r1 * 13 + r2 + 169 });
        hands.push({ cards: [{ rank: r1, suit: 0 }, { rank: r2, suit: 1 }], key: r1 * 13 + r2 });
      }
    }
  }
  for (let opp = 1; opp <= 9; opp++) {
    const col = {};
    for (const h of hands) col[h.key] = winRateMulti(h.cards, opp, shortDeck, WINRATE_MULTI_SIMS);
    table[opp] = col;
  }
  return table;
}

/** 后台异步构建 (每 15 手 yield 一次, 不阻塞事件循环); 完成写盘 */
async function buildWinRateTableMultiAsync(shortDeck) {
  const k = shortDeck ? 1 : 0;
  if (_multiBuilding[k]) return;
  _multiBuilding[k] = true;
  try {
    const cached = loadWinRateTableMulti(shortDeck);
    if (cached) { WIN_RATE_MULTI_CACHE[k] = cached; return; }
    const table = {};
    const minR = shortDeck ? 6 : 2;
    const hands = [];
    for (let r1 = minR; r1 <= 14; r1++) {
      for (let r2 = minR; r2 <= 14; r2++) {
        if (r1 === r2) hands.push({ cards: [{ rank: r1, suit: 0 }, { rank: r2, suit: 1 }], key: r1 * 13 + r2 });
        else if (r1 > r2) {
          hands.push({ cards: [{ rank: r1, suit: 0 }, { rank: r2, suit: 0 }], key: r1 * 13 + r2 + 169 });
          hands.push({ cards: [{ rank: r1, suit: 0 }, { rank: r2, suit: 1 }], key: r1 * 13 + r2 });
        }
      }
    }
    for (let opp = 1; opp <= 9; opp++) {
      const col = {};
      for (let i = 0; i < hands.length; i++) {
        col[hands[i].key] = winRateMulti(hands[i].cards, opp, shortDeck, WINRATE_MULTI_SIMS);
        if (i % 15 === 14) await new Promise(r => setImmediate(r));
      }
      table[opp] = col;
      if (opp % 3 === 0) await new Promise(r => setImmediate(r));
    }
    WIN_RATE_MULTI_CACHE[k] = table;
    saveWinRateTableMulti(shortDeck, table);
  } catch (e) {
    console.error('[胜率表] vs N 对手表构建失败:', e && e.message);
  } finally {
    _multiBuilding[k] = false;
  }
}

/** 获取手牌 vs numOpponents 个对手的胜率 (1-9): 优先查多对手表, 未就绪回退近似 */
function getWinRateMulti(hole, numOpponents, shortDeck) {
  numOpponents = Math.max(1, Math.min(9, numOpponents | 0));
  const k = shortDeck ? 1 : 0;
  const table = WIN_RATE_MULTI_CACHE[k];
  const c1 = hole[0], c2 = hole[1];
  if (table && table[numOpponents] && c1 && c2) {
    const high = Math.max(c1.rank, c2.rank);
    const low = Math.min(c1.rank, c2.rank);
    const key = high * 13 + low + (c1.suit === c2.suit ? 169 : 0);
    const r = table[numOpponents][key];
    if (r && typeof r.win === 'number') return r.win;
  }
  // 表未就绪(构建中) → 回退旧的近似缩放
  const base = getWinRate(hole, shortDeck).win;
  const scaled = base * N_SCALE[numOpponents - 1];
  return Math.max(0.03, Math.min(0.95, scaled));
}

/* vs N 对手近似系数 (仅作构建期间兜底) */
const N_SCALE = [
  1.00, 0.83, 0.71, 0.62, 0.55, 0.49, 0.44, 0.40, 0.36
];

/** 起手牌档位 (基于胜率 + 牌型) - 6 档分级, 颜色从红到灰 */
function handTier(hole, shortDeck) {
  const c1 = hole[0], c2 = hole[1];
  if (!c1 || !c2) return { tier: 5, label: '?', color: '#666', short: '?' };
  const pair = c1.rank === c2.rank;
  const suited = c1.suit === c2.suit;
  const high = Math.max(c1.rank, c2.rank);
  const low = Math.min(c1.rank, c2.rank);
  const adj = high - low <= 1;
  const adj2 = high - low <= 2;
  const t = shortDeck ? 1 : 0;
  // SSS 顶级: AA KK QQ JJ AKs AKo AQs
  if (pair && high >= 12) return { tier: 0, label: 'SSS 高富帅', color: '#ef4444', short: 'SSS' };
  if (high === 14 && low === 13) return { tier: 0, label: 'SSS 高富帅', color: '#ef4444', short: 'SSS' }; // AKo/AKs
  if (high === 14 && low === 12 && suited) return { tier: 0, label: 'SSS 高富帅', color: '#ef4444', short: 'SSS' }; // AQs
  // SS 强牌: TT-99, AQo, AJs, KQs, KJs, QJs
  if (pair && high >= 9 + t) return { tier: 1, label: 'SS 实力派', color: '#f97316', short: 'SS' }; // TT-99 (短牌:TT 也算)
  if (high === 14 && low >= 9 + t) return { tier: 1, label: 'SS 实力派', color: '#f97316', short: 'SS' }; // AJs, A10s, 短牌 A9s
  if (high === 13 && low >= 11) return { tier: 1, label: 'SS 实力派', color: '#f97316', short: 'SS' }; // KQ/KJ/K10
  if (high === 12 && low === 11) return { tier: 1, label: 'SS 实力派', color: '#f97316', short: 'SS' }; // QJ
  // A 经济适用: 88-77-66, A8s-A9s, ATo, KT+, QTs+, JTs
  if (pair && high >= 6) return { tier: 2, label: 'A 经济适用', color: '#eab308', short: 'A' }; // 88-77-66
  if (high === 14 && low >= (shortDeck ? 6 : 7)) return { tier: 2, label: 'A 经济适用', color: '#eab308', short: 'A' }; // 长牌 A7s+/ATo, 短牌 A6s+(短牌最小牌面 6)
  if (high === 13 && low >= 10) return { tier: 2, label: 'A 经济适用', color: '#eab308', short: 'A' }; // KTo, K9s
  if (high === 12 && low >= 10) return { tier: 2, label: 'A 经济适用', color: '#eab308', short: 'A' }; // QTo, Q9s
  if ((high === 11 && low === 10) && suited) return { tier: 2, label: 'A 经济适用', color: '#eab308', short: 'A' }; // JTs
  if ((high === 11 && low >= 9) && suited) return { tier: 2, label: 'A 经济适用', color: '#eab308', short: 'A' }; // J9s+
  // B 后排: 55-44, 同花连张, K8s+, Q8s+, JTo
  if (pair && high >= 4) return { tier: 3, label: 'B 后排', color: '#84cc16', short: 'B' }; // 55-44
  if (adj2 && suited && high >= 9 && low >= 7) return { tier: 3, label: 'B 后排', color: '#84cc16', short: 'B' }; // 同花连张(差≤2)
  if (high === 13 && low >= 8) return { tier: 3, label: 'B 后排', color: '#84cc16', short: 'B' }; // K8s+
  if (high === 12 && low >= 8) return { tier: 3, label: 'B 后排', color: '#84cc16', short: 'B' }; // Q8s+
  if (high === 11 && low >= 9) return { tier: 3, label: 'B 后排', color: '#84cc16', short: 'B' }; // JTo, J8s+
  // C 歪瓜裂枣: 33-22, 边缘同花, 连牌
  if (pair) return { tier: 4, label: 'C 歪瓜裂枣', color: '#3b82f6', short: 'C' }; // 33-22
  if (suited && high >= 7) return { tier: 4, label: 'C 歪瓜裂枣', color: '#3b82f6', short: 'C' }; // 边缘同花
  if (adj && high >= 8) return { tier: 4, label: 'C 歪瓜裂枣', color: '#3b82f6', short: 'C' }; // 连牌
  // D 垃圾
  return { tier: 5, label: 'D 垃圾中的战斗机', color: '#6b7280', short: 'D' };
}

module.exports = {
  evaluateBest, evaluateExact5, compareScore, shuffle, createDeck, winRate, handTier, getWinRate, getWinRateMulti,
  buildWinRateTableMultiAsync,
  rankName, cardLabel, SUIT_CHARS, RANK_NAMES
};
