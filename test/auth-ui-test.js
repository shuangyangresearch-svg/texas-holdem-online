'use strict';
/** 无头 Chrome 验证: 登录界面默认登录页签 + 账号密码自动预填 */
const { execFileSync } = require('child_process');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 独立 user-data-dir, 避免污染真实浏览器存储
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
try {
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', `--user-data-dir=${profile}`,
    '--window-size=900,700', '--virtual-time-budget=6000', '--dump-dom',
    'http://localhost:3000/test-auth.html'
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const m = dom.match(/<title>(AUTH-OK|AUTH-FAIL)<\/title>/);
  const pre = dom.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
  console.log(pre ? pre[1] : '(未找到结果)');
  process.exit(m && m[1] === 'AUTH-OK' ? 0 : 1);
} catch (e) {
  console.error('执行失败:', e.message.split('\n')[0]);
  process.exit(1);
} finally {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
