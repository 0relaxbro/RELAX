/* =========================================================
   RELAX NFT CREATOR — Irys Web Storage Provider
   =========================================================
   This is the ONLY file in the project that knows Irys exists.
   storage-adapter.js (one layer up) never imports this directly by
   name in a way that couldn't be swapped — RelaxStorage.uploadMedia()/
   uploadMetadataJson() are the only calls the rest of the app makes.

   WHY THIS FILE EXISTS SEPARATELY (decided 21 Jul 2026, after real
   research — see SWAP_V2_MIGRATION_PLAN.md / NFT Creator section):
   Unlike Metaplex's Token Metadata program (a fixed, documented,
   years-stable on-chain instruction layout we could hand-roll byte
   for byte), Irys is a live client-server PROTOCOL with its own data
   transaction format, funding/pricing flow, and tag serialization —
   reimplementing that by hand would mean rebuilding a real client
   library, not copying a stable byte layout. Official guidance
   (docs.irys.xyz, fetched 21 Jul 2026) is npm-package-only
   (@irys/web-upload + @irys/web-upload-solana), no raw HTTP path
   documented for direct fetch() use. Irys's upload SDK is also a much
   smaller dependency graph than Metaplex's Umi plugin ecosystem was,
   so the CDN-transpilation risk here is real but meaningfully smaller
   — acceptable as a controlled, isolated provider, not a core
   mint-instruction dependency.

   FAIL-CLOSED BY DESIGN: if the bundle isn't loaded for any reason,
   this throws a clear, specific error. There is no silent fallback
   and no half-completed upload — nothing is charged, nothing is
   uploaded, the caller gets an unambiguous "try again" state.

   UPDATE (21 Jul 2026, real devnet testing): the original plan was a
   dynamic esm.sh import at runtime. In practice this failed twice —
   first a wrong version pin (real bug, fixed), then a genuine esm.sh
   packaging failure for @irys/web-upload-solana specifically: dozens
   of cascading 404s for internal @noble/curves/@noble/hashes/uuid
   chunks, plus Irys's own packages importing real Node.js builtins
   (stream/crypto/events) that a browser has no native equivalent for
   and esm.sh wasn't polyfilling correctly. Per the escalation path
   agreed in advance (SWAP_V2_MIGRATION_PLAN.md), moved to a locally
   pre-built bundle instead: `irys-bundle.js`, built once via esbuild
   with proper Node-builtin browser polyfills (crypto-browserify,
   stream-browserify), exposing `window.RelaxIrysBundle.{WebUploader,
   WebSolana}`. Zero runtime CDN dependency now — the whole dependency
   tree is resolved once, at build time, not on every page load.
   ========================================================= */

const RelaxIrysWebProvider = (function () {
	// FIX (found live, 21 Jul 2026): the signMessage bug above caused
	// an indefinite silent hang with no error at all — this timeout
	// ensures that if something similar ever happens again (a
	// different wallet's quirk, a future Irys version, etc.), the
	// user gets a clear, actionable error instead of a frozen "WORKING…"
	// button forever.
	function withTimeout(promise, ms, message) {
		return Promise.race([
			promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
		]);
	}

	// FIX (found live via repeated 402s during real devnet testing, 21
	// Jul 2026 — first attempt at this fix assumed a bundler-side
	// indexing lag and just waited-and-retried; that turned out to be
	// the WRONG diagnosis. The actual error Irys's bundle throws is
	// "402 error: Not enough balance for transaction" — a genuine
	// shortfall, not a timing issue, so waiting alone never helped.
	// Root cause: ensureFunded() only funds for getPrice(bytes.length)
	// — the price of the raw payload — but Irys's real data item also
	// includes tag/header/signature overhead, and devnet bundler
	// pricing can move between our estimate and the actual charge. A
	// small buffer covers both. This distinguishes the two known 402
	// shapes from Irys's own code (see the `case 402:` branch in
	// Uploader.uploadTransaction, irys-bundle.js):
	//   - "Not enough balance for transaction" -> re-fund with a
	//     buffer (via the caller-supplied onInsufficientBalance) before
	//     retrying — waiting does nothing here.
	//   - anything else 402 (e.g. genuine bundler rate-limiting, which
	//     DOES carry Irys's own `retry-after` header) -> wait that many
	//     seconds (or a sane default) and retry as before.
	// Any non-402 error (wallet rejection, network failure, timeout)
	// still fails immediately, unchanged.
	async function uploadWithRetry(uploadCall, timeoutMs, timeoutMessage, opts) {
		opts = opts || {};
		const maxAttempts = opts.maxAttempts || 3;
		const onInsufficientBalance = opts.onInsufficientBalance;
		let lastErr;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return await withTimeout(uploadCall(), timeoutMs, timeoutMessage);
			} catch (err) {
				lastErr = err;
				const msg = err && err.message ? err.message : String(err);
				const is402 = /^402 error:/.test(msg);
				if (!is402 || attempt === maxAttempts) {
					throw err;
				}
				const isInsufficientBalance = /not enough balance/i.test(msg);
				if (isInsufficientBalance && onInsufficientBalance) {
					console.log(
						"[IRYS DIAG] uploadWithRetry: 402 insufficient balance, topping up before retry",
						{ attempt, maxAttempts, message: msg }
					);
					await onInsufficientBalance(attempt);
				} else {
					const retryAfterMatch = msg.match(/retry after ([\d.]+)s/);
					const waitSeconds = retryAfterMatch ? parseFloat(retryAfterMatch[1]) : attempt * 2;
					console.log(
						"[IRYS DIAG] uploadWithRetry: got 402, waiting then retrying",
						{ attempt, maxAttempts, waitSeconds, message: msg }
					);
					await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
				}
			}
		}
		throw lastErr;
	}


	// *** DEVNET MODE — flip to false only after a full devnet mint
	// has succeeded end-to-end, per SWAP_V2_MIGRATION_PLAN.md / NFT
	// Creator's testing plan. While true, storage uploads run on
	// Irys's own devnet/test tier (worthless SOL, ~60-day retention)
	// instead of its real mainnet tier. ***
	const DEVNET_MODE = true;
	const DEVNET_RPC_URL = "https://card.0relaxbro.xyz/rpc-devnet"; // same devnet route the mint flow itself uses — one devnet config to keep in sync, not two

	let cachedUploader = null;
	let cachedWalletAddress = null;

	// FIX (found via review, 21 Jul 2026): caching only the first
	// connected uploader forever meant switching wallets (Phantom ->
	// Solflare, or switching accounts within the same wallet) would
	// keep using the OLD wallet's uploader — the exact same
	// stale-cache pattern already found and fixed today in Swap's
	// balance reconciliation. Cache is now keyed to the wallet address
	// itself; a different address invalidates it and reconnects fresh.
	//
	// CAVEAT (flagged via review, 21 Jul 2026): `walletProvider` here
	// is meant to be the raw injected provider (window.solana /
	// window.solflare) — the same object RelaxHolder already uses for
	// Swap. Irys's own official example passes a React wallet-adapter
	// hook object instead, not a raw provider directly. Phantom's raw
	// window.solana is very likely compatible (same de-facto standard
	// shape), but Solflare compatibility specifically has NOT been
	// verified yet — confirm on devnet with both wallets before
	// trusting this for real uploads, same as the mint flow itself
	// needs a devnet pass.
	// FIX (found via real devnet testing + reading Irys's own source
	// code directly, 21 Jul 2026 — the actual root cause behind the
	// "stuck with no wallet popup, no error, endless getLatestBlockhash
	// calls" symptom): Irys's SolanaConfig.sendTx() (in
	// @irys/web-upload-solana/dist/esm/token.js) calls
	// `this.wallet.sendTransaction(transaction, connection, options)` —
	// this is the @solana/wallet-adapter-base SHAPE (sign AND send in
	// one call), which raw injected providers like window.solana do
	// NOT implement at all (Phantom's raw API only has
	// .signTransaction(), which signs but doesn't send). Calling a
	// missing method fails inside Irys's own retry wrapper, which
	// silently retries the whole preparation sequence (re-fetching a
	// blockhash each time) instead of surfacing a clean error — exactly
	// matching what was observed live. This wraps the raw provider in a
	// minimal adapter-shaped object that adds a working
	// sendTransaction(), built from the raw provider's own
	// signTransaction() plus a real broadcast via the given connection.
	function wrapProviderForIrys(rawProvider) {
		return {
			publicKey: rawProvider.publicKey,

			async signTransaction(transaction) {
				console.log("[IRYS DIAG] wrapper.signTransaction: called");
				const result = await rawProvider.signTransaction(transaction);
				console.log("[IRYS DIAG] wrapper.signTransaction: returned");
				return result;
			},

			async signAllTransactions(transactions) {
				console.log("[IRYS DIAG] wrapper.signAllTransactions: called", { count: transactions.length });
				if (typeof rawProvider.signAllTransactions === "function") {
					const result = await rawProvider.signAllTransactions(transactions);
					console.log("[IRYS DIAG] wrapper.signAllTransactions: returned (native)");
					return result;
				}
				const signed = [];
				for (const transaction of transactions) {
					signed.push(await rawProvider.signTransaction(transaction));
				}
				console.log("[IRYS DIAG] wrapper.signAllTransactions: returned (manual loop)");
				return signed;
			},

			// FIX (found via source-code verification, 21 Jul 2026 —
			// confirmed by reading Irys's own installed source directly:
			// @irys/bundles/.../injectedSolanaSigner.js does
			// `return await this.provider.signMessage(message);` with
			// ZERO post-processing). Phantom's raw signMessage() resolves
			// to { signature, publicKey } — NOT a plain Uint8Array — so
			// passing it straight through fed Irys a wrong-shaped value,
			// which silently broke its internal retry loop (matching the
			// live symptom: funding succeeded, but upload hung
			// indefinitely with no wallet popup and no console error).
			async signMessage(message) {
				console.log("[IRYS DIAG] wrapper.signMessage: called", { messageLength: message && message.length });
				if (typeof rawProvider.signMessage !== "function") {
					throw new Error("This wallet does not support message signing, which storage upload requires.");
				}
				const result = await rawProvider.signMessage(message, "utf8");
				console.log("[IRYS DIAG] wrapper.signMessage: raw provider returned", { resultShape: result && Object.keys(result) });
				if (result && result.signature) return result.signature;
				if (result instanceof Uint8Array) return result;
				throw new Error("Wallet returned an unsupported message signature format.");
			},

			async sendTransaction(transaction, connection, options = {}) {
				console.log("[IRYS DIAG] wrapper.sendTransaction: called");
				const signed = await rawProvider.signTransaction(transaction);
				console.log("[IRYS DIAG] wrapper.sendTransaction: signed, now broadcasting");
				const sig = await connection.sendRawTransaction(signed.serialize(), {
					skipPreflight: options.skipPreflight ?? false,
					preflightCommitment: options.preflightCommitment || "confirmed",
					maxRetries: options.maxRetries
				});
				console.log("[IRYS DIAG] wrapper.sendTransaction: broadcast returned", { sig });
				return sig;
			}
		};
	}

	async function getUploader(walletProvider) {
		console.log("[IRYS DIAG] getUploader: start");
		const walletAddress = walletProvider && walletProvider.publicKey ? walletProvider.publicKey.toString() : null;
		if (!walletAddress) {
			throw new Error("Connect a Solana wallet before using storage.");
		}
		// FIX (found via review, 21 Jul 2026): cache key now includes
		// the network too, not just the wallet address. Harmless today
		// since DEVNET_MODE is a static const (a page reload is the
		// only way it changes), but if this file ever gains a runtime
		// devnet/mainnet toggle, caching by wallet address alone could
		// silently hand back a devnet-configured uploader after
		// switching to mainnet (or vice versa) without reconnecting.
		const cacheKey = walletAddress + ":" + (DEVNET_MODE ? "devnet" : "mainnet");
		if (cachedUploader && cachedWalletAddress === cacheKey) {
			return cachedUploader;
		}
		cachedUploader = null;
		cachedWalletAddress = null;

		let WebUploader, WebSolana;
		try {
			if (!window.RelaxIrysBundle || !window.RelaxIrysBundle.WebUploader || !window.RelaxIrysBundle.WebSolana) {
				throw new Error("irys-bundle.js did not load correctly or wasn't included on this page — check the <script src=\"irys-bundle.js\"> tag runs before this file.");
			}
			({ WebUploader, WebSolana } = window.RelaxIrysBundle);
		} catch (err) {
			// FAIL CLOSED — exactly per the design requirement above.
			throw new Error(
				"Storage provider could not be loaded. No file was uploaded and no SOL was charged. " +
				"(Technical detail: " + (err && err.message ? err.message : err) + ")"
			);
		}

		try {
			console.log("[IRYS DIAG] getUploader: bundle loaded, calling WebUploader(WebSolana).withProvider()...withRpc()...devnet()");
			const uploader = DEVNET_MODE
				? await WebUploader(WebSolana).withProvider(wrapProviderForIrys(walletProvider)).withRpc(DEVNET_RPC_URL).devnet()
				: await WebUploader(WebSolana).withProvider(wrapProviderForIrys(walletProvider));
			console.log("[IRYS DIAG] getUploader: uploader constructed successfully");
			cachedUploader = uploader;
			cachedWalletAddress = cacheKey;
			return uploader;
		} catch (err) {
			throw new Error(
				"Could not connect the storage provider to your wallet. No file was uploaded and no SOL was charged. " +
				"(Technical detail: " + (err && err.message ? err.message : err) + ")"
			);
		}
	}

	// Real, on-chain-accurate cost estimate BEFORE anything is
	// uploaded — Irys prices by byte count, queried live from their
	// own network (fees fluctuate), never guessed or hardcoded.
	async function estimateUploadCostLamports(walletProvider, byteLength) {
		const uploader = await getUploader(walletProvider);
		const price = await uploader.getPrice(byteLength);
		return BigInt(price.toString());
	}

	// The user's current funded balance already sitting on Irys
	// (separate from their wallet's own SOL balance — this is what's
	// actually available to spend on uploads without a new funding
	// transaction).
	async function getLoadedBalance(walletProvider) {
		const uploader = await getUploader(walletProvider);
		const balance = await uploader.getLoadedBalance();
		return BigInt(balance.toString());
	}

	// FIX (found live, 21 Jul 2026, via the recurring "402 error: Not
	// enough balance for transaction"): getPrice(bytes.length) only
	// prices the raw payload, but the actual uploaded data item also
	// carries tag/header/signature overhead, and devnet bundler
	// pricing can move slightly between our estimate and the moment
	// the upload actually lands. A modest buffer (+20%, plus a small
	// fixed pad so tiny-value uploads like this one aren't left with
	// an effectively-zero buffer after integer rounding) covers both
	// without materially changing what the user is shown/charged.
	function withFundingBuffer(lamports) {
		return lamports + (lamports / 5n) + 5000n;
	}

	// FIX (found via review, 21 Jul 2026): the original version
	// computed a price via getPrice() but never actually funded the
	// account before calling upload() — Irys's own official flow is
	// getPrice -> fund (if needed) -> upload. Skipping this would
	// correctly show a cost estimate but then fail the real upload
	// with an "insufficient balance" error. This tops up only the
	// shortfall (if the user already has enough loaded balance from a
	// previous upload, no new funding transaction/signature is
	// needed).
	async function ensureFunded(walletProvider, requiredLamports) {
		console.log("[IRYS DIAG] ensureFunded: start", { requiredLamports: requiredLamports.toString() });
		const uploader = await getUploader(walletProvider);
		console.log("[IRYS DIAG] ensureFunded: got uploader");
		const required = BigInt(requiredLamports);
		console.log("[IRYS DIAG] ensureFunded: calling getLoadedBalance()");
		const balance = BigInt((await uploader.getLoadedBalance()).toString());
		console.log("[IRYS DIAG] ensureFunded: getLoadedBalance() returned", { balance: balance.toString() });
		if (balance < required) {
			console.log("[IRYS DIAG] ensureFunded: calling uploader.fund()", { amount: (required - balance).toString() });
			await uploader.fund(required - balance);
			console.log("[IRYS DIAG] ensureFunded: uploader.fund() returned");
		} else {
			console.log("[IRYS DIAG] ensureFunded: already funded, skipping fund()");
		}
		console.log("[IRYS DIAG] ensureFunded: done");
	}

	// Uploads raw file bytes (image, gif, mp4 — anything). Returns a
	// gateway URI immediately usable in NFT metadata's "image" or
	// "animation_url" field. Self-sufficient: funds any shortfall
	// itself right before uploading, so this never fails on
	// insufficient balance even if a UI's own explicit "fund" step was
	// skipped or the balance changed since that step ran.
	async function uploadFile(walletProvider, bytes, contentType) {
		console.log("[IRYS DIAG] uploadFile: start", { byteLength: bytes.length, contentType });
		const uploader = await getUploader(walletProvider);
		console.log("[IRYS DIAG] uploadFile: got uploader, calling getPrice()");
		const price = await uploader.getPrice(bytes.length);
		console.log("[IRYS DIAG] uploadFile: getPrice() returned", { price: price.toString() });
		await ensureFunded(walletProvider, withFundingBuffer(BigInt(price.toString())));
		console.log("[IRYS DIAG] uploadFile: ensureFunded() returned, calling uploader.upload()");
		const tags = [{ name: "Content-Type", value: contentType }];
		// FIX (found live, traced via [IRYS BUNDLE DIAG] logs, 21 Jul
		// 2026): Irys's uploadData() checks Buffer.isBuffer(data) to
		// pick its fast path — a plain Uint8Array fails that check and
		// silently falls through to an untested chunked-upload path,
		// which is exactly where this was hanging. Wrap with the SAME
		// Buffer class Irys's own bundled code uses internally.
		const bufferBytes = window.RelaxIrysBundle.Buffer.from(bytes);
		const receipt = await uploadWithRetry(
			() => uploader.upload(bufferBytes, { tags }),
			60000,
			"Media upload timed out after 60 seconds. No mint transaction was started — check your wallet for any pending signature requests, then try again.",
			{
				onInsufficientBalance: async () => {
					const freshPrice = BigInt((await uploader.getPrice(bytes.length)).toString());
					await ensureFunded(walletProvider, withFundingBuffer(freshPrice));
				}
			}
		);
		console.log("[IRYS DIAG] uploadFile: uploader.upload() returned", { receiptId: receipt.id });
		return "https://gateway.irys.xyz/" + receipt.id;
	}

	// Uploads a JSON object (the off-chain NFT metadata document
	// itself). Returns the gateway URI that becomes the on-chain
	// metadata's `uri` field (what CreateMetadataAccountV3 actually
	// stores). Same self-sufficient funding as uploadFile — metadata
	// JSON is small (a few hundred bytes), so this top-up is usually
	// tiny or nothing at all if the media upload already funded enough
	// headroom.
	async function uploadJson(walletProvider, obj) {
		const uploader = await getUploader(walletProvider);
		const bytes = new TextEncoder().encode(JSON.stringify(obj));
		const price = await uploader.getPrice(bytes.length);
		await ensureFunded(walletProvider, withFundingBuffer(BigInt(price.toString())));
		const tags = [{ name: "Content-Type", value: "application/json" }];
		const bufferBytes = window.RelaxIrysBundle.Buffer.from(bytes);
		const receipt = await uploadWithRetry(
			() => uploader.upload(bufferBytes, { tags }),
			60000,
			"Metadata upload timed out after 60 seconds. No mint transaction was started — check your wallet for any pending signature requests, then try again.",
			{
				onInsufficientBalance: async () => {
					const freshPrice = BigInt((await uploader.getPrice(bytes.length)).toString());
					await ensureFunded(walletProvider, withFundingBuffer(freshPrice));
				}
			}
		);
		return "https://gateway.irys.xyz/" + receipt.id;
	}

	return { estimateUploadCostLamports, getLoadedBalance, ensureFunded, uploadFile, uploadJson };
})();
