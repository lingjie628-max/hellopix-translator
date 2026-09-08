@echo off
setlocal EnableExtensions
cd /d D:\TBuild

echo.
echo === check VS environment ===
if not defined Platform (
  echo Open "x64 Native Tools Command Prompt for VS" first.
  echo Do not use normal CMD.
  goto fail
)
echo Platform=%Platform%

if not exist "D:\TBuild\tdesktop\Telegram\build\prepare\prepare.py" (
  echo Missing D:\TBuild\tdesktop\Telegram\build\prepare\prepare.py
  goto fail
)

echo.
echo === find Python 3.10 ===
set "PYEXE="

if exist "%LocalAppData%\Programs\Python\Python310\python.exe" set "PYEXE=%LocalAppData%\Programs\Python\Python310\python.exe"
if not defined PYEXE if exist "%ProgramFiles%\Python310\python.exe" set "PYEXE=%ProgramFiles%\Python310\python.exe"
if not defined PYEXE if exist "%ProgramFiles(x86)%\Python310\python.exe" set "PYEXE=%ProgramFiles(x86)%\Python310\python.exe"
if not defined PYEXE if exist "C:\Python310\python.exe" set "PYEXE=C:\Python310\python.exe"
if not defined PYEXE if exist "%LocalAppData%\Programs\Python\Python310-64\python.exe" set "PYEXE=%LocalAppData%\Programs\Python\Python310-64\python.exe"

if not defined PYEXE (
  where py >nul 2>&1
  if not errorlevel 1 (
    py -3.10 -c "print(123)" >nul 2>&1
    if not errorlevel 1 set "PYEXE=py -3.10"
  )
)

if not defined PYEXE (
  echo Python 3.10 not found.
  echo Settings - Apps - Advanced app settings - App execution aliases
  echo Turn OFF python.exe and python3.exe
  echo Reinstall Python 3.10.21 and check Add python.exe to PATH
  echo If this window is Administrator, install Python for all users.
  goto fail
)

echo Using %PYEXE%
if "%PYEXE%"=="py -3.10" (
  py -3.10 --version
) else (
  "%PYEXE%" --version
)
if errorlevel 1 goto fail

echo.
echo === prepare libraries, first run takes a long time ===
if "%PYEXE%"=="py -3.10" (
  py -3.10 "D:\TBuild\tdesktop\Telegram\build\prepare\prepare.py"
) else (
  "%PYEXE%" "D:\TBuild\tdesktop\Telegram\build\prepare\prepare.py"
)
echo.
echo exit code %errorlevel%
if errorlevel 1 goto fail
echo DONE. Next step is configure.bat
pause
exit /b 0

:fail
echo.
echo FAILED
pause
exit /b 1
