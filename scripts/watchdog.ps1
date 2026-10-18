# AnkiCardMaker 的看门狗：查端口是否被占用，未占用就启动服务；服务退出后 5 秒重启。
# 由计划任务在登录时以隐藏窗口方式调用，日志追加到 <项目根>\anki-card-maker.log。
# 启动统一入口；端口被占用则不重复启动。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
$server = Join-Path $root 'src\server.js'
$log = Join-Path $root 'anki-card-maker.log'
$port = 3210

while ($true) {
  try {
    $inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($inUse) {
      Add-Content -Path $log -Value "$(Get-Date -Format s) Port $port already in use; watchdog exits."
      exit 0
    }
    Add-Content -Path $log -Value "$(Get-Date -Format s) Starting AnkiCardMaker."
    & $node $server 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$(Get-Date -Format s) $_" }
  } catch {
    Add-Content -Path $log -Value "$(Get-Date -Format s) Watchdog error: $($_.Exception.Message)"
  }
  Add-Content -Path $log -Value "$(Get-Date -Format s) Server stopped; restarting in 5 seconds."
  Start-Sleep -Seconds 5
}
