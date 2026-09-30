@echo off
rem Starts the BustGuard API and web app, then opens it in the default browser.
cd /d "%~dp0backend"
start "" http://localhost:8000/
python run.py serve
