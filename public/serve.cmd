@echo off
rem FlexiPath: serve the built site over HTTP (D-02). Double-click this file in dist\, then open http://localhost:8000/
cd /d "%~dp0"
where py >nul 2>nul && (py -3 -m http.server 8000 --bind 127.0.0.1) || (python -m http.server 8000 --bind 127.0.0.1)
