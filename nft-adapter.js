/* =========================================================
   RELAX NFT ADAPTER
   =========================================================
   Layer 4 of 4 (the top): Adapter -> Provider -> InstructionBuilder -> Serializer

   THE MANDATORY ARCHITECTURE RULE (established 21 Jul 2026, see
   SWAP_V2_MIGRATION_PLAN.md / NFT Creator section): the Creator UI
   must ONLY ever call RelaxNFT.* — never RelaxLegacyProvider directly,
   never reach into instruction-builder.js or serializer.js itself.
   This is what makes a future standard change (Core graduating from
   "Stability 1 — Experimental" to "Stable") a one-file swap
   (add a RelaxCoreProvider, change the `activeProvider` line below)
   instead of a rewrite of every page that mints or reads an NFT.

   Today, activeProvider is always RelaxLegacyProvider — no other
   provider exists yet, by design (Core research stays a background
   watch item, not a v1 feature).
   ========================================================= */

const RelaxNFT = (function () {
	const activeProvider = RelaxLegacyProvider;

	/**
	 * Builds a complete, UNSIGNED mint transaction ready for the
	 * connected wallet to sign. Mirrors Swap's own pattern exactly:
	 * this function never signs, never sends, never touches a private
	 * key — the caller (Creator UI) gets a Transaction back, passes it
	 * to the wallet adapter's signTransaction(), then sends it via the
	 * connection, exactly like handleExecute() does in swap.html.
	 *
	 * @param {Object} params
	 * @param {solanaWeb3.Connection} params.connection
	 * @param {solanaWeb3.PublicKey|string} params.owner - connected wallet
	 * @param {string} params.name
	 * @param {string} [params.symbol] - defaults to "RELAX"
	 * @param {string} params.metadataUri - already-uploaded Arweave/Irys URI (see note below)
	 * @param {number} [params.sellerFeeBasisPoints] - defaults to 0
	 * @returns {Promise<{transaction: solanaWeb3.Transaction, mintKeypair: solanaWeb3.Keypair, mint: solanaWeb3.PublicKey, metadataPda: solanaWeb3.PublicKey, masterEditionPda: solanaWeb3.PublicKey, associatedTokenAccount: solanaWeb3.PublicKey}>}
	 *
	 * NOTE on metadataUri: uploading the image + off-chain JSON
	 * (name/description/image/relax{} namespace) to Arweave via Irys
	 * happens BEFORE this function is called, paid directly by the
	 * user's own wallet (per the "kullanıcı öder" decision, 21 Jul
	 * 2026) — that upload step is a separate, not-yet-built piece of
	 * the Creator UI, tracked separately from this mint-instruction
	 * layer.
	 */
	async function mint({ connection, owner, name, symbol, metadataUri, sellerFeeBasisPoints }) {
		if (!name || !name.trim()) throw new Error("NFT name is required.");
		if (!metadataUri || !metadataUri.trim()) throw new Error("metadataUri is required — upload metadata before minting.");

		const mintKeypair = solanaWeb3.Keypair.generate();

		const { instructions, mint, metadataPda, masterEditionPda, associatedTokenAccount } =
			await activeProvider.buildMintInstructions({
				connection, owner, mintKeypair, name: name.trim(),
				symbol: symbol || "RELAX", metadataUri: metadataUri.trim(),
				sellerFeeBasisPoints: sellerFeeBasisPoints || 0
			});

		const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
		const ownerPk = owner instanceof solanaWeb3.PublicKey ? owner : new solanaWeb3.PublicKey(owner);

		const transaction = new solanaWeb3.Transaction({
			feePayer: ownerPk,
			blockhash,
			lastValidBlockHeight
		}).add(...instructions);

		// The mint account itself must co-sign (a brand-new account
		// always signs its own creation) — the wallet signs for the
		// owner/payer role, this keypair signs for the mint role. Both
		// signatures are required before this transaction is valid.
		transaction.partialSign(mintKeypair);

		return { transaction, mintKeypair, mint, metadataPda, masterEditionPda, associatedTokenAccount };
	}

	// Placeholder for future use (e.g. NFT Creator's own "my mints"
	// list, or a future Marketplace reading listing state) — not
	// needed for a basic mint flow, kept here so the Adapter's shape
	// is visible even before every method has a real implementation.
	async function getMetadata(/* mint */) {
		throw new Error("getMetadata() not yet implemented — not needed for v1 mint flow.");
	}

	async function transfer(/* params */) {
		throw new Error("transfer() not yet implemented — SPL Token transfer of the NFT's token account; not needed for v1 mint flow.");
	}

	return { mint, getMetadata, transfer };
})();
