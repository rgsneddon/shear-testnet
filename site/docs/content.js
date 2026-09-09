window.SHEAR_DOCS = {
  tree: [
    { title: 'Start', children: [
      { id: 'overview', title: 'Overview' },
      { id: 'testnet', title: 'Testnet' },
      { id: 'whitepaper', title: 'Whitepaper' }
    ]},
    { title: 'Addresses', children: [
      { id: 'names', title: 'shear1, she1, ssa1' },
      { id: 'privacy', title: 'She is private' }
    ]},
    { title: 'Wallet', children: [
      { id: 'wallet', title: 'Overview' },
      { id: 'install', title: 'Install' },
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
      { id: 'sheark', title: 'ShearK 1.6' },
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
      { id: 'consensus', title: 'Consensus' },
      { id: 'header', title: 'Header' },
      { id: 'shearhash', title: 'ShearHash-v3' },
      { id: 'emissions', title: 'Emissions' },
      { id: 'confirms', title: 'Confirmations' },
      { id: 'pool', title: 'Public pool' },
      { id: 'explorer', title: 'Explorer' },
      { id: 'mempool', title: 'Mempool' }
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
      '<p>Private dests, public amounts. Continuity-settled. PoW elects the tip. The live network today is <code>shear-testnet-v2</code>.</p>' +
      '<table><tr><th>Coin</th><td>SHE (11 protocol decimals; public pages show nine)</td></tr>' +
      '<tr><th>Algo</th><td>ShearHash-v3 (RandomX light, CPU)</td></tr>' +
      '<tr><th>Block pot</th><td>Exactly 1 SHE</td></tr>' +
      '<tr><th>Target interval</th><td>90 seconds (ASERT)</td></tr>' +
      '<tr><th>Spendable</th><td>6 confirmations</td></tr>' +
      '<tr><th>Levy cap</th><td>0.001 SHE</td></tr>' +
      '<tr><th>Stratum</th><td><code>pool.shear.digital:1111</code></td></tr>' +
      '<tr><th>Wallet pin</th><td>0.29</td></tr>' +
      '<tr><th>Miner pin</th><td>ShearK 1.6</td></tr></table>' +
      '<p>How-to lives in this tree. The architecture note is a PDF at <a href="https://whitepaper.shear.digital">whitepaper.shear.digital</a> — that URL is not in the navbar on purpose.</p>'
  };

  P.testnet = {
    title: 'Testnet',
    crumb: 'start / testnet',
    html:
      '<p>This is testnet. Balances can vanish. Treat them as a practice run before mainnet.</p>' +
      '<p>Mainnet <code>shear-v1</code> is not scheduled. Do not launch until P0 1–14 on a public testnet book are green. Until then the magic stays <code>shear-testnet-v2</code>. Do not flip it early. Do not cut a mainnet genesis zip from these pages.</p>' +
      '<p>Install clients only from the buttons on <a href="https://shear.digital">shear.digital</a> or the official GitHub tags. Windows SmartScreen may warn that ShearK-Miner.exe is unrecognized; this testnet build is not Authenticode-signed.</p>'
  };

  P.whitepaper = {
    title: 'Whitepaper',
    crumb: 'start / whitepaper',
    html:
      '<p>The project note is a four-page preprint: goals, addresses, header, ShearHash-v3, emissions, Flow levy, wallet, Vortex / vort1, The Reserve, pool and node.</p>' +
      '<p><a href="https://whitepaper.shear.digital">whitepaper.shear.digital</a> presents it as a record with a PDF preview. Download <code>shear-whitepaper.pdf</code> from that page. There is no WHITEPAPER button in the site navbar.</p>'
  };

  P.names = {
    title: 'Three names, one holder',
    crumb: 'addresses / names',
    html:
      '<table><tr><th>Rest-frame</th><td><code>shear1…</code> — never share, never on chain</td></tr>' +
      '<tr><th>Silent ID</th><td><code>she1…</code> — offer this; never written as a vout</td></tr>' +
      '<tr><th>Dest</th><td><code>ssa1…</code> — revolving mailbox the book actually writes</td></tr></table>' +
      '<p>The wallet password is the view secret. Same rest-frame, view secret and index always regenerate the same dest. Miner login is <code>she1</code> or <code>ssa1</code>. A <code>she1</code> login pays the matching dest; the <code>she1</code> string never goes on the book. Nodes reject a block that puts <code>shear1</code> in a vout.</p>'
  };

  P.privacy = {
    title: 'She is private',
    crumb: 'addresses / privacy',
    html:
      '<p>The public explorer reports amounts, dests, and whether a memo exists. It does not show ciphertext and it does not show rest-frame strings. Memo plaintext stays in the two wallets that already know the dest.</p>' +
      '<p>Never POST a view secret, a rest-frame, or a password. Never put those in a vortice body you host.</p>'
  };

  P.wallet = {
    title: 'Wallet overview',
    crumb: 'wallet / overview',
    html:
      '<p>The Shear wallet is a six-tab app. It does not mine. Current pin is <strong>0.29</strong> (macOS, Android, leftover Windows / Linux / Arch).</p>' +
      '<table><tr><th>Continuum</th><td>Spendable balance, <code>she1</code>, six-slice pending pie</td></tr>' +
      '<tr><th>Flow</th><td>Send and receive</td></tr>' +
      '<tr><th>Resistance</th><td>Public CTF CLI</td></tr>' +
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
      '<p>Tag: <a href="https://github.com/rgsneddon/shear-testnet/releases/tag/0.29">shear-testnet 0.29</a>.</p>'
  };

  P.continuum = {
    title: 'Continuum',
    crumb: 'wallet / continuum',
    html:
      '<p>Continuum is spendable SHE and the pending pie. Each pending block fills one of six slices. Coin is spendable at 6 confirmations. Hash rewards sit inside the found block; they are not listed as their own rows.</p>' +
      '<p>While a Flow send is still filling the pie, the sender row remarks <strong>sending</strong>. The recipient row remarks <strong>receive</strong>.</p>' +
      '<p>Copy ID copies your <code>she1</code>. Offer that, not rest-frame.</p>'
  };

  P.flow = {
    title: 'Flow',
    crumb: 'wallet / flow',
    html:
      '<p>Flow sends SHE to a <code>she1</code> or <code>ssa1</code>. Optional memo is ciphertext on the wire. The public explorer only shows that a memo exists.</p>' +
      '<p>Scan receive QR fills the dest. Amount sits below that button. After Send, the tab keeps an advisory: <strong>sent</strong> (green) or <strong>not sent - try again</strong> (red). That line stays on Flow so you can read it.</p>' +
      '<p>One levy is quoted for the send, from current mempool depth, never more than 0.001 SHE. Continuum spendable pays it. See Levy.</p>'
  };

  P.resistance = {
    title: 'Resistance',
    crumb: 'wallet / resistance',
    html:
      '<p>Resistance is a public CTF CLI. Open a confirmed block from Shearview or the explorer and the same public fields print here. No ciphertext, no rest-frame, no view key.</p>'
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
      '<p>Official miner is <strong>ShearK-Miner 1.6</strong>, CPU only. Log in with your wallet <code>she1</code> (never <code>shear1</code>).</p>' +
      '<pre>./ShearK-Miner --selftest\n' +
      './ShearK-Miner --pool pool.shear.digital:1111 --user YOUR_SHE1.worker --dest YOUR_SSA1 --backend jit --threads 8</pre>' +
      '<p>Windows: <code>ShearK-Miner.exe</code> with the same flags. <code>.worker</code> is only a name. Downloads: <a href="https://github.com/rgsneddon/ShearK/releases/tag/1.6">ShearK 1.6</a>.</p>' +
      '<p>The public pool takes 1% of the 1 SHE pot. Hash bonuses are paid in full to the hasher who produced them.</p>'
  };

  P.solo = {
    title: 'Solo mine',
    crumb: 'mining / solo',
    html:
      '<p>Solo means your node finds the block: you keep the whole 1 SHE pot plus your hash bonus.</p>' +
      '<pre>git clone --depth 1 https://github.com/rgsneddon/shear-testnet.git\n' +
      'cd shear-testnet\nnpm install\nnpm run pool</pre>' +
      '<p>Then point ShearK at localhost:</p>' +
      '<pre>./ShearK-Miner --pool 127.0.0.1:1111 --user YOUR_SHE1.solo --threads 8</pre>' +
      '<p>You still need the RandomX native addon on that box or shares come back <code>hash_failed</code>.</p>'
  };

  P.sheark = {
    title: 'ShearK 1.6',
    crumb: 'mining / sheark',
    html:
      '<p>ShearK-Miner is the official hasher. Pin <strong>1.6</strong>. Do not recut 1.1 or 1.0. Default <code>--backend jit</code> is ShearHash-v3 light JIT. Always run <code>--selftest</code> once on a new machine.</p>' +
      '<p>One login. No miner-fee dual-login. Keep any extra fee yourself if you run a private stratum.</p>'
  };

  P.shares = {
    title: 'Shares and PROP',
    crumb: 'mining / shares',
    html:
      '<p>Every stratum job is a full 128-byte header template. A share that is not a valid header hash mints nothing. Vardiff moves share bits with accepted-share rate and never exceeds current block bits.</p>' +
      '<p>When a block is found, the 1 SHE pot is split by proven work in that round (PROP). Proven hashes are <code>2^shareBits</code> per accepted share, not the client counter. Hash bonuses are not PROP-split.</p>'
  };

  P['hash-bonus'] = {
    title: 'Hash bonus',
    crumb: 'mining / hash bonus',
    html:
      '<p>Each accepted hash mints <strong>1 unit = 10<sup>−11</sup> SHE</strong> to the miner who produced it. The block finder does not scoop anyone else’s bonus. Public pages show nine fractional digits, so a single hash looks like dust; the unit is still written into the payout.</p>' +
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
      '<p>The Reserve is the first vortice and the only programme allowed to mint extra SHE. Open it from the Vortex tab. You lock SHE into your own portal. π SHE (about 3.14159265358 SHE) unlocks one vote for the current epoch. <strong>Your deposits</strong> shows two rows; extra deposits scroll inside that pane.</p>'
  };

  P.epochs = {
    title: 'Epochs',
    crumb: 'reserve / epochs',
    html:
      '<p>An epoch is 400 days. The first qualifying π deposit opens the inaugural epoch — not genesis, not an operator clock. Last 99 days: new deposits still lock and may vote, but they sit idle (no stake interest). Vote changes are only in the first 301 days.</p>'
  };

  P.stake = {
    title: 'Stake, idle, lock',
    crumb: 'reserve / stake',
    html:
      '<p>Staked principal earns the oracle APR for the full 400 days. Idle coin earns nothing. Locked is staked plus idle. Daily credits sit in the portal until you withdraw after epoch end. One fee to add funds (lock); Continuum pays it.</p>'
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
      '<p>The staking rate is a 400-day APR observed by <code>shear-reserve-oracle-v1</code>, coded into every node. Consensus of the chain does not depend on this feed. A bad rate cannot reorg blocks or steal the 1 SHE pot. The wallet paints it as <strong>Oracle observed Apr</strong>.</p>'
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
      '<p>Node source is the NODE button on the main site. A node is the book: append, verify, P2P, and the GATE that lets native Flow and pinned Reserve bytecode land in the same block. Build RandomX on the box; never copy a macOS <code>shearhash.node</code> onto Linux.</p>' +
      '<p>Tree: <a href="https://github.com/rgsneddon/shear-testnet/tree/main/node">rgsneddon/shear-testnet/node</a>.</p>'
  };

  P.consensus = {
    title: 'Consensus',
    crumb: 'network / consensus',
    html:
      '<p>Heaviest valid chain wins. Equal work keeps first-seen. Magic <code>shear-testnet-v2</code>. Extra mint is allowed only from <code>shear-reserve-v1</code>. Hash-tx law is consensus: 1 hash = 1 bonus unit, collated per miner, never one JSON object per hash.</p>'
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
      '<tr><th>Hash bonus</th><td>10<sup>−11</sup> SHE per accepted hash, to that hasher</td></tr>' +
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
      '<p><a href="https://explorer.shear.digital">explorer.shear.digital</a> paints confirmed blocks, public amounts, dests, and Reserve vault stats. Last block is age of the tip. AVG BLOCK TIME is the mean interval of every sealed header since genesis. The block list is the whole chain, newest first, ten rows in view; scroll for the rest. Search is by height, id, from, to. The Resistance CLI on that page is public fields only.</p>'
  };

  P.mempool = {
    title: 'Mempool',
    crumb: 'network / mempool',
    html:
      '<p><a href="https://mempool.shear.digital">mempool.shear.digital</a> shows in-flight work. Levy surge is taken from waiting depth. Spendable policy on that page follows the API, not a hard-coded 6 in the HTML.</p>'
  };
})(window.SHEAR_DOCS.pages);
