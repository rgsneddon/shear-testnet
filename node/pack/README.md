# Portable Shear node

Same node as `node node/src/node.js`. Pin is `PRODUCT_VERSION` 19.0, displayed Shear Sentinel v19. Continuum wallet is 0.72. The zip walks `pool/src/pool.js` so `posture.js` ships with the pool entry. Do not retag v9. Do not pass --clobber. Do not move git tags `v16`, `v17`, or `v18`. The pack name is `shear-node-v19-<flavor>.zip`. There is no published v19 release yet. Each zip is built on that OS. A Windows-only pack is not the release.

Build **on the OS you ship**. Native `shearhash.node` / `shearadmit.node` are not portable across OS.

```
python node/pack/zip_node.py windows
python node/pack/zip_node.py linux
python node/pack/zip_node.py fedora
```

User: unzip, run `shear-node.cmd` or `./shear-node.sh`. Optional `--solo` after `ibd=false`.
No automatic bootstrap. Manual files: https://boot.shear.digital
