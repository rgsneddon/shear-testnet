NODE_INC ?= $(shell node -p "require('path').join(process.config.variables.node_prefix, 'include/node')")
RX := $(abspath ../randomx)
RXLIB := $(RX)/build/librandomx.a
MINER := $(abspath ../../sheark-miner)
CC ?= cc
CXX ?= c++
CFLAGS ?= -O2 -Wall -fPIC

.PHONY: all clean

all: shearhash.node

shearhash.node: shearhash.c $(MINER)/src/shear_hash.c $(MINER)/src/sha512.c $(RXLIB)
	$(CXX) $(CFLAGS) -bundle -undefined dynamic_lookup \
	  -I$(NODE_INC) -I$(MINER)/src -I$(RX)/src \
	  -o $@ shearhash.c $(MINER)/src/shear_hash.c $(MINER)/src/sha512.c $(RXLIB) \
	  -pthread

clean:
	rm -f shearhash.node
