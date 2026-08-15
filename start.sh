#!/usr/bin/env bash
# 德州扑克 - Linux/macOS 一键启动（本地服务器，可选公网隧道）
set -e
cd "$(dirname "$0")"

PORT="${PORT:-3000}"

echo "=========================================="
echo "  德州扑克 - 启动脚本"
echo "=========================================="

# 1. 安装依赖
if [ ! -d "node_modules" ]; then
  echo "[1/3] 首次运行，安装依赖..."
  npm install
else
  echo "[1/3] 依赖已就绪"
fi

# 2. 启动服务器 (守护模式: 崩溃/退出自动重启)
echo "[2/3] 启动游戏服务器 (端口 $PORT, 守护模式)..."
while true; do
  node server.js >> server.log 2>&1
  echo "[$(date '+%F %T')] 服务器退出, 3 秒后重启..."
  sleep 3
done &
SERVER_PID=$!

# 3. 等服务器就绪
sleep 2
echo "[3/3] 服务器已启动: http://localhost:$PORT"
echo "      局域网联机: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
echo ""
echo "如需公网访问, 另开终端执行:"
echo "  cloudflared tunnel --url http://localhost:$PORT"
echo ""
echo "按 Ctrl+C 停止服务器..."
wait $SERVER_PID
