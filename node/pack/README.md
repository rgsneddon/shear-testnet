# Portable Shear node

Same node as `node node/src/node.js`. Pin is `PRODUCT_VERSION` 17.0, displayed Shear Sentinel v17. Continuum wallet is 0.68. The zip walks `pool/src/pool.js` so `posture.js` ships with the pool entry. Do not retag v9. Do not pass --clobber. Do not move git tag `v16`. The six zips `shear-node-v17-windows.zip`, `shear-node-v17-linux.zip`, `shear-node-v17-archlinux.zip`, `shear-node-v17-fedora.zip`, `shear-node-v17-opensuse.zip`, and `shear-node-v17-macos.zip` are one release: https://github.com/rgsneddon/shear-testnet/releases/tag/v17. Each zip is built on that OS. A Windows-only pack is not the release.

Build **on the OS you ship**. Native `shearhash.node` / `shearadmit.node` are not portable across OS.

```
python node/pack/zip_node.py windows
python node/pack/zip_node.py linux
python node/pack/zip_node.py archlinux
python node/pack/zip_node.py fedora
python node/pack/zip_node.py opensuse
sh node/pack/pack_macos.sh
```

User: unzip, run `shear-node.cmd` or `./shear-node.sh`. Optional `--solo` after `ibd=false`.
No automatic bootstrap. Manual files: https://boot.shear.digital
