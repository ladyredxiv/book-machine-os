@echo off
title Book Machine OS
echo Starting Book Machine OS...
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo ERROR: Node.js is not installed.
  echo Install the LTS version from https://nodejs.org, then run START.bat again.
  pause
  exit /b 1
)

REM Optional: point this at a folder containing Book Machine projects.
REM You can also configure paths inside the desktop app's Config tab.
REM set "REPO_PATH=C:\Users\you\Desktop\WRITING\your-project-root"

REM Optional: Discord flag notifications.
REM set "DISCORD_WEBHOOK_URL=https://discord.example/webhook"

echo Your browser will open at http://localhost:3000
echo Keep this window open while you write. Close it to stop the program.
echo.
node server.js
pause
