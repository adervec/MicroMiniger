@echo off
rem MicroMiniger launcher — serves the app locally (PWA install needs http, not file://)
cd /d "%~dp0"
start "" "http://localhost:8137"
python -m http.server 8137
