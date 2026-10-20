@echo off
rem Start Manimator and open it in your browser. Close this window (or press Ctrl+C) to stop it.
cd /d "%~dp0"
".venv\Scripts\python.exe" run.py %*
if errorlevel 1 pause
