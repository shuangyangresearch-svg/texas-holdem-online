@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   德州扑克 - 后台启动 (完全无窗口, 关掉本窗口不中断)
echo ==========================================
echo.
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo [提示] 服务器已经在运行: http://localhost:3000
  echo        如需重启请先运行 "停止服务器.bat"
  pause
  exit /b
)
echo 正在后台启动 node server.js ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-hidden.ps1"
timeout /t 3 /nobreak >nul
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo.
  echo [OK] 服务器已在后台运行: http://localhost:3000
  echo      日志文件: server.log ^(错误: server.err^)
) else (
  echo.
  echo [失败] 服务器未启动, 请查看 server.log
)
pause
