#include <node_api.h>
#include <string.h>
#include "shear_hash.h"

static napi_value hash_fn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  size_t len = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &len) != napi_ok || len != SHEAR_HEADER_LEN) {
    napi_throw_error(env, NULL, "header must be 128 bytes");
    return NULL;
  }
  unsigned char out[32];
  shear_hash((const unsigned char *)data, out);
  napi_value buf;
  napi_create_buffer_copy(env, 32, out, NULL, &buf);
  return buf;
}

static napi_value key_fn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  size_t len = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &len) != napi_ok || len != SHEAR_HEADER_LEN) {
    napi_throw_error(env, NULL, "header must be 128 bytes");
    return NULL;
  }
  unsigned char k[32];
  shear_key((const unsigned char *)data, k);
  napi_value buf;
  napi_create_buffer_copy(env, 32, k, NULL, &buf);
  return buf;
}

static napi_value backend_fn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc >= 1) {
    size_t n = 0;
    char name[32];
    napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &n);
    shear_hash_set_backend(name);
  }
  napi_value out;
  const char *b = shear_hash_backend();
  napi_create_string_utf8(env, b, NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value init(napi_env env, napi_value exports) {
  shear_hash_set_backend("interpreter");
  napi_value h, k, b;
  napi_create_function(env, NULL, 0, hash_fn, NULL, &h);
  napi_create_function(env, NULL, 0, key_fn, NULL, &k);
  napi_create_function(env, NULL, 0, backend_fn, NULL, &b);
  napi_set_named_property(env, exports, "hash", h);
  napi_set_named_property(env, exports, "key", k);
  napi_set_named_property(env, exports, "backend", b);
  return exports;
}

NAPI_MODULE(shearhash, init)
