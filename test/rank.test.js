'use strict';
/** 排行榜清理验证:
 *  A. 单元级(同进程): 注册时游客战绩继承 + 游客记录删除 + guestAccountId 关联
 *  B. socket 级: rank:list 条目带 account/kind、榜单无重复账号、僵尸游客被过滤
 */
const { io } = require('socket.io-client');
const accounts = require('../src/accounts');
const auth = require('../src/auth');
const URL = 'http://localhost:3000';
const delay = ms => new Promise(r => setTimeout(r, ms));
const client = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['polling'] });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const emitAck = (s, ev, d = {}) => new Promise(r => s.emit(ev, d, r));

(async () => {
  console.log('== 排行榜清理验证 ==');
  let fail = 0;
  const ok = (name, cond) => { console.log(`  ${cond ? '✓' : '✗'} ${name}`); if (!cond) fail++; };

  // ===== A. 单元级: 注册合并游客战绩 =====
  const gid = 'a_unit_' + Date.now().toString(36);
  accounts.getOrCreateAccount(gid, '游客乙');
  accounts.saveAccount(gid, { score: 1420, wins: 4, losses: 2 });
  const uname = 'unituser' + Math.floor(Math.random() * 100000);
  const reg = auth.register(uname, 'pass123456', '单元玩家', gid);
  ok('A1 注册成功', reg.ok === true);
  ok('A2 继承游客战绩 (score=1420 wins=4 losses=2)', reg.score === 1420 && reg.wins === 4 && reg.losses === 2);
  ok('A3 游客记录已删除 (榜单去重)', accounts.getAccountById(gid) === null);
  const uRec = auth.getAccountByUsername(uname);
  ok('A4 正式账号关联 guestAccountId', !!uRec && uRec.guestAccountId === gid);
  ok('A5 listAll 暴露 guestAccountId 供去重', auth.listAll().some(x => x.username === uname && x.guestAccountId === gid));
  // 清理单元测试数据
  try {
    const fs = require('fs'); const path = require('path');
    const f = path.join(__dirname, '..', 'data', 'users.json');
    const all = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete all[uname]; fs.writeFileSync(f, JSON.stringify(all, null, 2));
    accounts.flush();
  } catch (e) { console.log('  (清理测试用户失败: ' + e.message + ')'); }

  // ===== B. socket 级: 榜单字段/去重/僵尸过滤 (服务器进程内数据) =====
  const s = await client();
  const rank = await emitAck(s, 'rank:list', {});
  ok('B1 条目带 account/kind', rank.ok && rank.list.every(r => r.account && r.kind));
  const unique = new Set(rank.list.map(r => r.account)).size === rank.list.length;
  ok('B2 榜单无重复账号', unique);
  const kinds = new Set(rank.list.map(r => r.kind));
  ok('B3 kind 仅 user/guest', [...kinds].every(k => k === 'user' || k === 'guest'));

  // 僵尸游客: 在服务器进程内创建 (account:info) 但无战绩 → 不应入榜
  const zombie = 'a_zombie_' + Date.now().toString(36);
  await emitAck(s, 'account:info', { accountId: zombie, name: '僵尸' });
  await delay(600); // 等服务器写盘/缓存
  const rank2 = await emitAck(s, 'rank:list', {});
  ok('B4 僵尸游客(0战绩)不入榜', !rank2.list.some(r => r.account === zombie));
  // 清理僵尸
  try { accounts.removeAccount(zombie); accounts.flush(); } catch (e) {}
  s.close();

  console.log(fail === 0 ? '\n== 全部通过 ==' : `\n== ${fail} 项失败 ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
