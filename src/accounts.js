/**
 * 轻量账号模块
 * 设计 (v2): 服务端生成全局唯一的 accountId (UUID), 昵称可重复。
 *  - 积分 / 段位 / 战绩 绑定到 accountId, 不同玩家的重名不再串号。
 *  - 前端通过 localStorage 保存 accountId, 每次连接携带, 服务端按 accountId 读写。
 *  - 首次使用 (无 accountId) 时由服务端生成并下发。
 *  - 昵称只是显示名, 可随时更改, 不影响账号数据与战绩连续性。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCOUNT_FILE = path.join(DATA_DIR, 'accounts.json');

const DEFAULTS = () => ({ score: 1000, wins: 0, losses: 0 });

// ---- 内存缓存 + 防抖写盘: 多房间频繁结算时避免每次同步读/写全量 JSON ----
let cache = null;       // { accountId: rec }
let dirty = false;
let flushTimer = null;
const FLUSH_DELAY = 800; // ms

function makeUuid() {
  // Node 14+ 可用 crypto.randomUUID; 兜底手工生成
  try {
    // eslint-disable-next-line node/no-unsupported-features/node-builtins
    const { randomUUID } = require('crypto');
    if (typeof randomUUID === 'function') return randomUUID();
  } catch (e) { /* ignore */ }
  return 'a_' + Date.now().toString(36) + '_' +
    Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function readAll() {
  if (cache) return cache;
  try {
    if (!fs.existsSync(ACCOUNT_FILE)) cache = {};
    else {
      const raw = fs.readFileSync(ACCOUNT_FILE, 'utf8');
      cache = raw.trim() ? JSON.parse(raw) : {};
    }
  } catch (e) {
    console.error('[accounts] read error', e);
    cache = cache || {};
  }
  return cache;
}

/** 更新内存缓存并防抖写盘 (合并多次修改) */
function writeAll(obj) {
  cache = obj;
  dirty = true;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, FLUSH_DELAY);
}

/** 立即同步写盘 (进程退出/兜底时调用) */
function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty || !cache) return;
  dirty = false;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('[accounts] write error', e);
    dirty = true; // 写失败保留脏标记, 下次写入再试
  }
}

// 进程退出前兜底落盘 (exit 事件只能同步操作, flushNow 为同步写)
process.on('exit', flushNow);

/**
 * 生成新的 accountId (不持久化, 由调用方决定何时落库)
 */
function genAccountId() {
  return makeUuid();
}

/**
 * 按 accountId 读取账号 (若不存在返回 null)。
 */
function getAccountById(accountId) {
  if (!accountId) return null;
  const all = readAll();
  const rec = all[accountId];
  if (!rec) return null;
  return Object.assign(DEFAULTS(), rec);
}

/**
 * 获取或创建账号: 有 accountId 则加载, 否则新建并落库。
 * 返回 { accountId, name, score, wins, losses }。
 */
function getOrCreateAccount(accountId, name) {
  const all = readAll();
  if (accountId && all[accountId]) {
    const rec = Object.assign(DEFAULTS(), all[accountId]);
    // 昵称允许更新 (可重复, 仅显示用)
    if (name && name !== rec.name) {
      rec.name = name;
      all[accountId] = rec;
      writeAll(all);
    }
    return { accountId: accountId, name: rec.name, score: rec.score, wins: rec.wins, losses: rec.losses };
  }
  // 新建: 客户端传入的 accountId 一律保留 (前端持久化后必须能回读积分; 前端可能生成
  // crypto.randomUUID 格式的 id, 不强制要求 a_ 前缀)
  const newId = accountId ? String(accountId) : makeUuid();
  const rec = Object.assign(DEFAULTS(), { name: name || '玩家' });
  all[newId] = rec;
  writeAll(all);
  return { accountId: newId, name: rec.name, score: rec.score, wins: rec.wins, losses: rec.losses };
}

/**
 * 保存账号数据 (按 accountId)。data 可含 score/wins/losses/name。
 */
function saveAccount(accountId, data = {}) {
  if (!accountId) return;
  const all = readAll();
  const rec = Object.assign(DEFAULTS(), all[accountId] || {}, data);
  all[accountId] = rec;
  writeAll(all);
}

/** 全部游客账号 (排行榜用) */
function listAll() {
  const all = readAll();
  return Object.entries(all).map(([accountId, rec]) => ({
    accountId,
    name: rec.name || '玩家',
    score: rec.score,
    wins: rec.wins || 0,
    losses: rec.losses || 0
  }));
}

/** 删除游客账号 (注册升级为正式账号后清理, 避免榜单/数据重复) */
function removeAccount(accountId) {
  if (!accountId) return false;
  const all = readAll();
  if (!all[accountId]) return false;
  delete all[accountId];
  writeAll(all);
  return true;
}

module.exports = {
  genAccountId,
  getAccountById,
  getOrCreateAccount,
  saveAccount,
  listAll,
  removeAccount,
  flush: flushNow,
  DEFAULTS
};
