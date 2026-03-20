@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

set "START_MODE=compact"
set "DOCTOR_MODE=0"
for %%A in (%*) do (
  if /I "%%~A"=="--verbose" set "START_MODE=verbose"
  if /I "%%~A"=="--doctor" set "DOCTOR_MODE=1"
)
set "BUILD_LOG=%TEMP%\aibot-dashboard-build.log"

echo.
echo +------------------------------------------------------+
echo ^| AI Bot - One-Click Start                            ^|
if /I "!START_MODE!"=="compact" (
  echo ^| Mode: Compact ^(clean output^)                     ^|
) else (
  echo ^| Mode: Verbose ^(full logs^)                        ^|
)
echo ^| Server + Dashboard (port 3000)                      ^|
echo +------------------------------------------------------+
echo.

if /I "!START_MODE!"=="compact" (
  set "STARTUP_COMPACT=1"
  set "LOG_LEVEL=warn"
  set "HTTP_CONSOLE_MODE=errors"
  set "NO_COLOR=1"
) else (
  set "STARTUP_COMPACT=0"
  if not defined LOG_LEVEL set "LOG_LEVEL=info"
)

echo [0/4] Running startup doctor checks...
set "PREFLIGHT_FAIL=0"

where node >nul 2>&1
if !errorlevel! neq 0 (
  echo   [ERROR] Node.js not found in PATH
  set "PREFLIGHT_FAIL=1"
) else (
  set "NODE_VERSION="
  for /f "usebackq delims=" %%V in (`node -v`) do (
    set "NODE_VERSION=%%V"
  )
  echo   [OK] Node !NODE_VERSION!
)

where npm >nul 2>&1
if !errorlevel! neq 0 (
  echo   [ERROR] npm not found in PATH
  set "PREFLIGHT_FAIL=1"
) else (
  set "NPM_VERSION="
  for /f "usebackq delims=" %%V in (`npm -v`) do (
    set "NPM_VERSION=%%V"
  )
  echo   [OK] npm !NPM_VERSION!
)

if not exist "server\package.json" (
  echo   [ERROR] Missing server\package.json
  set "PREFLIGHT_FAIL=1"
)
if not exist "dashboard\package.json" (
  echo   [ERROR] Missing dashboard\package.json
  set "PREFLIGHT_FAIL=1"
)

if exist "server\.env" (
  echo   [OK] server\.env found
) else (
  echo   [WARN] server\.env not found ^(copy from server\.env.example^)
)

if !PREFLIGHT_FAIL! neq 0 (
  echo   [FATAL] Startup doctor found blocking issues
  pause
  exit /b 1
)

set "PORT_PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess }"`) do (
  set "PORT_PID=%%P"
)

if defined PORT_PID (
  set "PORT_PROC="
  for /f "usebackq delims=" %%N in (`powershell -NoProfile -Command "$p=Get-Process -Id !PORT_PID! -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName }"`) do (
    set "PORT_PROC=%%N"
  )

  echo [INFO] Server already running on port 3000 ^(PID !PORT_PID! !PORT_PROC!^)
  echo.
  echo +------------------------------------------------------+
  echo ^| Status: Existing process is using port 3000         ^|
  echo ^| Open in browser: http://localhost:3000              ^|
  echo ^| To restart: taskkill /PID !PORT_PID! /F             ^|
  echo +------------------------------------------------------+
  echo.
  exit /b 0
)

if /I "!DOCTOR_MODE!"=="1" (
  echo   [OK] Doctor checks complete ^(no start requested^)
  echo.
  exit /b 0
)

echo [1/4] Checking server dependencies...
cd server
if not exist node_modules (
  echo   Installing server packages...
  call npm install
  if !errorlevel! neq 0 (
    echo   [ERROR] npm install failed in server
    pause
    exit /b 1
  )
)
echo   [OK] Server dependencies ready

echo [2/4] Checking dashboard dependencies...
cd ../dashboard
if not exist node_modules (
  echo   Installing dashboard packages...
  call npm install
  if !errorlevel! neq 0 (
    echo   [ERROR] npm install failed in dashboard
    pause
    exit /b 1
  )
)
echo   [OK] Dashboard dependencies ready

if /I "!START_MODE!"=="compact" (
  echo [3/4] Building dashboard ^(quiet mode^)...
  call npm run build > "!BUILD_LOG!" 2>&1
  if !errorlevel! neq 0 (
    echo   [ERROR] Dashboard build failed
    echo   Last 30 lines:
    powershell -NoProfile -Command "Get-Content -Path '!BUILD_LOG!' -Tail 30"
    echo   Full log: !BUILD_LOG!
    pause
    exit /b 1
  )

  set "BUILD_SUMMARY="
  for /f "usebackq delims=" %%L in (`powershell -NoProfile -Command "$line=(Select-String -Path '!BUILD_LOG!' -Pattern 'built in' | Select-Object -Last 1).Line; if ($line) { $line }"`) do (
    set "BUILD_SUMMARY=%%L"
  )

  if defined BUILD_SUMMARY (
    echo   [OK] Dashboard build complete ^(!BUILD_SUMMARY!^)
  ) else (
    echo   [OK] Dashboard build complete
  )
) else (
  echo [3/4] Building dashboard...
  call npm run build
  if !errorlevel! neq 0 (
    echo   [ERROR] Dashboard build failed
    pause
    exit /b 1
  )
  echo   [OK] Dashboard build complete
)

cd ../server
echo [4/4] Starting server...
echo.
echo +------------------------------------------------------+
echo ^| Open in browser: http://localhost:3000              ^|
echo ^| Webhook:        http://localhost:3000/webhook       ^|
echo ^| Health:         http://localhost:3000/health        ^|
echo ^| Keep this window open while the server is running   ^|
if /I "!START_MODE!"=="compact" (
  echo ^| Tip: use start.bat --verbose for full logs         ^|
)
echo +------------------------------------------------------+
echo.

if /I "!START_MODE!"=="compact" (
  call npm run --silent dev
) else (
  call npm run dev
)
