@echo off
title Stack Launcher
setlocal

:: --- Configuration ---
set BACKEND_PORT=8000
set FRONTEND_PORT=5173
set FRONTEND_DIR=task-sorter

echo ============================================
echo   INITIALIZING DEV ENVIRONMENT
echo ============================================

:: 1. Cleanup
echo [1/3] Clearing ports %BACKEND_PORT% and %FRONTEND_PORT%...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :%BACKEND_PORT% ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

:: 2. Validation
echo [2/3] Validating environment...

:: Check if .venv exists
if not exist .venv (
    goto :FAIL_MSG
)

:: Check if frontend node_modules exists (indicates npm install has been run)
if not exist "%FRONTEND_DIR%\node_modules" (
    goto :FAIL_MSG
)

:: 3. Launch with Error Trapping
echo [3/3] Launching Terminals...

:: We use a small trick here: 
:: Windows Terminal (wt) doesn't easily return the errorlevel of the sub-processes,
:: so we rely on our pre-launch folder checks above.
wt -w 0 nt --title "Backend" -d "." cmd /k "color 1F && .venv\Scripts\activate && uvicorn main:app --reload --port %BACKEND_PORT%" ; ^
split-pane -V --title "Frontend" -d ".\%FRONTEND_DIR%" cmd /k "color 5F && npm run dev"

:: Final check: If wt itself failed to launch
if %ERRORLEVEL% neq 0 goto :FAIL_MSG

:: 4. Browser
timeout /t 4 /nobreak > NUL
start chrome "http://localhost:%FRONTEND_PORT%"
echo Success!
exit /b

:FAIL_MSG
echo.
echo ------------------------------------------------------------
echo [ERROR] The environment failed to initialize.
echo It looks like the initial setup has not been completed.
echo Please run the setup steps at least once.
echo REFER TO THE README.md FOR INSTALLATION INSTRUCTIONS.
echo ------------------------------------------------------------
echo.
pause
exit /b