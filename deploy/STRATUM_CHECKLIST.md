# Stratum live ops checklist

Do not wipe `/var/lib/shear/testnet-v4`. Do not invent a TLS certificate.

## Required unit env (tip)

Copy from `deploy/shear-pool.service` / `deploy/shear-pool-v4.service`:

- `SHEAR_STRATUM_BIND=127.0.0.1`
- `SHEAR_STRATUM_AUTH=1`

Dev dest-only (`SHEAR_STRATUM_BIND=0.0.0.0`, `SHEAR_STRATUM_AUTH=0`) is local-only. Production / fleet binds loopback.

## Confirm live

```
GET http://127.0.0.1:8088/api/stats
```

Must show `stratumBind` = `127.0.0.1` and `loginAuth` = `ed25519`.

## Reload

On the pool box (`77.42.91.84` per `HANDOFF_OPS.md`):

```
sudo bash /opt/shear-v4/deploy/reload-stratum-units.sh
```

Success prints `ok: live stats match tip BIND+AUTH units`. Fail prints `FAIL:` and a non-zero exit.

## TLS in front

Optional: terminate TLS on nginx/Caddy in front of `127.0.0.1:1111` (`pool/deploy/nginx-stratum-tls.conf`). This tree does not ship certificates. `stratumCleartext=true` on `/api/stats` is a warning, not a pass.

## Live fleet drop-in (testnet soak)

Helsinki pool (`77.42.91.84`) may have `/etc/systemd/system/shear-pool.service.d/testnet-stratum.conf` setting `SHEAR_STRATUM_BIND=0.0.0.0` and empty `SHEAR_STRATUM_AUTH` so dest-only ShearK can hit public `:1111`. That drop-in wins over the landed unit. Do **not** delete it or restart onto loopback+AUTH until a TLS terminator is in front of `127.0.0.1:1111`. This tree does not ship certificates.

## Do not

- Do not set `SHEAR_MAINNET_EMIT=1`
- Do not recut older ShearK tags
- Do not bind stratum to `0.0.0.0` on a production fleet without a documented testnet drop-in
- Do not wipe `/var/lib/shear/testnet-v4` for a BIND/AUTH reload
