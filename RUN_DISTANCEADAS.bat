@echo off
cd /d "%~dp0"
echo DistanceADAS v1.0 beta.1
where py >nul 2>&1 && (py -m http.server 8080) || (python -m http.server 8080)
