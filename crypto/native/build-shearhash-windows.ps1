# Host libshearhash.dll for the Windows wallet bundle. Interpreter ShearHash-v3.
# Stamp the SHA-256 and pass --dart-define=SHEAR_HASH_SHA256=<hex> to flutter build.
# The dll is gitignored.
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $Here "..\..")
$Rx = Join-Path $Root "crypto\randomx"
$Miner = Join-Path $Root "sheark-miner\src"
$Out = Join-Path $Here "libshearhash.dll"
$Build = Join-Path $Rx "build-win"

cmake -S $Rx -B $Build -DCMAKE_BUILD_TYPE=Release -DARCH=default -DCMAKE_POSITION_INDEPENDENT_CODE=ON
cmake --build $Build --config Release
$Lib = Get-ChildItem -Path $Build -Recurse -Filter "randomx.lib" | Select-Object -First 1
if (-not $Lib) { $Lib = Get-ChildItem -Path $Build -Recurse -Filter "librandomx.lib" | Select-Object -First 1 }
if (-not $Lib) { throw "randomx.lib was not produced under $Build" }

$sources = @(
  (Join-Path $Here "shearhash_wallet.c"),
  (Join-Path $Miner "shear_hash.c"),
  (Join-Path $Miner "sha512.c"),
  (Join-Path $Miner "sha256.c")
)
cl /nologo /LD /O2 /DWIN32 `
  /I $Miner /I (Join-Path $Rx "src") `
  $sources `
  $Lib.FullName `
  /Fe:$Out /link /DLL
if (-not (Test-Path $Out)) { throw "missing $Out" }
python (Join-Path $Here "stamp_shearhash_pin.py") $Out
Write-Output "staged $Out"
