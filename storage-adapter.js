/* =========================================================
   RELAX STORAGE ADAPTER
   =========================================================
   Same architecture rule as RelaxNFT (see nft-adapter.js): the
   Creator UI only ever calls RelaxStorage.* — never
   RelaxIrysWebProvider directly. If Irys's CDN import ever proves
   unreliable in practice, or a better option appears (Pinata, a raw
   HTTP provider, a different Irys build), only `activeProvider`
   below changes — the UI's calls stay identical.
   ========================================================= */

const RelaxStorage = (function () {
	const activeProvider = RelaxIrysWebProvider;

	/**
	 * Step 1 of the safe upload sequence (see SWAP_V2_MIGRATION_PLAN.md
	 * / NFT Creator section for the full 9-step order): get a real
	 * cost estimate BEFORE uploading anything, so the Creator UI can
	 * show the user what they're about to pay and get explicit
	 * confirmation — never a blind combined upload+charge.
	 */
	async function estimateCost(walletProvider, fileBytes) {
		const lamports = await activeProvider.estimateUploadCostLamports(walletProvider, fileBytes.length);
		return lamports;
	}

	/**
	 * The user's current Irys-loaded balance (separate from their
	 * wallet's own SOL) — lets the Creator UI show "you already have
	 * enough loaded, no new funding needed" vs "you'll need to fund
	 * X more" before asking for a signature.
	 */
	async function getLoadedBalance(walletProvider) {
		return activeProvider.getLoadedBalance(walletProvider);
	}

	/**
	 * Explicit "fund storage" step for the UI to call after showing
	 * the cost estimate and getting confirmation (step 2 of the 9-step
	 * flow). Note: uploadMedia/uploadMetadataJson below ALSO ensure
	 * funding internally right before uploading — calling this
	 * explicitly first just makes the step visible to the user rather
	 * than folding it silently into the upload call.
	 */
	async function ensureFunded(walletProvider, requiredLamports) {
		return activeProvider.ensureFunded(walletProvider, requiredLamports);
	}

	/**
	 * Uploads the media file (image/gif/mp4). Call only after the user
	 * has seen the cost estimate and explicitly confirmed.
	 * @returns {Promise<string>} gateway URI
	 */
	async function uploadMedia(walletProvider, fileBytes, contentType) {
		return activeProvider.uploadFile(walletProvider, fileBytes, contentType);
	}

	/**
	 * Uploads the finished off-chain metadata JSON (built by
	 * metadata-builder.js, AFTER the media URI is already known).
	 * @returns {Promise<string>} gateway URI — this becomes the
	 *          on-chain metadata's `uri` field.
	 */
	async function uploadMetadataJson(walletProvider, metadataObject) {
		return activeProvider.uploadJson(walletProvider, metadataObject);
	}

	return { estimateCost, getLoadedBalance, ensureFunded, uploadMedia, uploadMetadataJson };
})();
