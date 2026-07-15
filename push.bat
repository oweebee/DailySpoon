@echo off
setlocal

cd /d "%~dp0"

set "msg=%*"
if "%msg%"=="" set "msg=Update DailySpoon"

echo.
echo === git add ===
git add .

echo.
echo === git commit -m "%msg%" ===
git commit -m "%msg%"

echo.
echo === git push ===
git push

echo.
echo Termine.
pause
