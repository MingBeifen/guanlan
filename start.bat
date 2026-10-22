@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Node.js not found. Install Node 20 or newer from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)
if not exist "config.json" (
  echo First run: opening the setup wizard.
  node "bin\setup.mjs"
)
node "bin\check-deps.mjs" --preflight
if errorlevel 1 (
  echo.
  echo [X] Not ready yet. Fix the items above, then run this again.
  echo.
  pause
  exit /b 1
)
node "bin\start.mjs"
echo.
echo Bot stopped. Press any key to close this window.
pause >nul
