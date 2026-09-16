NODE_INC ?= $(shell node -e "const fs=require('fs'); const p=process.config.variables.node_prefix||''; const cands=[p+'/include/node','/usr/local/include/node','/usr/include/node']; for (const d of cands) { if (fs.existsSync(d+'/node_api.h')) { process.stdout.write(d); process.exit(0);} } process.exit(1)")
RX := $(abspath ../randomx)
RXLIB := $(RX)/build/librandomx.a
MINER := $(abspath ../../sheark-miner)
CC ?= cc
CFLAGS ?= -O2 -Wall -fPIC
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  LINKFLAGS := -bundle -undefined dynamic_lookup
else
  LINKFLAGS := -shared -Wl,-z,noexecstack
endif

ADMIT_DIR := $(abspath admit)
ifeq ($(UNAME_S),Darwin)
  ADMITLIB := $(ADMIT_DIR)/target/release/libshear_admit.a
  ADMITSYS := -lpthread
else
  ADMITLIB := $(ADMIT_DIR)/target/release/libshear_admit.a
  ADMITSYS := -lpthread -ldl -lm
endif

.PHONY: all clean admitlib

all: shearhash.node shearadmit.node

# C sources. Do not link with g++ — stdatomic.h is not C++ on this box.
shearhash.node: shearhash.c $(MINER)/src/shear_hash.c $(MINER)/src/sha512.c $(RXLIB)
	$(CC) $(CFLAGS) $(LINKFLAGS) \
	  -I$(NODE_INC) -I$(MINER)/src -I$(RX)/src \
	  -o $@ shearhash.c $(MINER)/src/shear_hash.c $(MINER)/src/sha512.c $(RXLIB) \
	  -pthread

admitlib:
	cargo build --release --manifest-path $(ADMIT_DIR)/Cargo.toml

shearadmit.node: admit_napi.c admitlib
	$(CC) $(CFLAGS) $(LINKFLAGS) \
	  -I$(NODE_INC) \
	  -o $@ admit_napi.c $(ADMITLIB) $(ADMITSYS)

clean:
	rm -f shearhash.node shearadmit.node
	cargo clean --manifest-path $(ADMIT_DIR)/Cargo.toml
