# 备份本项目的源码与配置（不含 .git / .backup / output / node_modules / *.log）。
# 每次改动已有文件之前先跑一次，快照落在 .backup\<时间戳>\ 下（该目录已被 .gitignore 忽略）。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-sources.ps1
param(
  [string]$Root = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $Root ".backup\$stamp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$skipDirs = @('.git', '.backup', 'output', 'node_modules', 'tests\.tmp')

$files = Get-ChildItem -LiteralPath $Root -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($Root.Length + 1)
  $inSkip = $false
  foreach ($d in $skipDirs) {
    if ($rel -eq $d -or $rel.StartsWith("$d\")) { $inSkip = $true; break }
  }
  (-not $inSkip) -and ($rel -notlike '*.log')
}

foreach ($f in $files) {
  $rel = $f.FullName.Substring($Root.Length + 1)
  $target = Join-Path $dest $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $f.FullName -Destination $target -Force
}

Write-Output "backup -> $dest  ($($files.Count) files)"
