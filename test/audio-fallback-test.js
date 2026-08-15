'use strict';
/** 无头 Chrome 验证音频回退逻辑 */
const { execFileSync } = require('child_process');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
try {
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
    '--window-size=800,600', '--virtual-time-budget=4000', '--dump-dom',
    'http://localhost:3000/test-audio.html'
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const m = dom.match(/<title>(AUDIO-OK|AUDIO-FAIL)<\/title>/);
  const pre = dom.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
  console.log(pre ? pre[1] : '(未找到结果)');
  console.log(m ? `标题: ${m[1]}` : '(无标题判定)');
  process.exit(m && m[1] === 'AUDIO-OK' ? 0 : 1);
} catch (e) {
  console.error('执行失败:', e.message.split('\n')[0]);
  process.exit(1);
}
