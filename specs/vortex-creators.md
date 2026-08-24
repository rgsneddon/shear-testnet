# Vortex creators — minting a vortice deploy key

Shear does not host your dapp. You host it. The node mints a `vort1.` deploy key that names your origin and pins a hash of the exact bytes you serve. Holders paste that key in Vortex. The wallet fetches your origin, checks the hash, and deploys the dapp locally. There is no catalog browse: **no key, no dapp.**

The Reserve and The Join are pinned. They are not minted this way.

## What you host

Put the dapp body at a stable `http` or `https` URL. That body is what wallets download. If those bytes change, every key minted against the old body fails the hash check. Republish only when you intend to mint a new key.

Do not put Shear rest-frame `shear1` addresses, view keys, or seeds in the hosted body.

## What you must not do

- Use a reserved program id: `shear-reserve-v1`, `shear-join-v1`, `shear-join-watch-v1`.
- Print SHE. Third-party vortice cannot mint. If you pay rewards, top them up from SHE already in circulation.
- Ask users for a Shear password, twelve words, or a `join1.` migration key.
- Ship a key that points at an origin you do not control.

## Mint the key

On a Shear node (testnet `shear-testnet-v1`), call `store.mintVorticeDeployKey` with the program id, a short display name, the origin URL, and the **exact** bytes the origin will serve:

```
store.mintVorticeDeployKey({
  programId: 'your-dapp-v1',
  name: 'Your Dapp',
  origin: 'https://your.host/vortice.json',
  source: exactBytesYouServe,
})
```

The same fields are accepted by `POST /api/vortex/mint`. If the origin is already live, `store.mintVorticeFromOrigin({ programId, name, origin })` fetches it and pins those bytes.

You receive a `vort1.` key. Give that string to users. The node remembers the origin and the hash. It does **not** keep a copy of your dapp.

A program id can be minted once on a given node. Id must match `^[a-z0-9._-]{3,64}$`.

## What users do

In the Shear wallet: Vortex → Add new vortice → paste the `vort1.` key. A valid key is enough; the wallet downloads your origin, checks the pin, and deploys. They never type a URL. They never pick you from a list.

## After mint

Keep the origin serving the pinned bytes for as long as you want the key to work. A new body needs a new key. The 1 SHE block pot and the per-hash bonus are unchanged by any vortice you publish.
