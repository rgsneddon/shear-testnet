@echo off
REM ShearK-Miner 1.6 (ShearHash-v3 light) — Windows
REM Pool: pool.shear.digital:1111  (shear-testnet-v2)
REM
REM Paid login is an ssa1 dest the wallet exported (Copy dest), then .worker.
REM she1 without --dest is unpaid. Never use shear1.
REM
REM 1) Wallet: Copy dest. Paste it below as YOUR_SSA1.
REM 2) Change .worker to a unique name for this PC (e.g. .pc1).
REM 3) Set --threads to this machine's logical CPUs (echo %NUMBER_OF_PROCESSORS%).

cd /d "%~dp0"

if not exist "ShearK-Miner.exe" (
  echo ShearK-Miner.exe missing. Unpack ShearK-Miner-1.6-windows.zip first.
  pause
  exit /b 1
)

REM Edit this line, then double-click this file:
ShearK-Miner.exe --pool pool.shear.digital:1111 --user YOUR_SSA1.worker --backend jit --threads 8

REM she1 login is RAM-only and must also pass --dest (the same Copy dest):
REM ShearK-Miner.exe --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --dest YOUR_SSA1 --backend jit --threads 8

pause
