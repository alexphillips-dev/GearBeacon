@echo off
cd /d %~dp0
set MOCK_MODE=1
echo Starting GearBeacon V1.4 in MOCK MODE...
node --no-warnings backend\dist\index.js
pause
