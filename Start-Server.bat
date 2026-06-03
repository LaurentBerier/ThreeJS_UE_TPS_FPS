@echo off
REM Launch the ThreeJS UE TPS/FPS dev server. Prefers the py launcher, falls
REM back to python on PATH.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 serve.py
) else (
  python serve.py
)
pause
