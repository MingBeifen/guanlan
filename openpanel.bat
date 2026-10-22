@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Node.js not found. Install Node 20 or newer from https://nodejs.org/ first.
  echo.
  pause
  exit /b 1
)
node "panel\server.mjs"
pause >nul
