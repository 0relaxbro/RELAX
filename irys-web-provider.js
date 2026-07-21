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

   FAIL-CLOSED BY DESIGN: if the dynamic import fails for any reason
   (CDN issue, version mismatch, network problem), this throws a
   clear, specific error. There is no silent fallback and no
   half-completed upload — nothing is charged, nothing is uploaded,
   the caller gets an unambiguous "try again" state.
   ========================================================= */

const RelaxIrysWebProvider = (function () {
	// *** DEVNET MODE — flip to false only after a full devnet mint
	// has succeeded end-to-end, per SWAP_V2_MIGRATION_PLAN.md / NFT
	// Creator's testing plan. While true, storage uploads run on
	// Irys's own devnet/test tier (worthless SOL, ~60-day retention)
	// instead of its real mainnet tier. ***
	const DEVNET_MODE = true;
	const DEVNET_RPC_URL = "https://card.0relaxbro.xyz/rpc-devnet"; // same devnet route the mint flow itself uses — one devnet config to keep in sync, not two

	// esm.sh transpiles npm packages into browser-native ES modules on
	// the fly — no bundler needed, but genuinely a live external
	// dependency (unlike @solana/web3.js's own maintained iife CDN
	// build). Pinned to specific versions (not @latest) so a future
	// Irys release can't silently change behavior underneath RELAX.
	// FIX (found live via real devnet testing, 21 Jul 2026): pinned to
	// 0.2.9 originally, but that version was never actually published —
	// esm.sh returned a real 404 the first time this ran for real.
	// Confirmed via npm's own registry: @irys/web-upload's actual
	// latest published version is 0.0.15. @irys/web-upload-solana's
	// 0.1.8 pin was already correct (npm confirms this is its real
	// latest too) — only the first package's version was wrong.
	const IRYS_UPLOAD_CDN = "https://esm.sh/@irys/web-upload@0.0.15";
	const IRYS_SOLANA_CDN = "https://esm.sh/@irys/web-upload-solana@0.1.8";

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
	async function getUploader(walletProvider) {
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
			({ WebUploader } = await import(IRYS_UPLOAD_CDN));
			({ WebSolana } = await import(IRYS_SOLANA_CDN));
		} catch (err) {
			// FAIL CLOSED — exactly per the design requirement above.
			throw new Error(
				"Storage provider could not be loaded. No file was uploaded and no SOL was charged. " +
				"(Technical detail: " + (err && err.message ? err.message : err) + ")"
			);
		}

		try {
			// FIX (found via review, 21 Jul 2026 — genuinely critical
			// catch): this used to call .withProvider() with no network
			// configuration at all, meaning Irys itself defaulted to its
			// mainnet bundler network REGARDLESS of the Solana side
			// being switched to devnet — a real "mixed network" risk
			// (devnet mint, but mainnet-priced/mainnet-charged storage).
			// Confirmed via Irys's own documented pattern (docs.irys.xyz
			// + linea.build/irys-quickstart, fetched 21 Jul 2026,
			// consistent across every chain's example): the builder
			// chain is `.withRpc(rpcUrl).devnet()` — `.withRpc()` points
			// Irys at the CHAIN's own devnet RPC (reusing our own
			// /rpc-devnet route for consistency with the rest of the
			// devnet setup), and `.devnet()` switches IRYS's own network
			// to its temporary/test storage tier (~60 day retention,
			// funded with worthless devnet SOL, per Irys's own docs).
			// DEVNET_MODE toggles this; flip to false only once a
			// devnet mint has fully succeeded and real deployment is
			// being prepared.
			const uploader = DEVNET_MODE
				? await WebUploader(WebSolana).withProvider(walletProvider).withRpc(DEVNET_RPC_URL).devnet()
				: await WebUploader(WebSolana).withProvider(walletProvider);
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
		const uploader = await getUploader(walletProvider);
		const required = BigInt(requiredLamports);
		const balance = BigInt((await uploader.getLoadedBalance()).toString());
		if (balance < required) {
			await uploader.fund(required - balance);
		}
	}

	// Uploads raw file bytes (image, gif, mp4 — anything). Returns a
	// gateway URI immediately usable in NFT metadata's "image" or
	// "animation_url" field. Self-sufficient: funds any shortfall
	// itself right before uploading, so this never fails on
	// insufficient balance even if a UI's own explicit "fund" step was
	// skipped or the balance changed since that step ran.
	async function uploadFile(walletProvider, bytes, contentType) {
		const uploader = await getUploader(walletProvider);
		const price = await uploader.getPrice(bytes.length);
		await ensureFunded(walletProvider, BigInt(price.toString()));
		const tags = [{ name: "Content-Type", value: contentType }];
		const receipt = await uploader.upload(bytes, { tags });
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
		await ensureFunded(walletProvider, BigInt(price.toString()));
		const tags = [{ name: "Content-Type", value: "application/json" }];
		const receipt = await uploader.upload(bytes, { tags });
		return "https://gateway.irys.xyz/" + receipt.id;
	}

	return { estimateUploadCostLamports, getLoadedBalance, ensureFunded, uploadFile, uploadJson };
})();
