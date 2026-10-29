@echo off
REM ShearK-Miner 2.9 (ShearHash-v3 light) — Windows
REM Public pool: stratum+ssl://pool.shear.digital:443
REM This build is for shear-testnet-v12. The pool refuses ShearK older than 2.9.
REM Localhost solo stays cleartext: 127.0.0.1:1111
REM
REM R28 BluNotes: the pool never learns who you are.
REM 1) Wallet: turn on "This wallet mines" and copy the Mining address (shm1...).
REM    Paste it below as YOUR_MINING_ADDRESS. It stays on this PC; every
REM    share carries a fresh one-time key, and only your wallet finds its pay.
REM 2) Set --user to a worker name for this PC (e.g. pc1). Never an address:
REM    ShearK refuses one there, because it would be sent to the pool.
REM 3) Set --threads to this machine's logical CPUs (echo %NUMBER_OF_PROCESSORS%).
REM 4) Keep the OpenSSL and libsodium DLLs from ShearK-Miner-2.9-windows.zip beside this exe.

cd /d "%~dp0"

if not exist "ShearK-Miner.exe" (
  echo ShearK-Miner.exe missing. Unpack ShearK-Miner-2.9-windows.zip first.
  pause
  exit /b 1
)
if not exist "libssl-3-x64.dll" (
  echo libssl-3-x64.dll missing. Unpack the full 2.9 zip. The exe alone will not start.
  pause
  exit /b 1
)
if not exist "libcrypto-3-x64.dll" (
  echo libcrypto-3-x64.dll missing. Unpack the full 2.9 zip. The exe alone will not start.
  pause
  exit /b 1
)
if not exist "libsodium-26.dll" (
  echo libsodium-26.dll missing. Unpack the full 2.9 zip. The exe alone will not start.
  pause
  exit /b 1
)

REM Edit this line, then double-click this file:
ShearK-Miner.exe --pool stratum+ssl://pool.shear.digital:443 --user pc1 --blu YOUR_MINING_ADDRESS --backend jit-full --threads 8

REM Solo on your own node (npm run solo), cleartext; --solo sends the mining address to your node only:
REM ShearK-Miner.exe --pool 127.0.0.1:1111 --user pc1 --blu YOUR_MINING_ADDRESS --solo --backend jit-full --threads 8

pause
