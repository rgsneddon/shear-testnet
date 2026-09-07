# Seed box: p2p.shear.digital (46.224.132.83)

Validating node + P2P only. **Do not start the book until the cutover goal.**
Do not open stratum. Do not serve HTTP. Do not install `shear-testnet-v2` as the running network here.

## Role

- Hostname: **p2p.shear.digital**
- A record: `46.224.132.83`
- Bind: **`0.0.0.0:30303`** (not the hostname)
- RPC: `127.0.0.1` only
- Datadir: `/var/lib/shear/mainnet` (separate from testnet)
- Magic: `shear-v1`

## Do not

- Do not restart Germany `178.105.187.178` systemd
- Do not open **1111**, **80**, or **443**
- Do not mine `shear-testnet-v2` into this datadir
- Do not publish genesis hash from this box in this goal

## Ubuntu 22.04 / 24.04

```
sudo useradd --system --home /var/lib/shear --shell /usr/sbin/nologin shear || true
sudo mkdir -p /var/lib/shear/mainnet /opt/shear-node
sudo chown -R shear:shear /var/lib/shear /opt/shear-node
```

Node 20+:

```
sudo apt-get update
sudo apt-get install -y nodejs
```

Install the node tree into `/opt/shear-node` (this repo copy). Unit file:

```
sudo install -m 644 deploy/shear-node-mainnet.service /etc/systemd/system/shear-node-mainnet.service
sudo systemctl daemon-reload
# Do not enable/start until cutover.
```

## ufw

```
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from OPERATOR_IP to any port 22 proto tcp
sudo ufw allow 30303/tcp
sudo ufw deny 1111
sudo ufw deny 80
sudo ufw deny 443
sudo ufw enable
```

## Seeds (order is not authority)

- `p2p.shear.digital:30303`
- `46.224.132.83:30303` (fallback)
- `178.105.187.178:30303` (future equal peer; do not restart Germany)

## After install, before cutover

`systemctl is-active shear-node-mainnet` must stay **inactive**.
`ss -lntp | grep 1111` must be empty.
