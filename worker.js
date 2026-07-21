// RELAX RPC Proxy + Share Card generator
// - Existing behavior (POST /): secure Helius RPC proxy, unchanged.
// - New (GET /og): renders a PNG share card for a given score.
// - New (GET /share): tiny HTML page with Open Graph tags pointing at
//   the /og image, so X (and anywhere else) shows a rich preview card
//   automatically — no manual image attach needed, on mobile or desktop.
// - New (GET /pumpfun-price): server-side proxy for pump.fun's bonding-
//   curve price data. This MUST be proxied — frontend-api-v3.pump.fun
//   blocks browser-origin (CORS) requests, so calling it directly from
//   index.html/swap.html's client-side JS fails. This route does the
//   fetch server-side and returns a small, clean JSON shape.
//   NOTE: this hits an unofficial/reverse-engineered pump.fun endpoint,
//   not a documented public API — the response shape could change
//   without notice. Revisit if RELAX graduates off the bonding curve
//   (at that point, DexScreener becomes the correct source again).

import { ImageResponse } from "workers-og";
import { html } from "satori-html";

const ALLOWED_METHODS = new Set([
	"getSignaturesForAddress",
	"getTransaction",
	// Added for Holder Verification (shared module used by Swap, Creator,
	// Market) — read-only, only returns token account balances, never
	// signs or moves anything.
	"getTokenAccountsByOwner",
	// Added for the "Max" balance-fill button in Swap — reads native SOL
	// balance (SPL token balances already covered by
	// getTokenAccountsByOwner above). Read-only.
	"getBalance",
	// Added (19 Jul 2026) for the Swap Hybrid Engine branch
	// (swap-hybrid-test.html) only — NOT used by the live v1.0 swap.html.
	// Router-path transactions are built and signed client-side (unlike
	// the live swap's /order+/execute, which Jupiter builds and lands
	// for us), so this worker needs two things back that were removed
	// below: a way to simulate before signing (compute unit estimation
	// — Jupiter's own /build doesn't include a CU limit, only a price)
	// and a way to poll for on-chain confirmation after /submit, which
	// — unlike /execute — does not confirm landing itself. Both are
	// read-only/status-only: simulateTransaction never broadcasts
	// anything, and getSignatureStatuses only reads status for a
	// signature that's already been submitted elsewhere.
	"simulateTransaction",
	"getSignatureStatuses",
	// Added (19 Jul 2026, review round 2) — also for the Hybrid
	// Research branch only: confirmRouterSignature() now genuinely
	// checks the transaction's lastValidBlockHeight against the chain's
	// current block height (per Jupiter's own reference confirmation
	// flow), so an expired blockhash surfaces as a clear "expired,
	// never landed" instead of a 30-second ambiguous timeout.
	// Read-only: returns a single integer, takes no parameters of
	// consequence.
	"getBlockHeight",
	// Added (21 Jul 2026) for NFT Creator (nft-creator.html) only —
	// mirrors the same "client-side build+sign, no Jupiter/Beam to
	// land it" situation as the Hybrid Engine's Router path, so it
	// needs the same category of RPC support: a fresh blockhash to
	// build against, the real rent-exempt minimum for the new mint
	// account (queried live — rent rates can change, never hardcoded),
	// and a way to actually broadcast the fully-signed transaction
	// (Swap never needed this since Jupiter's /execute or /submit did
	// the sending; minting a raw Token Metadata NFT has no equivalent
	// managed-send endpoint). sendTransaction here only ever forwards
	// a transaction the connected wallet has ALREADY fully signed —
	// same "forward already-signed data" principle as everything else
	// in this file, not a new capability to send arbitrary/unsigned
	// instructions.
	"getLatestBlockhash",
	"getMinimumBalanceForRentExemption",
	"sendTransaction",
	// Added (21 Jul 2026, confirmed via the actual 403 error's JSON
	// body during real devnet testing — not guessed): Irys's own
	// uploader calls this internally (via @solana/web3.js's Connection
	// class) as part of its own fee estimation for funding
	// transactions. Read-only, computes a fee estimate for a given
	// message — doesn't move funds, doesn't reveal anything beyond
	// public blockchain state. Useful on mainnet too (once
	// DEVNET_MODE flips off in irys-web-provider.js), not devnet-only
	// like requestAirdrop above.
	"getFeeForMessage"
	// REMOVED (18 Jul 2026), reinstated in part (19 Jul 2026, then
	// again 21 Jul 2026): sendTransaction, getLatestBlockhash — these
	// existed for the old self-managed send/confirm flow (build tx,
	// sign, send via our own RPC, poll for confirmation). The live
	// swap.html still doesn't need these — it uses Jupiter's Swap V2
	// /execute endpoint, which handles sending, landing (via Jupiter
	// Beam), and confirmation. The Hybrid Research branch's Router
	// path signs a raw-instruction transaction and needs blockhash/CU
	// handling of its own (see swap-hybrid-test.html), and /submit
	// handles ITS broadcast — Router still doesn't call
	// sendTransaction directly. NFT Creator (21 Jul 2026, see above)
	// is the first tool with no managed-send equivalent at all, hence
	// sendTransaction being genuinely needed and reinstated for real
	// this time. Add anything else deliberately, not by assumption.
]);

const MAX_BODY_BYTES = 20000;
const SITE_URL = "https://0relaxbro.xyz/score.html";
const RELAX_MINT = "6DDJ6Gsuvhe4Hb7zkohLBhDjKkyCxHsYt4thNukbpump";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// RESOURCE ISOLATION (17 Jul 2026): RELAX Score can fire up to ~60
// getTransaction calls in a single wallet scan — by far the heaviest
// Helius usage on the site. Everything else (Swap balance checks via
// getTokenAccountsByOwner/getBalance, holder verification) is
// comparatively light, occasional traffic — Swap's actual transaction
// sending no longer goes through Helius at all as of 18 Jul 2026
// (Jupiter's /execute handles that now). Sharing one Helius key/credit
// pool still meant a burst of Score usage could exhaust the quota that
// these lighter reads depend on. A batch is routed to the dedicated Score key only if EVERY call
// in it is one of these; any batch containing anything else (including
// a mixed batch) uses the main key, so nothing Swap/holder-verification
// depends on can ever be routed through Score's pool.
const SCORE_ONLY_METHODS = new Set(["getSignaturesForAddress", "getTransaction"]);

// SECURITY (17 Jul 2026, updated 18 Jul 2026): jupiter-order/jupiter-execute
// (and the v1 routes they replaced) were open to any
// origin (Access-Control-Allow-Origin: "*"), meaning any other website
// could call them from a visitor's browser and burn RELAX's Jupiter API
// quota for free. Restricting to the real site closes that off for
// browser-based abuse. Note this does NOT stop a direct server-to-server
// or curl request — CORS only constrains browsers — so it's paired with
// body-size limits, basic parameter validation, and upstream timeouts
// below. Real abuse-rate protection belongs in Cloudflare's dashboard
// (Security > WAF > Rate limiting rules, free tier covers this) — code
// alone can reduce the damage per request, not the request rate itself.
function jupiterCorsHeaders(env) {
	return {
		"Access-Control-Allow-Origin": env.CORS_ALLOW_ORIGIN || "https://0relaxbro.xyz",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "86400",
		"Content-Type": "application/json"
	};
}

// Small cache to avoid hammering pump.fun on every page load across all
// visitors — Cloudflare Workers can share a short-lived in-memory cache
// per instance. This is best-effort, not a correctness guarantee.
let pumpfunPriceCache = { data: null, fetchedAt: 0 };
const PUMPFUN_CACHE_MS = 15000;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return handleRootLanding();
		}

		if (request.method === "GET" && url.pathname === "/og") {
			return handleOgImage(url);
		}

		if (request.method === "GET" && url.pathname === "/share") {
			return handleSharePage(url, request);
		}

		if (request.method === "GET" && url.pathname === "/pumpfun-price") {
			return handlePumpfunPrice(request);
		}

		// CUTOVER COMPLETE (18 Jul 2026): swap.html now uses the v2
		// order/execute flow exclusively — see SWAP_V2_MIGRATION_PLAN.md.
		// The old v1 quote/swap routes (Metis-only, self-managed send)
		// have been removed; nothing references them anymore.
		if (request.method === "GET" && url.pathname === "/jupiter-order") {
			return handleJupiterOrder(url, env);
		}

		if (request.method === "POST" && url.pathname === "/jupiter-execute") {
			return handleJupiterExecute(request, env);
		}

		// FIX (19 Jul 2026): token search/lookup was calling
		// lite-api.jup.ag DIRECTLY from the browser — the one place in
		// swap.html that still broke the "never call a third-party API
		// unauthenticated from the client" rule the rest of this worker
		// exists to enforce. lite-api.jup.ag is also flagged in Jupiter's
		// own docs as deprecated (a date that's already passed as of this
		// writing) — routing through our own worker onto the paid,
		// stable api.jup.ag endpoint fixes both problems at once, same
		// pattern as order/execute.
		if (request.method === "GET" && url.pathname === "/jupiter-token-search") {
			return handleJupiterTokenSearch(url, env);
		}

		// RESEARCH ONLY (19 Jul 2026): backs an isolated, unlinked test
		// page exploring the "Metis Hybrid" idea documented in
		// SWAP_V2_MIGRATION_PLAN.md — Router path (/build, Metis-only,
		// 0 Jupiter fee) tried first, falling back to the live
		// order/execute (Meta-Aggregator) path when Router can't find a
		// route. Does not touch or replace the live routes above.
		if (request.method === "GET" && url.pathname === "/jupiter-build") {
			return handleJupiterBuild(url, env);
		}

		if (request.method === "POST" && url.pathname === "/jupiter-submit") {
			return handleJupiterSubmit(request, env);
		}

		if (request.method === "OPTIONS" && (url.pathname === "/jupiter-order" || url.pathname === "/jupiter-execute" || url.pathname === "/jupiter-token-search" || url.pathname === "/jupiter-build" || url.pathname === "/jupiter-submit")) {
			return new Response(null, { headers: jupiterCorsHeaders(env) });
		}

		// Note: a /rpc-full route (wider RPC allowlist for Jupiter) was
		// added and then removed in the same session — Jupiter Plugin
		// (the current, correct product) needs no RPC endpoint at all,
		// it's "Powered by Ultra" on Jupiter's own infrastructure. Not
		// leaving unused surface area around for something that turned
		// out to be unnecessary.

		// Added (21 Jul 2026, urgent fix): NFT Creator's own devnet
		// testing REQUIRES a real devnet RPC route — the default
		// handleRpcProxy() below has always forwarded to mainnet
		// Helius, with no devnet path at all. A prior version of
		// nft-creator.html displayed a "NOT YET DEVNET-TESTED" banner
		// while actually being wired to this mainnet-only endpoint —
		// meaning any "test" attempt would have spent real mainnet SOL
		// while implying a safe, no-stakes devnet trial. Caught via
		// review before any real testing happened; this dedicated
		// route is the fix. Separate pathname, separate upstream
		// (devnet.helius-rpc.com), same allowlist/CORS/body-size
		// protections as the mainnet route — genuinely isolated, not
		// just a flag on the same handler.
		if (url.pathname === "/rpc-devnet") {
			return handleRpcProxy(request, env, "devnet");
		}

		return handleRpcProxy(request, env, "mainnet");
	}
};

/* ============================================================
   Jupiter Swap V2 Meta-Aggregator proxy — keeps JUPITER_API_KEY
   entirely server-side. RELAX Swap (swap.html) is public, static
   HTML/JS hosted on GitHub Pages — anything hardcoded in it is
   visible to anyone. Embedding the Jupiter key directly there (as an
   early version of this feature briefly did) was flagged as
   unacceptable even though the key itself can't move funds — the
   rule going forward is: NO secret, however low-risk, lives in
   client-side code. Same pattern as HELIUS_API_KEY below.

   Set the key with: wrangler secret put JUPITER_API_KEY
   ============================================================ */
/* ============================================================
   Swap V2 Meta-Aggregator (GET /order + POST /execute) — the live
   swap flow as of 18 Jul 2026, backing both swap.html (production)
   and swap-v2-test.html (kept around for further comparison testing).
   Replaced the old Metis-only v1 quote/swap flow entirely — see
   SWAP_V2_MIGRATION_PLAN.md for the full research trail.

   Deliberately NEVER sets a "payer" param — per Jupiter's own docs,
   setting a payer different from the taker (integrator-sponsored gas)
   is what disables JupiterZ routing. We never sponsor gas here, so
   JupiterZ stays available and we get the full meta-aggregation
   benefit. Users remain economically responsible for network costs
   either way — sometimes paid as a separate SOL transaction, sometimes
   recovered through a gasless order's total fee — this param only
   controls who technically signs for it, not who ultimately pays.
   ============================================================ */
async function handleJupiterOrder(url, env) {
	const corsHeaders = jupiterCorsHeaders(env);

	if (!env.JUPITER_API_KEY) {
		return jsonError("Server misconfigured: missing Jupiter API key.", 500, corsHeaders);
	}

	const params = url.searchParams;
	const inputMint = params.get("inputMint");
	const outputMint = params.get("outputMint");
	const amount = params.get("amount");
	const taker = params.get("taker");

	if (!inputMint || !BASE58_RE.test(inputMint)) {
		return jsonError("Invalid or missing inputMint.", 400, corsHeaders);
	}
	if (!outputMint || !BASE58_RE.test(outputMint)) {
		return jsonError("Invalid or missing outputMint.", 400, corsHeaders);
	}
	if (!amount || !/^[0-9]{1,20}$/.test(amount) || BigInt(amount) <= 0n || BigInt(amount) > 10n ** 18n) {
		return jsonError("Invalid amount.", 400, corsHeaders);
	}
	// taker is optional per Jupiter's docs (omitting it returns quote
	// fields with no transaction). Real swap quotes always have a
	// connected wallet, so taker stays required by default — a request
	// without one is almost certainly a mistake. EXCEPT (19 Jul 2026,
	// review round 2): the Hybrid Research branch needs a tiny
	// SOL->USDC reference quote purely for a USD-per-lamport rate, and
	// used to fake this by passing the System Program address as
	// taker. That's exactly the case Jupiter's own docs cover with a
	// taker-less quote — so allow it here, but only when the caller
	// explicitly says quoteOnly=true, keeping the strict taker
	// requirement for every real swap quote.
	const quoteOnly = params.get("quoteOnly") === "true";
	if (!quoteOnly && (!taker || !BASE58_RE.test(taker))) {
		return jsonError("Invalid or missing taker (connect a wallet first).", 400, corsHeaders);
	}
	if (quoteOnly && taker !== null) {
		return jsonError("quoteOnly requests must not include a taker.", 400, corsHeaders);
	}

	// RELAX platform fee is 0% on this path per the migration plan —
	// no referralAccount/referralFee ever added here. "payer" is never
	// set either, for the JupiterZ reason noted above.
	const upstreamParams = new URLSearchParams({ inputMint, outputMint, amount });
	if (!quoteOnly) upstreamParams.set("taker", taker);

	let upstream;
	try {
		upstream = await fetch("https://api.jup.ag/swap/v2/order?" + upstreamParams.toString(), {
			headers: { "x-api-key": env.JUPITER_API_KEY },
			signal: AbortSignal.timeout(15000)
		});
	} catch (err) {
		const timedOut = err && err.name === "TimeoutError";
		return jsonError(
			timedOut ? "Jupiter order request timed out." : "Jupiter order request failed.",
			timedOut ? 504 : 502,
			corsHeaders
		);
	}

	const body = await upstream.text();
	return new Response(body, {
		status: upstream.status,
		headers: corsHeaders
	});
}

async function handleJupiterExecute(request, env) {
	const corsHeaders = jupiterCorsHeaders(env);

	if (!env.JUPITER_API_KEY) {
		return jsonError("Server misconfigured: missing Jupiter API key.", 500, corsHeaders);
	}

	const contentLength = Number(request.headers.get("content-length") || 0);
	if (contentLength > MAX_BODY_BYTES) {
		return jsonError("Request body too large.", 413, corsHeaders);
	}

	let payload;
	try {
		payload = await request.json();
	} catch (err) {
		return jsonError("Invalid JSON body.", 400, corsHeaders);
	}

	if (!payload || typeof payload !== "object") {
		return jsonError("Invalid request body.", 400, corsHeaders);
	}
	if (!payload.signedTransaction || typeof payload.signedTransaction !== "string") {
		return jsonError("Missing or invalid signedTransaction.", 400, corsHeaders);
	}
	if (!payload.requestId || typeof payload.requestId !== "string") {
		return jsonError("Missing or invalid requestId.", 400, corsHeaders);
	}

	let upstream;
	try {
		upstream = await fetch("https://api.jup.ag/swap/v2/execute", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": env.JUPITER_API_KEY
			},
			body: JSON.stringify({
				signedTransaction: payload.signedTransaction,
				requestId: payload.requestId
			}),
			signal: AbortSignal.timeout(30000) // longer: this call waits for Jupiter's own managed landing
		});
	} catch (err) {
		const timedOut = err && err.name === "TimeoutError";
		return jsonError(
			timedOut ? "Jupiter execute request timed out." : "Jupiter execute request failed.",
			timedOut ? 504 : 502,
			corsHeaders
		);
	}

	const body = await upstream.text();
	return new Response(body, {
		status: upstream.status,
		headers: corsHeaders
	});
}

async function handleJupiterTokenSearch(url, env) {
	const corsHeaders = jupiterCorsHeaders(env);

	if (!env.JUPITER_API_KEY) {
		return jsonError("Server misconfigured: missing Jupiter API key.", 500, corsHeaders);
	}

	const query = url.searchParams.get("query");

	if (!query || !query.trim() || query.trim().length > 100) {
		return jsonError("Invalid or missing query.", 400, corsHeaders);
	}

	let upstream;
	try {
		upstream = await fetch(
			"https://api.jup.ag/tokens/v2/search?query=" + encodeURIComponent(query.trim()),
			{
				headers: { "x-api-key": env.JUPITER_API_KEY },
				signal: AbortSignal.timeout(10000)
			}
		);
	} catch (err) {
		const timedOut = err && err.name === "TimeoutError";
		return jsonError(
			timedOut ? "Token search request timed out." : "Token search request failed.",
			timedOut ? 504 : 502,
			corsHeaders
		);
	}

	const body = await upstream.text();
	return new Response(body, {
		status: upstream.status,
		headers: corsHeaders
	});
}

/* ============================================================
   RESEARCH ONLY (19 Jul 2026) — Router path (Metis-only, 0 Jupiter
   fee). See SWAP_V2_MIGRATION_PLAN.md "Swap Hybrid Engine". Backs
   an isolated, unlinked test page only.
   ============================================================ */
async function handleJupiterBuild(url, env) {
	const corsHeaders = jupiterCorsHeaders(env);

	if (!env.JUPITER_API_KEY) {
		return jsonError("Server misconfigured: missing Jupiter API key.", 500, corsHeaders);
	}

	const params = url.searchParams;
	const inputMint = params.get("inputMint");
	const outputMint = params.get("outputMint");
	const amount = params.get("amount");
	const taker = params.get("taker");

	if (!inputMint || !BASE58_RE.test(inputMint)) {
		return jsonError("Invalid or missing inputMint.", 400, corsHeaders);
	}
	if (!outputMint || !BASE58_RE.test(outputMint)) {
		return jsonError("Invalid or missing outputMint.", 400, corsHeaders);
	}
	if (!amount || !/^[0-9]{1,20}$/.test(amount) || BigInt(amount) <= 0n || BigInt(amount) > 10n ** 18n) {
		return jsonError("Invalid amount.", 400, corsHeaders);
	}
	if (!taker || !BASE58_RE.test(taker)) {
		return jsonError("Invalid or missing taker (connect a wallet first).", 400, corsHeaders);
	}

	// FIX (19 Jul 2026, review round 2): tipAmount used to be optional
	// and accepted 0 — but this endpoint exists solely to feed the
	// /submit flow, which requires a minimum 1,000,000-lamport
	// (0.001 SOL) tip instruction to accept the transaction at all.
	// A /build response without a valid tip produces a transaction
	// that /submit will reject — so a missing or too-low tipAmount
	// here can only ever be a frontend bug or a stray direct call.
	// Fail closed instead of letting an invalid Router transaction be
	// built. (The frontend has always sent 1,000,000; this just makes
	// the worker enforce what was previously only a convention.)
	const MIN_SUBMIT_TIP = 1000000n;
	const tipAmount = params.get("tipAmount");
	if (tipAmount === null || !/^[0-9]{1,12}$/.test(tipAmount) || BigInt(tipAmount) < MIN_SUBMIT_TIP) {
		return jsonError("tipAmount is required and must be at least 1000000 lamports (Jupiter's /submit minimum).", 400, corsHeaders);
	}

	const upstreamParams = new URLSearchParams({ inputMint, outputMint, amount, taker, tipAmount });

	let upstream;
	try {
		upstream = await fetch("https://api.jup.ag/swap/v2/build?" + upstreamParams.toString(), {
			headers: { "x-api-key": env.JUPITER_API_KEY },
			signal: AbortSignal.timeout(15000)
		});
	} catch (err) {
		const timedOut = err && err.name === "TimeoutError";
		return jsonError(
			timedOut ? "Jupiter build request timed out." : "Jupiter build request failed.",
			timedOut ? 504 : 502,
			corsHeaders
		);
	}

	const body = await upstream.text();
	return new Response(body, {
		status: upstream.status,
		headers: corsHeaders
	});
}

async function handleJupiterSubmit(request, env) {
	const corsHeaders = jupiterCorsHeaders(env);

	const contentLength = Number(request.headers.get("content-length") || 0);
	if (contentLength > MAX_BODY_BYTES) {
		return jsonError("Request body too large.", 413, corsHeaders);
	}

	let payload;
	try {
		payload = await request.json();
	} catch (err) {
		return jsonError("Invalid JSON body.", 400, corsHeaders);
	}

	if (!payload || typeof payload !== "object") {
		return jsonError("Invalid request body.", 400, corsHeaders);
	}
	// /submit accepts either a single transaction or an array — this
	// worker only forwards the single-transaction shape our test page
	// actually sends.
	if (!payload.transaction || typeof payload.transaction !== "string") {
		return jsonError("Missing or invalid transaction.", 400, corsHeaders);
	}

	// FIX (19 Jul 2026, confirmed via Jupiter's own official code
	// example): /tx/v1/submit expects the field named
	// "signedTransaction", not "transaction" — this worker was
	// forwarding the wrong field name to the actual Jupiter API,
	// which would make every Router-path submit fail. Our own
	// request body (from the client) still uses "transaction" for
	// consistency with the rest of this worker's naming; only the
	// upstream call to Jupiter needs the corrected field name.

	// /submit docs: "works on all plans including keyless access" —
	// pass the key when we have one anyway, for consistency and in case
	// it affects rate limits, but don't hard-fail if it's ever missing.
	const headers = { "Content-Type": "application/json" };
	if (env.JUPITER_API_KEY) headers["x-api-key"] = env.JUPITER_API_KEY;

	let upstream;
	try {
		upstream = await fetch("https://api.jup.ag/tx/v1/submit", {
			method: "POST",
			headers,
			body: JSON.stringify({ signedTransaction: payload.transaction }),
			signal: AbortSignal.timeout(20000)
		});
	} catch (err) {
		const timedOut = err && err.name === "TimeoutError";
		return jsonError(
			timedOut ? "Jupiter submit request timed out." : "Jupiter submit request failed.",
			timedOut ? 504 : 502,
			corsHeaders
		);
	}

	const body = await upstream.text();
	return new Response(body, {
		status: upstream.status,
		headers: corsHeaders
	});
}

function corsJsonHeaders(request) {
	return {
		"Content-Type": "application/json",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "public, max-age=10"
	};
}

async function handlePumpfunPrice(request) {
	const now = Date.now();

	if (pumpfunPriceCache.data && now - pumpfunPriceCache.fetchedAt < PUMPFUN_CACHE_MS) {
		return new Response(JSON.stringify(pumpfunPriceCache.data), {
			headers: corsJsonHeaders(request)
		});
	}

	try {
		const upstream = await fetch(
			"https://frontend-api-v3.pump.fun/coins/" + RELAX_MINT,
			{
				headers: {
					// Some pump.fun endpoints expect a browser-like UA; the
					// public single-coin lookup has been reported to work
					// without a JWT, but this should be verified/monitored —
					// if pump.fun starts rejecting this, this route is the
					// one place to fix it (holder-verification.js and
					// index.html never talk to pump.fun directly).
					"User-Agent": "Mozilla/5.0 (compatible; RelaxPriceProxy/1.0)"
				}
			}
		);

		if (!upstream.ok) {
			throw new Error("pump.fun upstream returned " + upstream.status);
		}

		const coin = await upstream.json();

		// usd_market_cap / total_supply gives price-per-token in USD.
		// total_supply is a raw integer string in pump.fun's response
		// (1e15 raw units for a 1e9-supply, 6-decimal token — CONFIRMED
		// on-chain 17 Jul 2026 via getTokenAccountsByOwner that $RELAX's
		// real decimals is 6, matching the value used below).
		const usdMarketCap = Number(coin.usd_market_cap);
		const totalSupplyRaw = Number(coin.total_supply);
		const decimals = 6; // confirmed on-chain for $RELAX, see note above
		const totalSupply = totalSupplyRaw / Math.pow(10, decimals);

		const priceUsd =
			Number.isFinite(usdMarketCap) && totalSupply > 0
				? usdMarketCap / totalSupply
				: null;

		const result = {
			priceUsd,
			usdMarketCap: Number.isFinite(usdMarketCap) ? usdMarketCap : null,
			bondingCurveComplete: coin.complete === true,
			source: "pumpfun"
		};

		pumpfunPriceCache = { data: result, fetchedAt: now };

		return new Response(JSON.stringify(result), {
			headers: corsJsonHeaders(request)
		});
	} catch (err) {
		return new Response(
			JSON.stringify({ priceUsd: null, error: String(err && err.message || err) }),
			{ status: 502, headers: corsJsonHeaders(request) }
		);
	}
}

function clampInt(value, fallback, min, max) {
	const n = parseInt(value, 10);
	if (Number.isNaN(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

function safeText(value, fallback, maxLen) {
	if (!value) return fallback;
	const s = String(value).slice(0, maxLen);
	return s.replace(/[<>&"]/g, "");
}

function shortenAddress(addr) {
	if (!addr || addr.length < 10) return addr || "";
	return addr.slice(0, 4) + "..." + addr.slice(-4);
}

const FONT_CACHE = {};

async function fetchGoogleFontTTF(family, weight) {

	const cacheKey = family + "-" + weight;
	if (FONT_CACHE[cacheKey]) return FONT_CACHE[cacheKey];

	const cssUrl =
		"https://fonts.googleapis.com/css2?family=" +
		encodeURIComponent(family) + ":wght@" + weight + "&display=swap";

	const cssRes = await fetch(cssUrl, {
		headers: {
			// An old UA that doesn't support woff2, so Google serves plain TTF.
			"User-Agent": "Mozilla/5.0 (Windows NT 6.1; rv:2.0) Gecko/20100101"
		}
	});

	if (!cssRes.ok) {
		throw new Error("Google Fonts CSS request failed (" + cssRes.status + ") for " + family);
	}

	const css = await cssRes.text();
	const match = css.match(/url\((https:[^)]+\.ttf)\)/);

	if (!match) {
		throw new Error("Could not find TTF url for " + family + " " + weight);
	}

	const fontRes = await fetch(match[1]);

	if (!fontRes.ok) {
		throw new Error("Font file download failed (" + fontRes.status + ") for " + family);
	}

	const buffer = await fontRes.arrayBuffer();

	FONT_CACHE[cacheKey] = buffer;
	return buffer;

}

async function handleOgImage(url) {
	const f = clampInt(url.searchParams.get("f"), 0, 0, 100);
	const p = clampInt(url.searchParams.get("p"), 0, 0, 100);
	const r = clampInt(url.searchParams.get("r"), 0, 0, 100);
	const age = safeText(url.searchParams.get("age"), "Unknown", 20);
	const hold = safeText(url.searchParams.get("hold"), "N/A", 20);
	const addr = shortenAddress(safeText(url.searchParams.get("addr"), "", 60));

	try {
		return await renderOgImage(f, p, r, age, hold, addr);
	} catch (err) {
		// RESILIENCE (17 Jul 2026): a Google Fonts hiccup or a satori
		// render error used to mean the share card came back as a
		// broken image entirely (500, nothing) — which on X/social
		// previews looks like the whole site is broken, not just one
		// font request. This fallback needs no external font at all
		// (system sans-serif), so it can't fail the same way twice.
		return buildFallbackOgSvg(r, addr);
	}
}

async function renderOgImage(f, p, r, age, hold, addr) {
	const [orbitron, inter] = await Promise.all([
		fetchGoogleFontTTF("Orbitron", 800),
		fetchGoogleFontTTF("Inter", 500)
	]);

	const markup = html`
		<div style="display:flex;flex-direction:column;width:1200px;height:675px;background:linear-gradient(135deg,#050713,#0A0F24);border:2px solid rgba(153,69,255,0.25);box-sizing:border-box;padding:50px;font-family:Inter;">
			<div style="display:flex;justify-content:space-between;width:100%;">
				<div style="display:flex;flex-direction:column;">
					<div style="font-family:Orbitron;font-size:32px;font-weight:800;color:#F5F7FF;letter-spacing:1px;">RELAX SCORE</div>
					<div style="font-size:15px;color:#929BB5;margin-top:6px;">0relaxbro.xyz  ·  @0relaxbro</div>
				</div>
				<div style="font-size:14px;color:#5C6480;">${addr}</div>
			</div>

			<div style="display:flex;width:100%;margin-top:70px;justify-content:space-between;">
				<div style="display:flex;flex-direction:column;align-items:center;width:216px;">
					<div style="font-family:Orbitron;font-size:12px;color:#929BB5;letter-spacing:1px;">FOMO SIGNAL</div>
					<div style="font-family:Orbitron;font-size:62px;font-weight:800;color:#FF5F87;">${f}</div>
					<div style="font-size:12px;color:#5C6480;text-align:center;">Token-chasing pattern</div>
				</div>
				<div style="display:flex;flex-direction:column;align-items:center;width:216px;">
					<div style="font-family:Orbitron;font-size:12px;color:#929BB5;letter-spacing:1px;">PANIC SIGNAL</div>
					<div style="font-family:Orbitron;font-size:62px;font-weight:800;color:#5B7CFF;">${p}</div>
					<div style="font-size:12px;color:#5C6480;text-align:center;">Clustered fast trades</div>
				</div>
				<div style="display:flex;flex-direction:column;align-items:center;width:216px;">
					<div style="font-family:Orbitron;font-size:12px;color:#929BB5;letter-spacing:1px;">RELAX SCORE</div>
					<div style="font-family:Orbitron;font-size:62px;font-weight:800;color:#14F195;">${r}</div>
					<div style="font-size:12px;color:#5C6480;text-align:center;">Overall composure</div>
				</div>
				<div style="display:flex;flex-direction:column;align-items:center;width:216px;">
					<div style="font-family:Orbitron;font-size:12px;color:#929BB5;letter-spacing:1px;">WALLET AGE</div>
					<div style="font-family:Orbitron;font-size:44px;font-weight:800;color:#B983FF;">${age}</div>
				</div>
				<div style="display:flex;flex-direction:column;align-items:center;width:216px;">
					<div style="font-family:Orbitron;font-size:12px;color:#929BB5;letter-spacing:1px;">AVG HOLDING</div>
					<div style="font-family:Orbitron;font-size:44px;font-weight:800;color:#B983FF;">${hold}</div>
				</div>
			</div>

			<div style="display:flex;width:100%;justify-content:center;margin-top:auto;">
				<div style="font-family:Orbitron;font-size:15px;font-weight:800;color:#14F195;letter-spacing:2px;">0 FEAR . 0 PANIC . 0 REGRETS . JUST $RELAX</div>
			</div>
		</div>
	`;

	return new ImageResponse(markup, {
		width: 1200,
		height: 675,
		fonts: [
			{ name: "Orbitron", data: orbitron, weight: 800, style: "normal" },
			{ name: "Inter", data: inter, weight: 500, style: "normal" }
		]
	});
}

function buildFallbackOgSvg(r, addr) {
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675">' +
		'<rect width="1200" height="675" fill="#050713"/>' +
		'<text x="60" y="90" font-family="sans-serif" font-size="30" font-weight="800" fill="#F5F7FF">RELAX SCORE</text>' +
		'<text x="60" y="118" font-family="sans-serif" font-size="15" fill="#929BB5">0relaxbro.xyz · @0relaxbro</text>' +
		'<text x="1140" y="90" font-family="sans-serif" font-size="14" fill="#5C6480" text-anchor="end">' + escapeSvgText(addr) + '</text>' +
		'<text x="600" y="360" font-family="sans-serif" font-size="90" font-weight="800" fill="#14F195" text-anchor="middle">' + r + '</text>' +
		'<text x="600" y="410" font-family="sans-serif" font-size="16" fill="#929BB5" text-anchor="middle">RELAX SCORE</text>' +
		'<text x="600" y="610" font-family="sans-serif" font-size="15" font-weight="800" fill="#14F195" text-anchor="middle" letter-spacing="2">0 FEAR . 0 PANIC . 0 REGRETS . JUST $RELAX</text>' +
		'</svg>';

	return new Response(svg, {
		headers: { "Content-Type": "image/svg+xml" }
	});
}

function escapeSvgText(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

async function handleSharePage(url, request) {
	const workerOrigin = new URL(request.url).origin;
	const qs = url.search;

	const r = safeText(url.searchParams.get("r"), "?", 5);

	const ogImageUrl = workerOrigin + "/og" + qs;

	const pageHtml =
		"<!doctype html><html><head>" +
		'<meta charset="utf-8">' +
		"<title>RELAX Score: " + r + "</title>" +
		'<meta property="og:title" content="My RELAX Score: ' + r + '">' +
		'<meta property="og:description" content="0 Fear. 0 Panic. 0 Regrets. Just $RELAX">' +
		'<meta property="og:image" content="' + ogImageUrl + '">' +
		'<meta property="og:image:width" content="1200">' +
		'<meta property="og:image:height" content="675">' +
		'<meta name="twitter:card" content="summary_large_image">' +
		'<meta name="twitter:image" content="' + ogImageUrl + '">' +
		'<meta http-equiv="refresh" content="0; url=' + SITE_URL + '">' +
		'<link rel="canonical" href="' + SITE_URL + '">' +
		"</head><body>Redirecting to RELAX Score…</body></html>";

	return new Response(pageHtml, {
		headers: { "Content-Type": "text/html; charset=utf-8" }
	});
}

// Purely cosmetic: someone landing on card.0relaxbro.xyz directly (out
// of curiosity, or a stray click) used to see a raw JSON-RPC error,
// which reads as "this is broken" rather than "this is an API, not a
// page." This is the only route that returns HTML for a GET on "/" —
// every other path keeps returning its existing JSON/PNG response
// exactly as before.
function handleRootLanding() {
	const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RELAX API</title>
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="2;url=https://0relaxbro.xyz">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#050713;color:#F5F7FF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
text-align:center;padding:40px 20px;}
.wrap{max-width:420px;}
.dot{width:8px;height:8px;border-radius:50%;background:#14F195;display:inline-block;margin-right:8px;}
h1{font-size:20px;margin:0 0 12px;}
p{color:#929BB5;font-size:14px;line-height:1.6;margin:0 0 24px;}
a{color:#14F195;text-decoration:none;font-size:13px;}
a:hover{text-decoration:underline;}
</style>
<script>
// FIX (20 Jul 2026): meta-refresh alone works everywhere without
// needing JS, but a JS redirect on top makes it feel instant rather
// than a visible 2-second wait for anyone who does have JS enabled
// (which is everyone reaching this page in a real browser).
setTimeout(function () { window.location.href = "https://0relaxbro.xyz"; }, 300);
</script>
</head>
<body>
<div class="wrap">
<h1><span class="dot"></span>RELAX API — running</h1>
<p>This is a backend service (RPC proxy + share card generator), not a page meant to be browsed directly. Redirecting you back automatically…</p>
<a href="https://0relaxbro.xyz">&larr; Back to 0relaxbro.xyz now</a>
</div>
</body>
</html>`;

	return new Response(htmlBody, {
		headers: { "Content-Type": "text/html;charset=UTF-8" }
	});
}

async function handleRpcProxy(request, env, network) {
	const corsOrigin = env.CORS_ALLOW_ORIGIN || "https://0relaxbro.xyz";

	const corsHeaders = {
		"Access-Control-Allow-Origin": corsOrigin,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		// Added (21 Jul 2026, found via real devnet testing): Irys's
		// uploader sends a custom `solana-client` header on its own RPC
		// calls (fund/getLoadedBalance) through @solana/web3.js's
		// Connection class — CORS preflight was rejecting it since only
		// Content-Type was ever allowed. Harmless to allow: it's just a
		// client-identification header (like a User-Agent), carries no
		// authority/capability of its own — the actual RPC method
		// allowlist below is still what gates what can be called.
		"Access-Control-Allow-Headers": "Content-Type, solana-client",
		"Access-Control-Max-Age": "86400"
	};

	if (request.method === "OPTIONS") {
		return new Response(null, { headers: corsHeaders });
	}

	if (request.method !== "POST") {
		return jsonError("Only POST requests are supported.", 405, corsHeaders);
	}

	if (!env.HELIUS_API_KEY) {
		return jsonError("Server misconfigured: missing API key.", 500, corsHeaders);
	}

	const contentLength = Number(request.headers.get("content-length") || 0);

	if (contentLength > MAX_BODY_BYTES) {
		return jsonError("Request body too large.", 413, corsHeaders);
	}

	let payload;

	try {
		payload = await request.json();
	} catch (err) {
		return jsonError("Invalid JSON body.", 400, corsHeaders);
	}

	const calls = Array.isArray(payload) ? payload : [payload];

	if (calls.length === 0 || calls.length > 5) {
		return jsonError("Invalid batch size.", 400, corsHeaders);
	}

	for (const call of calls) {
		const isAllowed = call && typeof call.method === "string" && (
			ALLOWED_METHODS.has(call.method) ||
			// requestAirdrop is devnet-only by design (Solana's own
			// mainnet validators don't support it regardless — this is
			// purely a dev-convenience faucet call, never usable to move
			// real funds, and explicitly scoped here to never apply on
			// the mainnet route even though the method itself would be
			// harmless there too). Added 21 Jul 2026 — public devnet
			// faucets were rate-limited during real NFT Creator testing;
			// this routes airdrop requests through Helius's own devnet
			// RPC instead, which may have separate/less congested limits.
			(network === "devnet" && call.method === "requestAirdrop")
		);
		if (!isAllowed) {
			return jsonError(
				"Method not allowed: " + (call && call.method),
				403,
				corsHeaders
			);
		}
	}

	// RESOURCE ISOLATION: see SCORE_ONLY_METHODS note above. Falls back
	// to the main key automatically if HELIUS_API_KEY_SCORE isn't set up
	// yet — this degrades gracefully to today's shared-key behavior
	// rather than breaking anything if the second key isn't added yet.
	const isScoreOnlyBatch = calls.every((call) => SCORE_ONLY_METHODS.has(call.method));
	const heliusKey = (isScoreOnlyBatch && env.HELIUS_API_KEY_SCORE) || env.HELIUS_API_KEY;

	// Helius keys work across both networks on the same account/plan —
	// only the hostname changes (mainnet.helius-rpc.com vs
	// devnet.helius-rpc.com). If that ever stops being true for a
	// future plan tier, a dedicated HELIUS_API_KEY_DEVNET secret would
	// need to be added here — not needed today.
	const heliusHost = network === "devnet" ? "devnet.helius-rpc.com" : "mainnet.helius-rpc.com";
	const heliusUrl = "https://" + heliusHost + "/?api-key=" + heliusKey;

	const upstreamResponse = await fetch(heliusUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload)
	});

	const upstreamBody = await upstreamResponse.text();

	return new Response(upstreamBody, {
		status: upstreamResponse.status,
		headers: {
			...corsHeaders,
			"Content-Type": "application/json"
		}
	});
}

function jsonError(message, status, corsHeaders) {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code: -32000, message }
		}),
		{
			status,
			headers: {
				...corsHeaders,
				"Content-Type": "application/json"
			}
		}
	);
}
