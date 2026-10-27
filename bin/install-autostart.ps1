# 登记开机自启（登录 Windows 后自动拉起 机器人QQ/OneBot收发端 + 观澜 + 控制面板）。
# 必须管理员权限运行（由 install-autostart.bat 负责提权，本脚本只检查、不自行提权）。
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$name   = 'WhaleKit-Autostart'
$target = Join-Path $root 'bin\autostart.ps1'
$logDir = Join-Path $root 'logs'
$log    = Join-Path $logDir 'install-autostart.log'

function Say([string]$m) {
  $line = '[{0}] {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m
  try {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  } catch { }
  Write-Host $m
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Say '不是管理员权限，已退出（请重新双击 install-autostart.bat）'
  exit 2
}

if (-not (Test-Path $target)) {
  Say ('找不到启动脚本：' + $target)
  exit 3
}

$ps     = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arg    = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $target + '"'
$user   = $env:USERDOMAIN + '\' + $env:USERNAME

Say ('开始登记：' + $name)
Say ('  运行用户：' + $user)
Say ('  执行脚本：' + $target)

# 先删掉旧任务（旧任务可能指向上一个目录，留着会开机报错）
$old = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($old) {
  try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop } catch {
    Say ('删除旧任务失败：' + $_.Exception.Message)
  }
  Say '已删除旧任务'
}

$action    = New-ScheduledTaskAction -Execute $ps -Argument $arg
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest

try {
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
} catch {
  Say ('登记失败：' + $_.Exception.Message)
  exit 4
}

# 回读确认，别只看"没报错"
$chk = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if (-not $chk) {
  Say '登记后读不到任务，安装失败'
  exit 5
}
$actArg = ($chk.Actions | Select-Object -First 1).Arguments
Say ('回读任务：' + $chk.TaskName + ' | 状态 ' + $chk.State)
Say ('  动作参数：' + $actArg)
if ($actArg -notmatch [regex]::Escape($target)) {
  Say '警告：任务动作里的脚本路径和预期不一致'
  exit 6
}

Say '安装完成：以后登录 Windows 会自动拉起 机器人QQ + OneBot收发端 + 观澜 + 控制面板。'
Say '取消自启：schtasks /Delete /TN "WhaleKit-Autostart" /F'
exit 0
