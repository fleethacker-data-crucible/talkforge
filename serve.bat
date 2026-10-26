@echo off
REM serve.bat — Windows entry point for the TalkForge-tts static server
REM Double-click or run from a command prompt. Requires PowerShell 5.1+.

setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve-windows.ps1" %*
