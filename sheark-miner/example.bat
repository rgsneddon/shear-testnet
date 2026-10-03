@echo off
REM ShearK-Miner 2.8 (ShearHash-v3 light) — Windows
REM Public pool: stratum+ssl://pool.shear.digital:443  (shear-testnet-v4)
REM Live book is shear-testnet-v10. --print-config still reports magic shear-testnet-v4.
REM Localhost solo stays cleartext: stratum+tcp://127.0.0.1:1111
REM
REM Paid login is an ssa1 dest the wallet exported (Copy dest), then .worker.
REM she1 without --dest is unpaid. Never use shear1.
REM
REM 1) Wallet: Copy dest. Paste it below as YOUR_SSA1.
REM 2) Change .worker to a unique name for this PC (e.g. .pc1).
REM 3) Set --threads to this machine's logical CPUs (echo %NUMBER_OF_PROCESSORS%).
REM 4) Keep the OpenSSL DLLs from ShearK-Miner-2.8-windows.zip beside this exe.

cd /d "%~dp0"

if not exist "ShearK-Miner.exe" (
  echo ShearK-Miner.exe missing. Unpack ShearK-Miner-2.8-windows.zip first.
  pause
  exit /b 1
)
if not exist "libssl-3-x64.dll" (
  echo libssl-3-x64.dll missing. Unpack the full 2.8 zip. The exe alone will not start.
  pause
  exit /b 1
)
if not exist "libcrypto-3-x64.dll" (
  echo libcrypto-3-x64.dll missing. Unpack the full 2.8 zip. The exe alone will not start.
  pause
  exit /b 1
)

REM Edit this line, then double-click this file:
ShearK-Miner.exe --pool stratum+ssl://pool.shear.digital:443 --user YOUR_SSA1.worker --backend jit-full --threads 8

REM Local solo stays cleartext:
REM ShearK-Miner.exe --pool stratum+tcp://127.0.0.1:1111 --notls --user YOUR_SSA1.worker --backend jit-full --threads 8

REM she1 login is RAM-only and must also pass --dest (the same Copy dest):
REM ShearK-Miner.exe --pool stratum+ssl://pool.shear.digital:443 --user YOUR_SHE1.worker --dest YOUR_SSA1 --backend jit --threads 8

pause
