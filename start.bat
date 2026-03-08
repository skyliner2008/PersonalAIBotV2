@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ╔══════════════════════════════════════════════════╗
echo ║     🤖 AI Bot - One-Click Start                ║
echo ║     Server + Dashboard (port 3000)              ║
echo ╚══════════════════════════════════════════════════╝
echo.

:: ==========================================
:: [1/4] ติดตั้ง server dependencies
:: ==========================================
echo [1/4] ตรวจสอบ Server dependencies...
cd server
if not exist node_modules (
    echo   Installing server packages...
    call npm install
    if !errorlevel! neq 0 (
        echo   ❌ npm install server ล้มเหลว
        pause & exit /b 1
    )
)
echo   ✅ Server OK

:: ==========================================
:: [2/4] ติดตั้ง dashboard dependencies
:: ==========================================
echo [2/4] ตรวจสอบ Dashboard dependencies...
cd ../dashboard
if not exist node_modules (
    echo   Installing dashboard packages...
    call npm install
    if !errorlevel! neq 0 (
        echo   ❌ npm install dashboard ล้มเหลว
        pause & exit /b 1
    )
)
echo   ✅ Dashboard OK

:: ==========================================
:: [3/4] Build Dashboard (React → static files)
:: ==========================================
echo [3/4] Building Dashboard...
call npm run build
if !errorlevel! neq 0 (
    echo   ❌ Dashboard build ล้มเหลว
    pause & exit /b 1
)
echo   ✅ Dashboard built เรียบร้อย

:: ==========================================
:: [4/4] Start Server (ครอบคลุม Dashboard แล้ว)
:: ==========================================
cd ../server
echo [4/4] Starting Server...
echo.
echo ╔══════════════════════════════════════════════════╗
echo ║  🌐 เปิด Browser ที่: http://localhost:3000     ║
echo ║  📡 Webhook:          http://localhost:3000/..  ║
echo ║  ⚠️  อย่าปิดหน้าต่างนี้                         ║
echo ╚══════════════════════════════════════════════════╝
echo.

call npm run dev
