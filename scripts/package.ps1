# 打包分发：把源码 + 配置样例 + 脚本 + README 打成一个 zip。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package.ps1 -OutDir D:\dist
#
# 用 git archive 只导出**被 git 跟踪**的文件，所以 config/*.config.json（密钥）、
# *.pfx、ca.crt、*.log、.backup/、tests/.tmp/ 这些天然进不了包；脚本还会再检查一遍。
param(
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd'
$zip = Join-Path $OutDir "anki-card-maker-$stamp.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

Push-Location $root
try {
  $status = git status --porcelain
  if ($status) { Write-Output '提示：工作区有未提交的改动，打出来的包只包含已提交的内容。' }
  git archive --format=zip --prefix=anki-card-maker/ -o $zip HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive 失败' }
} finally { Pop-Location }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $entries = $archive.Entries | ForEach-Object { $_.FullName }
  $forbidden = $entries | Where-Object { $_ -match '(?i)(^|/)(config/[^/]*\.config\.json|.*\.pfx|ca\.crt|.*\.bak.*|.*\.log|\.backup/|dist/|node_modules/|tests/\.tmp/)' }
  if ($forbidden) { throw "包里含不该有的文件：`n$($forbidden -join "`n")" }
  Write-Output "已打包：$zip"
  Write-Output "文件数：$($entries.Count)"
  Write-Output '包内容：'
  $entries | Sort-Object | ForEach-Object { Write-Output "  $_" }
  Write-Output ''
  Write-Output '检查：包内没有 config/*.config.json、没有 .pfx / ca.crt、没有 .bak / .log、没有 .backup 与 tests/.tmp ✔'
} finally { $archive.Dispose() }
