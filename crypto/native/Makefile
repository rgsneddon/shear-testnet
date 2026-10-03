NODE_INC ?= $(shell node -e "const fs=require('fs'); const path=require('path'); const execDir=path.dirname(process.execPath); const prefix=process.config.variables.node_prefix||''; const cands=[prefix?path.join(prefix,'include','node'):'','/usr/local/include/node','/usr/include/node',path.join(execDir,'include','node'),path.join(execDir,'..','include','node')].filter(Boolean); for (const d of cands) { if (fs.existsSync(path.join(d,'node_api.h'))) { process.stdout.write(d.split(path.sep).join('/')); process.exit(0);} } process.exit(1)")
RX := $(abspath ../randomx)
RXLIB := $(RX)/build/librandomx.a
MINER := $(abspath ../../sheark-miner)
CC ?= cc
CFLAGS ?= -O2 -Wall -fPIC
UNAME_S := $(shell uname -s 2>/dev/null)
ifeq ($(OS),Windows_NT)
  # Command-line CC= still wins. Plain `cc` is not this MinGW gcc.
  CC := gcc
  # N-API lives in node.exe. dlltool builds an import lib; do not link node.lib.
  # This WinLibs build has no libstdc++.a. The shared runtime must be the
  # same MinGW that linked the addon: an earlier libgcc on PATH (Rust, Android
  # SDK) loads and then fails with "procedure could not be found" (error 127).
  LINKFLAGS := -shared
  NODE_IMPORT := win_node_import.a
  LIBSTDCXX := -pthread -lstdc++
  ADMITSYS := -lws2_32 -luserenv -lbcrypt -lntdll -pthread
else ifeq ($(UNAME_S),Darwin)
  LINKFLAGS := -bundle -undefined dynamic_lookup
  NODE_IMPORT :=
  LIBSTDCXX := -pthread -lstdc++
  ADMITSYS := -lpthread
else
  LINKFLAGS := -shared -Wl,-z,noexecstack
  NODE_IMPORT :=
  LIBSTDCXX := -pthread -lstdc++
  ADMITSYS := -lpthread -ldl -lm
endif

ADMIT_DIR := $(abspath admit)
ADMITLIB := $(ADMIT_DIR)/target/release/libshear_admit.a

.PHONY: all clean admitlib

all: shearhash.node shearadmit.node

# C sources. Do not compile with g++ — stdatomic.h is not C++ on this box.
# RandomX is C++, and Windows N-API symbols come from node.exe via the import lib.
shearhash.node: shearhash.c $(MINER)/src/shear_hash.c $(MINER)/src/sha512.c $(MINER)/src/sha256.c $(RXLIB) $(NODE_IMPORT)
	$(CC) $(CFLAGS) $(LINKFLAGS) \
	  -I$(NODE_INC) -I$(MINER)/src -I$(RX)/src \
	  -o $@ shearhash.c $(MINER)/src/shear_hash.c $(MINER)/src/sha512.c $(MINER)/src/sha256.c $(RXLIB) \
	  $(NODE_IMPORT) $(LIBSTDCXX)
ifeq ($(OS),Windows_NT)
	node copy-mingw-runtime.js $(CC)
endif

admitlib:
	cargo build --release --manifest-path $(ADMIT_DIR)/Cargo.toml

win_node_import.a: win_node_import.def
	dlltool -d $< -l $@ -D node.exe

shearadmit.node: admit_napi.c admitlib $(NODE_IMPORT)
	$(CC) $(CFLAGS) $(LINKFLAGS) \
	  -I$(NODE_INC) \
	  -o $@ admit_napi.c $(ADMITLIB) $(NODE_IMPORT) $(ADMITSYS)

clean:
	rm -f shearhash.node shearadmit.node win_node_import.a
	cargo clean --manifest-path $(ADMIT_DIR)/Cargo.toml
