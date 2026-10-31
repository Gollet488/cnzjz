@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing from PATH. Install Node 24.22.1 and pnpm 11.25.0; see README.md.
  pause
  exit /b 1
)
node "scripts\stop-demo.mjs" %*
if errorlevel 1 (
  pause
  exit /b 1
)
