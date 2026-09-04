@echo off
cd /d %~dp0
set GEARBEACON_ACCESS_MODE=private
set GEARBEACON_BIND_HOST=0.0.0.0
echo Starting GearBeacon V1.6 as a private authenticated server...
echo First run: use the one-time setup token printed below in the dashboard.
node --no-warnings backend\dist\index.js
pause
