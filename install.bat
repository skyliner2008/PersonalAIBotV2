@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo +------------------------------------------------------+
echo ^| AI Bot - One-Click Installer                        ^|
echo ^| Automated Setup and Dependency Check                ^|
echo +------------------------------------------------------+
echo.

:: ==========================================
:: [1/5] Check prerequisites (Node.js and Python)
:: ==========================================
echo [1/5] Checking prerequisites...

:: Check Node.js
where node >nul 2>nul
if !errorlevel! neq 0 (
    echo   [ERROR] Node.js was not found
    echo   Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo   [OK] Node.js !NODE_VER! is installed

:: Check npm
where npm >nul 2>nul
if !errorlevel! neq 0 (
    echo   [ERROR] npm was not found
    pause
    exit /b 1
)
echo   [OK] npm is installed

:: Check Python (warning only)
where python >nul 2>nul
if !errorlevel! neq 0 (
    echo   [WARN] Python was not found
    echo   Some tools may not work (Python scripts, py_autogui, node-pty/sqlite3 builds)
    echo   Recommended: install Python from https://www.python.org/downloads/
    echo.
) else (
    for /f "tokens=*" %%v in ('python --version 2^>^&1') do set PY_VER=%%v
    echo   [OK] !PY_VER! is installed
)

:: ==========================================
:: [2/5] Install server dependencies and Playwright
:: ==========================================
echo.
echo [2/5] Installing server dependencies...
cd server

if not exist node_modules (
    echo   Running npm install...
    call npm install
    if !errorlevel! neq 0 (
        echo   [ERROR] npm install failed in server
        echo   Tip: if node-gyp or sqlite3 fails, run this as Administrator:
        echo   npm install --global windows-build-tools
        pause
        exit /b 1
    )
) else (
    echo   [OK] Server modules already exist
)

echo   Installing Playwright (Chromium for web tools)...
call npx playwright install chromium --with-deps
if !errorlevel! neq 0 (
    echo   [WARN] Playwright install had issues (some web tools may not work)
)

:: ==========================================
:: [3/5] Install dashboard dependencies
:: ==========================================
echo.
echo [3/5] Installing dashboard dependencies...
cd ../dashboard

if not exist node_modules (
    echo   Running npm install...
    call npm install
    if !errorlevel! neq 0 (
        echo   [ERROR] npm install failed in dashboard
        pause
        exit /b 1
    )
) else (
    echo   [OK] Dashboard modules already exist
)

:: ==========================================
:: [4/5] Build dashboard
:: ==========================================
echo.
echo [4/5] Building dashboard...
call npm run build
if !errorlevel! neq 0 (
    echo   [ERROR] Dashboard build failed
    pause
    exit /b 1
)
echo   [OK] Dashboard build complete

:: ==========================================
:: [5/5] Initialize folders and environment
:: ==========================================
echo.
echo [5/5] Initializing folders and environment...
cd ../server
call npm run init-folders
if !errorlevel! neq 0 (
    echo   [ERROR] Folder initialization failed
    pause
    exit /b 1
)

echo.
echo +------------------------------------------------------+
echo ^| Installation complete                                ^|
echo ^|                                                      ^|
echo ^| Next steps:                                          ^|
echo ^| 1. Run start.bat                                     ^|
echo ^| 2. Open http://localhost:3000                        ^|
echo ^| 3. Configure API keys and agents in Dashboard        ^|
echo +------------------------------------------------------+
echo.
pause
