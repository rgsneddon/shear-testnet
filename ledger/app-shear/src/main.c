/*
 * Shear Ledger device app (docs/LEDGER-VORTICE.md §5).
 *
 * The device holds the account seed s: SLIP-10 Ed25519 at 44'/COIN'/acct'.
 * It exports spendPub = Ed25519(s), and with on-screen consent the view key
 * SHA256("shear-view-v1" || pkcs8 || s), the same derivation as
 * createIdentity in wallet/lib/shear_identity.dart. s never leaves the
 * device. The FS-1 spend authorisation (SA+L) waits for decision D1 and
 * answers SW_AWAITING_D1 until then.
 *
 * APDUs, CLA 0xE0:
 *   01 GET_VERSION                      -> M N P
 *   10 GET_ACCOUNT P1=0                 path -> spendPub(32)
 *   10 GET_ACCOUNT P1=1 (confirm)       path -> spendPub(32) viewKey(32)
 *   12 SPEND_AUTH                       -> SW_AWAITING_D1
 */
#include <string.h>

#include "os.h"
#include "cx.h"
#include "io.h"
#include "parser.h"
#include "nbgl_use_case.h"

#define CLA 0xE0
#define INS_GET_VERSION 0x01
#define INS_GET_ACCOUNT 0x10
#define INS_SPEND_AUTH 0x12

#define SW_OK 0x9000
#define SW_DENY 0x6985
#define SW_BAD_DATA 0x6A80
#define SW_BAD_INS 0x6D00
#define SW_BAD_CLA 0x6E00
#define SW_BAD_P1 0x6B00
#define SW_AWAITING_D1 0x6A8B
#define SW_INTERNAL 0x6F00

#define MAX_PATH 5

static const uint8_t PKCS8_PREFIX[16] = {0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
                                         0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20};
static const char VIEW_DST[] = "shear-view-v1";

static struct {
    uint8_t spend_pub[32];
    uint8_t view_key[32];
} G_pending;

/* path = n || u32 BE * n. Must be under 44'/COIN' and fully hardened. */
static int parse_path(const uint8_t *d, size_t len, uint32_t *path, uint8_t *n) {
    if (len < 1) return 0;
    *n = d[0];
    if (*n < 3 || *n > MAX_PATH || len != 1 + 4u * *n) return 0;
    for (uint8_t i = 0; i < *n; i++) {
        path[i] = U4BE(d, 1 + 4 * i);
        if (!(path[i] & 0x80000000u)) return 0; /* SLIP-10 Ed25519 is hardened only */
    }
    return path[0] == (0x80000000u | 44) && path[1] == (0x80000000u | SHEAR_COIN_TYPE);
}

/* Derive s, then spendPub and viewKey. s is wiped before return. */
static int derive_account(const uint32_t *path, uint8_t n, uint8_t pub[32], uint8_t view[32]) {
    uint8_t raw[64];
    cx_ecfp_private_key_t pk;
    cx_ecfp_public_key_t pubk;
    int ok = 0;
    if (os_derive_bip32_with_seed_no_throw(HDW_ED25519_SLIP10, CX_CURVE_Ed25519, path, n, raw, NULL, NULL, 0) != CX_OK) {
        goto end;
    }
    if (cx_ecfp_init_private_key_no_throw(CX_CURVE_Ed25519, raw, 32, &pk) != CX_OK) goto end;
    if (cx_ecfp_generate_pair_no_throw(CX_CURVE_Ed25519, &pubk, &pk, 1) != CX_OK) goto end;
    /* Uncompressed 04 || x BE || y BE to RFC 8032 little-endian y with x's sign bit. */
    for (int i = 0; i < 32; i++) pub[i] = pubk.W[64 - i];
    if (pubk.W[32] & 1) pub[31] |= 0x80;
    if (view) {
        cx_sha256_t h;
        cx_sha256_init_no_throw(&h);
        if (cx_hash_no_throw((cx_hash_t *) &h, 0, (const uint8_t *) VIEW_DST, sizeof(VIEW_DST) - 1, NULL, 0) != CX_OK ||
            cx_hash_no_throw((cx_hash_t *) &h, 0, PKCS8_PREFIX, sizeof(PKCS8_PREFIX), NULL, 0) != CX_OK ||
            cx_hash_no_throw((cx_hash_t *) &h, CX_LAST, raw, 32, view, 32) != CX_OK) {
            goto end;
        }
    }
    ok = 1;
end:
    explicit_bzero(raw, sizeof(raw));
    explicit_bzero(&pk, sizeof(pk));
    return ok;
}

static void on_view_choice(bool approve) {
    if (approve) {
        uint8_t out[64];
        memcpy(out, G_pending.spend_pub, 32);
        memcpy(out + 32, G_pending.view_key, 32);
        io_send_response_pointer(out, sizeof(out), SW_OK);
        explicit_bzero(out, sizeof(out));
        nbgl_useCaseStatus("View key exported", true, nbgl_useCaseHome_cb);
    } else {
        io_send_sw(SW_DENY);
        nbgl_useCaseStatus("Rejected", false, nbgl_useCaseHome_cb);
    }
    explicit_bzero(&G_pending, sizeof(G_pending));
}

/*
 * The send review the SA+L will sit behind (§5 step 2): amount and
 * destination come from the opening the device checks, never from the host
 * alone. Unused until D1.
 */
__attribute__((unused)) static void ui_review_send(const char *amount, const char *dest, const char *fee,
                                                   nbgl_choiceCallback_t cb) {
    static nbgl_contentTagValue_t pairs[3];
    static nbgl_contentTagValueList_t list;
    pairs[0] = (nbgl_contentTagValue_t){.item = "Amount", .value = amount};
    pairs[1] = (nbgl_contentTagValue_t){.item = "To", .value = dest};
    pairs[2] = (nbgl_contentTagValue_t){.item = "Fee", .value = fee};
    list = (nbgl_contentTagValueList_t){.pairs = pairs, .nbPairs = 3};
    nbgl_useCaseReview(TYPE_TRANSACTION, &list, &ICON_APP, "Review Shear send", NULL, "Sign Shear send?", cb);
}

static int dispatch(const command_t *cmd) {
    if (cmd->cla != CLA) return io_send_sw(SW_BAD_CLA);
    switch (cmd->ins) {
        case INS_GET_VERSION: {
            uint8_t v[3] = {APPVERSION_M, APPVERSION_N, APPVERSION_P};
            return io_send_response_pointer(v, 3, SW_OK);
        }
        case INS_GET_ACCOUNT: {
            uint32_t path[MAX_PATH];
            uint8_t n;
            if (cmd->p1 > 1 || cmd->p2 != 0) return io_send_sw(SW_BAD_P1);
            if (!parse_path(cmd->data, cmd->lc, path, &n)) return io_send_sw(SW_BAD_DATA);
            if (cmd->p1 == 0) {
                uint8_t pub[32];
                if (!derive_account(path, n, pub, NULL)) return io_send_sw(SW_INTERNAL);
                return io_send_response_pointer(pub, 32, SW_OK);
            }
            if (!derive_account(path, n, G_pending.spend_pub, G_pending.view_key)) {
                explicit_bzero(&G_pending, sizeof(G_pending));
                return io_send_sw(SW_INTERNAL);
            }
            nbgl_useCaseChoice(&ICON_APP, "Export Shear view key?",
                               "The wallet can then see this account's incoming payments. It cannot spend.",
                               "Export", "Reject", on_view_choice);
            return 0; /* answered from the callback */
        }
        case INS_SPEND_AUTH:
            return io_send_sw(SW_AWAITING_D1);
        default:
            return io_send_sw(SW_BAD_INS);
    }
}

void app_main(void) {
    command_t cmd;
    io_init();
    nbgl_useCaseHome(APPNAME, &ICON_APP, "Keys stay on this device", false, NULL, NULL);
    for (;;) {
        int len = io_recv_command();
        if (len < 0) return;
        if (!apdu_parser(&cmd, G_io_apdu_buffer, (size_t) len)) {
            io_send_sw(SW_BAD_DATA);
            continue;
        }
        dispatch(&cmd);
    }
}
