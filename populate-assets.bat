@echo off
REM populate-assets.bat — Windows entry point for downloading TalkForge-tts assets
REM Prefers the GitHub Release, falls back to the upstream URL; every file is SHA-256 verified.
REM Double-click or run from a command prompt. Requires PowerShell 5.1+.
REM
REM Usage:
REM   populate-assets.bat
REM   populate-assets.bat -AssetRoot C:\path\to\assets

setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0populate-assets.ps1" %*
echo.
pause
