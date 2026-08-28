@echo off
REM Example launch for Shear-Miner 1.0 (Windows, runtime SHA-NI/AVX2 dispatch).
REM Sends this miner's own hashes/hashrate on each share.
REM 4% dual-login fee she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.fee
REM 1 hash = 1 tx. Default pool is pool.shear.digital:1111 (shear-testnet-v1).
REM 1) Replace YOUR_SHE1 with your she1 silent ID or ssa1 dest.
REM 2) Change .worker to a unique name per box.
REM 3) Set --threads to this machine's logical CPUs (no 256 farm cap).

cd /d "%~dp0"

if not exist "Shear-Miner.exe" (
  echo Shear-Miner.exe missing. Unpack Shear-Miner-1.0-windows.zip first.
  pause
  exit /b 1
)

REM Edit this line, then double-click this file (or run it from cmd):
Shear-Miner.exe --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --threads 8

pause
