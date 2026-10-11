@echo off
rem Local dev server for supplier-scout. Logic lives in dev.ps1 (bat stays ASCII-only).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1"
if errorlevel 1 pause
