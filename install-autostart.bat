@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 防死循环：带 --elevated 标记的实例只负责干活，绝不再提权一次。
if /i "%~1"=="--elevated" goto run

net session >nul 2>&1
if not errorlevel 1 goto run

echo 需要管理员权限，正在请求提权（只弹一次 UAC，请点「是」）...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -ArgumentList '--elevated' -Verb RunAs -ErrorAction Stop; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo.
  echo [失败] 提权被取消或失败，未做任何改动。
  pause
  exit /b 1
)
echo 已交给管理员窗口继续，本窗口可以关掉。
exit /b 0

:run
echo 正在登记开机自启...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\install-autostart.ps1"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo [失败] 安装未完成，错误码 %RC%。日志：logs\install-autostart.log
) else (
  echo [完成] 以后登录 Windows 会自动拉起 NapCat + 机器人 + 控制面板。
)
pause
exit /b %RC%
