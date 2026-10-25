@echo off
setlocal
cd /d "%~dp0"
set "KINETIC_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "KINETIC_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%KINETIC_NODE%" scripts\start-demo.mjs
if errorlevel 1 pause
