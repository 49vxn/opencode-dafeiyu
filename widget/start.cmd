@echo off
setlocal
cd /d "%~dp0"
title dafeiyu

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required and was not found.
  echo   Install the LTS build from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   First run - installing once. This takes a minute.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   Install failed. Run "npm install" in this folder to see why.
    echo.
    pause
    exit /b 1
  )
)

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
