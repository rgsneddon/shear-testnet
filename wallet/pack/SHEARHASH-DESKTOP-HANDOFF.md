# Desktop handoff: libshearhash on Apple

No Mac CI builds this library. Russell builds and signs it on the Desktop
the same way `libshear_admit.dylib` is signed. Linux, Windows, and Android
CI build their own copies. A phone timing run is also Russell's; the VM
bench in the PR is Linux only.

## Build

From the repo root, with Xcode's clang:

```sh
cmake -S crypto/randomx -B crypto/randomx/build \
  -DCMAKE_BUILD_TYPE=Release -DARCH=default \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON
cmake --build crypto/randomx/build -j
cc -dynamiclib -O2 -fPIC \
  -I sheark-miner/src -I crypto/randomx/src \
  -o crypto/native/libshearhash.dylib \
  crypto/native/shearhash_wallet.c \
  sheark-miner/src/shear_hash.c \
  sheark-miner/src/sha512.c \
  sheark-miner/src/sha256.c \
  crypto/randomx/build/librandomx.a \
  -lc++
python3 crypto/native/stamp_shearhash_pin.py --define crypto/native/libshearhash.dylib
```

The printed `--dart-define=SHEAR_HASH_SHA256=<hex>` is the pin. Pass it to
`flutter build macos`. An empty pin refuses the load.

## Bundle

Copy the signed dylib to:

`Shear Wallet.app/Contents/Frameworks/libshearhash.dylib`

The loader opens that path only. It does not read `SHEAR_HASH_LIB`, the
working directory, or a bare `libshearhash.dylib` name. Sign it with the
same Developer ID used for `libshear_admit.dylib` before stamping the pin,
so the hash is of the bytes you ship.

## What it is

ShearHash-v3, interpreter backend, for the 11-header median-time window.
Each header has its own 128 MiB key, so the wallet does not walk the whole
chain. If MemAvailable is under that cache plus the scratchpad, the hash is
skipped and the unlock clock stays off.
