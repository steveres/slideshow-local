@echo off
rem Prepares a photo folder for slideshow.html. Drag a folder onto this file, or run: prepare.bat "C:\path\to\photos"
setlocal
if "%~1"=="" (
  set /p "FOLDER=Folder containing your photos: "
) else (
  set "FOLDER=%~1"
)
set "FOLDER=%FOLDER:"=%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepare.ps1" -Folder "%FOLDER%"
echo.
pause
