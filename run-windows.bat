@echo off
cd /d %~dp0
echo Starting GearBeacon V1.4...
node --no-warnings backend\dist\index.js
pause
