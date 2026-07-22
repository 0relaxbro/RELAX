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
	// FIX (found via review, 22 Jul 2026): the [IRYS DIAG] logging added
	// throughout this file during real devnet debugging (funding/402/
	// signMessage/upload tracing) was extremely useful for finding the
	// bugs it found, but left on permanently it just fills a normal
	// user's console with internal wallet/storage step-by-step detail
	// they never asked to see. Gated behind a single flag instead of
	// deleted outright — flip to true again if a similar live-debugging
	// need comes up rather than re-adding logs one at a time.
	const DEBUG_IRYS = false;
	function debug(...args) {
		if (DEBUG_IRYS) console.log("[IRYS DIAG]", ...args);
	}

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
					debug(
						"uploadWithRetry: 402 insufficient balance, topping up before retry",
						{ attempt, maxAttempts, message: msg }
					);
					await onInsufficientBalance(attempt);
				} else {
					const retryAfterMatch = msg.match(/retry after ([\d.]+)s/);
					const waitSeconds = retryAfterMatch ? parseFloat(retryAfterMatch[1]) : attempt * 2;
					debug(
						"uploadWithRetry: got 402, waiting then retrying",
						{ attempt, maxAttempts, waitSeconds, message: msg }
					);
					await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
				}
			}
		}
		throw lastErr;
	}


	// FIX (found via review, 22 Jul 2026): this used to be a separate
	// local const from nft-creator.html's own RPC_URL/SOLANA_CLUSTER —
	// two files that happened to agree but nothing enforced it, and
	// this exact split previously caused a real "mint on devnet,
	// storage on mainnet" mismatch earlier in this project. Reading
	// the same window.RELAX_NFT_CONFIG both files share means a future
	// mainnet switch is one line in one place, not two consts in two
	// files that both have to be remembered.
	const DEVNET_MODE = window.RELAX_NFT_CONFIG.irysDevnet === true;
	const DEVNET_RPC_URL = window.RELAX_NFT_CONFIG.rpcUrl;

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
	// CAVEAT (flagged via review, 21 Jul 2026, RESOLVED 22 Jul 2026):
	// `walletProvider` here is meant to be the raw injected provider
	// (window.solana / window.solflare) — the same object RelaxHolder
	// already uses for Swap. Irys's own official example passes a
	// React wallet-adapter hook object instead, not a raw provider
	// directly. Phantom and Solflare raw-provider compatibility were
	// both verified end-to-end on devnet on 22 Jul 2026 (full mint,
	// including Irys funding/upload through this exact wrapper, on
	// both wallets).
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
				debug("wrapper.signTransaction: called");
				const result = await rawProvider.signTransaction(transaction);
				debug("wrapper.signTransaction: returned");
				return result;
			},

			async signAllTransactions(transactions) {
				debug("wrapper.signAllTransactions: called", { count: transactions.length });
				if (typeof rawProvider.signAllTransactions === "function") {
					const result = await rawProvider.signAllTransactions(transactions);
					debug("wrapper.signAllTransactions: returned (native)");
					return result;
				}
				const signed = [];
				for (const transaction of transactions) {
					signed.push(await rawProvider.signTransaction(transaction));
				}
				debug("wrapper.signAllTransactions: returned (manual loop)");
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
				debug("wrapper.signMessage: called", { messageLength: message && message.length });
				if (typeof rawProvider.signMessage !== "function") {
					throw new Error("This wallet does not support message signing, which storage upload requires.");
				}
				const result = await rawProvider.signMessage(message, "utf8");
				debug("wrapper.signMessage: raw provider returned", { resultShape: result && Object.keys(result) });
				if (result && result.signature) return result.signature;
				if (result instanceof Uint8Array) return result;
				throw new Error("Wallet returned an unsupported message signature format.");
			},

			async sendTransaction(transaction, connection, options = {}) {
				debug("wrapper.sendTransaction: called");
				const signed = await rawProvider.signTransaction(transaction);
				debug("wrapper.sendTransaction: signed, now broadcasting");
				const sig = await connection.sendRawTransaction(signed.serialize(), {
					skipPreflight: options.skipPreflight ?? false,
					preflightCommitment: options.preflightCommitment || "confirmed",
					maxRetries: options.maxRetries
				});
				debug("wrapper.sendTransaction: broadcast returned", { sig });
				return sig;
			}
		};
	}

	async function getUploader(walletProvider) {
		debug("getUploader: start");
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
			debug("getUploader: bundle loaded, calling WebUploader(WebSolana).withProvider()...withRpc()...devnet()");
			const uploader = DEVNET_MODE
				? await WebUploader(WebSolana).withProvider(wrapProviderForIrys(walletProvider)).withRpc(DEVNET_RPC_URL).devnet()
				: await WebUploader(WebSolana).withProvider(wrapProviderForIrys(walletProvider));
			debug("getUploader: uploader constructed successfully");
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
		debug("ensureFunded: start", { requiredLamports: requiredLamports.toString() });
		const uploader = await getUploader(walletProvider);
		debug("ensureFunded: got uploader");
		const required = BigInt(requiredLamports);
		debug("ensureFunded: calling getLoadedBalance()");
		const balance = BigInt((await uploader.getLoadedBalance()).toString());
		debug("ensureFunded: getLoadedBalance() returned", { balance: balance.toString() });
		if (balance < required) {
			debug("ensureFunded: calling uploader.fund()", { amount: (required - balance).toString() });
			await uploader.fund(required - balance);
			debug("ensureFunded: uploader.fund() returned");
		} else {
			debug("ensureFunded: already funded, skipping fund()");
		}
		debug("ensureFunded: done");
	}

	// Uploads raw file bytes (image, gif, mp4 — anything). Returns a
	// gateway URI immediately usable in NFT metadata's "image" or
	// "animation_url" field. Self-sufficient: funds any shortfall
	// itself right before uploading, so this never fails on
	// insufficient balance even if a UI's own explicit "fund" step was
	// skipped or the balance changed since that step ran.
	// FIX (found via review, 22 Jul 2026): the migration plan called
	// for confirming a freshly-uploaded URI is actually readable from
	// the gateway before handing it off to the mint transaction, as a
	// guard against gateway propagation lag right after upload. This
	// is deliberately NON-BLOCKING: fetch()'s CORS behavior against
	// Irys's gateway hasn't been independently confirmed, and a fetch
	// failure caused by a CORS restriction (rather than the content
	// genuinely being unreadable) is indistinguishable from here — a
	// hard failure would risk blocking an otherwise-successful mint
	// over an unverified assumption. So this only ever logs a warning
	// (visible regardless of DEBUG_IRYS, since it's an actionable
	// signal) and always lets the mint proceed either way.
	async function verifyGatewayUriBestEffort(uri, maxAttempts) {
		maxAttempts = maxAttempts || 3;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const response = await fetch(uri, { method: "GET", cache: "no-store" });
				if (response.ok) {
					debug("verifyGatewayUriBestEffort: confirmed readable", { uri, attempt });
					return;
				}
			} catch (err) {
				// Could be genuine propagation lag, or could be a CORS
				// restriction unrelated to whether the upload actually
				// succeeded — either way, only retry-and-warn, never throw.
			}
			if (attempt < maxAttempts) {
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
		}
		console.warn(
			"[IRYS] Uploaded data at " + uri + " could not be confirmed readable from the gateway after " +
			maxAttempts + " attempts (may just be propagation delay, or a cross-origin fetch restriction on " +
			"this check itself — not necessarily a failed upload). Proceeding anyway."
		);
	}

	async function uploadFile(walletProvider, bytes, contentType) {
		debug("uploadFile: start", { byteLength: bytes.length, contentType });
		const uploader = await getUploader(walletProvider);
		debug("uploadFile: got uploader, calling getPrice()");
		const price = await uploader.getPrice(bytes.length);
		debug("uploadFile: getPrice() returned", { price: price.toString() });
		await ensureFunded(walletProvider, withFundingBuffer(BigInt(price.toString())));
		debug("uploadFile: ensureFunded() returned, calling uploader.upload()");
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
		debug("uploadFile: uploader.upload() returned", { receiptId: receipt.id });
		const uri = "https://gateway.irys.xyz/" + receipt.id;
		await verifyGatewayUriBestEffort(uri);
		return uri;
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
		const uri = "https://gateway.irys.xyz/" + receipt.id;
		await verifyGatewayUriBestEffort(uri);
		return uri;
	}

	return { estimateUploadCostLamports, getLoadedBalance, ensureFunded, uploadFile, uploadJson };
})();
