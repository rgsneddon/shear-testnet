#include "stratum_tls.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
/* wincrypt.h names collide with OpenSSL. */
#undef X509_NAME
#undef X509_EXTENSIONS
#undef X509_CERT_PAIR
#undef PKCS7_SIGNER_INFO
#endif

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/x509.h>
#include <stdio.h>
#include <string.h>

static SSL_CTX *g_ctx;
static SSL *g_ssl;

static void tls_err(char *err, size_t errcap, const char *what) {
  unsigned long e = ERR_get_error();
  const char *s = e ? ERR_error_string(e, NULL) : "failed";
  snprintf(err, errcap, "%s: %s", what, s ? s : "failed");
}

#ifdef _WIN32
/* OpenSSL's default verify directory is not the Windows trust store. */
static int load_windows_roots(SSL_CTX *ctx) {
  HCERTSTORE sys = CertOpenSystemStoreW(0, L"ROOT");
  if (!sys) return 0;
  X509_STORE *xs = SSL_CTX_get_cert_store(ctx);
  PCCERT_CONTEXT cur = NULL;
  int n = 0;
  while ((cur = CertEnumCertificatesInStore(sys, cur)) != NULL) {
    const unsigned char *p = cur->pbCertEncoded;
    X509 *x = d2i_X509(NULL, &p, (long)cur->cbCertEncoded);
    if (!x) continue;
    if (X509_STORE_add_cert(xs, x) == 1) n++;
    X509_free(x);
  }
  CertCloseStore(sys, 0);
  return n;
}
#endif

static int pin_matches(SSL *ssl, const char *pinHex) {
  if (!pinHex || !pinHex[0]) return 1;
  X509 *cert = SSL_get_peer_certificate(ssl);
  if (!cert) return 0;
  unsigned char md[EVP_MAX_MD_SIZE];
  unsigned int n = 0;
  int ok = X509_digest(cert, EVP_sha256(), md, &n) == 1 && n == 32;
  X509_free(cert);
  if (!ok) return 0;
  char hex[65];
  for (unsigned i = 0; i < 32; i++) snprintf(hex + (i * 2), 3, "%02x", md[i]);
  return strcmp(hex, pinHex) == 0;
}

int stratum_tls_handshake(int fd, const char *host, const char *caFile, const char *pinHex, char *err, size_t errcap) {
  if (err && errcap) err[0] = 0;
  OPENSSL_init_ssl(0, NULL);
  g_ctx = SSL_CTX_new(TLS_client_method());
  if (!g_ctx) {
    tls_err(err, errcap, "tls ctx");
    return -1;
  }
  SSL_CTX_set_verify(g_ctx, SSL_VERIFY_PEER, NULL);
  if (caFile && caFile[0]) {
    if (SSL_CTX_load_verify_locations(g_ctx, caFile, NULL) != 1) {
      tls_err(err, errcap, "tls ca");
      return -1;
    }
  } else {
    int paths = SSL_CTX_set_default_verify_paths(g_ctx);
#ifdef _WIN32
    int roots = load_windows_roots(g_ctx);
    if (paths != 1 && roots < 1) {
      tls_err(err, errcap, "tls system trust");
      return -1;
    }
#else
    if (paths != 1) {
      tls_err(err, errcap, "tls system trust");
      return -1;
    }
#endif
  }
  g_ssl = SSL_new(g_ctx);
  if (!g_ssl) {
    tls_err(err, errcap, "tls ssl");
    return -1;
  }
  SSL_set_fd(g_ssl, fd);
  if (host && host[0]) {
    SSL_set_tlsext_host_name(g_ssl, host);
    SSL_set1_host(g_ssl, host);
  }
  if (SSL_connect(g_ssl) != 1) {
    tls_err(err, errcap, "tls handshake");
    return -1;
  }
  if (SSL_get_verify_result(g_ssl) != X509_V_OK) {
    snprintf(err, errcap, "tls verify failed");
    return -1;
  }
  if (!pin_matches(g_ssl, pinHex)) {
    snprintf(err, errcap, "tls pin mismatch");
    return -1;
  }
  return 0;
}

int stratum_tls_active(void) { return g_ssl != NULL; }

int stratum_tls_write(const char *buf, int n) {
  if (!g_ssl) return -1;
  int w = SSL_write(g_ssl, buf, n);
  if (w == n) return 0;
  int er = SSL_get_error(g_ssl, w);
  if (er == SSL_ERROR_WANT_READ || er == SSL_ERROR_WANT_WRITE) return 1;
  return -1;
}

int stratum_tls_read(char *buf, int cap) {
  if (!g_ssl) return -1;
  int n = SSL_read(g_ssl, buf, cap);
  if (n > 0) return n;
  int er = SSL_get_error(g_ssl, n);
  if (er == SSL_ERROR_WANT_READ || er == SSL_ERROR_WANT_WRITE) return 0;
  if (er == SSL_ERROR_ZERO_RETURN) return -1;
  return -1;
}

void stratum_tls_close(void) {
  if (g_ssl) {
    SSL_shutdown(g_ssl);
    SSL_free(g_ssl);
    g_ssl = NULL;
  }
  if (g_ctx) {
    SSL_CTX_free(g_ctx);
    g_ctx = NULL;
  }
}
