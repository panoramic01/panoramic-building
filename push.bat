@echo off
cd /d "%~dp0"

del /f /q ".git\HEAD.lock" 2>nul
del /f /q ".git\index.lock" 2>nul

git add -A

git diff --cached --quiet
if not errorlevel 1 (
  echo Nothing to commit.
  goto pull
)

set /p MSG=Commit message (Enter for "Update site"):
if "%MSG%"=="" set MSG=Update site
git commit -m "%MSG%"

:pull
git pull --rebase origin main
if errorlevel 1 (
  echo.
  echo ERROR: Pull failed. See above.
  pause
  exit /b 1
)

git push origin main
if errorlevel 1 (
  echo.
  echo ERROR: Push failed. See above.
  pause
  exit /b 1
)

echo.
echo Done! GitHub Pages will be live in ~2 minutes.
pause
