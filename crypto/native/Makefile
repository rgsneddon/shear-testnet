NODE_INC ?= $(shell node -e "const fs=require('fs'); const path=require('path'); const execDir=path.dirname(process.execPath); const prefix=process.config.variables.node_prefix||''; const cands=[prefix?path.join(prefix,'include','node'):'','/usr/local/include/node','/usr/include/node',path.join(execDir,'include','node'),path.join(execDir,'..','include','node')].filter(Boolean); for (const d of cands) { if (fs.existsSync(path.join(d,'node_api.h'))) { process.stdout.write(d.split(path.sep).join('/')); process.exit(0);} } process.exit(1)")
RX := $(abspath ../randomx)
RXLIB := $(RX)/build/librandomx.a
MINER := $(abspath ../../sheark-miner)
CC ?= cc
CFLAGS ?= -O2 -Wall -fPIC
# x86_64 public builds pin the ISA baseline, not the compiler's default, which
# can be higher (scripts/randomx_build.sh says why; scripts/isa_scan.py checks
# the addons). Build librandomx.a with that script too.
ifneq ($(filter x86_64 amd64 AMD64,$(shell uname -m 2>/dev/null)),)
  X86_BASELINE := -march=x86-64 -mtune=generic
endif
UNAME_S := $(shell uname -s 2>/dev/null)
ifeq ($(OS),Windows_NT)
  # Command-line CC= still wins. Plain `cc` is not this MinGW gcc.
  CC := gcc
  # N-API lives in node.exe. dlltool builds an import lib; do not link node.lib.
  # The GCC runtime and winpthreads are linked statically, so no
  # libgcc_s_seh-1.dll, libstdc++-6.dll or libwinpthread-1.dll ships (GPL
  # object code; see docs/licensing-audit.md decision 4). This needs a MinGW
  # with libstdc++.a and libwinpthread.a (MSYS2 UCRT64 has both). The gcc
  # driver ignores -static-libstdc++, hence -Bstatic around -lstdc++.
  # --whole-archive: the driver appends a dynamic -lpthread after our flags.
  LINKFLAGS := -shared
  NODE_IMPORT := win_node_import.a
  WIN_STATIC_RT := -static-libgcc -Wl,-Bstatic -lstdc++ -Wl,--whole-archive -lwinpthread -Wl,--no-whole-archive,-Bdynamic
  LIBSTDCXX := -pthread $(WIN_STATIC_RT)
  ADMITSYS := -lws2_32 -luserenv -lbcrypt -lntdll -pthread -static-libgcc -Wl,-Bstatic,--whole-archive -lwinpthread -Wl,--no-whole-archive,-Bdynamic
else ifeq ($(UNAME_S),Darwin)
  LINKFLAGS := -bundle -undefined dynamic_lookup
  NODE_IMPORT :=
  LIBSTDCXX := -pthread -lstdc++
  ADMITSYS := -lpthread
else
  # libgcc and libstdc++ are linked statically, so no pack ships
  # libstdc++.so.6 or libgcc_s.so.1 (docs/licensing-audit.md decision 4).
  # --exclude-libs hides the archived runtime inside the addon, so it never
  # binds to the libstdc++ that node itself loads. Fedora needs the
  # libstdc++-static package.
  LINKFLAGS := -shared -Wl,-z,noexecstack -Wl,--exclude-libs,ALL
  NODE_IMPORT :=
  LIBSTDCXX := -pthread -static-libgcc -Wl,-Bstatic -lstdc++ -Wl,-Bdynamic
  ADMITSYS := -lpthread -ldl -lm -static-libgcc
  GCC_RT_CHECK := python3 ../../scripts/licenses/release_notices.py no-gcc-runtime
endif

ADMIT_DIR := $(abspath admit)
# Node addon only. Wallet targets do not pass admit-v3.
ADMIT_FEATURES := --features admit-v3
ADMIT_TARGET := $(ADMIT_DIR)/target/node
ADMITLIB := $(ADMIT_TARGET)/release/libshear_admit.a

.PHONY: all clean admitlib ios-staticlib android-arm64

all: shearhash.node shearadmit.node

# C sources. Do not compile with g++ — stdatomic.h is not C++ on this box.
# RandomX is C++, and Windows N-API symbols come from node.exe via the import lib.
shearhash.node: shearhash.c $(MINER)/src/shear_hash.c $(MINER)/src/sha512.c $(MINER)/src/sha256.c $(RXLIB) $(NODE_IMPORT)
	$(CC) $(X86_BASELINE) $(CFLAGS) $(LINKFLAGS) \
	  -I$(NODE_INC) -I$(MINER)/src -I$(RX)/src \
	  -o $@ shearhash.c $(MINER)/src/shear_hash.c $(MINER)/src/sha512.c $(MINER)/src/sha256.c $(RXLIB) \
	  $(NODE_IMPORT) $(LIBSTDCXX)
ifeq ($(OS),Windows_NT)
	python ../../scripts/licenses/release_notices.py no-mingw-runtime $@
endif
ifdef GCC_RT_CHECK
	$(GCC_RT_CHECK) $@
endif

admitlib:
	cargo build --release $(ADMIT_FEATURES) --target-dir $(ADMIT_TARGET) --manifest-path $(ADMIT_DIR)/Cargo.toml

# iOS wallet staticlib. No codesign. admit-v3 stays off.
ios-staticlib:
	cargo rustc --release --target aarch64-apple-ios --crate-type staticlib --manifest-path $(ADMIT_DIR)/Cargo.toml

# Android arm64-v8a cdylib into the Flutter jniLibs tree.
android-arm64:
	bash $(abspath build-android-arm64.sh)

win_node_import.a: win_node_import.def
	dlltool -d $< -l $@ -D node.exe

shearadmit.node: admit_napi.c admitlib $(NODE_IMPORT)
	$(CC) $(X86_BASELINE) $(CFLAGS) $(LINKFLAGS) \
	  -I$(NODE_INC) \
	  -o $@ admit_napi.c $(ADMITLIB) $(NODE_IMPORT) $(ADMITSYS)
ifeq ($(OS),Windows_NT)
	python ../../scripts/licenses/release_notices.py no-mingw-runtime $@
endif
ifdef GCC_RT_CHECK
	$(GCC_RT_CHECK) $@
endif

clean:
	rm -f shearhash.node shearadmit.node win_node_import.a
	cargo clean --manifest-path $(ADMIT_DIR)/Cargo.toml
