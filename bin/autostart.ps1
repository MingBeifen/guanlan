# 开机自启：等桌面起来 → 拉起 OneBot 实现（NapCat 或 SnowLuma）→ 拉看门人（机器人+面板）
# 由计划任务 WhaleKit-Autostart 在登录时以最高权限调用。
#
# 【2026-10-22 重要】计划任务是 RunLevel=Highest，跑起来是 High 完整性。
# 在 High 上下文里，DSH 沙箱派生的受限子进程（pwsh/bash）会在加载 DLL 阶段
# 直接死掉，报 0xC0000142 / exit 3221225794 —— 观澜因此完全用不了命令行。
# 所以这里第一件事是把自己降回 Medium（普通用户权限）再干活：
# 经 explorer.exe 中转启动，Windows 会把完整性级别重置为 Medium。
param([switch]$Delevated)

$ErrorActionPreference = 'Continue'
# 开源版：包根不再写死，从脚本自身位置往上推一级（bin/autostart.ps1 -> 包根)
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
# 开源版：用哪种 OneBot 实现。WW_ONEBOT = napcat（默认） / snowluma。
$IMPL = if ($env:WW_ONEBOT) { $env:WW_ONEBOT.ToLower() } else { 'napcat' }
# 开源版：NapCat 装在哪由你自己填（或先设环境变量 WW_NAPCAT）
$NAP  = if ($env:WW_NAPCAT) { $env:WW_NAPCAT } else { 'C:\NapCat' }
# 开源版：SnowLuma 装在哪由你自己填（或先设环境变量 WW_SNOWLUMA）
$SL   = if ($env:WW_SNOWLUMA) { $env:WW_SNOWLUMA } else { 'C:\SnowLuma' }
$SL_PORT = if ($env:WW_SNOWLUMA_PORT) { [int]$env:WW_SNOWLUMA_PORT } else { 5099 }
# 开源版：QQ 可执行文件与「机器人号专用 profile」。
#   QQ_EXE 留空 = 从正在运行的 QQ.exe 里自己找；QQ_PROF 默认放在包根下的 QQ-Profile。
#   为什么机器人号要单独一个 profile：同一个 QQ 客户端只能登一个号，
#   主人自己的号和机器人号必须各开一个实例，否则注入错号 = 拿主人的身份说话。
$QQ_EXE  = if ($env:WW_QQ) { $env:WW_QQ } else { '' }
$QQ_PROF = if ($env:WW_QQ_PROF) { $env:WW_QQ_PROF } else { Join-Path $ROOT 'QQ-Profile' }
# 开源版：node 路径优先用环境变量 WW_NODE，其次 PATH 里的 node（不写死某台机器的安装位置）
$NODE = if ($env:WW_NODE) { $env:WW_NODE } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
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

# 1) OneBot 实现 + QQ
if (Test-Port 3001) {
  Say 'OneBot 3001 已在监听，跳过启动 OneBot 实现'
} elseif ($IMPL -eq 'snowluma') {
  # 【SnowLuma 和 NapCat 差别很大，别照抄 NapCat 的做法】
  #   · SnowLuma 不启动 QQ，它往「已经在跑的 QQ.exe」注入 DLL，所以必须先有 QQ。
  #   · 机器人号要单独用一个 profile 目录开第二个实例，别去注入主人自己的号。
  #   · SnowLuma 进程必须是 Medium 完整性，否则注入 Medium 的 QQ 会被 No-Write-Up 拒绝；
  #     所以它**不能**放在带 Low SACL 的目录下（例如 DSH 沙箱工作区）。
  #   · 起来了也不会自动注入（runtime.json 里 hookAutoLoad=false），要 POST 一次
  #     /api/processes/<pid>/load —— 由 bin\snowluma-inject.mjs 做这一步，并核对账号。
  Say ('OneBot 实现：SnowLuma（' + $SL + '）')

  # 1a) 机器人 QQ 实例（用独立 profile，避免和主人那个冲突）
  $qqMain = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue |
              Where-Object { $_.CommandLine -notmatch '--type=' })
  $hasBotQQ = @($qqMain | Where-Object { $_.CommandLine -match [regex]::Escape($QQ_PROF) }).Count -gt 0
  if ($hasBotQQ) {
    Say '机器人 QQ 实例已在跑'
  } elseif ($QQ_EXE -and (Test-Path $QQ_EXE)) {
    Say ('启动机器人 QQ 实例（profile=' + $QQ_PROF + '）')
    try {
      Start-Process -FilePath $QQ_EXE -ArgumentList ('--user-data-dir=' + $QQ_PROF) -WindowStyle Hidden
      for ($i = 0; $i -lt 30; $i++) {
        $n = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandLine -match [regex]::Escape($QQ_PROF) }).Count
        if ($n -gt 0) { break }
        Start-Sleep -Seconds 1
      }
    } catch { Say ('机器人 QQ 启动失败：' + $_.Exception.Message) }
  } else {
    Say ('没有指定 QQ 路径（WW_QQ），也不见在跑的 QQ 实例 —— 需要人工登录机器人号')
  }

  # 1b) SnowLuma 本体
  if (-not (Test-Path (Join-Path $SL 'node.exe'))) {
    Say ('找不到 SnowLuma：' + $SL + '（设 WW_SNOWLUMA 指到它的目录）')
  } else {
    Say '启动 SnowLuma'
    try {
      Start-Process -FilePath (Join-Path $SL 'node.exe') `
                    -ArgumentList ((Join-Path $SL 'index.mjs')) `
                    -WorkingDirectory $SL -WindowStyle Hidden
    } catch { Say ('SnowLuma 启动失败：' + $_.Exception.Message) }
    for ($i = 0; $i -lt 45; $i++) {
      if (Test-Port $SL_PORT) { break }
      Start-Sleep -Seconds 2
    }
    Say ('SnowLuma WebUI ' + $SL_PORT + ': ' + (Test-Port $SL_PORT))
  }

  # 1c) 注入机器人 QQ，并核对账号
  # 只注入「用 --user-data-dir=$QQ_PROF 启动的那个进程」，绝不注入主人自己的号。
  $botPid = 0
  for ($i = 0; $i -lt 30; $i++) {
    $row = Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match [regex]::Escape($QQ_PROF) } |
           Select-Object -First 1
    if ($row) { $botPid = [int]$row.ProcessId; break }
    Start-Sleep -Seconds 2
  }
  if ($botPid -gt 0) {
    Say ('注入机器人 QQ：PID ' + $botPid)
    try {
      $out = & $NODE (Join-Path $ROOT 'bin\snowluma-inject.mjs') --pid $botPid 2>&1
      foreach ($line in $out) { Say ('  ' + $line) }
    } catch { Say ('注入失败：' + $_.Exception.Message) }
  } else {
    Say ('没找到机器人 QQ 实例（profile=' + $QQ_PROF + '），跳过注入 —— 需要人工登录')
  }

  # 1d) 等 OneBot 端口
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Port 3001) { break }
    Start-Sleep -Seconds 2
  }
  Say ('OneBot 3001: ' + (Test-Port 3001))
} else {
  # NapCat：它自己会拉起 QQ 并登录，不需要注入
  Say ('启动 NapCat（launcher.bat）：' + $NAP)
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
