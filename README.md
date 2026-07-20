<div align="center">

<img src="logo.png" alt="RELAX" width="120" height="120">

<h1>RELAX</h1>

<strong>Not another memecoin. A mindset.</strong>

<p>0 Fear. 0 Panic. 0 Regrets. Just RELAX</p>

<p>
<a href="https://0relaxbro.xyz">Website</a> ·
<a href="https://x.com/0relaxbro">X</a> ·
<a href="https://www.youtube.com/@0relaxbro">YouTube</a> ·
<a href="https://pump.fun/coin/6DDJ6Gsuvhe4Hb7zkohLBhDjKkyCxHsYt4thNukbpump">Pump.fun</a> ·
<a href="https://dexscreener.com/solana/5ztferjiljz3u4kzkwmguyujxcwkpagzfqwwyja7yzx3">DexScreener</a>
</p>

</div>

---

## What is RELAX

RELAX is a Solana-based community token built around one simple idea:
markets are chaotic, but your decisions don't have to be.

The story: RELAX survived it — not by ignoring the risk, but by
already pricing it in. He was there when the world ended, and made it
through when others gave up. Now he's here to share that calm, not
advice.

Built in public. Open source. Verify everything yourself.

**Built in public.** This entire site — code, design, and features — is
open for anyone to read, question, or fork.

## The Contract

```
6DDJ6Gsuvhe4Hb7zkohLBhDjKkyCxHsYt4thNukbpump
```

Always verify the contract address independently before interacting
with any token. Never trust a slogan — check the chain.

- Fixed supply, no additional minting
- No private creator allocation
- Public, on-chain verifiable

## What's in this repo

This is the full source of [0relaxbro.xyz](https://0relaxbro.xyz) — a
static site (no build step, no framework) hosted on GitHub Pages, plus
the Cloudflare Worker that backs its live features.

| File | What it is |
|---|---|
| `index.html` | The main site |
| `score.html` | RELAX Score — a live tool that reads a public Solana wallet's recent on-chain activity and estimates a FOMO / Panic / RELAX read, with a one-click shareable result card. No wallet connection, no signing, no cost. |
| `swap.html` | RELAX Swap — swap any Solana token, built on Jupiter's Swap V2 Meta-Aggregator (Metis + JupiterZ + Dflow + OKX). 0% RELAX platform fee, for everyone, always — not a holder discount. Non-custodial: every transaction is signed by your own wallet, landed through Jupiter's own managed infrastructure. |
| `swap-hybrid-test.html` | RELAX Swap Hybrid Engine (Experiment 003) — a research branch, not the live swap. Compares Jupiter's 0%-fee Router path against the same Meta-Aggregator flow above and only picks Router when it's genuinely cheaper by a real margin; otherwise the proven Meta-Aggregator path is used, identical to `swap.html`. `noindex`, not linked from the main nav — reachable via a small link on the live Swap page for anyone who wants to try it early. |
| `holder-verification.js` | Shared wallet-connection module — Swap and Swap Hybrid Engine both use it purely for connect/disconnect/getConnection. It also contains a `$20+ $RELAX holder` balance check, kept ready but not currently called by any live tool (the Swap fee is 0% for everyone, no holder gating today) — reserved for future perks (NFT Creator / RELAX Market). |
| `worker.js` | The Cloudflare Worker behind everything live: a permission-limited Solana RPC proxy, the Jupiter order/execute/token-search proxy (keeps the API key server-side), and the on-the-fly share-card image generator. |
| `wrangler.toml` | Worker deployment config. |
| `404.html` | Custom not-found page |
| `manifest.json` | PWA metadata (favicons, add-to-home-screen) |

## RELAX Swap (Experiment 002)

`swap.html` swaps any Solana token — not a fixed list — built on
Jupiter's Swap V2 Meta-Aggregator, which competes Metis, JupiterZ,
Dflow, and OKX for the best available route and lands the transaction
through Jupiter's own managed infrastructure (Beam). Every swap is
signed by your own wallet; RELAX never holds, custodies, or has access
to your SOL, tokens, or NFTs at any point, in any tool.

**RELAX's own platform fee is 0% — for everyone, always**, not a
holder discount. Jupiter's own fee and the order's estimated total
cost, when applicable, are shown transparently before you sign —
never hidden. $20+ $RELAX holder status doesn't affect the Swap fee;
it's reserved for perks on future tools (NFT Creator, RELAX Market).

Selecting a token outside the small pinned set (SOL / USDC / $RELAX)
surfaces a risk banner if it isn't on Jupiter's verified list, or if
it has a freeze authority or permanent delegate set — the same class
of signal Jupiter's own swap UI surfaces. Always verify the token
you're swapping yourself; RELAX does not curate, endorse, or guarantee
any token available through the swap interface.

## RELAX Swap Hybrid Engine (Experiment 003)

An in-progress research branch, not the live Swap. `swap-hybrid-test.html`
tries Jupiter's Router path (0% Jupiter fee, but a mandatory ~0.001 SOL
network tip) alongside the same Meta-Aggregator flow `swap.html` uses,
and only selects Router when it's verified — via a real cost
simulation and a safety margin — to actually leave more in your
wallet. In every other case (no route, failed simulation, or the
difference isn't clearly meaningful) it falls back to the exact same
proven Meta-Aggregator path as the live Swap, so it's never worse than
`swap.html`, only sometimes better on larger trades.

`noindex`, not linked from the main site navigation — reachable via a
small "try the experimental Swap Hybrid Engine" link on the live Swap
page for anyone curious enough to test it early.

## RELAX Score (Experiment 001)

Our first experiment: can public on-chain behavior reveal something
about FOMO and panic patterns? `score.html` reads up to 30 days of a
wallet's transaction history directly from Solana's public network,
proxied through a Cloudflare Worker with a method allowlist — no API
key ever touches the client, no backend database, no data stored
anywhere.

It surfaces five signals: FOMO Signal, Panic Signal, RELAX Score,
estimated wallet age, and average token holding time — all derived
from transaction patterns, not price history.

It's a heuristic, not financial analysis. It can be wrong. It's
labeled as an experiment because it is one.

Any result can be shared as a real image card, generated on the fly
— no manual screenshotting.

## Philosophy

- **Observe.** Watch the market without reacting to every candle.
- **Build.** Ship things that are actually ready, not announced early.
- **Experiment.** Test ideas in the open. Some will work. Some won't.
- **Evolve.** No fixed roadmap with fake dates — just honest iteration.

## Not financial advice

RELAX is a community token, not an investment vehicle. Crypto assets
are volatile and carry real risk. Always do your own research and
verify the contract before making any decision.

---

<div align="center">

<strong>Just RELAX Bro.</strong>

</div>
