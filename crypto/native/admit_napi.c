#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

int32_t shear_note_h(uint8_t *out);
int32_t shear_admit_max_proof(void);
int32_t shear_admit_arity(void);
int32_t shear_admit_leaf(const uint8_t *p, uint8_t *out);
int32_t shear_admit_jroot(const uint8_t *dest, const uint8_t *c, uint32_t n, uint8_t *out);
int32_t shear_admit_prove(
    const uint8_t *x, const uint8_t *p, const uint8_t *c, const uint8_t *t,
    uint32_t index, const uint8_t *dest, const uint8_t *cs, uint32_t n,
    uint8_t *c_tilde_out, uint8_t *proof_out, uint32_t *proof_len);
int32_t shear_admit_verify(
    const uint8_t *proof, uint32_t proof_len, const uint8_t *jroot,
    const uint8_t *c_tilde, const uint8_t *spend_tag,
    const uint8_t *dest, const uint8_t *cs, uint32_t n);
int32_t shear_range_prove(uint64_t v, const uint8_t *r, uint8_t *out, uint32_t *out_len);
int32_t shear_range_verify(const uint8_t *c, const uint8_t *proof, uint32_t proof_len);
int32_t shear_admit_verify_batch(
    const uint8_t *proofs, const uint32_t *lens, uint32_t count,
    const uint8_t *jroot, const uint8_t *c_tildes, const uint8_t *tags,
    const uint8_t *dest, const uint8_t *cs, uint32_t n);
int32_t shear_admit_bench(uint32_t n, uint64_t *prove_us, uint64_t *verify_us, uint32_t *proof_len);

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

static napi_value prove_fn(napi_env env, napi_callback_info info) {
  size_t argc = 7;
  napi_value argv[7];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t x[32], p[32], c[32], t[32];
  uint32_t index = 0;
  if (argc < 7
      || buf32(env, argv[0], x) || buf32(env, argv[1], p) || buf32(env, argv[2], c) || buf32(env, argv[3], t)) {
    napi_throw_error(env, NULL, "prove scalars");
    return NULL;
  }
  napi_get_value_uint32(env, argv[4], &index);
  uint8_t *dest = NULL, *cs = NULL;
  uint32_t nd = 0, nc = 0;
  if (concat_32s(env, argv[5], &dest, &nd) || concat_32s(env, argv[6], &cs, &nc)) {
    free(dest);
    free(cs);
    napi_throw_error(env, NULL, "prove leaves");
    return NULL;
  }
  uint32_t n = nd < nc ? nd : nc;
  uint8_t ct[32];
  uint32_t maxp = (uint32_t)shear_admit_max_proof();
  uint8_t *proof = (uint8_t *)malloc(maxp);
  uint32_t plen = 0;
  int32_t ok = 0;
  if (proof) ok = shear_admit_prove(x, p, c, t, index, dest, cs, n, ct, proof, &plen);
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

static napi_value verify_fn(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *pr = NULL;
  size_t prlen = 0;
  uint8_t jr[32], ct[32], tag[32];
  if (argc < 4
      || napi_get_buffer_info(env, argv[0], &pr, &prlen) != napi_ok
      || buf32(env, argv[1], jr) || buf32(env, argv[2], ct) || buf32(env, argv[3], tag)) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  uint8_t *dest = NULL, *cs = NULL;
  uint32_t nd = 0, nc = 0, n = 0;
  if (argc >= 6) {
    concat_32s(env, argv[4], &dest, &nd);
    concat_32s(env, argv[5], &cs, &nc);
    n = nd < nc ? nd : nc;
  }
  int32_t ok = shear_admit_verify((const uint8_t *)pr, (uint32_t)prlen, jr, ct, tag, dest, cs, n);
  free(dest);
  free(cs);
  napi_value out;
  napi_get_boolean(env, ok == 1, &out);
  return out;
}

static napi_value prove_range_fn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int64_t v = 0;
  uint8_t r[32];
  if (argc < 2 || napi_get_value_int64(env, argv[0], &v) != napi_ok || v < 0 || buf32(env, argv[1], r)) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  uint32_t maxp = (uint32_t)shear_admit_max_proof() + 16384;
  uint8_t *out = (uint8_t *)malloc(maxp);
  uint32_t olen = 0;
  int32_t ok = 0;
  if (out) ok = shear_range_prove((uint64_t)v, r, out, &olen);
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

static napi_value verify_batch_fn(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  bool is_arr = 0;
  if (argc < 4 || napi_is_array(env, argv[0], &is_arr) != napi_ok || !is_arr) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  uint32_t count = 0;
  napi_get_array_length(env, argv[0], &count);
  uint8_t jr[32];
  if (buf32(env, argv[1], jr)) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  size_t total = 0;
  uint32_t *lens = (uint32_t *)calloc(count, sizeof(uint32_t));
  if (!lens && count) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  for (uint32_t i = 0; i < count; i++) {
    napi_value el;
    napi_get_element(env, argv[0], i, &el);
    void *data = NULL;
    size_t len = 0;
    napi_get_buffer_info(env, el, &data, &len);
    lens[i] = (uint32_t)len;
    total += len;
  }
  uint8_t *blob = (uint8_t *)malloc(total ? total : 1);
  size_t off = 0;
  for (uint32_t i = 0; i < count; i++) {
    napi_value el;
    napi_get_element(env, argv[0], i, &el);
    void *data = NULL;
    size_t len = 0;
    napi_get_buffer_info(env, el, &data, &len);
    memcpy(blob + off, data, len);
    off += len;
  }
  uint8_t *cts = NULL, *tags = NULL;
  uint32_t nct = 0, ntg = 0;
  concat_32s(env, argv[2], &cts, &nct);
  concat_32s(env, argv[3], &tags, &ntg);
  uint8_t *dest = NULL, *cs = NULL;
  uint32_t nd = 0, nc = 0, n = 0;
  if (argc >= 6) {
    concat_32s(env, argv[4], &dest, &nd);
    concat_32s(env, argv[5], &cs, &nc);
    n = nd < nc ? nd : nc;
  }
  int32_t ok = 0;
  if (nct == count && ntg == count) {
    ok = shear_admit_verify_batch(blob, lens, count, jr, cts, tags, dest, cs, n);
  }
  free(lens);
  free(blob);
  free(cts);
  free(tags);
  free(dest);
  free(cs);
  napi_value out;
  napi_get_boolean(env, ok == 1, &out);
  return out;
}

static napi_value bench_fn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint32_t n = 0;
  if (argc < 1 || napi_get_value_uint32(env, argv[0], &n) != napi_ok || n == 0) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  uint64_t prove_us = 0, verify_us = 0;
  uint32_t plen = 0;
  int32_t ok = shear_admit_bench(n, &prove_us, &verify_us, &plen);
  if (ok != 1) {
    napi_value f;
    napi_get_boolean(env, 0, &f);
    return f;
  }
  napi_value obj, p_v, v_v, l_v;
  napi_create_object(env, &obj);
  napi_create_double(env, (double)prove_us, &p_v);
  napi_create_double(env, (double)verify_us, &v_v);
  napi_create_uint32(env, plen, &l_v);
  napi_set_named_property(env, obj, "proveUs", p_v);
  napi_set_named_property(env, obj, "verifyUs", v_v);
  napi_set_named_property(env, obj, "proofLen", l_v);
  return obj;
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
  EX("prove", prove_fn);
  EX("verify", verify_fn);
  EX("proveRange", prove_range_fn);
  EX("verifyRange", verify_range_fn);
  EX("verifyBatch", verify_batch_fn);
  EX("bench", bench_fn);
#undef EX
  return exports;
}

NAPI_MODULE(shearadmit, init)
