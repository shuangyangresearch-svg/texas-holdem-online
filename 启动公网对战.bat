@echo off
chcp 65001 >nul
title 德州扑克 - 一键启动(守护模式)
echo ==========================================
echo   德州扑克 - 本地服务器 + 公网隧道
echo   守护模式: 服务器异常退出会自动重启
echo ==========================================
echo.

cd /d "%~dp0"

echo [1/3] 启动游戏服务器 (端口 3000, 守护循环)...
REM 优先用 PATH 里的 node, 找不到则回退到绝对路径
where node >nul 2>nul
if %errorlevel%==0 (
  set NODE_BIN=node
) else (
  set NODE_BIN=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe
)
start "德州扑克服务器(守护)" cmd /k "%NODE_BIN% scripts/daemon.js"

echo [2/3] 等待服务器就绪...
timeout /t 4 /nobreak >nul

echo [3/3] 创建公网隧道 (Cloudflare)...
echo 提示: 窗口出现 "Your quick Tunnel has been created" 后,
echo       把 trycloudflare.com 链接发给朋友即可开玩!
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 --no-autoupdate

pause
