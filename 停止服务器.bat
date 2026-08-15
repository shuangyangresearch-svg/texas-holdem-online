@echo off
chcp 65001 >nul
echo ==========================================
echo   德州扑克 - 停止服务器 (仅停 3000 端口)
echo ==========================================
echo.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo [失败] 端口 3000 仍被占用, 请手动结束占用进程
) else (
  echo [OK] 服务器已停止
)
pause
