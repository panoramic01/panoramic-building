@echo off
echo === Panoramic Building Safe Push ===
echo.

cd /d "%~dp0"

REM Remove any stale lock files
del /f /q ".git\HEAD.lock" 2>nul
del /f /q ".git\index.lock" 2>nul
del /f /q ".git\refs\heads\main.lock" 2>nul
echo [1/3] Cleared lock files

REM Pull latest from GitHub (brings in any admin saves) then rebase our commits on top
git pull --rebase origin main
if errorlevel 1 (
  echo ERROR: Pull failed. Check above for details.
  pause
  exit /b 1
)
echo [2/3] Pulled latest from GitHub

REM Push
git push origin main
if errorlevel 1 (
  echo ERROR: Push failed. Check above for details.
  pause
  exit /b 1
)
echo [3/3] Pushed successfully!
echo.
echo Netlify is deploying -- live in ~2 minutes.
pause
