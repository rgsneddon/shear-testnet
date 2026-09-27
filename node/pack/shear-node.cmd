@echo off
setlocal
set "ROOT=%~dp0"
if exist "%ROOT%runtime\node.exe" (
  set "NODEBIN=%ROOT%runtime\node.exe"
) else (
  set "NODEBIN=node"
)
if not defined SHEAR_DATA set "SHEAR_DATA=%USERPROFILE%\.shear\testnet-v5"
if not defined SHEAR_NETWORK set "SHEAR_NETWORK=shear-testnet-v5"
if not defined SHEAR_SEEDS set "SHEAR_SEEDS=p2p.shear.digital:30303,r2r.shear.digital:30303,b2b.shear.digital:30303"
if not defined SHEAR_RPC_BIND set "SHEAR_RPC_BIND=127.0.0.1"
cd /d "%ROOT%"
"%NODEBIN%" "%ROOT%node\src\node.js" %*
endlocal
