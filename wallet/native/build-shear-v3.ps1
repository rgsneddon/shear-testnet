# Windows shear_v3.dll. shear_hash.c uses pthread, so this is MinGW, and
# libgcc, libstdc++, and winpthread are linked statically. The Flutter
# release zip must not contain those runtime DLLs.
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $Here '..\..')).Path
$Miner = Join-Path $Root 'sheark-miner\src'
$Rx = Join-Path $Root 'crypto\randomx'
$Build = Join-Path $Rx 'build-win'
$Out = Join-Path $Here 'shear_v3.dll'

function Find-MingwGcc {
  $candidates = @(
    $env:SHEAR_MINGW_GCC,
    'C:\msys64\mingw64\bin\gcc.exe',
    'C:\tools\msys64\mingw64\bin\gcc.exe'
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  $cmd = Get-Command gcc -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$Gcc = Find-MingwGcc
if (-not $Gcc) {
  Write-Error 'MinGW gcc was not found. Install mingw-w64 (MSYS2 mingw64) and re-run. shear_v3.dll was not built.'
}
$Bin = Split-Path -Parent $Gcc
$Gxx = Join-Path $Bin 'g++.exe'
$env:PATH = "$Bin;$env:PATH"
$env:CC = $Gcc
$env:CXX = $Gxx

$RxLib = Join-Path $Build 'librandomx.a'
if (-not (Test-Path $RxLib)) {
  & cmake -S $Rx -B $Build -G 'MinGW Makefiles' -DARCH=default -DCMAKE_BUILD_TYPE=Release
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & cmake --build $Build --target randomx -j
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path $RxLib)) {
  Write-Error "librandomx.a missing under $Build"
}

if (-not (Test-Path $Gxx)) {
  Write-Error "MinGW g++ was not found beside $Gcc. shear_v3.dll was not built."
}
$Obj = Join-Path $Here 'build\win'
New-Item -ItemType Directory -Force -Path $Obj | Out-Null
$Inc = @('-I', $Miner, '-I', (Join-Path $Rx 'src'))
function Compile-C([string]$Src, [string]$Name) {
  & $Gcc -O2 -Wall @Inc -c -o (Join-Path $Obj $Name) $Src
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Compile-C (Join-Path $Here 'shear_v3_export.c') 'shear_v3_export.o'
Compile-C (Join-Path $Miner 'shear_hash.c') 'shear_hash.o'
Compile-C (Join-Path $Miner 'sha512.c') 'sha512.o'
Compile-C (Join-Path $Miner 'sha256.c') 'sha256.o'
# C sources stay C. g++ only links, so libstdc++ and winpthread stay static.
& $Gxx -shared -O2 -static -static-libgcc -static-libstdc++ `
  -o $Out `
  (Join-Path $Obj 'shear_v3_export.o') `
  (Join-Path $Obj 'shear_hash.o') `
  (Join-Path $Obj 'sha512.o') `
  (Join-Path $Obj 'sha256.o') `
  $RxLib `
  -Wl,-Bstatic -lpthread -Wl,-Bdynamic
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "built $Out"
