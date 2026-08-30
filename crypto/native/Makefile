NODE_INC ?= $(shell node -e "const fs=require('fs'); const p=process.config.variables.node_prefix||''; const cands=[p+'/include/node','/usr/local/include/node','/usr/include/node']; for (const d of cands) { if (fs.existsSync(d+'/node_api.h')) { process.stdout.write(d); process.exit(0);} } process.exit(1)")
RX := $(abspath ../randomx)
RXLIB := $(RX)/build/librandomx.a
MINER := $(abspath ../../sheark-miner)
CC ?= cc
CXX ?= c++
CFLAGS ?= -O2 -Wall -fPIC
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  LINKFLAGS := -bundle -undefined dynamic_lookup
else
  LINKFLAGS := -shared
endif

.PHONY: all clean

all: shearhash.node

shearhash.node: shearhash.c $(MINER)/src/shear_hash.c $(MINER)/src/sha512.c $(RXLIB)
	$(CXX) $(CFLAGS) $(LINKFLAGS) \
	  -I$(NODE_INC) -I$(MINER)/src -I$(RX)/src \
	  -o $@ shearhash.c $(MINER)/src/shear_hash.c $(MINER)/src/sha512.c $(RXLIB) \
	  -pthread

clean:
	rm -f shearhash.node
