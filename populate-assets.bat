@echo off
REM populate-assets.bat — Windows entry point for downloading Piper TTS assets
REM Prefers the v1.0.0 GitHub Release; falls back to CDN / Hugging Face.
REM Double-click or run from a command prompt. Requires PowerShell 5.1+.
REM
REM Usage:
REM   populate-assets.bat
REM   populate-assets.bat -AssetRoot C:\path\to\assets

setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0populate-assets.ps1" %*
