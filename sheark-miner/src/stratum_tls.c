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
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>
#include <stdio.h>
#include <string.h>

#include "tls_roots.h"

/* Host for the SAN check. Set for the handshake, cleared after. */
static char g_tls_host[256];

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

static int host_is_ip(const char *host) {
  int dots = 0;
  if (!host || !host[0]) return 0;
  if (strchr(host, ':')) return 1;
  for (const char *p = host; *p; p++) {
    if (*p == '.') dots++;
    else if (*p < '0' || *p > '9') return 0;
  }
  return dots == 3;
}

/* DNS or IP SAN. A cert with no such name still uses the OpenSSL CN check. */
static int cert_has_dns_or_ip_san(X509 *cert) {
  GENERAL_NAMES *names = X509_get_ext_d2i(cert, NID_subject_alt_name, NULL, NULL);
  int found = 0;
  if (!names) return 0;
  for (int i = 0; i < sk_GENERAL_NAME_num(names); i++) {
    const GENERAL_NAME *gn = sk_GENERAL_NAME_value(names, i);
    if (gn && (gn->type == GEN_DNS || gn->type == GEN_IPADD)) {
      found = 1;
      break;
    }
  }
  GENERAL_NAMES_free(names);
  return found;
}

/* OpenSSL may report a CN miss. When a SAN exists, the name has to match
   that SAN. Issuer, expiry, and self-signed errors stay failures. */
static int verify_san_host(int ok, X509_STORE_CTX *ctx) {
  X509 *cert;
  int match;
  if (ok) return 1;
  if (X509_STORE_CTX_get_error(ctx) != X509_V_ERR_HOSTNAME_MISMATCH) return 0;
  cert = X509_STORE_CTX_get_current_cert(ctx);
  if (!cert || !g_tls_host[0] || !cert_has_dns_or_ip_san(cert)) return 0;
  if (host_is_ip(g_tls_host)) {
    match = X509_check_ip_asc(cert, g_tls_host, 0) == 1;
  } else {
    match = X509_check_host(cert, g_tls_host, 0, X509_CHECK_FLAG_NEVER_CHECK_SUBJECT, NULL) == 1;
  }
  if (!match) return 0;
  X509_STORE_CTX_set_error(ctx, X509_V_OK);
  return 1;
}

static int add_bundled_roots(SSL_CTX *ctx) {
  BIO *bio = BIO_new_mem_buf(kBundledTlsRoots, -1);
  X509_STORE *xs;
  int n = 0;
  if (!bio) return 0;
  xs = SSL_CTX_get_cert_store(ctx);
  for (;;) {
    X509 *x = PEM_read_bio_X509(bio, NULL, NULL, NULL);
    if (!x) break;
    if (X509_STORE_add_cert(xs, x) == 1) n++;
    X509_free(x);
  }
  BIO_free(bio);
  return n;
}

static void log_verified_chain(SSL *ssl, const char *host, int bundled, int windowsRoots) {
  X509 *leaf = SSL_get_peer_certificate(ssl);
  char subject[256] = "";
  char issuer[256] = "";
  if (leaf) {
    X509_NAME_oneline(X509_get_subject_name(leaf), subject, sizeof(subject));
    X509_NAME_oneline(X509_get_issuer_name(leaf), issuer, sizeof(issuer));
    X509_free(leaf);
  }
  fprintf(stderr,
          "tls verify ok host=%s verify=X509_V_OK bundled_roots=%d windows_roots=%d pin=none subject=%s issuer=%s\n",
          host ? host : "", bundled, windowsRoots, subject, issuer);
  STACK_OF(X509) *chain = SSL_get_peer_cert_chain(ssl);
  if (!chain) return;
  for (int i = 0; i < sk_X509_num(chain); i++) {
    X509 *x = sk_X509_value(chain, i);
    char name[256] = "";
    if (x) X509_NAME_oneline(X509_get_subject_name(x), name, sizeof(name));
    fprintf(stderr, "tls chain[%d]=%s\n", i, name);
  }
}

int stratum_tls_handshake(int fd, const char *host, const char *caFile, const char *pinHex, char *err, size_t errcap) {
  if (err && errcap) err[0] = 0;
  OPENSSL_init_ssl(0, NULL);
  g_ctx = SSL_CTX_new(TLS_client_method());
  if (!g_ctx) {
    tls_err(err, errcap, "tls ctx");
    return -1;
  }
  SSL_CTX_set_verify(g_ctx, SSL_VERIFY_PEER, verify_san_host);
  {
    X509_VERIFY_PARAM *vp = SSL_CTX_get0_param(g_ctx);
    if (vp) X509_VERIFY_PARAM_set_flags(vp, X509_V_FLAG_TRUSTED_FIRST);
  }
  int bundled = add_bundled_roots(g_ctx);
  if (bundled < 4) {
    tls_err(err, errcap, "tls bundled roots");
    return -1;
  }
  int windowsRoots = 0;
  if (caFile && caFile[0]) {
    if (SSL_CTX_load_verify_locations(g_ctx, caFile, NULL) != 1) {
      tls_err(err, errcap, "tls ca");
      return -1;
    }
  } else {
    SSL_CTX_set_default_verify_paths(g_ctx);
#ifdef _WIN32
    windowsRoots = load_windows_roots(g_ctx);
#endif
  }
  if (pinHex && pinHex[0]) {
    snprintf(err, errcap, "tls pin refused");
    return -1;
  }
  g_ssl = SSL_new(g_ctx);
  if (!g_ssl) {
    tls_err(err, errcap, "tls ssl");
    return -1;
  }
  SSL_set_fd(g_ssl, fd);
  g_tls_host[0] = 0;
  if (host && host[0]) {
    snprintf(g_tls_host, sizeof(g_tls_host), "%s", host);
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
  log_verified_chain(g_ssl, host, bundled, windowsRoots);
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
