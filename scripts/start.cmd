@echo off
rem One-click start. All logic (and all Chinese text) lives in start.ps1:
rem cmd.exe parses .cmd files using the OEM code page, so UTF-8 Chinese in a .cmd
rem file gets mangled and can even break the batch syntax.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
