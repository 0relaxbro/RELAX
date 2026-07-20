/* =========================================================
   RELAX HOLDER VERIFICATION — shared module
   Currently active use: wallet connection plumbing (connect/
   disconnect/getConnection/detectProviders/onAccountChanged) for
   Swap and Swap Hybrid Engine — neither one currently calls
   checkHolderStatus() below; the Swap fee is 0% for everyone,
   holder status doesn't gate anything today. checkHolderStatus()
   is kept ready, dormant, for future NFT Creator / NFT Market
   perks — not wired into any live tool yet.

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

	let activeConnection = null; // { providerId, publicKey (string), rawProvider }

	/* ============================================================
	   Account-change detection — if the user switches accounts inside
	   Phantom/Solflare/Backpack without disconnecting from the site,
	   activeConnection.publicKey used to go stale: the UI kept showing
	   the old short address, balance/holder checks kept reading the old
	   wallet, and a swap could end up being signed by a different
	   account than the one everything was computed for. Wallets that
	   support it emit "accountChanged" — this listens for it and keeps
	   activeConnection in sync, then notifies anyone registered via
	   onAccountChanged() so pages can refresh their own state.
	   ============================================================ */
	let accountChangeListeners = [];

	function onAccountChanged(callback) {
		accountChangeListeners.push(callback);
	}

	function notifyAccountChanged(newPublicKeyOrNull) {
		accountChangeListeners.forEach((cb) => {
			try { cb(newPublicKeyOrNull); } catch (err) {}
		});
	}

	function wireAccountChangeListener(providerObj) {
		if (!providerObj || typeof providerObj.on !== "function") return;
		try {
			providerObj.on("accountChanged", (newPublicKey) => {
				if (!newPublicKey) {
					// Some wallets emit this with no key when the user
					// locks/disconnects from inside the extension itself.
					activeConnection = null;
					notifyAccountChanged(null);
					return;
				}
				const keyString = newPublicKey.toString ? newPublicKey.toString() : String(newPublicKey);
				if (activeConnection) {
					activeConnection.publicKey = keyString;
				}
				notifyAccountChanged(keyString);
			});
		} catch (err) {
			// Some providers (Backpack's event surface has been less
			// consistently documented than Phantom/Solflare's) may not
			// support this — non-fatal, connection still works fine,
			// just without live account-switch detection for that one.
		}
	}

	async function connect(providerId) {
		const candidates = detectProviders();
		const target = providerId
			? candidates.find((c) => c.id === providerId)
			: candidates[0];

		if (!target) {
			throw new Error(
				"No Solana wallet found. Install Phantom, Solflare, or Backpack and try again."
			);
		}

		const resp = await target.provider.connect();
		const publicKey = (resp && resp.publicKey ? resp.publicKey : target.provider.publicKey)
			.toString();

		activeConnection = { providerId: target.id, publicKey, rawProvider: target.provider };
		wireAccountChangeListener(target.provider);
		return activeConnection;
	}

	/* ============================================================
	   Silent auto-reconnect on page load — addresses the "I have to
	   reconnect every time I refresh" gap found during testing on
	   16 Jul 2026. Uses the standard wallet-adapter "onlyIfTrusted"
	   pattern (supported by Phantom, Solflare, Backpack): if the
	   user already approved this site in a previous session, this
	   reconnects with NO popup. If they never approved it (or
	   revoked access), it fails silently and we just fall back to
	   showing the normal "Connect Wallet" button — never throws,
	   never interrupts the page load.
	   ============================================================ */
	async function tryEagerConnect() {
		const candidates = detectProviders();

		for (const candidate of candidates) {
			try {
				if (typeof candidate.provider.connect !== "function") continue;

				const resp = await candidate.provider.connect({ onlyIfTrusted: true });
				const publicKey = (
					resp && resp.publicKey ? resp.publicKey : candidate.provider.publicKey
				);

				if (!publicKey) continue;

				activeConnection = {
					providerId: candidate.id,
					publicKey: publicKey.toString(),
					rawProvider: candidate.provider
				};
				wireAccountChangeListener(candidate.provider);
				return activeConnection;
			} catch (err) {
				// Expected when the user hasn't previously trusted this site
				// for this wallet — try the next candidate, if any.
				continue;
			}
		}

		return null;
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
	 * Throws if the wallet isn't connected or a network call fails —
	 * callers must treat holder status as unknown in that case and must
	 * not grant any holder-only benefit unless verification actually
	 * succeeds. (Holder status no longer affects the Swap fee — that's
	 * 0% for everyone — it's reserved for future perks on other tools,
	 * e.g. NFT Creator / RELAX Market fee waivers.)
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

	/* ============================================================
	   Wallet passthrough helper — for tools (like Jupiter Plugin)
	   that expect a @solana/wallet-adapter-react-shaped context
	   object instead of managing their own wallet connection.

	   Built from RelaxHolder's already-connected raw provider so the
	   user connects ONCE (via RelaxHolder) rather than once for us
	   and again inside a third-party widget.

	   ⚠️ Needs live testing: this mirrors the commonly-documented
	   useWallet() shape as closely as possible without actually
	   using @solana/wallet-adapter-react (we're plain HTML/JS), but
	   Jupiter's internal validation of this object hasn't been
	   confirmed against a real swap yet. If passthrough doesn't
	   take effect, the wallet/connected fields are the first things
	   to double-check against Jupiter's current plugin source.
	   ============================================================ */
	function getWalletAdapterPassthrough() {
		if (!activeConnection || !activeConnection.rawProvider) {
			return {
				publicKey: null,
				connected: false,
				connecting: false,
				disconnecting: false,
				wallet: null,
				wallets: [],
				signTransaction: undefined,
				signAllTransactions: undefined,
				signMessage: undefined
			};
		}

		const provider = activeConnection.rawProvider;

		return {
			publicKey: provider.publicKey || null,
			connected: true,
			connecting: false,
			disconnecting: false,
			wallet: {
				adapter: {
					name: activeConnection.providerId,
					publicKey: provider.publicKey || null
				}
			},
			wallets: [],
			signTransaction: provider.signTransaction
				? provider.signTransaction.bind(provider)
				: undefined,
			signAllTransactions: provider.signAllTransactions
				? provider.signAllTransactions.bind(provider)
				: undefined,
			signMessage: provider.signMessage
				? provider.signMessage.bind(provider)
				: undefined
		};
	}

	return {
		detectProviders,
		connect,
		tryEagerConnect,
		disconnect,
		getConnection,
		checkHolderStatus,
		getWalletAdapterPassthrough,
		onAccountChanged,
		HOLDER_USD_THRESHOLD
	};

})();
