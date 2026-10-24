# 观澜备份总入口（计划任务调这个，全 ASCII 路径，绕开中文名 bat 的编码坑）
# 依次跑：1) 代码仓  2) 数据仓
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$log = Join-Path $root "logs\auto-backup.log"

function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m
  Write-Host $line
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Add-Content -Path $log -Value $line -Encoding UTF8
  } catch { }
}

Say "===== 自动备份开始 ====="
$okCode = $false
$okData = $false

# 1) 代码仓
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "bin\backup-github.ps1") 2>&1 |
    ForEach-Object { Say ("[code] " + $_) }
  $okCode = ($LASTEXITCODE -eq 0)
} catch { Say ("[code] ERROR: " + $_.Exception.Message) }

# 2) 数据仓
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "bin\backup-data.ps1") 2>&1 |
    ForEach-Object { Say ("[data] " + $_) }
  $okData = ($LASTEXITCODE -eq 0)
} catch { Say ("[data] ERROR: " + $_.Exception.Message) }

# 收尾：整轮结果写一行，事后一眼能看出哪天挂了
Say ("===== 自动备份结束 code=" + $okCode + " data=" + $okData + " =====")
if (-not ($okCode -and $okData)) { exit 1 }
exit 0
