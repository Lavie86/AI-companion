@echo off
setlocal
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git was not found. Install it from https://git-scm.com/download/win and try again.
    echo.
    pause
    exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Install Node.js 20 or newer from https://nodejs.org/ and try again.
    echo.
    pause
    exit /b 1
)

node "%~dp0tools\english-ui\update-from-upstream.js" %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
