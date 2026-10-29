# Shear Ledger device app (docs/LEDGER-VORTICE.md §5).
# Build in ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:
#   make BOLOS_SDK=$NANOX_SDK      (also NANOSP, STAX, FLEX)
ifeq ($(BOLOS_SDK),)
$(error BOLOS_SDK is not set)
endif
include $(BOLOS_SDK)/Makefile.defines

APPNAME      = "Shear"
APPVERSION_M = 0
APPVERSION_N = 1
APPVERSION_P = 0
APPVERSION   = "$(APPVERSION_M).$(APPVERSION_N).$(APPVERSION_P)"

# PLACEHOLDER: SLIP-44 coin type for SHE (D2). The single place to change it.
# 1 (the shared testnet type) until SatoshiLabs assigns a number. The request
# for 2004 is in Desktop/SLIP44-SHE-PR.md. Every host and test reads it from here.
SHEAR_COIN_TYPE ?= 1
DEFINES += SHEAR_COIN_TYPE=$(SHEAR_COIN_TYPE)

CURVE_APP_LOAD_PARAMS = ed25519
PATH_APP_LOAD_PARAMS  = "44'/$(SHEAR_COIN_TYPE)'"

VARIANT_PARAM  = COIN
VARIANT_VALUES = SHE

ICON_NANOX  = icons/shear_14px.gif
ICON_NANOSP = icons/shear_14px.gif
ICON_STAX   = icons/shear_32px.gif
ICON_FLEX   = icons/shear_40px.gif

ENABLE_BLUETOOTH = 1
ENABLE_NBGL_FOR_NANO_DEVICES = 1
ENABLE_NBGL_QRCODE = 0
DISABLE_STANDARD_APP_FILES = 0
APP_SOURCE_PATH += src

include $(BOLOS_SDK)/Makefile.standard_app
