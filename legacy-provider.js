/* =========================================================
   RELAX NFT CREATOR — Legacy Provider
   =========================================================
   Layer 3 of 4: Adapter -> Provider -> InstructionBuilder -> Serializer

   Implements the NFT Adapter contract (mint/getMetadata/transfer)
   using Legacy Token Metadata specifically. Per the architecture
   decision (21 Jul 2026, SWAP_V2_MIGRATION_PLAN.md / NFT Creator
   section): Legacy was chosen over Metaplex Core because Auction
   House (RELAX's planned marketplace, real 0% commission) requires a
   Mint Account with a linked Metadata Account — exactly Legacy's
   structure, which Core's single-account design doesn't have.

   RELAX's branding-without-custody approach (see architecture
   decision): no Certified Collection (would require RELAX to hold a
   signing key server-side — directly against the non-custodial
   principle already established in Swap). Instead:
     - symbol: "RELAX"
     - creators: [{ address: RELAX_CREATOR_ADDRESS, verified: false, share: 0 },
                  { address: <user>, verified: true, share: 100 }]
     - a custom `relax: {}` namespace in the OFF-CHAIN metadata JSON
       (not on-chain — free-form JSON, no signing/authority implications
       at all) for a later Marketplace to filter on
       (`metadata.relax !== undefined`) without needing a real Collection.

   Mint is fully non-custodial: every instruction below is unsigned
   until returned to the caller, who has the connected wallet sign
   before sending — exactly the same pattern as Swap's own
   `handleExecute()`. RELAX has no private key here, nowhere.
   ========================================================= */

const RelaxLegacyProvider = (function () {
	const IB = RelaxInstructionBuilder;

	// RELAX's own address for the (always-unverified, zero-share)
	// creator entry — this is NOT a signing authority, just an
	// informational tag. share: 0 means it entitles this address to
	// $0 of any future secondary-sale royalty; it exists purely so
	// wallets/marketplaces that display creators can show "RELAX" as
	// associated with the mint, without RELAX ever needing to sign
	// anything or hold any key that matters economically.
	//
	// Dedicated brand-identity wallet (decided 21 Jul 2026) — kept
	// deliberately separate from the dev/test wallet, so this address's
	// on-chain history stays purely "RELAX Creator" and never gets
	// mixed with personal trading, test transfers, etc.
	const RELAX_CREATOR_ADDRESS = "2cXdymQQL5wKixkGnZJVhSDGhfNUuiV5Lb5MJxYmBNu7";

	// Standard SPL Token mint account size, stable for years.
	const MINT_ACCOUNT_SIZE = 82;

	/**
	 * Builds the complete, unsigned set of instructions to mint one
	 * Legacy Token Metadata NFT. Returns everything the caller needs
	 * to assemble a transaction and get it signed by the connected
	 * wallet — this function itself never signs or sends anything.
	 *
	 * @param {Object} params
	 * @param {solanaWeb3.Connection} params.connection
	 * @param {solanaWeb3.PublicKey|string} params.owner - the connected wallet; pays for everything, receives the NFT, becomes the verified creator
	 * @param {solanaWeb3.Keypair} params.mintKeypair - a freshly generated throwaway keypair for the new mint account (caller generates this, e.g. solanaWeb3.Keypair.generate())
	 * @param {string} params.name - NFT name (max ~32 chars is the Token Metadata practical limit before account-size costs climb)
	 * @param {string} params.symbol - defaults to "RELAX" if not given
	 * @param {string} params.metadataUri - the Arweave/permanent URI where the off-chain JSON (name/description/image/relax{} namespace) is already uploaded — uploading itself happens BEFORE calling this, in the Creator UI, paid by the user's own wallet via Irys
	 * @param {number} params.sellerFeeBasisPoints - secondary sale royalty, 0-10000
	 * @returns {Promise<{instructions: solanaWeb3.TransactionInstruction[], mint: solanaWeb3.PublicKey, metadataPda: solanaWeb3.PublicKey, masterEditionPda: solanaWeb3.PublicKey, associatedTokenAccount: solanaWeb3.PublicKey}>}
	 */
	async function buildMintInstructions({ connection, owner, mintKeypair, name, symbol, metadataUri, sellerFeeBasisPoints }) {
		const ownerPk = owner instanceof solanaWeb3.PublicKey ? owner : new solanaWeb3.PublicKey(owner);
		const mintPk = mintKeypair.publicKey;

		const [metadataPda, masterEditionPda, associatedTokenAccount, mintRentLamports] = await Promise.all([
			IB.findMetadataPda(mintPk),
			IB.findMasterEditionPda(mintPk),
			IB.findAssociatedTokenAddress(ownerPk, mintPk),
			connection.getMinimumBalanceForRentExemption(MINT_ACCOUNT_SIZE)
		]);

		const instructions = [
			// 1. Allocate the raw mint account (owner pays the one-time
			//    rent deposit — this account lives forever, this rent is
			//    NOT refundable, unlike a temporary wSOL account in Swap).
			IB.buildCreateAccount({
				payer: ownerPk, newAccount: mintPk,
				lamports: mintRentLamports, space: MINT_ACCOUNT_SIZE
			}),

			// 2. Initialize it as an SPL Token mint. decimals: 0 (NFTs are
			//    whole units). mintAuthority: the owner, temporarily — see
			//    step 6, this gets permanently transferred away.
			IB.buildInitializeMint2({
				mint: mintPk, decimals: 0, mintAuthority: ownerPk, freezeAuthority: null
			}),

			// 3. Create the owner's associated token account for this mint
			//    (idempotent — harmless if it somehow already exists).
			IB.buildCreateAssociatedTokenAccountIdempotent({
				payer: ownerPk, associatedToken: associatedTokenAccount, owner: ownerPk, mint: mintPk
			}),

			// 4. Mint exactly one unit into that account.
			IB.buildMintTo({
				mint: mintPk, destination: associatedTokenAccount, mintAuthority: ownerPk, amount: 1
			}),

			// 5. Create the Metadata account — name/symbol/uri/royalty/
			//    creators. is_mutable: true (owner can still update this
			//    later; RELAX has no say in this either way since RELAX
			//    is never the update authority).
			IB.buildCreateMetadataAccountV3({
				metadata: metadataPda, mint: mintPk, mintAuthority: ownerPk, payer: ownerPk,
				updateAuthority: ownerPk, updateAuthorityIsSigner: true,
				dataV2: {
					name: name,
					symbol: symbol || "RELAX",
					uri: metadataUri,
					sellerFeeBasisPoints: sellerFeeBasisPoints || 0,
					creators: [
						{ address: RELAX_CREATOR_ADDRESS, verified: false, share: 0 },
						{ address: ownerPk.toBase58(), verified: true, share: 100 }
					]
				},
				isMutable: true
			}),

			// 6. Create the Master Edition — this is the step that makes
			//    it a REAL 1-of-1 NFT: max_supply 0 means no further
			//    prints/editions can ever be minted from this, and mint+
			//    freeze authority permanently transfer to the edition PDA
			//    (nobody, including the owner, can mint more of this
			//    specific mint ever again after this instruction lands).
			IB.buildCreateMasterEditionV3({
				edition: masterEditionPda, mint: mintPk, updateAuthority: ownerPk,
				mintAuthority: ownerPk, payer: ownerPk, metadata: metadataPda,
				maxSupply: 0
			})
		];

		return { instructions, mint: mintPk, metadataPda, masterEditionPda, associatedTokenAccount };
	}

	return { buildMintInstructions, RELAX_CREATOR_ADDRESS, MINT_ACCOUNT_SIZE };
})();
