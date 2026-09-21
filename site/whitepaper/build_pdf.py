#!/usr/bin/env python3
"""Build the Shear whitepaper PDF (Times, A4). Run from this directory."""
from __future__ import annotations

from pathlib import Path

from fpdf import FPDF
from fpdf.enums import XPos, YPos

HERE = Path(__file__).resolve().parent
OUT = HERE / "shear-whitepaper.pdf"


def _font_pair():
    mac = Path("/System/Library/Fonts/Supplemental")
    win = Path(r"C:\Windows\Fonts")
    if (mac / "Times New Roman.ttf").exists():
        return (
            mac / "Times New Roman.ttf",
            mac / "Times New Roman Bold.ttf",
            mac / "Times New Roman Italic.ttf",
            mac / "Times New Roman Bold Italic.ttf",
        )
    if (win / "times.ttf").exists():
        return (win / "times.ttf", win / "timesbd.ttf", win / "timesi.ttf", win / "timesbi.ttf")
    raise FileNotFoundError("Times New Roman not found (macOS Supplemental or Windows Fonts)")


FONT, FONT_B, FONT_I, FONT_BI = _font_pair()


class Paper(FPDF):
    def header(self):
        if self.page_no() == 1:
            return
        self.set_font("ShearSerif", "I", 9)
        self.set_text_color(90, 90, 90)
        self.cell(
            0,
            8,
            "Shear  ·  Continuity-settled proof of work  ·  testnet preprint",
            align="C",
            new_x=XPos.LMARGIN,
            new_y=YPos.NEXT,
        )
        self.ln(4)
        self.set_draw_color(180, 180, 180)
        self.line(25, 16, 210 - 25, 16)
        self.ln(6)
        self.set_text_color(0, 0, 0)

    def footer(self):
        self.set_y(-16)
        self.set_font("ShearSerif", "", 9)
        self.set_text_color(90, 90, 90)
        self.cell(0, 8, str(self.page_no()), align="C", new_x=XPos.LMARGIN, new_y=YPos.NEXT)


def h1(pdf: Paper, text: str):
    pdf.ln(4)
    pdf.set_font("ShearSerif", "B", 13)
    pdf.multi_cell(0, 7, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(2)


def h2(pdf: Paper, text: str):
    pdf.ln(3)
    pdf.set_font("ShearSerif", "B", 11.5)
    pdf.multi_cell(0, 6.5, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(1)


def body(pdf: Paper, text: str):
    pdf.set_font("ShearSerif", "", 11)
    pdf.multi_cell(0, 5.6, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(2)


def italic(pdf: Paper, text: str):
    pdf.set_font("ShearSerif", "I", 11)
    pdf.multi_cell(0, 5.6, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(2)


def bullet(pdf: Paper, items: list[str]):
    pdf.set_font("ShearSerif", "", 11)
    for item in items:
        x = pdf.l_margin
        pdf.set_x(x)
        pdf.cell(6, 5.6, "•", new_x=XPos.END, new_y=YPos.LAST)
        pdf.multi_cell(0, 5.6, item, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(1)


def main() -> None:
    pdf = Paper(format="A4", unit="mm")
    pdf.set_auto_page_break(auto=True, margin=22)
    pdf.set_margins(25, 22, 25)
    pdf.add_font("ShearSerif", "", FONT)
    pdf.add_font("ShearSerif", "B", FONT_B)
    pdf.add_font("ShearSerif", "I", FONT_I)
    pdf.add_font("ShearSerif", "BI", FONT_BI)
    pdf.add_page()
    pdf.set_xy(25, 22)

    pdf.set_font("ShearSerif", "", 10)
    pdf.set_text_color(80, 80, 80)
    pdf.multi_cell(0, 6, "SHEAR PREPRINT  ·  TESTNET  ·  13 September 2026", align="C", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(4)
    pdf.set_text_color(0, 0, 0)

    pdf.set_font("ShearSerif", "B", 18)
    pdf.multi_cell(0, 8, "Shear: Continuity-settled Proof of Work", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(2)
    pdf.set_font("ShearSerif", "", 12)
    pdf.multi_cell(0, 6, "Shear project", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("ShearSerif", "I", 11)
    pdf.multi_cell(0, 6, "shear.digital  ·  Version 2.0 (testnet)  ·  Network magic shear-testnet-v4", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(4)

    pdf.set_font("ShearSerif", "B", 11)
    pdf.multi_cell(0, 6, "Abstract", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(1)
    italic(
        pdf,
        "Shear is a CPU-mined ledger whose coin, SHE, is created when a block is found and not before. "
        "There is no premine and no sale of SHE by the developers. Privacy is the default: the rest-frame "
        "identity never appears on the book; holders offer a silent ID and the chain writes revolving dests. "
        "Proof of work is ShearHash-v3, a RandomX light-mode parameterisation. A found block closes exactly "
        "one SHE. Each hasher dest that produced proven work receives its own hash bonus on the next sealed block. The only programme "
        "allowed to mint extra SHE is The Reserve, a vortice in which holders lock coin, vote on that hash bonus, "
        "and earn a 400-day stake. This note states the project’s goals and the architecture that carries them.",
    )

    pdf.set_font("ShearSerif", "", 10)
    pdf.multi_cell(
        0,
        5,
        "Keywords: Shear, SHE, ShearHash-v3, RandomX, continuity-tethered Flow, Vortex, vort1, The Reserve, CPU mining",
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )
    pdf.ln(2)

    h1(pdf, "1.  Goals")
    body(
        pdf,
        "Shear is built around a short list of decisions that are not supposed to drift.",
    )
    bullet(
        pdf,
        [
            "PoW elects the tip. Coin comes from hashing, not from an allocation, an auction, or a snapshot of some other book.",
            "CPU only. ShearHash-v3 is RandomX light.",
            "Private dests, confidential amounts. ADMITv2 membership over this book’s notes. Rest-frame shear1 stays in Closure. Holders offer she1. Settled dests are ssa1.",
            "One coin per block. The pot is 1 SHE. Votes leave the pot in place. The Reserve oracle leaves the pot in place.",
            "Each hasher dest keeps its own bonus. Finding the block leaves every other dest’s hashes with that dest.",
            "Programmes may move coin you already have. They may not print SHE, other than The Reserve’s interest.",
            "No catalog of third-party programmes. A vortice is installed with a vort1 deploy key, or it is not installed.",
        ],
    )
    body(
        pdf,
        "The public sites — shear.digital, pool.shear.digital, explorer.shear.digital, mempool.shear.digital — "
        "are the face of the testnet. Live magic is shear-testnet-v4. Mainnet shear-v1 is not live "
        "and a launch date is not decided. "
        "Testnet balances can vanish. Treat them as a practice run.",
    )

    h1(pdf, "2.  Architecture")
    h2(pdf, "2.1  Three names, one holder")
    body(
        pdf,
        "A wallet is sealed by a password. That password is the view secret. From it the wallet derives a rest-frame "
        "identity (shear1), a public silent ID (she1), and a revolving family of chain dests (ssa1). The rest-frame "
        "string stays off vouts and off stratum. The silent ID is what you hand to a payer. "
        "Copy dest (ssa1) is the mailbox the book writes and the login you mine with. The same (rest-frame, view secret, index) always regenerates the "
        "same dest. Nodes keep shear1 off the wire.",
    )
    body(
        pdf,
        "Optional memos travel as ciphertext. The public explorer reports only whether a memo is present. Plaintext "
        "stays in the two wallets that already know the dest.",
    )

    h2(pdf, "2.2  Header, work, and time")
    body(
        pdf,
        "Blocks are 128-byte little-endian headers: version, previous hash, merkle root of packed transactions, "
        "continuity root, Unix-millisecond timestamp, compact bits, nonce, and a base-fee field. Proof of work is "
        "ShearHash-v3 of that header, compared with the target implied by bits. The continuity root commits this "
        "round’s hash samples. After a hundred confirmations the sample bodies may be pruned; the header, the "
        "coinbase, and every user transaction stay.",
    )
    body(
        pdf,
        "Resistance retargets with ASERT toward ninety seconds. Floor 14 bits, ceiling 256 bits. Heaviest valid "
        "chain wins. Consensus spendable depth is six confirmations, counting the including block as one. Merchant "
        "desks may ask for more; they may not ask for less than six.",
    )

    h2(pdf, "2.3  ShearHash-v3")
    body(
        pdf,
        "ShearHash-v3 is RandomX v1.2.3 in light mode: 128 MiB cache, no 2 GiB DRAM dataset copy. The cache key "
        "is bound to previous hash, continuity root, merkle root, and bits, so it rebuilds every block and does not "
        "include miner identity. Mining may JIT if the digest matches the interpreter on the self-test vector. "
        "Verification is the light-mode interpreter. Wire algorithm name is ShearHash. Personalisation is ShearHash-v3. "
        "The official hasher is ShearK-Miner 2.5.",
    )

    h2(pdf, "2.4  Emissions")
    body(
        pdf,
        "Three paths, and they do not stand in for each other. First, the block pot: exactly 1 SHE in the coinbase. "
        "Solo, the finder takes it. On the public pool it is split by proven work in that round (PROP); the pool may "
        "keep one percent of the pot. Second, the hash bonus: one protocol unit, 10^-11 SHE, for each proven floor share, "
        "paid to the hasher dest that produced it on the next sealed block. Public pages show nine fractional digits so a single hash looks like dust; "
        "the unit is still written. Third, The Reserve: interest on staked SHE at the oracle rate, minted only by "
        "programme id shear-reserve-v1. Any other vortice that wants to pay rewards must top them up from coin already "
        "in circulation.",
    )

    h2(pdf, "2.5  Flow and levy")
    body(
        pdf,
        "Continuity-tethered Flow is how SHE moves between dests. A send quotes a levy L from current mempool depth. "
        "L_base is the greater of 100 units and two basis points of the amount; surge rises with waiting bytes. Lock "
        "and vote in The Reserve pay the same levy. Withdraw of Reserve principal does not. The Continuum dest pays L. "
        "Empty-mempool floor is 100 units.",
    )

    h2(pdf, "2.6  Wallet")
    body(
        pdf,
        "The wallet is a six-tab app, pin 0.46. Continuum is spendable balance, silent ID, and the six-slice pending pie. "
        "Flow is send and receive. Resistance is Tx detail. Vortex is where programmes live. Shearview is "
        "the holder’s own explorer. Closure holds the rest-frame string and the shewall.bin export. The file plus "
        "the password restore the same wallet. There is no paper seed. Lose the password and the file does not open. "
        "Sync is a local node at 127.0.0.1:18332: headers, compact blocks, and the tree root. The old height sampler is not the send, balance, or history path. Pool HTTP submit is an advanced toggle.",
    )

    h2(pdf, "2.7  Vortex, vortices, and vort1")
    body(
        pdf,
        "Vortex is a drawer, not a chain of contracts you browse. Each programme in it is a vortice. The Reserve is "
        "already installed. Anyone else hosts their own bytes. A Shear node mints a vort1 deploy key that names the "
        "origin URL and pins a hash of those exact bytes. The holder pastes the key; the wallet fetches the origin, "
        "checks the pin, and deploys locally. No key, no programme. If the hosted file changes, the old key stops "
        "working. Third-party vortices cannot mint SHE, cannot ask for a password, and cannot move the 1 SHE pot.",
    )

    h2(pdf, "2.8  The Reserve")
    body(
        pdf,
        "The Reserve is the first vortice and the only one allowed to mint. A holder locks SHE into a personal portal. "
        "π SHE (about 3.14159265358 SHE) unlocks one vote for the current 400-day epoch. The first qualifying deposit "
        "opens the inaugural epoch; it is not started by an operator clock. Staked principal earns the oracle’s 400-day "
        "APR. Idle coin earns nothing. Inside the last 99 days, new deposits still lock and may vote, but they sit idle. "
        "A vote may raise the hash bonus by one unit, lower it by one unit, or leave it. The pot is not on the ballot. "
        "Each portal votes once. At epoch end the unique plurality of the three piles moves the live bonus, or a tie "
        "leaves it. Principal and accrued interest return to Continuum on a signed withdraw. Miss the window and "
        "previous-epoch rewards stay claimable; a new epoch does not confiscate them.",
    )

    h2(pdf, "2.9  Pool, explorer, node")
    body(
        pdf,
        "The public pool is stratum in front of a validating node, not the ledger. Jobs are full 128-byte header "
        "templates. Shares that are not a valid header hash mint nothing. Stratum listens on pool.shear.digital:1111. "
        "Login is Copy dest as ssa1.worker. The explorer paints confirmed blocks, kinds, and proof-ok — no dest safari, no amount column. Ciphertext "
        "and rest-frame strings stay off that page. A node is the book: append, verify, P2P, and the GATE that lets "
        "native Flow and pinned Reserve bytecode land in the same block model. "
        "Shipped P2P seeds are p2p.shear.digital:30303, r2r.shear.digital:30303, b2b.shear.digital:30303, magic shear-testnet-v4. Wallet 0.46 reads a local node at 127.0.0.1:18332. "
        "After 1000 confirmations, sample rows prune; sealed txs stay. An optional latest-only snapshot is published at height 1000, then every 400 blocks.",
    )

    h1(pdf, "3.  Publication")
    body(
        pdf,
        "This is a testnet preprint. Constants here match the live fingerprint: 1 SHE pot, 10^-11 SHE per proven floor share "
        "paid per hasher dest, six-confirmation spendable floor, ASERT 90 s, ShearHash-v3 light, chain id 2701 for pool withdraw signatures. How-to pages — "
        "installing the wallet, pointing ShearK at the pool, opening The Reserve, minting a vort1 key — live at "
        "shear.digital/docs. The clients are the WALLET, MINER, and NODE buttons on shear.digital.",
    )
    body(
        pdf,
        "She is private.",
    )

    pdf.ln(6)
    pdf.set_draw_color(180, 180, 180)
    pdf.line(25, pdf.get_y(), 210 - 25, pdf.get_y())
    pdf.ln(4)
    pdf.set_font("ShearSerif", "I", 9)
    pdf.set_text_color(80, 80, 80)
    pdf.multi_cell(
        0,
        5,
        "Correspondence: shear.digital. Software under the MIT License, Copyright 2026 Shear. "
        "RandomX is vendored from tevador/RandomX v1.2.3 (BSD). Official miner ShearK-Miner 2.5. "
        "Wallet pin at publication: 0.46.",
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )

    pdf.set_title("Shear: Continuity-settled Proof of Work")
    pdf.set_author("Shear")
    pdf.set_subject("Testnet whitepaper")
    pdf.set_keywords("shear-testnet-v4 ADMITv2 wallet-0.46 ShearK-2.5, ShearHash-v3, Vortex, vort1, The Reserve")
    pdf.set_creator("Shear whitepaper builder")
    OUT.write_bytes(pdf.output())
    print("wrote", OUT, OUT.stat().st_size)


if __name__ == "__main__":
    main()
