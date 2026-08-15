# 德州扑克 - 隐藏启动 node server.js (后台运行, 无窗口, 日志写文件)
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File start-hidden.ps1
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# node 可执行文件: 优先 PATH, 找不到则回退到硬编码路径
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeExe = $nodeCmd.Source
} else {
  $nodeExe = 'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe'
}

$serverJs = Join-Path $scriptDir 'server.js'
$logFile  = Join-Path $scriptDir 'server.log'
$errFile  = Join-Path $scriptDir 'server.err'

Start-Process -FilePath $nodeExe `
  -ArgumentList ('"{0}"' -f $serverJs) `
  -WorkingDirectory $scriptDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError $errFile
