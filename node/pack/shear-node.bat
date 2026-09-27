@echo off
setlocal EnableExtensions
title SHEAR-NODEv6
cd /d "%~dp0" || (
  echo Could not enter "%~dp0"
  goto :hold
)

set "ROOT=%~dp0"
if exist "%ROOT%node\src\node.js" goto :have_script
if exist "%ROOT%..\..\node\src\node.js" (
  for %%I in ("%ROOT%..\..") do set "ROOT=%%~fI\"
  cd /d "%ROOT%" || (
    echo Could not enter repo root
    goto :hold
  )
)
:have_script
set "SCRIPT=%ROOT%node\src\node.js"
if not exist "%SCRIPT%" (
  echo Missing %SCRIPT%
  echo Unzip the whole shear-node zip, then double-click shear-node.bat in that folder.
  goto :hold
)

set "NODEBIN="
if exist "%ROOT%runtime\node.exe" set "NODEBIN=%ROOT%runtime\node.exe"
if not defined NODEBIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODEBIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODEBIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODEBIN=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODEBIN (
  where node >nul 2>&1
  if not errorlevel 1 for /f "delims=" %%I in ('where node 2^>nul') do (
    set "NODEBIN=%%I"
    goto :gotnode
  )
)
:gotnode
if not defined NODEBIN (
  echo Node.js was not found.
  echo Install Node 20+ from https://nodejs.org or keep runtime\node.exe next to this file.
  goto :hold
)

if not defined SHEAR_DATA set "SHEAR_DATA=%APPDATA%\Shear\testnet-v5"
if not defined SHEAR_NETWORK set "SHEAR_NETWORK=shear-testnet-v5"
if not defined SHEAR_SEEDS set "SHEAR_SEEDS=p2p.shear.digital:30303,r2r.shear.digital:30303,b2b.shear.digital:30303"
if not defined SHEAR_RPC_BIND set "SHEAR_RPC_BIND=127.0.0.1"

echo Starting SHEAR-NODEv6
echo Data   %SHEAR_DATA%
echo Using  %NODEBIN%
echo Script %SCRIPT%
echo.
"%NODEBIN%" "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"
echo.
echo Shear node stopped. Exit code %RC%
goto :hold_rc

:hold
set "RC=1"
:hold_rc
if /i "%SHEAR_NODE_NOPAUSE%"=="1" goto :done
echo.
pause
:done
endlocal & exit /b %RC%
