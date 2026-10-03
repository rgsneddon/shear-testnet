#ifndef SHEARK_STRATUM_TLS_H
#define SHEARK_STRATUM_TLS_H

#include <stddef.h>

/* 0 ok, -1 fail (err set). caFile may be null (system trust). pinHex may be null. */
int stratum_tls_handshake(int fd, const char *host, const char *caFile, const char *pinHex, char *err, size_t errcap);
int stratum_tls_write(const char *buf, int n);
int stratum_tls_read(char *buf, int cap);
void stratum_tls_close(void);
int stratum_tls_active(void);

#endif
