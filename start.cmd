@echo off
cd /d "%~dp0"
docker compose up -d --build
if errorlevel 1 pause
if not errorlevel 1 start http://127.0.0.1:5173/
