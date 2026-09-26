window.SHEAR_DOCS = {
  tree: [
    { title: 'Start', children: [
      { id: 'overview', title: 'Overview' },
      { id: 'testnet', title: 'Testnet' },
      { id: 'whitepaper', title: 'Whitepaper' }
    ]},
    { title: 'Addresses', children: [
      { id: 'names', title: 'shear1, she1, ssa1' },
      { id: 'privacy', title: 'She is private' },
      { id: 'admit', title: 'ADMITv2' }
    ]},
    { title: 'Wallet', children: [
      { id: 'wallet', title: 'Overview' },
      { id: 'install', title: 'Install' },
      { id: 'android', title: 'Android APK' },
      { id: 'node-sync', title: 'Node-sync' },
      { id: 'continuum', title: 'Continuum' },
      { id: 'flow', title: 'Flow' },
      { id: 'resistance', title: 'Resistance' },
      { id: 'shearview', title: 'Shearview' },
      { id: 'closure', title: 'Closure' },
      { id: 'backup', title: 'shewall.bin' },
      { id: 'fees', title: 'Levy' }
    ]},
    { title: 'Mining', children: [
      { id: 'mine', title: 'How to mine' },
      { id: 'solo', title: 'Solo mine' },
      { id: 'sheark', title: 'ShearK 2.6' },
      { id: 'shares', title: 'Shares and PROP' },
      { id: 'hash-bonus', title: 'Hash bonus' }
    ]},
    { title: 'Vortex', children: [
      { id: 'vortex', title: 'Vortex tab' },
      { id: 'vortices', title: 'Vortices' },
      { id: 'vort1', title: 'vort1 keys' },
      { id: 'creators', title: 'Mint a vort1 key' }
    ]},
    { title: 'The Reserve', children: [
      { id: 'reserve', title: 'Overview' },
      { id: 'epochs', title: 'Epochs' },
      { id: 'stake', title: 'Stake, idle, lock' },
      { id: 'votes', title: 'Votes' },
      { id: 'oracle', title: 'Oracle' },
      { id: 'withdraw', title: 'Withdraw' }
    ]},
    { title: 'Network', children: [
      { id: 'node', title: 'Run a node' },
      { id: 'p2p', title: 'P2P' },
      { id: 'rpc', title: 'RPC' },
      { id: 'bootstrap', title: 'Bootstrap' },
      { id: 'prune', title: 'Prune-1000' },
      { id: 'ports', title: 'Ports' },
      { id: 'consensus', title: 'Consensus' },
      { id: 'header', title: 'Header' },
      { id: 'shearhash', title: 'ShearHash-v3' },
      { id: 'emissions', title: 'Emissions' },
      { id: 'confirms', title: 'Confirmations' },
      { id: 'pool', title: 'Public pool' },
      { id: 'explorer', title: 'Explorer' },
      { id: 'mempool', title: 'Mempool' },
      { id: 'stem', title: 'Stem then fluff' },
      { id: 'compact', title: 'Compact txs' },
      { id: 'gate', title: 'GATE' }
    ]}
  ],
  pages: {}
};

(function (P) {
  P.overview = {
    title: 'Shear',
    crumb: 'start / overview',
    html:
      '<p>Shear is a CPU-mined ledger. Coin is created when a block is found, not before. There is no premine and the developers do not sell SHE. You hash, or someone who already holds coin pays you.</p>' +
      '<p>ADMITv2 membership over this book\'s notes, with confidential amounts. Continuity-settled. PoW elects the tip. Offer a silent ID (<code>she1</code>) when someone pays you. Incoming coin lands on a revolving dest (<code>ssa1</code>). Rest-frame <code>shear1</code> stays in Closure. On the public pool, hash bonus (no 1% fee) and pot share accumulate and auto-pay to your miner <code>ssa1</code> at π SHE on the next sealed payout. The live network today is <code>shear-testnet-v5</code>. While this book has fewer than 10,000 notes the membership set is thin.</p>' +
      '<table><tr><th>Coin</th><td>SHE (11 protocol decimals; public pages show nine)</td></tr>' +
      '<tr><th>Algo</th><td>ShearHash-v3 (RandomX light, CPU)</td></tr>' +
      '<tr><th>Block pot</th><td>1.00 SHE in epoch 0, then −0.01 SHE/epoch to a 0.20 SHE floor (4d testnet / 400d mainnet)</td></tr>' +
      '<tr><th>Target interval</th><td>90 seconds (ASERT)</td></tr>' +
      '<tr><th>Spendable</th><td>protocol floor 6 confirmations (policy may freeze credits)</td></tr>' +
      '<tr><th>Levy cap</th><td>0.001 SHE</td></tr>' +
      '<tr><th>Stratum</th><td><code>pool.shear.digital:1111</code></td></tr>' +
      '<tr><th>Wallet pin</th><td>0.53</td></tr>' +
      '<tr><th>Miner pin</th><td>ShearK 2.6</td></tr></table>' +
      '<p>How-to lives in this tree. Docs live under <a href="https://shear.digital/docs/">https://shear.digital/docs/</a> (typed docs.shear.digital may fail TLS). The architecture note is a PDF at <a href="https://shear.digital/whitepaper/">https://shear.digital/whitepaper/</a> — that URL is not in the navbar on purpose.</p>'
  };

  P.testnet = {
    title: 'Testnet',
    crumb: 'start / testnet',
    html:
      '<p>This is testnet. Balances can vanish. Treat them as a practice run before mainnet.</p>' +
      '<p>This public testnet is the privacy-class book (<code>shear-testnet-v5</code>). Mainnet <code>shear-v1</code> is not live. A launch date is not decided. Do not cut a mainnet genesis zip from these pages.</p>' +
      '<p>Install clients only from the buttons on <a href="https://shear.digital">shear.digital</a> or the official GitHub tags. Windows SmartScreen may warn that ShearK-Miner.exe is unrecognized; this testnet build is not Authenticode-signed.</p>'
  };

  P.whitepaper = {
    title: 'Whitepaper',
    crumb: 'start / whitepaper',
    html:
      '<p>Version 2.0 of the project note: ADMITv2, node-sync wallets, prune-1000, bootstrap at height 1000 then every 400, ShearHash-v3, emissions, Flow levy, Vortex / vort1, The Reserve. Wallet pin 0.53. Live magic <code>shear-testnet-v5</code>.</p>' +
      '<p><a href="https://shear.digital/whitepaper/">https://shear.digital/whitepaper/</a> presents it as a record with a PDF preview. Download <code>shear-whitepaper.pdf</code> from that page. There is no WHITEPAPER button in the site navbar. Typed whitepaper.shear.digital may fail TLS (apex SAN).</p>'
  };

  P.names = {
    title: 'Three names, one holder',
    crumb: 'addresses / names',
    html:
      '<table><tr><th>Rest-frame</th><td><code>shear1…</code> — never share, never on chain</td></tr>' +
      '<tr><th>Silent ID</th><td><code>she1…</code> — offer this; never written as a vout</td></tr>' +
      '<tr><th>Dest</th><td><code>ssa1…</code> — revolving mailbox the book actually writes</td></tr></table>' +
      '<p>The wallet password is the view secret. Copy ID is the full <code>she1</code> payment code (scan + spend pubs). Copy dest is the stable Continuum <code>ssa1</code> mining mailbox (the string on screen — Copy dest copies it and does not mint a new dest). Two pays to one published code produce two <code>ssa1</code> dests. Miner login is Copy dest as a bare <code>ssa1</code>. A typed suffix is optional. Nodes keep <code>she1</code> and <code>shear1</code> off address fields on the book.</p>'
  };

  P.privacy = {
    title: 'She is private',
    crumb: 'addresses / privacy',
    html:
      '<p>The public explorer shows height, time, status, and type — no dest, no amount. Ciphertext and rest-frame strings stay off that page. Memo plaintext opens only with the stealth shared secret in the two wallets that scanned that dest.</p>' +
      '<p>Amounts are confidential. Dests are stealth. Stratum login is Copy dest (a bare <code>ssa1</code>). A typed suffix is optional. Hash bonuses land on that dest. Keep view secrets, rest-frame, seeds, and passwords off POST bodies and vortice hosts. There is no telemetry. While this book has fewer than 10,000 notes the membership set is thin.</p>'
  };

  P.wallet = {
    title: 'Wallet overview',
    crumb: 'wallet / overview',
    html:
      '<p>The Shear wallet is a six-tab app. It does not mine. Current pin is <strong>0.53</strong> (Windows, Linux, Arch, Android; macOS coming soon). Sync is a local node at <code>127.0.0.1:18332</code> — not flyclient, not pool HTTP as the only path. Magic <code>shear-testnet-v5</code>.</p>' +
      '<table><tr><th>Continuum</th><td>Spendable balance, <code>she1</code>, six-slice pending pie</td></tr>' +
      '<tr><th>Flow</th><td>Send and receive</td></tr>' +
      '<tr><th>Resistance</th><td>Tx detail</td></tr>' +
      '<tr><th>Vortex</th><td>Programmes (The Reserve, plus any vort1 you paste)</td></tr>' +
      '<tr><th>Shearview</th><td>Your explorer</td></tr>' +
      '<tr><th>Closure</th><td>Rest-frame, silent ID, <code>shewall.bin</code></td></tr></table>' +
      '<p>There is no paper seed. The password plus the export file is the wallet.</p>'
  };

  P.install = {
    title: 'Install the wallet',
    crumb: 'wallet / install',
    html:
      '<ol><li>On a Mac, open the disk image, drag Shear into Applications, eject, then launch from Applications. Do not keep running it from the image, a zip, or Downloads. On Windows or Linux, unzip and open the app. On Android, install the APK.</li>' +
      '<li>Choose a password of at least eight characters, type it again, tap <strong>Set password</strong>. That creates the wallet.</li>' +
      '<li>You will enter that password each time. If it is lost, the wallet cannot be opened. Fingerprint or face unlock, where the device offers it, only works on this device.</li>' +
      '<li>Continuum shows spendable SHE and your <code>she1</code>. Copy that when someone needs to pay you. Incoming coin lands on a private <code>ssa1</code>. Never share a <code>shear1</code> string.</li>' +
      '<li>Open Closure and export <code>shewall.bin</code>. Keep that file with the password.</li></ol>' +
      '<p>Tag: <a href="https://github.com/rgsneddon/shear-testnet/releases/tag/0.53">shear-testnet 0.53</a>. 0.48 is the previous public pack pin. 0.53 is the fuller Continuum wallet, with the bug fixes. macOS .dmg for 0.53 is a MacBook cut (coming soon).</p>'
  };

  P.android = {
    title: 'Android APK',
    crumb: 'wallet / android',
    html:
      '<p>Install <code>shear-wallet-0.53-android.apk</code> from the official 0.53 tag. Package id is <code>com.shear.shear_wallet</code>. The APK is a single fat package (all ABIs), INTERNET granted on the released file, not a split APK. Packed on Windows (Flutter + Android SDK); macOS <code>.dmg</code> stays a MacBook cut.</p>' +
      '<p>If a phone still says <strong>App not installed</strong>: uninstall the old debug-signed build first, then sideload 0.53. Do not install a Darwin zip or an unsigned copy. Camera and biometrics need the permissions already in the manifest.</p>'
  };

  P['node-sync'] = {
    title: 'Node-sync',
    crumb: 'wallet / node-sync',
    html:
      '<p>0.53 talks to a stock local node on <code>shear-testnet-v5</code>. Default seed is <code>http://127.0.0.1:18332</code>. Headers, compact blocks, and the tree root / jroot come from that node. Flyclient height sampling is not the send, balance, or history path. Hashbonus is dest-owned after 6 confs; the pot auto-pays at π after 30 confs.</p>' +
      '<p>Run <code>node node/src/node.js</code> on the same machine (or point the wallet at a node you trust). Public pool HTTP submit stays an advanced toggle with an IP warning. Do not use pool.shear.digital as the only sync path.</p>'
  };

  P.continuum = {
    title: 'Continuum',
    crumb: 'wallet / continuum',
    html:
      '<p>Continuum is spendable SHE and the pending pie. Each pending block fills one of six slices. Coin is protocol-spendable after 6 confirmations unless credits are frozen. Hash rewards sit inside the found block; they are not listed as their own rows. Continuum is not instant.</p>' +
      '<p>If Continuum stays 0 after 6+ confs while the pool shows sent, treat that as a wallet/sync bug (until soak is green on this book). Fallback sync is <a href="https://pool.shear.digital">https://pool.shear.digital</a> if local RPC is down; pool HUD is not spendable.</p>' +
      '<p>While a Flow send is still filling the pie, the sender row remarks <strong>sending</strong>. The recipient row remarks <strong>receive</strong>.</p>' +
      '<p>Copy ID copies your <code>she1</code>. Offer that, not rest-frame.</p>'
  };

  P.flow = {
    title: 'Flow',
    crumb: 'wallet / flow',
    html:
      '<p>Flow sends SHE to a <code>she1</code> or <code>ssa1</code>. Optional memo is ciphertext on the wire. The public explorer only shows that a memo exists.</p>' +
      '<p>Scan receive QR fills the dest. Amount sits below that button. After Send, the tab keeps an advisory: <strong>sent</strong> (green), a public-http / sync-tip line when that is why it failed, or <strong>not sent - try again</strong> (red) for unknown failures. That line stays on Flow so you can read it.</p>' +
      '<p>One levy is quoted for the send, from current mempool depth, never more than 0.001 SHE. Continuum spendable pays it. See Levy.</p>'
  };

  P.resistance = {
    title: 'Resistance',
    crumb: 'wallet / resistance',
    html:
      '<p>Resistance is Tx detail. Open a confirmed block from Shearview or the explorer and the same public fields print here. The CTF transcript sits behind an advanced toggle. No ciphertext, no rest-frame, no view key in the header.</p>'
  };

  P.shearview = {
    title: 'Shearview',
    crumb: 'wallet / shearview',
    html:
      '<p>Shearview is your dedicated explorer. Full blocks list at 6 confirmations. A Flow send or receive appears from 1 confirmation as <strong>pending</strong>, with <strong>sending</strong> on the payer wallet and <strong>receiving</strong> on the payee wallet. At 6 confirmations the pending remark drops; the row stays as sent / received. Mempool-only (0 conf) does not appear.</p>' +
      '<p>If someone sent you a memo, Shearview can show <strong>you have a new memo</strong>. Tap to expand, then Dismiss. The sender never sees that line.</p>'
  };

  P.closure = {
    title: 'Closure',
    crumb: 'wallet / closure',
    html:
      '<p>Closure holds the rest-frame <code>shear1</code> and the public <code>she1</code>. Rest-frame never goes on the book. Confirmed SHE settles here. Chain dests are <code>ssa1</code> mailboxes derived from this identity; they do not need to be kept after prune.</p>' +
      '<p>Settings: unlock with biometrics on this device. Password still encrypts <code>shewall.bin</code>.</p>'
  };

  P.backup = {
    title: 'shewall.bin',
    crumb: 'wallet / backup',
    html:
      '<p>Export from Closure. The file plus the password restore the same wallet on another machine. There is nothing to copy onto paper. Lose the password and the file does not open.</p>'
  };

  P.fees = {
    title: 'Levy',
    crumb: 'wallet / levy',
    html:
      '<p>Flow send, Reserve lock, and Reserve vote each pay one levy <code>L</code> quoted from mempool depth at that step. Withdraw of Reserve principal is not taxed. Hash bonus and the block pot are not taxed.</p>' +
      '<p><code>L_base</code> is the greater of 100 units and two basis points of the amount. Surge rises with waiting bytes. Empty-mempool floor is 100 units. <strong>L never exceeds 0.001 SHE</strong>, even on a large send or a crowded mempool. Continuum spendable pays <code>L</code>. Lock and vote quote separately — they can differ if the mempool moved between the two.</p>' +
      '<p>When the block that includes the taxed send seals, <code>L</code> is split 50/50. Half is paid to the block finder as <code>finder-fee</code> on the coinbase (that miner’s dest). The other half is <code>reserve-fee</code>, credited to The Reserve vault fee bank. If <code>L</code> is an odd number of units, the finder gets the floor of half and the vault gets the remainder.</p>'
  };

  P.mine = {
    title: 'How to mine',
    crumb: 'mining / how-to',
    html:
      '<p>Official miner is <strong>ShearK-Miner 2.6</strong>, CPU only. Login is wallet Copy dest as a bare <code>ssa1</code>. A typed suffix is optional.</p>' +
      '<pre>./ShearK-Miner --selftest\n' +
      './ShearK-Miner --pool pool.shear.digital:1111 --user YOUR_SSA1 --backend jit-full --threads 8</pre>' +
      '<p>Windows: <code>ShearK-Miner.exe</code> with the same flags. Downloads: <a href="https://github.com/rgsneddon/ShearK/releases/tag/2.6">ShearK 2.6</a>.</p>' +
      '<p>Public stratum <code>pool.shear.digital:1111</code> is <strong>cleartext TCP</strong> unless TLS is configured. Production pools should set <code>SHEAR_STRATUM_AUTH=1</code>.</p>' +
      '<p>The public pool takes 1% of the 1 SHE pot. Each hasher dest that produced proven work receives its own hash bonus in full on the next sealed block.</p>'
  };

  P.solo = {
    title: 'Solo mine',
    crumb: 'mining / solo',
    html:
      '<p>Solo means your node finds the block: you keep the live epoch pot plus your hash bonus. OS deps match README (apt, cmake, Node 20, rustup). The pool process must light-verify ShearHash-v3 on that same box. Without <code>crypto/native/shearhash.node</code> (or a 2.6 <code>ShearK-Miner</code> on <code>PATH</code> / <code>SHEARK_MINER</code>), every share comes back <code>native_missing</code>. Never copy a Darwin <code>.node</code> onto Linux. If make misses <code>node_api.h</code>, set <code>NODE_INC</code>.</p>' +
      '<pre>sudo apt-get update\nsudo apt-get install -y git curl build-essential cmake python3 pkg-config libssl-dev\ncurl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -\nsudo apt-get install -y nodejs\ncurl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y\n. "$HOME/.cargo/env"\ngit clone https://github.com/rgsneddon/shear-testnet.git\n' +
      'cd shear-testnet\ngit checkout 0.53\nnpm ci\n' +
      'cmake -S crypto/randomx -B crypto/randomx/build -DARCH=native\n' +
      'cmake --build crypto/randomx/build -j"$(nproc)"\n' +
      'make -C crypto/native\n' +
      'export SHEAR_SEEDS=p2p.shear.digital:30303,r2r.shear.digital:30303,b2b.shear.digital:30303\n' +
      'npm run solo</pre>' +
      '<p>Then point ShearK 2.6 at localhost. Login is Copy dest as a bare <code>ssa1</code>. Do not <code>npm run pool</code> for solo. A solo seal while any peer is ahead is refused. Public stratum is an optional alternate (cleartext TCP unless TLS is in front).</p>' +
      '<pre>./ShearK-Miner --selftest\n' +
      './ShearK-Miner --pool 127.0.0.1:1111 --user YOUR_SSA1 --threads 8</pre>'
  };

  P.sheark = {
    title: 'ShearK 2.6',
    crumb: 'mining / sheark',
    html:
      '<p>ShearK-Miner is the official hasher. Pin <strong>2.6</strong> (bare <code>ssa1</code>, abort on restamp, verify claimed digest). Do not recut 2.5. Default <code>--backend jit-full</code> is the 2 GiB dataset (same digest as light). Always run <code>--selftest</code> once on a new machine.</p>' +
      '<p>One login. No miner-fee dual-login. Keep any extra fee yourself if you run a private stratum.</p>'
  };

  P.shares = {
    title: 'Shares and PROP',
    crumb: 'mining / shares',
    html:
      '<p>Every stratum job is a full 128-byte header template. A share that is not a valid header hash mints nothing. Vardiff moves share bits with accepted-share rate and never exceeds current block bits.</p>' +
      '<p>When a block is found, the 1 SHE pot is split by proven work in that round (PROP) among hasher dests. Proven hashes are floor-share units, not the client counter. Hash bonuses pay separately to each of those dests.</p>'
  };

  P['hash-bonus'] = {
    title: 'Hash bonus',
    crumb: 'mining / hash bonus',
    html:
      '<p>Each proven floor share mints <strong>1 unit = 10<sup>−11</sup> SHE</strong> (256 units per floor share at eight bits) onto the hasher dest that produced it, on the next sealed network block. The block finder receives their own hashbonus and allows every other dest’s bonus to be sent on the same blockfind. Public pages show nine fractional digits, so a single hash looks like dust; the unit is still written into the payout.</p>' +
      '<p>The Reserve vote may raise or lower that unit by one, or leave it. The 1 SHE pot is not on the ballot.</p>'
  };

  P.vortex = {
    title: 'Vortex',
    crumb: 'vortex / tab',
    html:
      '<p>Vortex is a tab in the wallet. It is a drawer of programmes that run on Shear. Each programme is a vortice. The Reserve is already installed and cannot be removed. You do not browse a catalog of the rest. A vortice you pasted can be removed from this wallet only — the vort1 origin the creator published stays up.</p>'
  };

  P.vortices = {
    title: 'Vortices',
    crumb: 'vortex / vortices',
    html:
      '<p>A vortice is a hosted programme. Third-party vortices cannot mint SHE. They may move coin you already have, keep a vault, or pay rewards they have funded themselves. They cannot ask for a password, a backup file, or rest-frame. They cannot raise or lower the 1 SHE pot.</p>' +
      '<p>If the hosted file changes, the old key stops working. A new body needs a new key. Verify a third-party vortice before you paste anything. Open that vortice and tap <strong>Remove vortice</strong> to drop it from this wallet only. That does not take the programme down at the vort1 origin. The Reserve stays on Vortex for every user.</p>'
  };

  P.vort1 = {
    title: 'vort1 keys',
    crumb: 'vortex / vort1',
    html:
      '<p>A <code>vort1.</code> deploy key names an origin URL and pins a hash of the exact bytes that origin serves. In the wallet: Vortex → add new vortice → paste the key. The wallet fetches the origin, checks the pin, and deploys locally. You never type a web address. You never pick from a list. No key, no programme.</p>' +
      '<p>Reserved programme id <code>shear-reserve-v1</code> is not minted this way. It is already pinned as The Reserve.</p>'
  };

  P.creators = {
    title: 'Mint a vort1 key',
    crumb: 'vortex / creators',
    html:
      '<p>You host the dapp. The node only remembers origin and hash. Put the body at a stable <code>http</code> or <code>https</code> URL. If those bytes change, every key minted against the old body fails the hash check.</p>' +
      '<pre>store.mintVorticeDeployKey({\n' +
      "  programId: 'your-dapp-v1',\n" +
      "  name: 'Your Dapp',\n" +
      "  origin: 'https://your.host/vortice.json',\n" +
      '  source: exactBytesYouServe,\n' +
      '})</pre>' +
      '<p>The same fields are accepted by <code>POST /api/vortex/mint</code>. If the origin is already live, <code>mintVorticeFromOrigin</code> fetches it and pins those bytes. Programme id matches <code>^[a-z0-9._-]{3,64}$</code> and can be minted once on a given node.</p>' +
      '<p>Do not use reserved ids. Do not print SHE. Do not ask users for a Shear password. Keep serving the pinned bytes for as long as you want the key to work.</p>'
  };

  P.reserve = {
    title: 'The Reserve',
    crumb: 'reserve / overview',
    html:
      '<p>The Reserve is the first vortice and the only programme allowed to mint extra SHE. Open it from the Vortex tab. You lock SHE into your own portal. π SHE (about 3.14159265358 SHE) unlocks one vote for the current epoch. <strong>Your deposits</strong> shows two rows; extra deposits scroll inside that pane. A Reserve send shows your IP to the node. Use a VPN.</p>' +
      '<p>There is no Shear privacy hop. Confirm <strong>I already use a VPN / I accept exposing my IP</strong>, then Send. The same confirm is on Windows, Linux, Arch, and Android.</p>'
  };

  P.epochs = {
    title: 'Epochs',
    crumb: 'reserve / epochs',
    html:
      '<p>An epoch is 4 days on this testnet (400 days on mainnet). The first qualifying π deposit opens the inaugural epoch — not genesis, not an operator clock. Last 1 testnet day / 99 mainnet days: new deposits still lock and may vote, but they sit idle (no stake interest). Vote changes are only before that idle window.</p>'
  };

  P.stake = {
    title: 'Stake, idle, lock',
    crumb: 'reserve / stake',
    html:
      '<p>Staked principal earns the oracle APR for the full epoch (4 days testnet / 400 days mainnet). Idle coin earns nothing. Locked is staked plus idle. Daily credits sit in the portal until you withdraw after epoch end. One fee to add funds (lock); Continuum pays it.</p>'
  };

  P.votes = {
    title: 'Votes',
    crumb: 'reserve / votes',
    html:
      '<p>A vote may raise the hash bonus by one unit, lower it by one unit, or leave it. The 1 SHE pot does not change. Each portal votes once. After you seal, the Vortex pane keeps the chosen row with a green check; the other boxes and Cast vote go away.</p>' +
      '<p>Ownership of a vote is the dest-opening of the portal dest. A second vote in the same epoch is <code>vote_locked</code>. Public tallies show the three piles. They do not name who voted. At epoch end the unique plurality moves the live bonus, or a tie leaves it.</p>' +
      '<p>One fee to vote, quoted from mempool depth at that step.</p>'
  };

  P.oracle = {
    title: 'The Reserve oracle',
    crumb: 'reserve / oracle',
    html:
      '<p>The staking rate is an epoch APR observed by <code>shear-reserve-oracle-v1</code> (4-day testnet / 400-day mainnet), coded into every node. Freeze is bounded and fail-closed. A bad rate cannot reorg blocks or steal the pot. The wallet paints live observations as observational until freeze; mint uses frozen <code>epochBps</code> only.</p>'
  };

  P.withdraw = {
    title: 'Withdraw',
    crumb: 'reserve / withdraw',
    html:
      '<p>After epoch end (and bonus enact), principal plus minted interest on staked SHE return to Continuum on a signed Withdraw. Miss that window and previous-epoch rewards stay claimable; a new epoch does not confiscate them. Withdraw is not levied.</p>'
  };

  P.node = {
    title: 'Run a node',
    crumb: 'network / node',
    html:
      '<p>Release <a href="https://github.com/rgsneddon/shear-testnet/releases/tag/0.53">0.53</a>. A node is the book. It appends, verifies, speaks P2P, and runs the GATE that lets native Flow and pinned Reserve bytecode land in the same block. Continuum 0.53 reads this node, not flyclient. Startup does not pull a bootstrap.</p>' +
      '<pre>git clone https://github.com/rgsneddon/shear-testnet.git\n' +
      'cd shear-testnet\ngit checkout 0.53\nnpm ci\n' +
      'export SHEAR_DATA="$HOME/.shear/testnet-v5"\n' +
      'export SHEAR_NETWORK=shear-testnet-v5\n' +
      'export SHEAR_BOOTSTRAP=0\n' +
      'export SHEAR_REORG_HALT_DEPTH=0\n' +
      'export SHEAR_P2P_PORT=30303\n' +
      'export SHEAR_P2P_BIND=0.0.0.0\n' +
      'export SHEAR_RPC_PORT=18332\n' +
      'export SHEAR_RPC_BIND=127.0.0.1\n' +
      'export SHEAR_SEEDS=p2p.shear.digital:30303,r2r.shear.digital:30303,b2b.shear.digital:30303\n' +
      'node node/src/node.js</pre>' +
      '<p>Magic <code>shear-testnet-v5</code>. RPC loopback <code>127.0.0.1:18332</code>. P2P <code>0.0.0.0:30303</code>. It does not mine until you add <code>--solo</code> after the height has caught the public tip. Build RandomX and <code>crypto/native</code> on that machine. Never copy a macOS <code>shearhash.node</code> onto Linux, or an Ubuntu one onto Fedora.</p>' +
      '<p>Windows, same release, in PowerShell from the repo root: <code>git checkout 0.53</code>, <code>npm ci</code>, then set <code>$env:SHEAR_DATA</code>, <code>$env:SHEAR_NETWORK</code>, <code>$env:SHEAR_BOOTSTRAP="0"</code>, <code>$env:SHEAR_SEEDS</code> to the same list, and run <code>node node/src/node.js</code>. Arch uses the same shell as Linux.</p>' +
      '<p>Default sync is full archival IBD from those peers. Reorg checkpoints are height 1000, then every 400. Do not set <code>SHEAR_FAST_SYNC</code> on a mining node.</p>' +
      '<p>Tree: <a href="https://github.com/rgsneddon/shear-testnet/tree/main/node">rgsneddon/shear-testnet/node</a>.</p>'
  };

  P.consensus = {
    title: 'Consensus',
    crumb: 'network / consensus',
    html:
      '<p>Heaviest valid chain wins. Equal work keeps first-seen. Magic <code>shear-testnet-v5</code> on release 0.53. ADMITv2 membership over this book\'s notes, with confidential amounts. Extra mint is allowed only from <code>shear-reserve-v1</code>. Hash-tx law is consensus: proven floor shares collate per hasher dest, and each dest is paid its own bonus on the next coinbase.</p>'
  };

  P.header = {
    title: 'Header',
    crumb: 'network / header',
    html:
      '<p>128 bytes, little-endian: version, previous hash, merkle root, continuity root, Unix-ms timestamp, compact bits, nonce, base fee. Continuity root commits this round’s samples. After 100 confirmations the sample bodies may be pruned; header, coinbase, and user transactions stay.</p>'
  };

  P.shearhash = {
    title: 'ShearHash-v3',
    crumb: 'network / shearhash',
    html:
      '<p>RandomX v1.2.3 light mode: 128 MiB cache, no 2 GiB DRAM dataset. Salt <code>ShearHash-v3/rx</code>. Cache key is bound to previous hash, continuity root, merkle root, and bits — not miner identity. Verification is the light-mode interpreter. Mining may JIT if it matches the interpreter on the self-test vector. Wire name: ShearHash.</p>'
  };

  P.emissions = {
    title: 'Emissions',
    crumb: 'network / emissions',
    html:
      '<table><tr><th>Block pot</th><td>1 SHE, every found block</td></tr>' +
      '<tr><th>Hash bonus</th><td>10<sup>−11</sup> SHE per proven floor share, paid to that hasher dest on the next sealed block</td></tr>' +
      '<tr><th>The Reserve</th><td>Oracle interest on staked SHE — the only dapp mint</td></tr></table>' +
      '<p>Third-party vortices must top up rewards from coin already in circulation.</p>'
  };

  P.confirms = {
    title: 'Confirmations',
    crumb: 'network / confirms',
    html:
      '<p>Consensus spendable is 6 confirmations, counting the including block as 1 (~9 minutes at 90 s). Merchant desks may ask for 12, 30, or more. They may not ask for less than 6. 0-conf is not spendable.</p>'
  };

  P.pool = {
    title: 'Public pool',
    crumb: 'network / pool',
    html:
      '<p>The pool is stratum in front of a validating node, not the ledger. Dashboard: <a href="https://pool.shear.digital">pool.shear.digital</a>. Stratum <code>pool.shear.digital:1111</code>. Jobs are full header templates. CPU inventory is per TCP session, summed on the worker row. No dual-login fee route.</p>'
  };

  P.explorer = {
    title: 'Explorer',
    crumb: 'network / explorer',
    html:
      '<p><a href="https://explorer.shear.digital">explorer.shear.digital</a> paints confirmed blocks — height, time, status, kind. No amount column, no from-dest column. Last block is age of the tip. AVG BLOCK TIME is the mean interval of every sealed header since genesis. Search is by height or id. The Resistance CLI on that page is public fields only (header, kind, proofs).</p>'
  };

  P.mempool = {
    title: 'Mempool',
    crumb: 'network / mempool',
    html:
      '<p><a href="https://mempool.shear.digital">mempool.shear.digital</a> is the network logarithmic lattice: gold pending sends, cyan miners, purple confirming rings with tx counts, then the curling sealed chain. Levy surge is taken from waiting depth. Spendable policy on that page follows the API, not a hard-coded 6 in the HTML.</p>'
  };

  P.admit = {
    title: 'ADMITv2',
    crumb: 'addresses / admit',
    html:
      '<p>Membership is the full live fluxset of every <code>admitPub</code> on this book, in appearance order. A spend proves it belongs in that set. A sampled subset is the wrong set and fails <code>admit_membership</code>. A reused spend tag fails <code>admit_link_tag</code>. ADMITv2 is full-chain membership, not rings of N. While this book has fewer than 10,000 notes the set is thin.</p>'
  };

  P.p2p = {
    title: 'P2P',
    crumb: 'network / p2p',
    html:
      '<p>Port 30303. Magic <code>shear-testnet-v5</code>. A node on an older book drops a hello whose magic is not <code>shear-testnet-v5</code>. Do not dual-magic. IBD is headers then a window of getblocks (default 16 in flight); merkle and native PoW still run.</p>'
  };

  P.rpc = {
    title: 'RPC',
    crumb: 'network / rpc',
    html:
      '<p>Loopback only: <code>127.0.0.1:18332</code>. That is the wallet’s default. It serves headers, compact blocks, and jroot. HTTP 8088 is the pool dashboard, also loopback on the live box — never open 8088 on 0.0.0.0.</p>'
  };

  P.bootstrap = {
    title: 'Bootstrap',
    crumb: 'network / bootstrap',
    html:
      '<p>Optional. <a href="https://boot.shear.digital">boot.shear.digital</a> offers one file pair: <code>latest.json</code> + <code>latest.bin</code>. First published at height 1000, then overwritten every 400 blocks (1400, 1800, …). Not every prune. Copy <code>latest.bin</code> onto an empty datadir as <code>chain.bin</code>, then run the stock node. Empty datadir only. After apply, the node must still reach the live tip hash.</p>'
  };

  P.prune = {
    title: 'Prune-1000',
    crumb: 'network / prune',
    html:
      '<p>After 1000 confirmations a node drops Flow samples and share rows. Sealed transactions, coinbase vouts, headers, and merkle stay. First prune fires at tip 1001. Share-batch PoW may skip only where local depth is ≥ 1000 <em>and</em> <code>samplesPruned</code> — a peer flag alone is not enough.</p>'
  };

  P.ports = {
    title: 'Ports',
    crumb: 'network / ports',
    html:
      '<table><tr><th>P2P</th><td>30303 (public)</td></tr>' +
      '<tr><th>Stratum</th><td>1111 (public pool)</td></tr>' +
      '<tr><th>HTTP</th><td>8088 loopback (pool dashboard / explorer HTML)</td></tr>' +
      '<tr><th>RPC</th><td>18332 loopback (wallet node-sync)</td></tr></table>' +
      '<p>Defaults do not change. Combined pool/node on Dedicated-de is one process.</p>'
  };

  P.stem = {
    title: 'Stem then fluff',
    crumb: 'network / stem',
    html:
      '<p>User txs stem to one peer, then fluff. Stem logs do not join IP + dest + amount. Compact bodies still strip dest+nanos plaintext. This does not hide the pool’s IP.</p>'
  };

  P.compact = {
    title: 'Compact txs',
    crumb: 'network / compact',
    html:
      '<p>On disk and on the wire, Flow strips dest and nanos. Amounts stay as sealed commit C plus range. Reserve lock / vote / withdraw still carry portalId, dest20, and valueProof.v so the vault can credit without plaintext. Copy dest payload is dest20||B so mining notes can wrap r.</p>'
  };

  P.gate = {
    title: 'GATE',
    crumb: 'network / gate',
    html:
      '<p>The node GATE lets native Flow and pinned Reserve bytecode land in the same block. Extra mint is allowed only from programme id <code>shear-reserve-v1</code>. Third-party vortices cannot mint SHE.</p>'
  };
})(window.SHEAR_DOCS.pages);
