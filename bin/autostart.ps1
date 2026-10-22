# 开机自启：等桌面起来 → 拉 NapCat/QQ → 拉看门人（机器人+面板）
# 由计划任务 WhaleKit-Autostart 在登录时以最高权限调用。
#
# 【重要】计划任务是 RunLevel=Highest，跑起来是 High 完整性。
# 在 High 上下文里，DSH 沙箱派生的受限子进程（pwsh/bash）会在加载 DLL 阶段
# 直接死掉，报 0xC0000142 / exit 3221225794 —— 机器人因此完全用不了命令行。
# 所以这里第一件事是把自己降回 Medium（普通用户权限）再干活：
# 经 explorer.exe 中转启动，Windows 会把完整性级别重置为 Medium。
param([switch]$Delevated)

$ErrorActionPreference = 'Continue'
# 路径全部自动推导，不写死盘符：
#   $ROOT = 本脚本所在目录的上一级（即仓库根）
#   $NAP  = 同级目录下的 NapCat；也可用环境变量 NAPCAT_DIR 覆盖
#   $NODE = 优先用 PATH 里的 node，找不到再退回环境变量 NODE_EXE
$ROOT = Split-Path -Parent $PSScriptRoot
$NAP  = if ($env:NAPCAT_DIR) { $env:NAPCAT_DIR } else { Join-Path (Split-Path -Parent $ROOT) 'NapCat' }
$NODE = if ($env:NODE_EXE) { $env:NODE_EXE } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
$LOG  = Join-Path $ROOT 'logs\autostart.log'

function Say([string]$m) {
  $line = '[{0}] {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m
  try { Add-Content -LiteralPath $LOG -Value $line -Encoding UTF8 } catch { }
}

function Get-SelfIntegrity {
  try {
    if (-not ('WkIL' -as [type])) {
      Add-Type -Namespace WkIL -Name Api -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
[DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
[DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr t, int cls, IntPtr buf, int len, out int need);
[DllImport("advapi32.dll", SetLastError=true)] public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LocalFree(IntPtr h);
'@
    }
    $tok = [IntPtr]::Zero
    if (-not [WkIL.Api]::OpenProcessToken([WkIL.Api]::GetCurrentProcess(), 8, [ref]$tok)) { return '' }
    $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(128)
    $need = 0
    if (-not [WkIL.Api]::GetTokenInformation($tok, 25, $buf, 128, [ref]$need)) {
      [Runtime.InteropServices.Marshal]::FreeHGlobal($buf); return ''
    }
    $sidPtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($buf)
    $str = [IntPtr]::Zero
    $res = ''
    if ([WkIL.Api]::ConvertSidToStringSidW($sidPtr, [ref]$str)) {
      $res = [Runtime.InteropServices.Marshal]::PtrToStringUni($str)
      [void][WkIL.Api]::LocalFree($str)
    }
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
    return $res
  } catch { return '' }
}

function Test-Port([int]$port) {
  $t = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $t.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(700)) { return $false }
    $t.EndConnect($ar)
    return $true
  } catch { return $false } finally { $t.Close() }
}

# 0) 降权：High → Medium（否则机器人跑不了任何命令）
if (-not $Delevated) {
  $il = Get-SelfIntegrity
  Say ('自启进程完整性：' + $il)
  if ($il -eq 'S-1-16-12288') {
    # 旧链如果是 High 起的，Medium 进程杀不掉它，必须趁现在（High）先清掉
    $stale = @()
    foreach ($n in 'start.mjs', 'whale-bot.mjs', 'server.mjs') {
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like ('*' + $n + '*') } |
        ForEach-Object { $stale += $_.ProcessId }
    }
    # 看门人的命令行里可能没有包路径（工作目录启动），靠 pid 文件兜底
    $supPidFile = Join-Path $ROOT 'runtime\supervisor.pid'
    if (Test-Path $supPidFile) {
      $p = [int](((Get-Content $supPidFile -ErrorAction SilentlyContinue) -join '') -replace '\D', '')
      if ($p -gt 0) { $stale += $p }
    }
    $stale = $stale | Sort-Object -Unique
    if ($stale.Count -gt 0) {
      Say ('清理旧的提权进程：' + ($stale -join ','))
      foreach ($p in $stale) { try { & taskkill.exe /PID $p /T /F 2>&1 | Out-Null } catch { } }
      Start-Sleep -Seconds 3
    } else {
      Say '没有需要清理的旧进程'
    }

    $cmd = Join-Path $env:TEMP 'whalekit-autostart-medium.cmd'
    $ps1 = $MyInvocation.MyCommand.Path
    $body = '@echo off' + "`r`n" + 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ps1 + '" -Delevated' + "`r`n"
    try {
      Set-Content -LiteralPath $cmd -Value $body -Encoding ASCII
      Start-Process explorer.exe -ArgumentList ('"' + $cmd + '"')
      Say '检测到提权，已通过 explorer 中转降回 Medium，本次 High 进程退出'
    } catch {
      Say ('降权失败，继续以 High 运行（机器人将无法执行命令）：' + $_.Exception.Message)
    }
    exit 0
  }
}

Say '===== 开机自启开始 ====='
Start-Sleep -Seconds 10

# 1) NapCat + QQ
if (Test-Port 3001) {
  Say 'OneBot 3001 已在监听，跳过 NapCat'
} else {
  Say '启动 NapCat（launcher.bat）'
  try {
    Start-Process -FilePath (Join-Path $NAP 'launcher.bat') -WorkingDirectory $NAP -WindowStyle Hidden
  } catch { Say ('NapCat 启动失败：' + $_.Exception.Message) }
  for ($i = 0; $i -lt 90; $i++) {
    if (Test-Port 3001) { break }
    Start-Sleep -Seconds 2
  }
  Say ('OneBot 3001: ' + (Test-Port 3001))
}

# 2) 看门人 + 机器人 + 面板
$sup = 0
$pidFile = Join-Path $ROOT 'runtime\supervisor.pid'
if (Test-Path $pidFile) {
  $sup = [int](((Get-Content $pidFile -ErrorAction SilentlyContinue) -join '') -replace '\D', '')
}
$alive = $false
if ($sup -gt 0) { $alive = [bool](Get-Process -Id $sup -ErrorAction SilentlyContinue) }
if ($alive) {
  Say "看门人已在跑（$sup）"
} else {
  Say '启动看门人 node bin\start.mjs --detach'
  try {
    Start-Process -FilePath $NODE -ArgumentList 'bin\start.mjs', '--detach' -WorkingDirectory $ROOT -WindowStyle Hidden
  } catch { Say ('看门人启动失败：' + $_.Exception.Message) }
}
for ($i = 0; $i -lt 25; $i++) {
  if (Test-Port 8790) { break }
  Start-Sleep -Seconds 1
}
Say ('面板 8790: ' + (Test-Port 8790))
Say ('收尾完整性：' + (Get-SelfIntegrity))
Say '===== 开机自启结束 ====='
