# v12 Windows and Android builds

Build log for the feat tip. Checkout `8735e620ab7fa56c1a0a55061eb487e292471043` (`Record the PR 68 review. 018e stays open.`). The brief named `690d35a7`; that commit is an ancestor of this tip. Ubuntu, Debian, Fedora, and openSUSE packs were not rebuilt. Nothing was installed on the soak hosts. No SSH. No `0.72`, `v19`, or ShearK tag. No genesis cut.

This VM is Linux x86_64. Windows node and miner binaries were cross-compiled with MinGW. The Windows wallet was not produced. The Android wallet debug APK was produced. The Android release APK was not.

Phones are wallet-only at launch. Russell waiver 2026-10-13. This tree has no Android node target and no Android miner target. There is no `android` project under `node/`, `miner/`, or `sheark-miner/`. The only Android project is `wallet/android`. No Android node or miner was built, and none was added.

## Toolchain on this VM

| Piece | What ran |
| --- | --- |
| MinGW | `x86_64-w64-mingw32-gcc` 13-posix, `dlltool`, `objdump` |
| OpenSSL | 3.5.4, `./Configure mingw64 --cross-compile-prefix=x86_64-w64-mingw32-`, shared. DLLs `libssl-3-x64.dll` and `libcrypto-3-x64.dll` |
| Rust | rustc 1.99.0 (`b940084d7`, 2026-09-28), target `x86_64-pc-windows-gnu` |
| Node headers and `npm ci` | Node.js 22.23.3 linux from nvm |
| Windows `node.exe` | Official `node-v22.23.3-win-x64.zip` from nodejs.org, file `node.exe` |
| Flutter | 3.47.7, Dart 3.13.5 |
| Android SDK | platform `android-36`, build-tools `36.0.0`, NDK `28.2.13676358`. The debug build also installed CMake 3.22.1 into that SDK |
| JDK | OpenJDK 21.0.12.1 |
| RandomX | `-DARCH=default`, `CMAKE_SYSTEM_NAME=Windows` |

`/opt/mingw-bin` held `gcc`, `g++`, `dlltool`, `as`, and `objdump` as the MinGW tools, plus `libgcc_s_seh-1.dll`, `libstdc++-6.dll`, and `libwinpthread-1.dll`. `dlltool` needs the MinGW `as` on `PATH`. The Linux assembler rejects `BFD_RELOC_RVA`.

Wine 9 (`/usr/lib/wine/wine64`) was used only on this VM to execute the PE files after they were built. It was not installed on a soak host.

## Windows node

Artifact: `dist/shear-node-v19-windows.zip`

- 49118485 bytes
- sha256 `e5022919f402416368c61b761e6b4b6c86626c711d9e35c0fb69c6eb2683be2f`
- 2536 members
- `runtime/node.exe`, `crypto/native/shearhash.node`, and `crypto/native/shearadmit.node` each start with `4d5a`
- Pin inside the packer line: `19.0`, flavor `windows`

`runtime/node.exe` is the official Node.js 22.23.3 win-x64 binary (86973768 bytes, sha256 `9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e`). This host's `node` is an ELF, so the packer will not invent a Windows runtime. The exe was copied into `runtime/` before packing. `runtime/` is untracked and is not in this commit.

RandomX, the Windows staticlib, and the two addons were built first. Then:

```bash
export PATH="/opt/mingw-bin:/home/ubuntu/.nvm/versions/node/v22.23.3/bin:$PATH"
python3 node/pack/zip_node.py windows
```

Packer output:

```text
wrote /workspace/dist/shear-node-v19-windows.zip bytes 49118485
ok shear-node-v19-windows.zip pin 19.0 flavor windows modules 2536
```

`node/pack/zip_node.py` skips `*.node` while walking the tree when the host is not Windows and the flavor is `windows`. `write_missing_required` then adds required paths that exist on disk, including `crypto/native/shearhash.node`. The files on disk were the MinGW DLLs below, and those are the bytes in the zip.

Under wine, `runtime/node.exe --version` printed `v22.23.3`. Loading the addons with that exe printed:

```text
shearhash object hash,key,backend
shearadmit object noteH,maxProof,arity,leaf,jroot,jrootPoint,frontierAppend,proveV3,verifyV3,proveRange,verifyRange
```

That is the export list after the ADMITv2 removal (PR 65). The v2 `prove`, `verify`, `verifyBatch`, and `bench` exports are gone, and `maxProof()` still returns 32768. The zip in this log was built before that removal, so its `shearadmit.node` still had `prove` and `verify`. Rebuild the addon from a tree that includes the removal before packing again.

### shearhash.node

Artifact inside the zip: `crypto/native/shearhash.node` (669570 bytes, sha256 `0659140c473c43ad80efb33334db5d53961dc0621ffc170ea124a2e02d271142`). PE32+ DLL, x86-64.

RandomX:

```bash
cmake -S crypto/randomx -B crypto/randomx/build \
  -G "Unix Makefiles" \
  -DCMAKE_SYSTEM_NAME=Windows \
  -DCMAKE_SYSTEM_PROCESSOR=x86_64 \
  -DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc \
  -DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-g++ \
  -DCMAKE_RC_COMPILER=x86_64-w64-mingw32-windres \
  -DCMAKE_BUILD_TYPE=Release \
  -DARCH=default
cmake --build crypto/randomx/build -j"$(nproc)"
```

`librandomx.a` members are `pe-x86-64`. The archive was left in place so the miner and addon makefiles did not reconfigure it with the Linux compiler.

Addon:

```bash
export PATH="/opt/mingw-bin:/home/ubuntu/.nvm/versions/node/v22.23.3/bin:$PATH"
make -C crypto/native shearhash.node \
  OS=Windows_NT \
  CC=/opt/mingw-bin/gcc \
  NODE_INC=/home/ubuntu/.nvm/versions/node/v22.23.3/include/node
```

```text
/opt/mingw-bin/gcc -O2 -Wall -fPIC -shared \
  -I/home/ubuntu/.nvm/versions/node/v22.23.3/include/node -I/workspace/sheark-miner/src -I/workspace/crypto/randomx/src \
  -o shearhash.node shearhash.c /workspace/sheark-miner/src/shear_hash.c /workspace/sheark-miner/src/sha512.c /workspace/sheark-miner/src/sha256.c /workspace/crypto/randomx/build/librandomx.a \
  win_node_import.a -pthread -lstdc++
node copy-mingw-runtime.js /opt/mingw-bin/gcc
copy-mingw-runtime: libstdc++-6.dll libgcc_s_seh-1.dll libwinpthread-1.dll from /opt/mingw-bin
```

`win_node_import.a` came from `dlltool -d win_node_import.def -l win_node_import.a -D node.exe` with MinGW `as` on `PATH`.

### shearadmit.node

Artifact inside the zip: `crypto/native/shearadmit.node` (6796527 bytes, sha256 `69e87f249bab245a4848ffddca5ee8ae340e9bb83f7b9db25813fdc7f0b29db2`). PE32+ DLL, x86-64.

`make shearadmit.node` was not used. Its `admitlib` recipe is phony and runs host `cargo build`, which writes a Linux archive at `target/release/libshear_admit.a`. The Windows archive was built directly:

```bash
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_AR=x86_64-w64-mingw32-ar
export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc
export CXX_x86_64_pc_windows_gnu=x86_64-w64-mingw32-g++
export AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar
export CARGO_BUILD_JOBS=2
cargo build --release --locked --target x86_64-pc-windows-gnu \
  --manifest-path crypto/native/admit/Cargo.toml
```

```text
Finished `release` profile [optimized] target(s) in 16.38s
```

Exit 0. `crypto/native/admit/target/x86_64-pc-windows-gnu/release/libshear_admit.a` is a COFF archive (22 MiB). Link, same flags as the makefile recipe, pointed at that archive:

```bash
/opt/mingw-bin/gcc -O2 -Wall -fPIC -shared \
  -I/home/ubuntu/.nvm/versions/node/v22.23.3/include/node \
  -o shearadmit.node admit_napi.c \
  admit/target/x86_64-pc-windows-gnu/release/libshear_admit.a \
  win_node_import.a \
  -lws2_32 -luserenv -lbcrypt -lntdll -pthread
```

Exit 0. No undefined symbols.

## Windows miner

Artifact: `dist/ShearK-Miner-2.9-windows.zip`

- 3539786 bytes
- sha256 `38f40cb5538422973ac0bf50c2b82d46eaaaac387eab6388e1a146e843cb7d80`
- `ShearK-Miner.exe` inside the zip is 267345 bytes, sha256 `7cc543663159f8ff5e817d3a6d1d9a44863aa7509dd7ac1daeb105f6efd5c881`, PE32+ console x86-64, starts with `4d5a`

Members: `ShearK-Miner.exe`, `example.bat`, `example.sh`, `libwinpthread-1.dll`, `libgcc_s_seh-1.dll`, `libstdc++-6.dll`, `libcrypto-3-x64.dll`, `libssl-3-x64.dll`, `README.txt`.

Link (RandomX archive already the MinGW build above):

```bash
export PATH="/opt/mingw-bin:$PATH"
export OS=Windows_NT
export OPENSSL_BIN=/opt/mingw-openssl/bin
export OPENSSL_INC=/opt/mingw-openssl/include
make -C sheark-miner \
  OS=Windows_NT \
  CC=/opt/mingw-bin/gcc \
  CXX=/opt/mingw-bin/g++ \
  OPENSSL_INC=/opt/mingw-openssl/include \
  OPENSSL_BIN=/opt/mingw-openssl/bin \
  -j4
```

The link line:

```text
/opt/mingw-bin/g++ -O3 -Wall -Wextra -std=c11 -fomit-frame-pointer -I/opt/mingw-openssl/include -o ShearK-Miner.exe src/sheark_miner.o src/shear_hash.o src/sha256.o src/sha512.o src/stratum_tls.o /workspace/crypto/randomx/build/librandomx.a /opt/mingw-openssl/bin/libssl-3-x64.dll /opt/mingw-openssl/bin/libcrypto-3-x64.dll -lws2_32 -lcrypt32 -pthread
```

That `make` then ran `python pack/zip_windows.py --stage` and exited 127: `python: No such file or directory`. This VM has `python3`. The exe was already linked. Debug sections were stripped from the exe and the runtime DLLs, and the zip was written with:

```bash
export PATH="/opt/mingw-bin:$PATH"
export OPENSSL_BIN=/opt/mingw-openssl/bin
python3 sheark-miner/pack/zip_windows.py
```

```text
wrote /workspace/dist/ShearK-Miner-2.9-windows.zip members ShearK-Miner.exe example.bat example.sh libwinpthread-1.dll libgcc_s_seh-1.dll libstdc++-6.dll libcrypto-3-x64.dll libssl-3-x64.dll README.txt
```

Under wine, from `sheark-miner/` with those DLLs beside the exe:

```text
selftest ok 98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b backend=jit-full
```

`--print-config` printed `"version":"2.9"` and `"magic":"shear-testnet-v12"`. Wine also printed `huge pages unavailable, using 4K pages` and, on the first prefix init, `failed to open rundll32.exe`. The self-test exit code was 0.

## Windows wallet

No Windows wallet artifact. Two commands were run. Both refused this Linux host.

GUI, from `wallet/`, Flutter 3.47.7:

```bash
flutter build windows --release --build-name=0.72.0 --build-number=97
```

Exit 1. Last line:

```text
"build windows" only supported on Windows hosts.
```

CLI:

```bash
dart compile exe --target-os windows --target-arch x64 \
  -o dist/shear-0.72-windows.exe bin/shear.dart
```

```text
Unsupported target platform windows_x64.
Supported target platforms: linux_arm, linux_arm64, linux_riscv64, linux_x64
```

Dart is 3.13.5. `--help` lists `windows` as a `--target-os` name. This SDK build does not contain a `windows_x64` AOT target. There is no Visual Studio and no Windows SDK on this VM. Flutter will not start a Windows desktop build here, so `wallet/pack/zip_windows.py` was not run. No `shear_wallet.exe` and no `shear-wallet-0.72-windows.zip`.

## Android wallet

Russell waiver 2026-10-13. Phones are wallet-only. No Android node. No Android miner.

Release, from `wallet/`:

```bash
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
flutter build apk --release --build-name=0.72.0 --build-number=97
```

`wallet/android/key.properties` is not in the tree. Gradle failed before an APK existed:

```text
Missing wallet/android/key.properties. Release assemble refuses the debug cert. Provide storePassword, keyPassword, keyAlias=continuum, and storeFile for the Continuum release keystore.
BUILD FAILED in 1m 36s
Gradle task assembleRelease failed with exit code 1
```

Exit 1. No release APK. The Continuum keystore was not created here.

Debug, same version flags:

```bash
flutter build apk --debug --build-name=0.72.0 --build-number=97
```

```text
✓ Built build/app/outputs/flutter-apk/app-debug.apk
```

Exit 0.

Artifact: `wallet/build/app/outputs/flutter-apk/app-debug.apk`

- 186808910 bytes
- sha256 `6c1a33d196e3f1fa0791f6a4cd17e601d0a171ffac5c5932e697d064e424bd30`
- `aapt dump badging`: `package: name='com.shear.shear_wallet' versionCode='97' versionName='0.72.0'`, `compileSdkVersion='36'`, `native-code: 'arm64-v8a' 'armeabi-v7a' 'x86_64'`, label `Shear 0.72`
- Signer DN `C=US, O=Android, CN=Android Debug`, certificate SHA-256 `686f70155278e2ff0263e11e4fda1a37edc757d72f5094e5152fd24cd59c1aa4`

This is a debug-signed fat APK from `wallet/android`. It is not the Continuum release APK. It was not installed on a device. `wallet/build/` is gitignored.

## Windows test box setup

A clean Windows Server clone with Node 22 and git, and without Rust or MSVC, fails the pool suite on a missing `crypto/native/shearhash.node`. Range proofs are not a third addon. `proveRange` and `verifyRange` are exports of `crypto/native/shearadmit.node`, the same addon as admit. Both files are gitignored. Build them on that machine. These steps were not run on the Linux VM above.

`crypto/native/Makefile` on Windows calls `gcc` and `dlltool`, then links `libshear_admit.a`. It does not call `cl.exe`. An MSVC staticlib (`shear_admit.lib` from `x86_64-pc-windows-msvc`) will not satisfy that link. rustup is therefore installed as `x86_64-pc-windows-gnu`. VS Build Tools is installed because this box has no MSVC yet. The addon compile still uses the MSYS2 gcc at `C:\msys64\mingw64\bin`, which is the MinGW this tree already points at (`C:/msys64/mingw64` in the ShearK makefile). Put that directory first on `PATH`. An earlier `libgcc` (the one rustup ships) loads and then fails with "The specified procedure could not be found" (error 127). Do not put `C:\msys64\usr\bin` on `PATH`. CMake's MinGW Makefiles generator refuses to run when that `sh.exe` is visible.

Run the block in an elevated PowerShell. `$Repo` is the clone. Stable rustc is required. 1.83 cannot build zeroize 1.9 (edition 2024).

```powershell
$ErrorActionPreference = 'Stop'
$Repo = 'C:\path\to\shear-testnet'
Set-Location $Repo

# Visual Studio 2022 Build Tools, silent. 0 is success. 3010 means success and a reboot is required.
# A rerun after that reboot skips this step.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$hasMsvc = $false
if (Test-Path $vswhere) {
  $found = & $vswhere -products Microsoft.VisualStudio.Product.BuildTools -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($found) { $hasMsvc = $true }
}
if (-not $hasMsvc) {
  $vs = Join-Path $env:TEMP 'vs_BuildTools.exe'
  Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile $vs
  $vsProc = Start-Process -FilePath $vs -Wait -PassThru -ArgumentList @(
    '--quiet', '--wait', '--norestart', '--nocache',
    '--add', 'Microsoft.VisualStudio.Workload.VCTools',
    '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '--includeRecommended'
  )
  if ($vsProc.ExitCode -eq 3010) {
    Write-Host 'VS Build Tools installed. Reboot, then run this script again.'
    exit 3010
  }
  if ($vsProc.ExitCode -ne 0) { throw "vs_BuildTools.exe exited $($vsProc.ExitCode)" }
}

# rustup, silent. Host is gnu so cargo writes libshear_admit.a.
$rustup = Join-Path $env:TEMP 'rustup-init.exe'
Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile $rustup
& $rustup -y --default-toolchain stable --default-host x86_64-pc-windows-gnu --profile minimal
if ($LASTEXITCODE -ne 0) { throw "rustup-init exited $LASTEXITCODE" }

# MSYS2 at C:\msys64. gcc, dlltool, mingw32-make, cmake.
if (-not (Test-Path 'C:\msys64\usr\bin\bash.exe')) {
  $msys = Join-Path $env:TEMP 'msys2-x86_64-latest.exe'
  Invoke-WebRequest -Uri 'https://github.com/msys2/msys2-installer/releases/download/nightly-x86_64/msys2-x86_64-latest.exe' -OutFile $msys
  $msysProc = Start-Process -FilePath $msys -Wait -PassThru -ArgumentList @(
    'in', '--confirm-command', '--accept-messages', '--root', 'C:/msys64'
  )
  if ($msysProc.ExitCode -ne 0) { throw "msys2 installer exited $($msysProc.ExitCode)" }
}
if (-not (Test-Path 'C:\msys64\mingw64\bin\gcc.exe')) {
  $bash = 'C:\msys64\usr\bin\bash.exe'
  & $bash -lc 'pacman -Syu --noconfirm'
  & $bash -lc 'pacman -Syu --noconfirm'
  & $bash -lc 'pacman -S --noconfirm --needed mingw-w64-x86_64-gcc mingw-w64-x86_64-binutils mingw-w64-x86_64-make mingw-w64-x86_64-cmake'
  if ($LASTEXITCODE -ne 0) { throw "pacman exited $LASTEXITCODE" }
}

$env:Path = "C:\msys64\mingw64\bin;$env:USERPROFILE\.cargo\bin;" + $env:Path
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = 'C:\msys64\mingw64\bin\gcc.exe'
$gcc = (where.exe gcc | Select-Object -First 1).Trim()
if ($gcc -ne 'C:\msys64\mingw64\bin\gcc.exe') { throw "gcc is $gcc, want C:\msys64\mingw64\bin\gcc.exe" }
rustc -vV
if ($LASTEXITCODE -ne 0) { throw 'rustc missing' }

# Node 22 headers. The makefile looks beside node.exe. If the installer omitted them, take include\node from the official win-x64 zip of this same version.
$nodeInc = & node -e "const fs=require('fs');const path=require('path');const d=path.join(path.dirname(process.execPath),'include','node');process.stdout.write(fs.existsSync(path.join(d,'node_api.h'))?d:'')"
if (-not $nodeInc) {
  $ver = (& node -p 'process.version').Trim()
  $zip = Join-Path $env:TEMP "node-$ver-win-x64.zip"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip
  $stage = Join-Path $env:TEMP "node-$ver-win-x64"
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  Expand-Archive -Path $zip -DestinationPath $env:TEMP
  $nodeInc = Join-Path $stage 'include\node'
  if (-not (Test-Path (Join-Path $nodeInc 'node_api.h'))) { throw "no node_api.h in $nodeInc" }
}

if (-not (Test-Path (Join-Path $Repo 'node_modules'))) { npm ci --ignore-scripts }

# RandomX static lib. ARCH=default, not -march=native. MinGW Makefiles, so the archive is librandomx.a.
cmake -S crypto\randomx -B crypto\randomx\build -G 'MinGW Makefiles' -DCMAKE_BUILD_TYPE=Release -DARCH=default
if ($LASTEXITCODE -ne 0) { throw "cmake configure exited $LASTEXITCODE" }
cmake --build crypto\randomx\build -j
if ($LASTEXITCODE -ne 0) { throw "randomx build exited $LASTEXITCODE" }

# shearhash.node and shearadmit.node (admit and range proofs).
mingw32-make -C crypto\native "NODE_INC=$nodeInc"
if ($LASTEXITCODE -ne 0) { throw "mingw32-make exited $LASTEXITCODE" }

node -e "const h=require('./crypto/native/shearhash.node'); const a=require('./crypto/native/shearadmit.node'); if (typeof h.hash!=='function') throw new Error('shearhash.node has no hash'); if (typeof a.proveV3!=='function') throw new Error('shearadmit.node has no proveV3'); if (typeof a.verifyV3!=='function') throw new Error('shearadmit.node has no verifyV3'); if (typeof a.proveRange!=='function') throw new Error('shearadmit.node has no proveRange'); console.log('addons ok');"

# Node 22's default --test globs do not match tests\test_*.js (the directory is tests, not test).
Set-Location (Join-Path $Repo 'pool')
node --test "tests/test_*.js"
```

`where.exe gcc` must print `C:\msys64\mingw64\bin\gcc.exe` first. `rustc -vV` must show `host: x86_64-pc-windows-gnu`. `addons ok` is the load check for hash, the v3 admit prove and verify, and range proof. The addon no longer exports the v2 `prove`, so the check does not ask for it. A bare `node --test` with no glob, run in `pool\`, reports tests 0 on Node 22. `node --test "tests/test_*.js"` from `pool\` is the suite.
