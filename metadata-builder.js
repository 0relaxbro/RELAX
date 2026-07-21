/* =========================================================
   RELAX NFT CREATOR — Metadata Builder
   =========================================================
   Pure function layer: takes form data + already-uploaded media
   URI(s), returns the exact off-chain JSON object to upload via
   RelaxStorage.uploadMetadataJson(). No network calls, no signing —
   this only shapes data.

   IMPORTANT — holderVerified is cosmetic, not security (flagged
   21 Jul 2026): this JSON is fully user-editable off-chain data.
   Anyone can upload their own metadata claiming holderVerified: true
   whether or not they actually held $RELAX at mint time. This field
   exists ONLY for a future Marketplace's visual badge/filter — it
   must NEVER be trusted as proof of anything. If a future Marketplace
   needs to give holders a REAL perk (fee discount, priority listing,
   etc.), it must re-verify the relevant wallet's $RELAX balance
   on-chain at that moment, via RelaxHolder.checkHolderStatus() — the
   same dormant function already sitting in holder-verification.js.
   ========================================================= */

const RelaxMetadataBuilder = (function () {
	const RELAX_IDENTITY_ADDRESS = "2cXdymQQL5wKixkGnZJVhSDGhfNUuiV5Lb5MJxYmBNu7";
	const CREATOR_VERSION = 1;

	/**
	 * @param {Object} params
	 * @param {string} params.name
	 * @param {string} params.description
	 * @param {string} params.imageUri - already uploaded via RelaxStorage.uploadMedia(). For a video NFT, this MUST be a cover image (not the video itself) — see media model note below.
	 * @param {string} params.imageContentType - e.g. "image/png", "image/gif"
	 * @param {string} [params.animationUri] - already uploaded, ONLY for actual video (holder feature) — GIFs go in imageUri/imageContentType instead, per the standard convention below
	 * @param {string} [params.animationContentType] - e.g. "video/mp4" — required if animationUri is given, never assumed
	 * @param {Array<{trait_type: string, value: string}>} [params.attributes]
	 * @param {string} params.ownerAddress - the minting wallet (base58)
	 * @param {boolean} [params.wasHolderAtMintTime] - result of a REAL
	 *        RelaxHolder.checkHolderStatus() check performed by the
	 *        Creator UI just before this call — this function only
	 *        records the result, it does not verify it itself.
	 * @returns {Object} the complete off-chain metadata JSON, ready for RelaxStorage.uploadMetadataJson()
	 *
	 * MEDIA MODEL (clarified via review, 21 Jul 2026 — this is the
	 * standard Metaplex/wallet-display convention, not a RELAX
	 * invention):
	 *   - PNG/JPG/WebP: goes directly in `image`, no animation_url.
	 *   - GIF: goes directly in `image` too — animation_url is NOT
	 *     required for GIFs, most wallets/marketplaces render an
	 *     animated `image` field fine on its own.
	 *   - MP4 (or other real video): `image` holds a still COVER
	 *     image (mandatory — many wallets/marketplaces that don't
	 *     support animation_url fall back to `image` for the
	 *     thumbnail/preview), `animation_url` holds the actual video.
	 */
	function build({ name, description, imageUri, imageContentType, animationUri, animationContentType, attributes, ownerAddress, wasHolderAtMintTime }) {
		if (!name || !name.trim()) throw new Error("Name is required.");
		if (!imageUri) throw new Error("imageUri is required — upload the media first.");
		if (!ownerAddress) throw new Error("ownerAddress is required.");
		if (animationUri && !animationContentType) {
			throw new Error("animationContentType is required whenever animationUri is given — never assumed.");
		}

		const files = [{ uri: imageUri, type: imageContentType || "image/png" }];
		if (animationUri) files.push({ uri: animationUri, type: animationContentType });

		// Category reflects the actual animated media type, not just
		// "did an animation_url exist" — a video's category is "video"
		// even though `image` also holds its cover image.
		const category = (animationContentType && animationContentType.startsWith("video/")) ? "video" : "image";

		return {
			name: name.trim(),
			symbol: "RELAX",
			description: description || "",
			image: imageUri,
			...(animationUri ? { animation_url: animationUri } : {}),
			external_url: "https://0relaxbro.xyz/nft-creator.html",
			attributes: Array.isArray(attributes) ? attributes : [],
			properties: {
				files: files,
				category: category,
				// Mirrors the on-chain creators array (see legacy-provider.js)
				// for consistency across any wallet/marketplace UI that
				// reads the off-chain JSON's creators list instead of (or
				// in addition to) the on-chain one. share:0 here carries
				// the same meaning as on-chain: purely informational, no
				// economic claim.
				creators: [
					{ address: RELAX_IDENTITY_ADDRESS, share: 0 },
					{ address: ownerAddress, share: 100 }
				]
			},
			// RELAX's own namespace — not a Metaplex/Solana standard
			// field, just free-form JSON that a future Marketplace can
			// filter on (`metadata.relax !== undefined`) without needing
			// a real Certified Collection. See the file header above:
			// holderVerified is cosmetic only, never trust it as proof.
			relax: {
				creatorVersion: CREATOR_VERSION,
				mintedVia: "RELAX Creator",
				identity: RELAX_IDENTITY_ADDRESS,
				holderVerified: !!wasHolderAtMintTime,
				timestamp: Math.floor(Date.now() / 1000)
			}
		};
	}

	return { build, RELAX_IDENTITY_ADDRESS, CREATOR_VERSION };
})();
