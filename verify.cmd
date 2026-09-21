@echo off
cd /d "%~dp0"
docker compose run --rm worker npm test
if errorlevel 1 exit /b 1
docker compose run --rm worker npm run check
