@echo off
cd /d %~dp0
set MOCK_MODE=1
set GEARBEACON_ACCESS_MODE=local
set GEARBEACON_BIND_HOST=127.0.0.1
echo Starting GearBeacon V1.5 in local-only MOCK MODE...
node --no-warnings backend\dist\index.js
pause
