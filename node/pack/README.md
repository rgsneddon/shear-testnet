# Portable Shear node

Same node as `node node/src/node.js`. Pin is `PRODUCT_VERSION` (9.0, displayed v9). Continuum wallet is 0.58. Tag `v7` stays.

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
