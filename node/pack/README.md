# Portable Shear node

Same node as `node node/src/node.js`. Source pin is `PRODUCT_VERSION` 19.0, displayed Shear Sentinel v19. Continuum wallet is 0.72. Magic is `shear-testnet-v12`. The zip walks `pool/src/pool.js` so `posture.js` ships with the pool entry. Do not retag v9. Do not pass --clobber. Do not move git tags `v16`, `v17`, `v18`, `0.70`, or `0.71`. Published packs remain `shear-node-v18-windows.zip`, `shear-node-v18-linux.zip`, and `shear-node-v18-fedora.zip` on tag v18. A v19 zip is not uploaded by this tree. Each zip is built on that OS. A Windows-only pack is not the release.

Build **on the OS you ship**. Native `shearhash.node` / `shearadmit.node` are not portable across OS.

```
python node/pack/zip_node.py windows
python node/pack/zip_node.py linux
python node/pack/zip_node.py fedora
```

User: unzip, run `shear-node.cmd` or `./shear-node.sh`. Optional `--solo` after `ibd=false`.
No automatic bootstrap. Manual files: https://boot.shear.digital
