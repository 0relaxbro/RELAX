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
	 * @param {string} params.metadataUri - the Irys storage URI where the off-chain JSON (name/description/image/relax{} namespace) is already uploaded — uploading itself happens BEFORE calling this, in the Creator UI, paid by the user's own wallet via Irys. NOTE: while DEVNET_MODE is on (see irys-web-provider.js), this is Irys's devnet/test storage tier — NOT permanent, ~60-day retention, no real monetary value. On mainnet, this becomes a paid Irys storage URI whose persistence properties must be verified against Irys's current docs before relying on it for production launch — not assumed permanent by default.
	 * @param {number} params.sellerFeeBasisPoints - secondary sale royalty, 0-10000
	 * @returns {Promise<{instructions: solanaWeb3.TransactionInstruction[], mint: solanaWeb3.PublicKey, metadataPda: solanaWeb3.PublicKey, masterEditionPda: solanaWeb3.PublicKey, associatedTokenAccount: solanaWeb3.PublicKey}>}
	 */
	async function buildMintInstructions({ connection, owner, mintKeypair, name, symbol, metadataUri, sellerFeeBasisPoints, collectionMint }) {
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
			//    whole units).
			//    mintAuthority AND freezeAuthority are BOTH set to the
			//    owner here, temporarily — see step 6.
			//
			//    *** CRITICAL — do NOT set freezeAuthority to null here. ***
			//    CreateMasterEditionV3 (step 6) transfers BOTH the mint
			//    authority and the freeze authority to the Edition PDA
			//    (confirmed against Metaplex Token Metadata docs). To
			//    TRANSFER the freeze authority, the mint must already HAVE
			//    one at this point, and its current holder (the owner) must
			//    sign the transfer. If freezeAuthority is null, step 6's
			//    internal SetAuthority(FreezeAccount) CPI has no authority
			//    to move and fails ("mint has no freeze authority" /
			//    "owner does not match"), which fails the ENTIRE mint
			//    transaction at simulation — this was the exact reason
			//    minting never succeeded before (fixed 22 Jul 2026).
			//
			//    This does NOT compromise the non-custodial ethos: after
			//    step 6 the freeze authority lives on the Edition PDA (no
			//    private key, nobody controls it), and the owner only holds
			//    it for the microseconds BETWEEN step 2 and step 6 inside
			//    this one atomic transaction — never exposed to RELAX or
			//    anyone else. This is the standard, correct 1/1 NFT setup.
			IB.buildInitializeMint2({
				mint: mintPk, decimals: 0, mintAuthority: ownerPk, freezeAuthority: ownerPk
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
					],
					// FIX (added 22 Jul 2026, part of the Verified Collection
					// architecture): when a collection mint is supplied, this
					// NFT's on-chain Collection struct is set (always
					// unverified — see encodeCollection in instruction-builder.js)
					// so a later, separate VerifyCollection instruction (signed
					// by RELAX's dedicated, narrowly-scoped collection
					// authority — never this same transaction, never this same
					// key as anything else) can flip it to verified. Omitted
					// entirely (stays undefined -> encoded as None) for any
					// mint that doesn't pass one — this NEVER silently opts a
					// mint into a collection it wasn't explicitly given.
					collectionMint: collectionMint || undefined
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

	/**
	 * Builds the single VerifyCollection instruction that flips an
	 * already-minted NFT's on-chain Collection struct from unverified
	 * to verified — assuming that NFT was minted with `collectionMint`
	 * passed to buildMintInstructions() above (otherwise its Metadata
	 * account has no Collection struct at all to verify, and this
	 * would fail on-chain with a missing-collection error).
	 *
	 * Deliberately returns a single INSTRUCTION, not a built/signed
	 * transaction — the caller (RelaxNFT.verifyCollection(), then
	 * whatever server-side flow actually holds the collection
	 * authority key) is responsible for assembling it into a
	 * transaction with the right fee payer and blockhash, and for
	 * collecting BOTH required signatures (payer AND
	 * collectionAuthority — see buildVerifyCollection's account list
	 * in instruction-builder.js). This function has no opinion on who
	 * signs what or when; it only knows how to build the one
	 * instruction correctly.
	 *
	 * @param {Object} params
	 * @param {solanaWeb3.PublicKey|string} params.nftMint - the mint of the NFT being verified (must already have an unverified Collection struct pointing at collectionMint)
	 * @param {solanaWeb3.PublicKey|string} params.collectionMint - RELAX's own Collection NFT's mint
	 * @param {solanaWeb3.PublicKey|string} params.collectionAuthority - the PUBLIC key of RELAX's dedicated, narrowly-scoped Verify signer (see the security note on buildVerifyCollection in instruction-builder.js) — this function never touches or needs the corresponding private key
	 * @param {solanaWeb3.PublicKey|string} params.payer - whoever pays the tx fee; typically the NFT's own owner
	 * @returns {Promise<solanaWeb3.TransactionInstruction>}
	 */
	async function buildVerifyCollectionInstruction({ nftMint, collectionMint, collectionAuthority, payer }) {
		const [nftMetadataPda, collectionMetadataPda, collectionMasterEditionPda] = await Promise.all([
			IB.findMetadataPda(nftMint),
			IB.findMetadataPda(collectionMint),
			IB.findMasterEditionPda(collectionMint)
		]);

		return IB.buildVerifyCollection({
			metadata: nftMetadataPda,
			collectionAuthority,
			payer,
			collectionMint,
			collectionMetadata: collectionMetadataPda,
			collectionMasterEdition: collectionMasterEditionPda
		});
	}

	return { buildMintInstructions, buildVerifyCollectionInstruction, RELAX_CREATOR_ADDRESS, MINT_ACCOUNT_SIZE };
})();
