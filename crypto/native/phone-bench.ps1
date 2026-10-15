# FS-1 spend prove/verify timing on a USB-attached Android phone, from Windows.
# Cross-compiles shear-fs1's fs1_spend_bench for arm64 with the NDK, pushes it
# to /data/local/tmp over adb, runs it, and saves the JSON lines locally.
#
#   powershell -ExecutionPolicy Bypass -File crypto\native\phone-bench.ps1
#   ... -Leaves 4096 -Runs 3 -Threads 0 -Inputs 1,2,5,8
#   ... -Binary C:\path\fs1_spend_bench   (skip the build)
#
# Needs: adb (platform-tools) on PATH, and for the build rustup/cargo plus the
# Android NDK (ANDROID_NDK_HOME, or the newest under ANDROID_HOME\ndk).
# The binary uses the same prove_spend/verify_spend as libshear_admit.so.
param(
  [int]$Leaves = 4096,
  [int]$Runs = 3,
  [int]$Threads = 0,
  [string]$Inputs = "1,2,5,8",
  [string]$Binary = "",
  [int]$Api = 29
)
$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Vendor = Join-Path $Here "vendor\monero-oxide-77788c3"
$Remote = "/data/local/tmp/fs1_spend_bench"
$Out = Join-Path $Here ("phone-bench-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".jsonl")

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
  throw "adb not found. Install Android platform-tools and add it to PATH."
}

if ($Binary -eq "") {
  $Ndk = $env:ANDROID_NDK_HOME
  if (-not $Ndk) { $Ndk = $env:ANDROID_NDK_ROOT }
  if (-not $Ndk) {
    $Sdk = $env:ANDROID_HOME
    if (-not $Sdk) { $Sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
    $NdkDir = Join-Path $Sdk "ndk"
    if (Test-Path $NdkDir) {
      $Ndk = (Get-ChildItem $NdkDir -Directory | Sort-Object Name | Select-Object -Last 1).FullName
    }
  }
  if (-not $Ndk -or -not (Test-Path $Ndk)) {
    throw "Set ANDROID_NDK_HOME (NDK r27d) or pass -Binary."
  }
  $Bin = Join-Path $Ndk "toolchains\llvm\prebuilt\windows-x86_64\bin"
  $Linker = Join-Path $Bin "aarch64-linux-android$Api-clang.cmd"
  if (-not (Test-Path $Linker)) { throw "Missing $Linker" }
  $env:CC_aarch64_linux_android = $Linker
  $env:AR_aarch64_linux_android = Join-Path $Bin "llvm-ar.exe"
  $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = $Linker
  & rustup target add aarch64-linux-android | Out-Null
  & cargo build --release --target aarch64-linux-android `
    --manifest-path (Join-Path $Vendor "Cargo.toml") -p shear-fs1 --features bench --bin fs1_spend_bench
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
  $Binary = Join-Path $Vendor "target\aarch64-linux-android\release\fs1_spend_bench"
}

$State = (& adb get-state 2>$null)
if ($State -ne "device") {
  throw "No authorized phone on adb (state: $State). Enable USB debugging and accept the prompt on the phone."
}

$Model = (& adb shell getprop ro.product.model).Trim()
$Soc = (& adb shell getprop ro.soc.model).Trim()
$Rel = (& adb shell getprop ro.build.version.release).Trim()
Write-Host "phone: $Model / $Soc / Android $Rel"

& adb push $Binary $Remote | Out-Null
if ($LASTEXITCODE -ne 0) { throw "adb push failed" }
& adb shell chmod 755 $Remote
& adb shell $Remote $Leaves $Runs $Threads $Inputs | ForEach-Object { $_.TrimEnd("`r") } | Tee-Object -FilePath $Out
& adb shell rm -f $Remote
Write-Host "saved $Out"
