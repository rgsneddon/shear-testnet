# Portable Shear node

Same node as `node node/src/node.js`. Pin is `PRODUCT_VERSION` (16.0, displayed Shear Sentinel v16). Continuum wallet is 0.67. The zip walks `pool/src/pool.js` so `posture.js` ships with the pool entry. Do not retag v9. Do not pass --clobber. Do not move git tag `v16`. Windows, Linux, and Fedora `shear-node-v16` zips are assets of https://github.com/rgsneddon/shear-testnet/releases/tag/0.67. Arch, openSUSE, and macOS node zips are not attached.

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
