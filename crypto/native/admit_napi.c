#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

int32_t shear_note_h(uint8_t *out);
int32_t shear_admit_max_proof(void);
int32_t shear_admit_arity(void);
int32_t shear_admit_leaf(const uint8_t *p, uint8_t *out);
int32_t shear_admit_jroot(const uint8_t *dest, const uint8_t *c, uint32_t n, uint8_t *out);
int32_t shear_admit_jroot_point(const uint8_t *dest, const uint8_t *c, uint32_t n, uint8_t *out);
int32_t shear_admit_frontier_append(
    const uint8_t *prev, uint32_t prev_len,
    const uint8_t *dest, const uint8_t *c, uint32_t n,
    uint8_t *out_frontier, uint32_t out_cap, uint32_t *out_len,
    uint8_t *out_root);
int32_t shear_admit_prove_v3(
    const uint8_t *x, const uint8_t *p, const uint8_t *c, const uint8_t *t,
    uint32_t index, const uint8_t *dest, const uint8_t *cs, uint32_t n,
    const uint8_t *ctx, uint32_t ctx_len,
    uint8_t *c_tilde_out, uint8_t *proof_out, uint32_t *proof_len);
int32_t shear_admit_verify_v3(
    const uint8_t *proof, uint32_t proof_len, const uint8_t *jroot,
    const uint8_t *c_tilde, const uint8_t *spend_tag,
    const uint8_t *ctx, uint32_t ctx_len);
int32_t shear_range_prove(uint64_t v, const uint8_t *r, uint8_t *out, uint32_t out_cap, uint32_t *out_len);
int32_t shear_range_verify(const uint8_t *c, const uint8_t *proof, uint32_t proof_len);
typedef struct Fs1Handle Fs1Handle;
uint32_t shear_fs1_blob_cap(uint32_t n);
uint32_t shear_fs1_record_bytes(void);
int32_t shear_fs1_root(const uint8_t *notes, uint64_t count, uint8_t *out);
Fs1Handle *shear_fs1_tree_new(void);
void shear_fs1_tree_free(Fs1Handle *h);
uint64_t shear_fs1_tree_len(const Fs1Handle *h);
int32_t shear_fs1_tree_append(Fs1Handle *h, const uint8_t *notes, uint64_t count);
int32_t shear_fs1_tree_truncate(Fs1Handle *h, uint64_t len);
int32_t shear_fs1_tree_root(const Fs1Handle *h, uint8_t *out);
int32_t shear_fs1_prove(
    const Fs1Handle *h, const uint64_t *indices, const uint8_t *xs, uint32_t n,
    const uint8_t *digest, uint64_t anchor, uint32_t threads,
    uint8_t *out_fs1, size_t fs1_cap, size_t *out_fs1_len,
    uint8_t *out_records, uint8_t *out_t);
int32_t shear_fs1_verify(
    const uint8_t *fs1, size_t fs1_len, const uint8_t *records, uint32_t n,
    const uint8_t *root, const uint8_t *digest, uint64_t anchor);
int32_t shear_fs1_prove_unlinked(
    const Fs1Handle *h, const uint64_t *indices, const uint8_t *xs, uint32_t n,
    const uint8_t *digest, uint64_t anchor, uint32_t threads, const uint8_t *null_bases,
    uint8_t *out_fs1, size_t fs1_cap, size_t *out_fs1_len,
    uint8_t *out_records, uint8_t *out_t, uint8_t *out_link);
int32_t shear_fs1_verify_unlinked(
    const uint8_t *fs1, size_t fs1_len, const uint8_t *records, uint32_t n,
    const uint8_t *link, const uint8_t *root, const uint8_t *digest, uint64_t anchor,
    const uint8_t *null_bases);

static int buf32(napi_env env, napi_value v, uint8_t out[32]) {
  void *data = NULL;
  size_t len = 0;
  if (napi_get_buffer_info(env, v, &data, &len) != napi_ok || len != 32 || !data) return -1;
  memcpy(out, data, 32);
  return 0;
}

static napi_value buf_from(napi_env env, const uint8_t *p, size_t n) {
  napi_value out;
  napi_create_buffer_copy(env, n, p, NULL, &out);
  return out;
}

static napi_value note_h_fn(napi_env env, napi_callback_info info) {
  (void)info;
  uint8_t h[32];
  if (shear_note_h(h) != 1) {
    napi_throw_error(env, NULL, "note_h");
    return NULL;
  }
  return buf_from(env, h, 32);
}

static napi_value max_proof_fn(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  napi_create_uint32(env, (uint32_t)shear_admit_max_proof(), &out);
  return out;
}

static napi_value arity_fn(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  napi_create_uint32(env, (uint32_t)shear_admit_arity(), &out);
  return out;
}

static napi_value leaf_fn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t p[32], out[32];
  if (argc < 1 || buf32(env, argv[0], p) != 0) {
    napi_throw_error(env, NULL, "leaf P");
    return NULL;
  }
  if (shear_admit_leaf(p, out) != 1) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  return buf_from(env, out, 32);
}

static int concat_32s(napi_env env, napi_value arr, uint8_t **out, uint32_t *n) {
  bool is_arr = 0;
  napi_is_array(env, arr, &is_arr);
  if (!is_arr) return -1;
  uint32_t len = 0;
  napi_get_array_length(env, arr, &len);
  uint8_t *buf = (uint8_t *)malloc((size_t)len * 32);
  if (!buf && len) return -1;
  for (uint32_t i = 0; i < len; i++) {
    napi_value el;
    napi_get_element(env, arr, i, &el);
    if (buf32(env, el, buf + (size_t)i * 32) != 0) {
      free(buf);
      return -1;
    }
  }
  *out = buf;
  *n = len;
  return 0;
}

static napi_value jroot_fn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t *dest = NULL, *cs = NULL;
  uint32_t nd = 0, nc = 0;
  if (argc < 2 || concat_32s(env, argv[0], &dest, &nd) != 0 || concat_32s(env, argv[1], &cs, &nc) != 0) {
    napi_throw_error(env, NULL, "jroot args");
    return NULL;
  }
  uint32_t n = nd < nc ? nd : nc;
  uint8_t out[32];
  int32_t ok = shear_admit_jroot(dest, cs, n, out);
  free(dest);
  free(cs);
  if (ok != 1) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  return buf_from(env, out, 32);
}

static napi_value jroot_point_fn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t *dest = NULL, *cs = NULL;
  uint32_t nd = 0, nc = 0;
  if (argc < 2 || concat_32s(env, argv[0], &dest, &nd) != 0 || concat_32s(env, argv[1], &cs, &nc) != 0) {
    napi_throw_error(env, NULL, "jrootPoint args");
    return NULL;
  }
  uint32_t n = nd < nc ? nd : nc;
  uint8_t out[32];
  int32_t ok = shear_admit_jroot_point(dest, cs, n, out);
  free(dest);
  free(cs);
  if (ok != 1) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  return buf_from(env, out, 32);
}


static napi_value prove_v3_fn(napi_env env, napi_callback_info info) {
  size_t argc = 8;
  napi_value argv[8];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t x[32], p[32], c[32], t[32];
  uint32_t index = 0;
  if (argc < 8
      || buf32(env, argv[0], x) || buf32(env, argv[1], p) || buf32(env, argv[2], c) || buf32(env, argv[3], t)) {
    napi_throw_error(env, NULL, "prove v3 scalars");
    return NULL;
  }
  napi_get_value_uint32(env, argv[4], &index);
  uint8_t *dest = NULL, *cs = NULL;
  uint32_t nd = 0, nc = 0;
  if (concat_32s(env, argv[5], &dest, &nd) || concat_32s(env, argv[6], &cs, &nc)) {
    free(dest);
    free(cs);
    napi_throw_error(env, NULL, "prove v3 leaves");
    return NULL;
  }
  void *ctxp = NULL;
  size_t ctxlen = 0;
  if (napi_get_buffer_info(env, argv[7], &ctxp, &ctxlen) != napi_ok || ctxlen != 64 || !ctxp) {
    free(dest);
    free(cs);
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  uint32_t n = nd < nc ? nd : nc;
  uint8_t ct[32];
  /* Height-4 v3 proof is 40354 bytes. Height 5 does not fit. v2 stays 32768. */
  uint32_t maxp = 40354;
  uint8_t *proof = (uint8_t *)malloc(maxp);
  uint32_t plen = 0;
  int32_t ok = 0;
  if (proof) {
    ok = shear_admit_prove_v3(
      x, p, c, t, index, dest, cs, n,
      (const uint8_t *)ctxp, (uint32_t)ctxlen, ct, proof, &plen);
  }
  free(dest);
  free(cs);
  if (!proof || ok != 1) {
    free(proof);
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  napi_value obj, ct_v, pr_v;
  napi_create_object(env, &obj);
  ct_v = buf_from(env, ct, 32);
  pr_v = buf_from(env, proof, plen);
  free(proof);
  napi_set_named_property(env, obj, "cTilde", ct_v);
  napi_set_named_property(env, obj, "proof", pr_v);
  return obj;
}

static napi_value verify_v3_fn(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *pr = NULL;
  size_t prlen = 0;
  uint8_t jr[32], ct[32], tag[32];
  void *ctxp = NULL;
  size_t ctxlen = 0;
  if (argc < 5
      || napi_get_buffer_info(env, argv[0], &pr, &prlen) != napi_ok
      || buf32(env, argv[1], jr) || buf32(env, argv[2], ct) || buf32(env, argv[3], tag)
      || napi_get_buffer_info(env, argv[4], &ctxp, &ctxlen) != napi_ok
      || ctxlen != 64 || !ctxp) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  int32_t ok = shear_admit_verify_v3(
    (const uint8_t *)pr, (uint32_t)prlen, jr, ct, tag,
    (const uint8_t *)ctxp, (uint32_t)ctxlen);
  napi_value out;
  napi_get_boolean(env, ok == 1, &out);
  return out;
}


/* Decimal digits only. A JS number above 2^53 is already rounded, so it is refused. */
static int parse_u64_digits(const char *s, size_t n, uint64_t *out) {
  uint64_t v = 0;
  size_t i;
  if (n == 0 || n > 20) return -1;
  for (i = 0; i < n; i++) {
    unsigned d;
    if (s[i] < '0' || s[i] > '9') return -1;
    d = (unsigned)(s[i] - '0');
    if (v > (UINT64_MAX - (uint64_t)d) / 10ull) return -1;
    v = v * 10ull + (uint64_t)d;
  }
  *out = v;
  return 0;
}

static int read_range_v(napi_env env, napi_value arg, uint64_t *out) {
  napi_valuetype t;
  if (napi_typeof(env, arg, &t) != napi_ok) return -1;
  if (t == napi_string) {
    size_t n = 0;
    char buf[24];
    size_t copied = 0;
    if (napi_get_value_string_utf8(env, arg, NULL, 0, &n) != napi_ok) return -1;
    if (n == 0 || n > 20) return -1;
    if (napi_get_value_string_utf8(env, arg, buf, sizeof buf, &copied) != napi_ok) return -1;
    if (copied != n) return -1;
    return parse_u64_digits(buf, copied, out);
  }
  if (t == napi_number) {
    double d = 0;
    uint64_t v;
    if (napi_get_value_double(env, arg, &d) != napi_ok) return -1;
    if (d < 0 || d > 9007199254740991.0) return -1;
    v = (uint64_t)d;
    if ((double)v != d) return -1;
    *out = v;
    return 0;
  }
  return -1;
}

static napi_value prove_range_fn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint64_t v = 0;
  uint8_t r[32];
  if (argc < 2 || read_range_v(env, argv[0], &v) != 0 || buf32(env, argv[1], r)) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  uint32_t maxp = (uint32_t)shear_admit_max_proof() + 16384;
  uint8_t *out = (uint8_t *)malloc(maxp);
  uint32_t olen = 0;
  int32_t ok = 0;
  if (out) ok = shear_range_prove(v, r, out, maxp, &olen);
  volatile uint8_t *wipe = r;
  for (size_t i = 0; i < sizeof r; i++) wipe[i] = 0;
  if (!out || ok != 1) {
    free(out);
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  napi_value buf = buf_from(env, out, olen);
  free(out);
  return buf;
}

static napi_value verify_range_fn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t c[32];
  void *pr = NULL;
  size_t prlen = 0;
  if (argc < 2 || buf32(env, argv[0], c) || napi_get_buffer_info(env, argv[1], &pr, &prlen) != napi_ok) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  int32_t ok = shear_range_verify(c, (const uint8_t *)pr, (uint32_t)prlen);
  napi_value out;
  napi_get_boolean(env, ok == 1, &out);
  return out;
}



static napi_value frontier_append_fn(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *prev_data = NULL;
  size_t prev_len = 0;
  if (argc < 3 || napi_get_buffer_info(env, argv[0], &prev_data, &prev_len) != napi_ok) {
    napi_throw_error(env, NULL, "frontier prev");
    return NULL;
  }
  if (prev_len > 0 && !prev_data) {
    napi_throw_error(env, NULL, "frontier prev");
    return NULL;
  }
  uint8_t *dest = NULL, *cs = NULL;
  uint32_t nd = 0, nc = 0;
  if (concat_32s(env, argv[1], &dest, &nd) != 0 || concat_32s(env, argv[2], &cs, &nc) != 0 || nd != nc) {
    free(dest);
    free(cs);
    napi_throw_error(env, NULL, "frontier leaves");
    return NULL;
  }
  uint8_t frontier[16384];
  uint8_t root[32];
  uint32_t out_len = 0;
  int32_t ok = shear_admit_frontier_append(
      (const uint8_t *)prev_data, (uint32_t)prev_len, dest, cs, nd,
      frontier, (uint32_t)sizeof(frontier), &out_len, root);
  free(dest);
  free(cs);
  if (ok != 1 || out_len == 0 || out_len > sizeof(frontier)) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  napi_value obj, root_v, fr_v;
  napi_create_object(env, &obj);
  root_v = buf_from(env, root, 32);
  fr_v = buf_from(env, frontier, out_len);
  napi_set_named_property(env, obj, "root", root_v);
  napi_set_named_property(env, obj, "frontier", fr_v);
  return obj;
}

static napi_value false_v(napi_env env) {
  napi_value f;
  napi_get_boolean(env, 0, &f);
  return f;
}

static napi_value bool_v(napi_env env, int ok) {
  napi_value b;
  napi_get_boolean(env, ok ? 1 : 0, &b);
  return b;
}

static int buf_any(napi_env env, napi_value v, uint8_t **data, size_t *len) {
  void *d = NULL;
  size_t n = 0;
  if (napi_get_buffer_info(env, v, &d, &n) != napi_ok) return -1;
  if (n > 0 && !d) return -1;
  *data = (uint8_t *)d;
  *len = n;
  return 0;
}

static int u64_arg(napi_env env, napi_value v, uint64_t *out) {
  double d = 0;
  if (napi_get_value_double(env, v, &d) != napi_ok) return -1;
  if (!(d >= 0) || d > 9007199254740991.0 || d != (double)(uint64_t)d) return -1;
  *out = (uint64_t)d;
  return 0;
}

static void fs1_tree_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  shear_fs1_tree_free((Fs1Handle *)data);
}

static Fs1Handle *fs1_handle(napi_env env, napi_value v) {
  void *data = NULL;
  if (napi_get_value_external(env, v, &data) != napi_ok) return NULL;
  return (Fs1Handle *)data;
}

static napi_value fs1_blob_cap_fn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint32_t n = 0;
  if (argc < 1 || napi_get_value_uint32(env, argv[0], &n) != napi_ok) n = 0;
  napi_value out;
  napi_create_uint32(env, shear_fs1_blob_cap(n), &out);
  return out;
}

static napi_value fs1_record_bytes_fn(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  napi_create_uint32(env, shear_fs1_record_bytes(), &out);
  return out;
}

static napi_value fs1_root_fn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t *notes = NULL;
  size_t len = 0;
  if (argc < 1 || buf_any(env, argv[0], &notes, &len) != 0 || len % 64 != 0) {
    napi_throw_error(env, NULL, "fs1Root notes");
    return NULL;
  }
  uint8_t out[32];
  if (shear_fs1_root(notes, (uint64_t)(len / 64), out) != 1) return false_v(env);
  return buf_from(env, out, 32);
}

static napi_value fs1_tree_new_fn(napi_env env, napi_callback_info info) {
  (void)info;
  Fs1Handle *h = shear_fs1_tree_new();
  if (!h) {
    napi_throw_error(env, NULL, "fs1TreeNew");
    return NULL;
  }
  napi_value out;
  if (napi_create_external(env, h, fs1_tree_finalize, NULL, &out) != napi_ok) {
    shear_fs1_tree_free(h);
    napi_throw_error(env, NULL, "fs1TreeNew");
    return NULL;
  }
  return out;
}

static napi_value fs1_tree_len_fn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Fs1Handle *h = argc < 1 ? NULL : fs1_handle(env, argv[0]);
  if (!h) {
    napi_throw_error(env, NULL, "fs1 handle");
    return NULL;
  }
  napi_value out;
  napi_create_double(env, (double)shear_fs1_tree_len(h), &out);
  return out;
}

static napi_value fs1_tree_append_fn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Fs1Handle *h = argc < 2 ? NULL : fs1_handle(env, argv[0]);
  uint8_t *notes = NULL;
  size_t len = 0;
  if (!h || buf_any(env, argv[1], &notes, &len) != 0 || len % 64 != 0) {
    napi_throw_error(env, NULL, "fs1TreeAppend args");
    return NULL;
  }
  return bool_v(env, shear_fs1_tree_append(h, notes, (uint64_t)(len / 64)) == 1);
}

static napi_value fs1_tree_truncate_fn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Fs1Handle *h = argc < 2 ? NULL : fs1_handle(env, argv[0]);
  uint64_t len = 0;
  if (!h || u64_arg(env, argv[1], &len) != 0) {
    napi_throw_error(env, NULL, "fs1TreeTruncate args");
    return NULL;
  }
  return bool_v(env, shear_fs1_tree_truncate(h, len) == 1);
}

static napi_value fs1_tree_root_fn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Fs1Handle *h = argc < 1 ? NULL : fs1_handle(env, argv[0]);
  if (!h) {
    napi_throw_error(env, NULL, "fs1 handle");
    return NULL;
  }
  uint8_t out[32];
  if (shear_fs1_tree_root(h, out) != 1) return false_v(env);
  return buf_from(env, out, 32);
}

/* fs1Prove(handle, indices[], xs (32n), digest32, anchor, threads) */
static napi_value fs1_prove_fn(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Fs1Handle *h = argc < 6 ? NULL : fs1_handle(env, argv[0]);
  bool is_arr = 0;
  uint32_t n = 0;
  if (h) napi_is_array(env, argv[1], &is_arr);
  if (is_arr) napi_get_array_length(env, argv[1], &n);
  uint8_t *xs = NULL;
  size_t xs_len = 0;
  uint8_t digest[32];
  uint64_t anchor = 0;
  uint32_t threads = 0;
  if (!h || !is_arr || n < 1 || n > 8 || buf_any(env, argv[2], &xs, &xs_len) != 0 || xs_len != (size_t)n * 32
      || buf32(env, argv[3], digest) != 0 || u64_arg(env, argv[4], &anchor) != 0
      || napi_get_value_uint32(env, argv[5], &threads) != napi_ok) {
    napi_throw_error(env, NULL, "fs1Prove args");
    return NULL;
  }
  uint64_t indices[8];
  for (uint32_t i = 0; i < n; i++) {
    napi_value el;
    napi_get_element(env, argv[1], i, &el);
    if (u64_arg(env, el, &indices[i]) != 0) {
      napi_throw_error(env, NULL, "fs1Prove index");
      return NULL;
    }
  }
  uint32_t cap = shear_fs1_blob_cap(n);
  uint32_t rec = shear_fs1_record_bytes();
  uint8_t *fs1 = (uint8_t *)malloc(cap);
  uint8_t *records = (uint8_t *)malloc((size_t)rec * n);
  uint8_t t[8 * 32];
  size_t fs1_len = 0;
  if (!fs1 || !records) {
    free(fs1);
    free(records);
    napi_throw_error(env, NULL, "fs1Prove alloc");
    return NULL;
  }
  int32_t ok = shear_fs1_prove(h, indices, xs, n, digest, anchor, threads, fs1, cap, &fs1_len, records, t);
  if (ok != 1) {
    free(fs1);
    free(records);
    memset(t, 0, sizeof(t));
    return false_v(env);
  }
  napi_value obj;
  napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "fs1", buf_from(env, fs1, fs1_len));
  napi_set_named_property(env, obj, "records", buf_from(env, records, (size_t)rec * n));
  napi_set_named_property(env, obj, "t", buf_from(env, t, (size_t)32 * n));
  memset(t, 0, sizeof(t));
  free(fs1);
  free(records);
  return obj;
}

/* fs1ProveUnlinked(handle, indices[], xs, digest32, anchor, threads, nullBases) */
static napi_value fs1_prove_unlinked_fn(napi_env env, napi_callback_info info) {
  size_t argc = 7;
  napi_value argv[7];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  Fs1Handle *h = argc < 7 ? NULL : fs1_handle(env, argv[0]);
  bool is_arr = 0;
  uint32_t n = 0;
  if (h) napi_is_array(env, argv[1], &is_arr);
  if (is_arr) napi_get_array_length(env, argv[1], &n);
  uint8_t *xs = NULL;
  size_t xs_len = 0;
  uint8_t *bases = NULL;
  size_t bases_len = 0;
  uint8_t digest[32];
  uint64_t anchor = 0;
  uint32_t threads = 0;
  if (!h || !is_arr || n < 1 || n > 8 || buf_any(env, argv[2], &xs, &xs_len) != 0 || xs_len != (size_t)n * 32
      || buf32(env, argv[3], digest) != 0 || u64_arg(env, argv[4], &anchor) != 0
      || napi_get_value_uint32(env, argv[5], &threads) != napi_ok
      || buf_any(env, argv[6], &bases, &bases_len) != 0 || bases_len != (size_t)n * 32) {
    napi_throw_error(env, NULL, "fs1ProveUnlinked args");
    return NULL;
  }
  uint64_t indices[8];
  for (uint32_t i = 0; i < n; i++) {
    napi_value el;
    napi_get_element(env, argv[1], i, &el);
    if (u64_arg(env, el, &indices[i]) != 0) {
      napi_throw_error(env, NULL, "fs1ProveUnlinked index");
      return NULL;
    }
  }
  uint32_t cap = shear_fs1_blob_cap(n);
  uint32_t rec = shear_fs1_record_bytes();
  uint8_t *fs1 = (uint8_t *)malloc(cap);
  uint8_t *records = (uint8_t *)malloc((size_t)rec * n);
  uint8_t *link = (uint8_t *)malloc((size_t)96 * n);
  uint8_t t[8 * 32];
  size_t fs1_len = 0;
  if (!fs1 || !records || !link) {
    free(fs1);
    free(records);
    free(link);
    napi_throw_error(env, NULL, "fs1ProveUnlinked alloc");
    return NULL;
  }
  int32_t ok = shear_fs1_prove_unlinked(
      h, indices, xs, n, digest, anchor, threads, bases, fs1, cap, &fs1_len, records, t, link);
  if (ok != 1) {
    free(fs1);
    free(records);
    free(link);
    memset(t, 0, sizeof(t));
    return false_v(env);
  }
  napi_value obj;
  napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "fs1", buf_from(env, fs1, fs1_len));
  napi_set_named_property(env, obj, "records", buf_from(env, records, (size_t)rec * n));
  napi_set_named_property(env, obj, "t", buf_from(env, t, (size_t)32 * n));
  napi_set_named_property(env, obj, "link", buf_from(env, link, (size_t)96 * n));
  memset(t, 0, sizeof(t));
  free(fs1);
  free(records);
  free(link);
  return obj;
}

/* fs1VerifyUnlinked(fs1, records, link, root32, digest32, anchor, nullBases) */
static napi_value fs1_verify_unlinked_fn(napi_env env, napi_callback_info info) {
  size_t argc = 7;
  napi_value argv[7];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t *fs1 = NULL, *records = NULL, *link = NULL, *bases = NULL;
  size_t fs1_len = 0, rec_len = 0, link_len = 0, bases_len = 0;
  uint8_t root[32], digest[32];
  uint64_t anchor = 0;
  if (argc < 7 || buf_any(env, argv[0], &fs1, &fs1_len) != 0 || buf_any(env, argv[1], &records, &rec_len) != 0
      || buf_any(env, argv[2], &link, &link_len) != 0 || buf32(env, argv[3], root) != 0
      || buf32(env, argv[4], digest) != 0 || u64_arg(env, argv[5], &anchor) != 0
      || buf_any(env, argv[6], &bases, &bases_len) != 0) {
    return false_v(env);
  }
  uint32_t rec = shear_fs1_record_bytes();
  if (rec_len == 0 || rec_len % rec != 0 || rec_len / rec > 8) return false_v(env);
  uint32_t n = (uint32_t)(rec_len / rec);
  if (link_len != (size_t)n * 96 || bases_len != (size_t)n * 32) return false_v(env);
  return bool_v(env, shear_fs1_verify_unlinked(fs1, fs1_len, records, n, link, root, digest, anchor, bases) == 1);
}

/* fs1Verify(fs1, records (321n), root32, digest32, anchor) */
static napi_value fs1_verify_fn(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t *fs1 = NULL, *records = NULL;
  size_t fs1_len = 0, rec_len = 0;
  uint8_t root[32], digest[32];
  uint64_t anchor = 0;
  if (argc < 5 || buf_any(env, argv[0], &fs1, &fs1_len) != 0 || buf_any(env, argv[1], &records, &rec_len) != 0
      || buf32(env, argv[2], root) != 0 || buf32(env, argv[3], digest) != 0 || u64_arg(env, argv[4], &anchor) != 0) {
    return false_v(env);
  }
  uint32_t rec = shear_fs1_record_bytes();
  if (rec_len == 0 || rec_len % rec != 0 || rec_len / rec > 8) return false_v(env);
  return bool_v(env, shear_fs1_verify(fs1, fs1_len, records, (uint32_t)(rec_len / rec), root, digest, anchor) == 1);
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
#define EX(name, fnp) \
  napi_create_function(env, NULL, 0, fnp, NULL, &fn); \
  napi_set_named_property(env, exports, name, fn)
  EX("noteH", note_h_fn);
  EX("maxProof", max_proof_fn);
  EX("arity", arity_fn);
  EX("leaf", leaf_fn);
  EX("jroot", jroot_fn);
  EX("jrootPoint", jroot_point_fn);
  EX("frontierAppend", frontier_append_fn);
  EX("proveV3", prove_v3_fn);
  EX("verifyV3", verify_v3_fn);
  EX("proveRange", prove_range_fn);
  EX("verifyRange", verify_range_fn);
  EX("fs1BlobCap", fs1_blob_cap_fn);
  EX("fs1RecordBytes", fs1_record_bytes_fn);
  EX("fs1Root", fs1_root_fn);
  EX("fs1TreeNew", fs1_tree_new_fn);
  EX("fs1TreeLen", fs1_tree_len_fn);
  EX("fs1TreeAppend", fs1_tree_append_fn);
  EX("fs1TreeTruncate", fs1_tree_truncate_fn);
  EX("fs1TreeRoot", fs1_tree_root_fn);
  EX("fs1Prove", fs1_prove_fn);
  EX("fs1Verify", fs1_verify_fn);
  EX("fs1ProveUnlinked", fs1_prove_unlinked_fn);
  EX("fs1VerifyUnlinked", fs1_verify_unlinked_fn);
#undef EX
  return exports;
}

NAPI_MODULE(shearadmit, init)
