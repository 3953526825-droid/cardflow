# 一键注册计划任务：登录时自启 + 看门狗。
#
# 用法（需要管理员权限的 PowerShell）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-tasks.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-tasks.ps1 -RemoveLegacyTasks
#
# 只在确认统一入口已经跑起来之后再执行（默认不加这个开关，谁都不会被动到）。
param(
  [string]$TaskName = 'AnkiCardMaker-Local',
  [switch]$RemoveLegacyTasks
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $root 'scripts\watchdog.ps1'

if (-not (Test-Path -LiteralPath $watchdog)) { throw "找不到看门狗脚本：$watchdog" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

# ExecutionTimeLimit 必须是 PT0S（不限时），否则跑满默认的 72 小时会被任务计划程序强杀；
# 同时关掉电池限制，避免笔记本拔掉电源就停。
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Output "已注册任务：$($task.TaskName)（状态：$($task.State)）"
Write-Output "  ExecutionTimeLimit = $($task.Settings.ExecutionTimeLimit)（PT0S 表示不限时）"
Write-Output "  AllowStartIfOnBatteries = $($task.Settings.DisallowStartIfOnBatteries -eq $false)"

if ($RemoveLegacyTasks) {
  foreach ($legacy in @()) {
    if (Get-ScheduledTask -TaskName $legacy -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $legacy -Confirm:$false
      Write-Output "已注销旧任务：$legacy"
    }
  }
} else {
  Write-Output '（未动旧任务）'
}

Write-Output ''
Write-Output '启动服务：Start-ScheduledTask -TaskName ' + $TaskName
Write-Output '查看日志：Get-Content ' + (Join-Path $root 'anki-card-maker.log') + ' -Tail 20'
