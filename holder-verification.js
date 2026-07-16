/* =========================================================
   RELAX HOLDER VERIFICATION — shared module
   Used by: Swap, NFT Creator, NFT Market (any RELAX tool that
   needs to know "is this wallet a $RELAX holder worth >= $20?")

   Design notes (see teknik plan, Bölüm 1 + Holder Verification
   architecture discussion):
   - This is the ONE place the $20 threshold and balance-reading
     logic live. Every tool calls RelaxHolder, none of them
     re-implement the check themselves.
   - Read-only. Never asks for a signature, never moves funds.
   - Reuses the exact RPC proxy (card.0relaxbro.xyz) and contract
     address already used by the rest of the site.
   ========================================================= */

const RelaxHolder = (function () {

	const RPC_URL = "https://card.0relaxbro.xyz";
	const RELAX_MINT = "6DDJ6Gsuvhe4Hb7zkohLBhDjKkyCxHsYt4thNukbpump";
	// DexScreener first, pump.fun as automatic fallback — same convention
	// used site-wide (see index.html's fetchRelaxMarket and the
	// .dex-chart-link fallback script). Self-corrects back to DexScreener
	// once $RELAX graduates and real liquidity/volume appears.
	const DEX_PAIR_ENDPOINT =
		"https://api.dexscreener.com/token-pairs/v1/solana/" + RELAX_MINT;
	const PUMPFUN_PRICE_ENDPOINT = "https://card.0relaxbro.xyz/pumpfun-price";
	const HOLDER_USD_THRESHOLD = 20;

	// Cache the price for a short window so rapid re-checks (e.g. re-running
	// verification after a swap) don't hammer DexScreener.
	let priceCache = { value: null, fetchedAt: 0 };
	const PRICE_CACHE_MS = 30000;

	/* ---------- Wallet connection ---------- */

	function detectProviders() {
		const found = [];
		if (typeof window !== "undefined") {
			if (window.solana && window.solana.isPhantom) {
				found.push({ id: "phantom", label: "Phantom", provider: window.solana });
			}
			if (window.solflare && window.solflare.isSolflare) {
				found.push({ id: "solflare", label: "Solflare", provider: window.solflare });
			}
			// Backpack injects window.backpack
			if (window.backpack) {
				found.push({ id: "backpack", label: "Backpack", provider: window.backpack });
			}
		}
		return found;
	}

	let activeConnection = null; // { providerId, publicKey (string) }

	async function connect(providerId) {
		const candidates = detectProviders();
		const target = providerId
			? candidates.find((c) => c.id === providerId)
			: candidates[0];

		if (!target) {
			throw new Error(
				"No Solana wallet found. Install Phantom or Solflare and try again."
			);
		}

		const resp = await target.provider.connect();
		const publicKey = (resp && resp.publicKey ? resp.publicKey : target.provider.publicKey)
			.toString();

		activeConnection = { providerId: target.id, publicKey };
		return activeConnection;
	}

	function disconnect() {
		try {
			const candidates = detectProviders();
			const active = candidates.find((c) => c.id === (activeConnection || {}).providerId);
			if (active && active.provider.disconnect) active.provider.disconnect();
		} catch (err) {
			// non-fatal
		}
		activeConnection = null;
	}

	function getConnection() {
		return activeConnection;
	}

	/* ---------- Balance + price reading (read-only RPC) ---------- */

	async function fetchRelaxTokenAmount(ownerAddress) {
		const body = {
			jsonrpc: "2.0",
			id: 1,
			method: "getTokenAccountsByOwner",
			params: [
				ownerAddress,
				{ mint: RELAX_MINT },
				{ encoding: "jsonParsed" }
			]
		};

		const res = await fetch(RPC_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body)
		});

		if (!res.ok) {
			throw new Error("Balance lookup failed (" + res.status + ")");
		}

		const json = await res.json();
		const accounts = (json && json.result && json.result.value) || [];

		// Sum across all token accounts for this mint (usually just one).
		let total = 0;
		for (const acc of accounts) {
			const amt =
				acc &&
				acc.account &&
				acc.account.data &&
				acc.account.data.parsed &&
				acc.account.data.parsed.info &&
				acc.account.data.parsed.info.tokenAmount &&
				acc.account.data.parsed.info.tokenAmount.uiAmount;
			if (typeof amt === "number") total += amt;
		}
		return total;
	}

	async function fetchRelaxPriceUsd() {
		const now = Date.now();
		if (priceCache.value !== null && now - priceCache.fetchedAt < PRICE_CACHE_MS) {
			return priceCache.value;
		}

		// Try DexScreener first.
		try {
			const dexRes = await fetch(DEX_PAIR_ENDPOINT, { cache: "no-store" });
			if (dexRes.ok) {
				const pairs = await dexRes.json();
				const bestPair = Array.isArray(pairs) && pairs.length > 0
					? pairs.slice().sort(
						(a, b) => Number((b && b.liquidity && b.liquidity.usd) || 0) -
							Number((a && a.liquidity && a.liquidity.usd) || 0)
					  )[0]
					: null;

				if (bestPair) {
					const price = Number(bestPair.priceUsd);
					if (Number.isFinite(price)) {
						priceCache = { value: price, fetchedAt: now };
						return price;
					}
				}
			}
		} catch (dexErr) {
			// fall through to pump.fun below
		}

		// Fall back to pump.fun (still on bonding curve, no DEX pair yet).
		const pumpRes = await fetch(PUMPFUN_PRICE_ENDPOINT, { cache: "no-store" });
		if (!pumpRes.ok) throw new Error("Price lookup failed (both sources)");

		const data = await pumpRes.json();

		if (typeof data.priceUsd !== "number" || !Number.isFinite(data.priceUsd)) {
			throw new Error("Invalid price data from pump.fun proxy");
		}

		priceCache = { value: data.priceUsd, fetchedAt: now };
		return data.priceUsd;
	}

	/* ---------- The single check every RELAX tool calls ---------- */

	/**
	 * Returns:
	 *   {
	 *     isHolder: boolean,
	 *     usdValue: number,
	 *     tokenAmount: number,
	 *     priceUsd: number,
	 *     threshold: number
	 *   }
	 * Throws if wallet isn't connected or a network call fails —
	 * callers should treat a thrown error as "fee tier unknown, default
	 * to standard (non-holder) fee" rather than silently granting 0%.
	 */
	async function checkHolderStatus() {
		if (!activeConnection) {
			throw new Error("Wallet not connected.");
		}

		const [tokenAmount, priceUsd] = await Promise.all([
			fetchRelaxTokenAmount(activeConnection.publicKey),
			fetchRelaxPriceUsd()
		]);

		const usdValue = tokenAmount * priceUsd;

		return {
			isHolder: usdValue >= HOLDER_USD_THRESHOLD,
			usdValue,
			tokenAmount,
			priceUsd,
			threshold: HOLDER_USD_THRESHOLD
		};
	}

	return {
		detectProviders,
		connect,
		disconnect,
		getConnection,
		checkHolderStatus,
		HOLDER_USD_THRESHOLD
	};

})();
