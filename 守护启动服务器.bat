@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   德州扑克 - 守护模式 (崩溃/退出自动重启)
echo   日志: server.log (追加)  停止: 关闭本窗口
echo ==========================================
echo.
:loop
echo [%date% %time%] 启动服务器...
node server.js >> server.log 2>&1
echo [%date% %time%] 服务器已退出, 3 秒后自动重启 (Ctrl+C 连续两次可终止)...
timeout /t 3 /nobreak >nul
goto loop
