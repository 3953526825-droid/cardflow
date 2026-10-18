# 一键启动：检测 Node.js → 起服务 → 自动打开浏览器。
# 由 scripts\start.cmd 调用（.cmd 里不放中文：cmd.exe 按 GBK 代码页解析批处理文件，
# UTF-8 的中文会被拆成乱码甚至破坏语法；PowerShell 脚本带 UTF-8 BOM 则没有这个问题）。
#
# 直接跑也可以：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1 -Port 3210 -NoBrowser
param(
  [int]$Port = 3210,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:ANKI_PORT = "$Port"

$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  Write-Output "端口 $Port 已经在监听：服务看起来已经在运行了。"
  if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/" }
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Output ''
  Write-Output '  没有找到 Node.js。'
  Write-Output '  请先安装 Node.js 的 LTS 版本，下载页：'
  Write-Output '    https://nodejs.org/zh-cn/download'
  Write-Output '  装完再运行本脚本即可。'
  Write-Output ''
  if (-not $NoBrowser) { Read-Host '按回车键关闭' }
  exit 1
}

Write-Output "已检测到 Node.js $(& node -v)（路径：$($node.Source)）"
Write-Output "正在启动 AnkiCardMaker：http://127.0.0.1:$Port/"
Write-Output '（关掉这个窗口就是停止服务）'
Write-Output ''

if (-not $NoBrowser) {
  # 稍等一下再开浏览器，避免打开时服务还没起来
  Start-Job -ScriptBlock { param($p) Start-Sleep -Seconds 2; Start-Process "http://127.0.0.1:$p/" } -ArgumentList $Port | Out-Null
}

& node (Join-Path $root 'src\server.js')

Write-Output ''
Write-Output '服务已退出。'
if (-not $NoBrowser) { Read-Host '按回车键关闭' }
