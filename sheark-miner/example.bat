@echo off
REM Example launch for ShearK-Miner 1.0 (ShearHash-v2 light, Windows).
REM 1 hash = 1 tx. Default pool is pool.shear.digital:1111 (shear-testnet-v2).
REM 1) Replace YOUR_SHE1 with your she1 silent ID or ssa1 dest.
REM 2) Change .worker to a unique name per box.
REM 3) Set --threads to this machine's logical CPUs.

cd /d "%~dp0"

if not exist "ShearK-Miner.exe" (
  echo ShearK-Miner.exe missing. Unpack ShearK-Miner-1.0-windows.zip first.
  pause
  exit /b 1
)

REM Edit this line, then double-click this file (or run it from cmd):
ShearK-Miner.exe --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --threads 8

pause
