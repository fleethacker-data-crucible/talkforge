@echo off
REM TalkForge.bat - Windows launcher for the TalkForge-tts local server (replaces serve.bat).
REM Double-click or run from a command prompt. Requires PowerShell 5.1+. No admin rights.
REM Any arguments are passed on: TalkForge.bat -Port 25005 -NoBrowser

setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Start-TalkForge.ps1" %*
