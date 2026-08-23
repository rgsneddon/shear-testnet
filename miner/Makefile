VERSION ?= 0.1.0
CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=c11
OPENSSL_PREFIX ?= $(shell brew --prefix openssl@3 2>/dev/null)
ifeq ($(OPENSSL_PREFIX),)
  SSL_CFLAGS := $(shell pkg-config --cflags openssl 2>/dev/null)
  SSL_LIBS := $(shell pkg-config --libs openssl 2>/dev/null)
  ifeq ($(strip $(SSL_LIBS)),)
    SSL_LIBS := -lssl -lcrypto
  endif
else
  SSL_CFLAGS := -I$(OPENSSL_PREFIX)/include
  SSL_LIBS := -L$(OPENSSL_PREFIX)/lib -lssl -lcrypto
endif
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  LIBS ?= -pthread
else
  LIBS ?= $(SSL_LIBS) -pthread
endif

BIN := shear-miner
SRC := src/shear_miner.c src/shear_hash.c

.PHONY: all clean selftest

all: $(BIN)

$(BIN): $(SRC) src/shear_hash.h
	$(CC) $(CFLAGS) $(SSL_CFLAGS) -o $@ $(SRC) $(LIBS)

selftest: $(BIN)
	./$(BIN) --selftest

clean:
	rm -f $(BIN)
