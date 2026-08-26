@echo off
REM Example launch for Shear miner 0.1.7 (Windows, runtime SHA-NI/AVX2 dispatch).
REM Sends this miner's own hashes/hashrate on each share.
REM 5% dual-login fee she1qlrll6hhdakpcrlygumhq5a2xqhcj49ys7j2lzj.fee
REM 1 hash = 1 tx. Default pool is pool.shear.digital:1111 (shear-testnet-v1).
REM 1) Replace YOUR_SHE1 with your she1 silent ID or shp1 dest.
REM 2) Change .worker to a unique name per box.
REM 3) Set --threads to this machine's logical CPUs (no 256 farm cap).

cd /d "%~dp0"

if not exist "shear-miner.exe" (
  echo shear-miner.exe missing. Unpack shear-miner-0.1.7-windows.zip first.
  pause
  exit /b 1
)

REM Edit this line, then double-click this file (or run it from cmd):
shear-miner.exe --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --threads 8

pause
