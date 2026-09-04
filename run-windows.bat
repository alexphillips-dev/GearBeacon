@echo off
cd /d %~dp0
set GEARBEACON_ACCESS_MODE=local
set GEARBEACON_BIND_HOST=127.0.0.1
echo Starting GearBeacon V0.1.10 in local-only mode...
node --no-warnings backend\dist\index.js
pause
