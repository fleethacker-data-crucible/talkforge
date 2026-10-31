@echo off
REM talkforge.cmd - headless TalkForge (speak / serve). Needs Node 18+ on PATH. Offline: local assets only.
node "%~dp0tools\talkforge.mjs" %*
exit /b %ERRORLEVEL%
