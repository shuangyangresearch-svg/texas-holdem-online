'use strict';
/**
 * 服务器守护脚本: 子进程运行 server.js
 *  - 崩溃/异常退出 → 自动重启
 *  - 每 RESTART_INTERVAL_MS (默认 4 小时) → 主动重启, 规避长时间运行的累积问题(内存/连接)
 * 用法: node scripts/daemon.js
 */
const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = process.env.PORT || '3000';
const MAX_RESTARTS = 20;      // 短时间内最大重启次数
const RESTART_WINDOW_MS = 5 * 60 * 1000; // 5 分钟窗口
const RESTART_INTERVAL_MS = (Number(process.env.RESTART_INTERVAL_MS) || 4 * 60 * 60 * 1000); // 默认 4 小时

let restarts = [];
let child = null;
let scheduleTimer = null;

function scheduleRestart() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  scheduleTimer = setTimeout(() => {
    console.log(`[守护] 定时重启 (已运行 ${RESTART_INTERVAL_MS / 60000} 分钟)`);
    if (child) {
      child.kill('SIGTERM');
      // child 'exit' 事件里会再 startServer
    }
  }, RESTART_INTERVAL_MS);
  if (scheduleTimer.unref) scheduleTimer.unref();
}

function startServer() {
  console.log(`[守护] 启动服务器 (端口 ${PORT})...`);
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT },
    stdio: 'inherit',
  });
  scheduleRestart();
  child.on('exit', (code, signal) => {
    const now = Date.now();
    restarts.push(now);
    // 清理窗口外的记录
    restarts = restarts.filter(t => now - t < RESTART_WINDOW_MS);
    console.log(`[守护] 服务器退出 (code=${code} signal=${signal})`);
    if (restarts.length > MAX_RESTARTS) {
      console.error(`[守护] 5 分钟内重启超过 ${MAX_RESTARTS} 次, 停止守护, 请检查服务器代码`);
      process.exit(1);
    }
    // 2 秒后重启
    console.log('[守护] 2 秒后自动重启...');
    setTimeout(startServer, 2000);
  });
  child.on('error', (err) => {
    console.error('[守护] 启动失败:', err.message);
    setTimeout(startServer, 5000);
  });
}

startServer();

// 优雅退出
process.on('SIGINT', () => {
  console.log('[守护] 收到退出信号, 停止守护');
  if (scheduleTimer) clearTimeout(scheduleTimer);
  if (child) child.kill('SIGTERM');
  process.exit(0);
});
