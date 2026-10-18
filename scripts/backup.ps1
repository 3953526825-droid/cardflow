# 把 config/ 与 prompts/ 打包备份（换机器、重装、迁移时用）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup.ps1 -OutDir D:\backup
#
# ⚠️ 包里有 config/<学科>.config.json（口令与 API Key），不要放到公开地方。
param(
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'backups' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$zip = Join-Path $OutDir "anki-card-maker-$stamp.zip"
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "acm-backup-$stamp"
New-Item -ItemType Directory -Force -Path $staging | Out-Null

foreach ($item in 'config', 'prompts', 'subjects') {
  $source = Join-Path $root $item
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $staging -Recurse -Force }
}

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force
Remove-Item -LiteralPath $staging -Recurse -Force

$size = (Get-Item -LiteralPath $zip).Length
Write-Output "备份完成：$zip（$([math]::Round($size / 1KB, 1)) KB）"
Write-Output '内容：config/ prompts/ subjects/'
Write-Output '注意：里面有 config/*.config.json（口令与密钥），别放到公开地方。'
