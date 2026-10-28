@echo off
REM ShearK-Miner 2.9 (ShearHash-v3 light) — Windows
REM Public pool: stratum+ssl://pool.shear.digital:443
REM This build is for shear-testnet-v12. The pool refuses ShearK older than 2.9.
REM YOUR_SSA1.worker is a placeholder. Keep each host's worker name and payout address.
REM Localhost solo stays cleartext: stratum+tcp://127.0.0.1:1111
REM
REM Paid login is an ssa1 dest the wallet exported (Copy dest), then .worker.
REM she1 without --dest is unpaid. Never use shear1.
REM
REM 1) Wallet: Copy dest. Paste it below as YOUR_SSA1.
REM 2) Change .worker to a unique name for this PC (e.g. .pc1).
REM 3) Threads: ShearK runs one per logical CPU (%NUMBER_OF_PROCESSORS%).
REM    Add --threads N only to leave CPUs free for other work.
REM 4) Keep the OpenSSL and libsodium DLLs from ShearK-Miner-2.9-windows.zip beside this exe.
REM 5) Wallet: turn on "This wallet mines", copy the Mining address, paste it as
REM    YOUR_MINING_ADDRESS. Each share then carries a fresh one-time key (BluNotes);
REM    without --blu the pool refuses every share (need_key).

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
ShearK-Miner.exe --pool stratum+ssl://pool.shear.digital:443 --user YOUR_SSA1.worker --blu YOUR_MINING_ADDRESS --backend jit-full

REM Solo on your own node (npm run solo), cleartext; --solo sends the mining address to your node only:
REM ShearK-Miner.exe --pool 127.0.0.1:1111 --user YOUR_SSA1.solo --blu YOUR_MINING_ADDRESS --solo --backend jit-full

REM she1 login is RAM-only and must also pass --dest (the same Copy dest):
REM ShearK-Miner.exe --pool stratum+ssl://pool.shear.digital:443 --user YOUR_SHE1.worker --dest YOUR_SSA1 --blu YOUR_MINING_ADDRESS --backend jit

pause
