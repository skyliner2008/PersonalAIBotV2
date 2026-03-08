@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo [DEV MODE - 2 Process]
echo Server: port 3000  |  Dashboard Dev: port 5173
echo Tip: Use start.bat for single-process production mode
echo.

echo [1/3] Checking dependencies...
cd server
if not exist node_modules (call npm install)
cd ../dashboard
if not exist node_modules (call npm install)
cd ..

echo [2/3] Starting Server (port 3000)...
start "AI Bot Server" cmd /k "cd /d "%~dp0server" && npm run dev"
timeout /t 3 /nobreak >nul

echo [3/3] Starting Dashboard Dev (port 5173)...
start "AI Dashboard Dev" cmd /k "cd /d "%~dp0dashboard" && npm run dev"

echo.
echo Dashboard: http://localhost:5173
echo API Server: http://localhost:3000
echo Health:    http://localhost:3000/health
echo.
pause
