/**
 * 正式账号系统 (v3)
 *  - 账号 = 用户名(username) + 密码(password) + 昵称(nickname)
 *  - 密码使用 scrypt 加盐哈希存储, 明文不落盘
 *  - 登录后服务端下发 sessionToken, 前端持久化并在后续请求携带
 *  - 积分/段位/战绩 绑定 username, 任何设备登录都跟随
 *
 * 兼容: 仍保留轻量 accountId 机制 (游客), 但正式账号优先。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const accounts = require('./accounts'); // 注册升级时合并游客战绩 (accounts 不依赖本模块, 无循环)

const DATA_DIR = path.join(__dirname, '..', 'data');
const USER_FILE = path.join(DATA_DIR, 'users.json');
// 会话表: token -> { username, expiresAt }  (内存为主, 重启失效, 可接受)
const sessions = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 天

const DEFAULTS = () => ({ score: 1000, wins: 0, losses: 0 });

// ---- 内存缓存 + 防抖写盘: 多房间频繁结算时避免每次同步读/写全量 JSON ----
let cache = null;       // { username: rec }
let dirty = false;
let flushTimer = null;
const FLUSH_DELAY = 800; // ms

function readAll() {
  if (cache) return cache;
  try {
    if (!fs.existsSync(USER_FILE)) cache = {};
    else {
      const raw = fs.readFileSync(USER_FILE, 'utf8');
      cache = raw.trim() ? JSON.parse(raw) : {};
    }
  } catch (e) {
    console.error('[auth] read error', e);
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
    fs.writeFileSync(USER_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('[auth] write error', e);
    dirty = true; // 写失败保留脏标记, 下次写入再试
  }
}

// 进程退出前兜底落盘 (exit 事件只能同步操作, flushNow 为同步写)
process.on('exit', flushNow);

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const { hash: h } = hashPassword(password, salt);
  // 定长比较, 防时序攻击
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function validateUsername(u) {
  if (typeof u !== 'string') return '用户名无效';
  const s = u.trim();
  if (s.length < 3 || s.length > 16) return '用户名需 3-16 个字符';
  if (!/^[一-龥A-Za-z0-9_]+$/.test(s)) return '用户名仅限中文/字母/数字/下划线';
  return null;
}

function validatePassword(p) {
  if (typeof p !== 'string') return '密码无效';
  if (p.length < 6) return '密码至少 6 位';
  return null;
}

function validateNickname(n) {
  if (typeof n !== 'string') return '昵称无效';
  const s = n.trim();
  if (s.length < 1 || s.length > 12) return '昵称需 1-12 个字符';
  return null;
}

// ---------- 注册 ----------
/**
 * guestAccountId: 注册时所在浏览器的游客账号 id。
 *  - 关联记录: 便于排行榜按账号去重 (同一人只出现一次);
 *  - 战绩继承: 若游客玩过 (有战绩或积分≠1000), 将游客战绩并入正式账号;
 *  - 清理: 删除该游客记录, 避免榜单/数据重复。
 */
function register(username, password, nickname, guestAccountId) {
  const u = String(username || '').trim();
  const n = String(nickname || '').trim();
  const pErr = validateUsername(u);
  if (pErr) return { ok: false, msg: pErr };
  const pwErr = validatePassword(password);
  if (pwErr) return { ok: false, msg: pwErr };
  const nErr = validateNickname(n);
  if (nErr) return { ok: false, msg: nErr };

  const all = readAll();
  if (all[u]) return { ok: false, msg: '用户名已被注册' };

  const { salt, hash } = hashPassword(password);
  const rec = Object.assign(DEFAULTS(), {
    username: u,
    nickname: n,
    pwSalt: salt,
    pwHash: hash,
    createdAt: Date.now()
  });
  const gid = guestAccountId ? String(guestAccountId).slice(0, 64) : '';
  if (gid) {
    rec.guestAccountId = gid;
    try {
      const guest = accounts.getAccountById(gid);
      if (guest && (guest.wins + guest.losses > 0 || guest.score !== 1000)) {
        // 游客玩过 → 继承其战绩, 账号升级不丢分
        rec.score = guest.score;
        rec.wins = guest.wins;
        rec.losses = guest.losses;
      }
      accounts.removeAccount(gid); // 清理游客记录 (榜单不再重复)
    } catch (e) { /* 游客数据异常不阻塞注册 */ }
  }
  all[u] = rec;
  writeAll(all);
  const token = createSession(u);
  return {
    ok: true,
    token,
    username: u,
    nickname: n,
    score: rec.score,
    wins: rec.wins,
    losses: rec.losses
  };
}

// ---------- 登录 ----------
function login(username, password) {
  const u = String(username || '').trim();
  const all = readAll();
  const rec = all[u];
  if (!rec) return { ok: false, msg: '用户名不存在' };
  if (!verifyPassword(password, rec.pwSalt, rec.pwHash)) return { ok: false, msg: '密码错误' };
  const token = createSession(u);
  return {
    ok: true,
    token,
    username: u,
    nickname: rec.nickname,
    score: rec.score,
    wins: rec.wins,
    losses: rec.losses
  };
}

// ---------- 会话 ----------
function createSession(username) {
  const token = genToken();
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(token); return null; }
  const all = readAll();
  const rec = all[s.username];
  if (!rec) { sessions.delete(token); return null; }
  return Object.assign(DEFAULTS(), rec);
}

function logout(token) {
  if (token) sessions.delete(token);
}

// ---------- 账号数据读写 (供 game 持久化) ----------
function getAccountByUsername(username) {
  if (!username) return null;
  const all = readAll();
  const rec = all[username];
  if (!rec) return null;
  return Object.assign(DEFAULTS(), rec);
}

function saveAccount(username, data = {}) {
  if (!username) return;
  const all = readAll();
  if (!all[username]) return;
  const rec = Object.assign(DEFAULTS(), all[username], data);
  all[username] = rec;
  writeAll(all);
}

/** 全部正式账号 (排行榜用; 不含密码哈希) */
function listAll() {
  const all = readAll();
  return Object.entries(all).map(([username, rec]) => ({
    username,
    nickname: rec.nickname || username,
    score: rec.score,
    wins: rec.wins || 0,
    losses: rec.losses || 0,
    guestAccountId: rec.guestAccountId || ''   // 关联的游客账号 (去重用)
  }));
}

module.exports = {
  register,
  login,
  logout,
  getUserByToken,
  getAccountByUsername,
  saveAccount,
  listAll,
  flush: flushNow,
  DEFAULTS
};
