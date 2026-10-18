# 给项目里所有 .ps1 补 UTF-8 BOM，并用 PowerShell 自己的解析器验证能否解析。
# 背景：Windows PowerShell 5.1 读 .ps1 时若没有 BOM，会按 ANSI(GBK) 解码，中文注释会变成乱码并可能破坏语法。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

$files = Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.ps1 | Where-Object { $_.FullName -notlike '*\.backup\*' -and $_.FullName -notlike '*\dist\*' }
foreach ($file in $files) {
  $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  if (-not $hasBom) {
    $text = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($file.FullName, $text, $utf8Bom)
    Write-Output "已补 BOM：$($file.FullName.Substring($root.Length + 1))"
  } else {
    Write-Output "已有 BOM：$($file.FullName.Substring($root.Length + 1))"
  }
}

Write-Output ''
Write-Output '=== 用 PowerShell 解析器逐个检查 ==='
foreach ($file in $files) {
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$errors)
  $status = if ($errors -and $errors.Count) { "语法错误 $($errors.Count) 处：$($errors[0].Message)" } else { 'OK' }
  Write-Output ("  {0,-34} {1}" -f $file.Name, $status)
}
