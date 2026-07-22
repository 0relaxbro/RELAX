/* =========================================================
   RELAX NFT CREATOR — Instruction Builder
   =========================================================
   Layer 2 of 4: Adapter -> Provider -> InstructionBuilder -> Serializer

   Builds raw, unsigned Solana TransactionInstruction objects for
   every step of a Legacy Token Metadata NFT mint. No @metaplex-foundation
   npm packages are used anywhere (decision made 21 Jul 2026 — see
   SWAP_V2_MIGRATION_PLAN.md / NFT Creator section: the modern Metaplex
   SDK is Umi/bundler-oriented with no reliable browser CDN build,
   unlike @solana/web3.js's own iife bundle already used by
   swap.html/swap-hybrid-test.html. Building instructions by hand here
   means zero dependency on any external CDN transpilation reliability,
   and matches the project's established pattern of owning this layer
   directly (Swap's own build/execute handling, Score's own algorithm,
   Holder verification's own logic).

   Every instruction here is checked against Metaplex's own generated
   Rust source (docs.rs, kinobi-generated — the ground truth for byte
   layout), not memory or a guess. Sources cited per instruction below.
   ========================================================= */

const RelaxInstructionBuilder = (function () {
	const B = RelaxBorsh;

	// ---- Well-known, stable program IDs ----
	// These have not changed in years and are among the most
	// referenced constants in the Solana ecosystem.
	const TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
	const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
	const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
	const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
	const SYSVAR_RENT_PUBKEY = "SysvarRent111111111111111111111111111111111";

	function pk(x) { return new solanaWeb3.PublicKey(x); }

	// ---- PDA derivation ----
	// Both seed schemes are stated verbatim in Metaplex's own generated
	// doc comments (see create_metadata_account_v3.rs / create_master_edition_v3.rs,
	// docs.rs, fetched 21 Jul 2026):
	//   metadata: pda of ['metadata', program id, mint id]
	//   edition:  pda of ['metadata', program id, mint, 'edition']
	async function findMetadataPda(mint) {
		const [addr] = await solanaWeb3.PublicKey.findProgramAddress(
			[new TextEncoder().encode("metadata"), pk(TOKEN_METADATA_PROGRAM_ID).toBytes(), pk(mint).toBytes()],
			pk(TOKEN_METADATA_PROGRAM_ID)
		);
		return addr;
	}
	async function findMasterEditionPda(mint) {
		const [addr] = await solanaWeb3.PublicKey.findProgramAddress(
			[new TextEncoder().encode("metadata"), pk(TOKEN_METADATA_PROGRAM_ID).toBytes(), pk(mint).toBytes(), new TextEncoder().encode("edition")],
			pk(TOKEN_METADATA_PROGRAM_ID)
		);
		return addr;
	}
	async function findAssociatedTokenAddress(owner, mint) {
		const [addr] = await solanaWeb3.PublicKey.findProgramAddress(
			[pk(owner).toBytes(), pk(TOKEN_PROGRAM_ID).toBytes(), pk(mint).toBytes()],
			pk(ASSOCIATED_TOKEN_PROGRAM_ID)
		);
		return addr;
	}

	// ---- DataV2 / Creator / Collection serialization ----
	// Field ORDER matters for Borsh — confirmed against Metaplex's own
	// generated types (docs.rs, fetched 21 Jul 2026):
	//   DataV2:    name, symbol, uri, seller_fee_basis_points, creators, collection, uses
	//   Creator:   address, verified, share   (NOT address/share/verified)
	//   Collection: verified, key             (verified comes FIRST)
	// `uses` is always None (not a v1 feature). `collection` was
	// always None too, per the original architecture decision against
	// Certified Collections — REVISED 22 Jul 2026: that decision was
	// specifically about not requiring RELAX to hold a signing key.
	// It's now a deliberate, narrowly-scoped exception (see
	// buildVerifyCollection below) — this field is what lets a minted
	// NFT point at RELAX's own Collection NFT at all. Still defaults
	// to None (backward compatible) when no collectionMint is given.
	function encodeCreator(creator) {
		return B.concatAll([
			B.pubkey(creator.address),
			B.bool(creator.verified),
			B.u8(creator.share)
		]);
	}

	function encodeCollection(collectionMint) {
		// Collection struct is ALWAYS written unverified at mint time —
		// `verified` can only legitimately become true via a real
		// VerifyCollection instruction signed by the collection's own
		// update authority (see buildVerifyCollection below). Writing
		// `verified: true` here directly would be meaningless — nothing
		// checks it at creation time, so it would just be a lie sitting
		// in an account, not an actual verification.
		return B.concatAll([
			B.bool(false),
			B.pubkey(collectionMint)
		]);
	}

	function encodeDataV2({ name, symbol, uri, sellerFeeBasisPoints, creators, collectionMint }) {
		return B.concatAll([
			B.str(name),
			B.str(symbol),
			B.str(uri),
			B.u16(sellerFeeBasisPoints),
			B.option(creators && creators.length ? creators : null, (list) => B.vec(list, encodeCreator)),
			B.option(collectionMint || null, encodeCollection),
			B.option(null, () => new Uint8Array(0))  // uses — always None, v1 doesn't use this
		]);
	}

	// ---- CreateMetadataAccountV3 ----
	// Source: docs.rs create_metadata_account_v3.rs (kinobi-generated),
	// fetched 21 Jul 2026. Discriminator 33. Accounts, in exact order,
	// with exact signer/writable flags as pushed in instruction_with_
	// remaining_accounts():
	//   0. metadata          [writable]
	//   1. mint              [readonly]
	//   2. mint_authority    [signer, readonly]
	//   3. payer             [signer, writable]
	//   4. update_authority  [signer, readonly]   <- variable is_signer
	//   5. system_program    [readonly]
	//   6. rent              [readonly, optional] — RELAX always omits
	//      this (recent Solana versions don't require the rent
	//      sysvar to be passed explicitly), matching the builder's own
	//      optional-account convention.
	// Args: CreateMetadataAccountV3InstructionArgs { data: DataV2,
	//       is_mutable: bool, collection_details: Option<CollectionDetails> }
	//       collection_details is always None for RELAX (that field is
	//       only for a Certified Collection PARENT NFT, which RELAX
	//       deliberately isn't creating).
	function buildCreateMetadataAccountV3({ metadata, mint, mintAuthority, payer, updateAuthority, updateAuthorityIsSigner, dataV2, isMutable }) {
		const discriminator = B.u8(33);
		const args = B.concatAll([
			encodeDataV2(dataV2),
			B.bool(isMutable),
			B.option(null, () => new Uint8Array(0)) // collection_details — always None, see above
		]);
		const data = B.concatAll([discriminator, args]);

		return new solanaWeb3.TransactionInstruction({
			programId: pk(TOKEN_METADATA_PROGRAM_ID),
			keys: [
				{ pubkey: pk(metadata), isSigner: false, isWritable: true },
				{ pubkey: pk(mint), isSigner: false, isWritable: false },
				{ pubkey: pk(mintAuthority), isSigner: true, isWritable: false },
				{ pubkey: pk(payer), isSigner: true, isWritable: true },
				{ pubkey: pk(updateAuthority), isSigner: !!updateAuthorityIsSigner, isWritable: false },
				{ pubkey: pk(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false }
			],
			data
		});
	}

	// ---- CreateMasterEditionV3 ----
	// Source: docs.rs create_master_edition_v3.rs (kinobi-generated),
	// fetched 21 Jul 2026. Discriminator 17. Accounts, in exact order:
	//   0. edition           [writable]
	//   1. mint              [writable]   <- note: WRITABLE here, unlike
	//      CreateMetadataAccountV3's read-only mint — this instruction
	//      transfers mint/freeze authority to the edition PDA, which
	//      mutates the mint account's state.
	//   2. update_authority  [signer, readonly]
	//   3. mint_authority    [signer, readonly] — "THIS WILL TRANSFER
	//      AUTHORITY AWAY FROM THIS KEY" per Metaplex's own doc comment;
	//      after this instruction, the edition PDA is the mint's new
	//      mint+freeze authority, permanently (this IS what makes it a
	//      real NFT: supply capped at 1, no further minting possible).
	//   4. payer             [signer, writable]
	//   5. metadata          [writable]
	//   6. token_program     [readonly]
	//   7. system_program    [readonly]
	//   8. rent              [readonly, optional] — omitted, same as above.
	// Args: CreateMasterEditionV3InstructionArgs { max_supply: Option<u64> }
	//       RELAX always passes max_supply = Some(0) for a standard
	//       1-of-1 NFT (supply of exactly one, no further prints ever
	//       possible) — this is the standard "this is a true 1/1 NFT"
	//       convention, not a batch/edition-print use case.
	function buildCreateMasterEditionV3({ edition, mint, updateAuthority, mintAuthority, payer, metadata, maxSupply }) {
		const discriminator = B.u8(17);
		const args = B.option(maxSupply === null || maxSupply === undefined ? null : maxSupply, (v) => B.u64(v));
		const data = B.concatAll([discriminator, args]);

		return new solanaWeb3.TransactionInstruction({
			programId: pk(TOKEN_METADATA_PROGRAM_ID),
			keys: [
				{ pubkey: pk(edition), isSigner: false, isWritable: true },
				{ pubkey: pk(mint), isSigner: false, isWritable: true },
				{ pubkey: pk(updateAuthority), isSigner: true, isWritable: false },
				{ pubkey: pk(mintAuthority), isSigner: true, isWritable: false },
				{ pubkey: pk(payer), isSigner: true, isWritable: true },
				{ pubkey: pk(metadata), isSigner: false, isWritable: true },
				{ pubkey: pk(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
				{ pubkey: pk(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false }
			],
			data
		});
	}

	// ---- SPL Token Program: InitializeMint2 ----
	// Instruction index 20 (`InitializeMint2` — the "2" variant omits
	// the rent sysvar account, current best practice). Layout is
	// small, simple, and has been stable for years:
	//   [20, decimals(u8), mint_authority(32 bytes),
	//    freeze_authority_option(1 byte + 32 bytes if Some)]
	// For a standard NFT: decimals = 0 (whole units only — you can't
	// own "0.5" of an NFT), freeze_authority = None (RELAX doesn't
	// want the ability to freeze users' NFTs — non-custodial ethos).
	function buildInitializeMint2({ mint, decimals, mintAuthority, freezeAuthority }) {
		const data = B.concatAll([
			B.u8(20),
			B.u8(decimals),
			B.pubkey(mintAuthority),
			B.option(freezeAuthority || null, (fa) => B.pubkey(fa))
		]);
		return new solanaWeb3.TransactionInstruction({
			programId: pk(TOKEN_PROGRAM_ID),
			keys: [{ pubkey: pk(mint), isSigner: false, isWritable: true }],
			data
		});
	}

	// ---- SPL Token Program: MintTo ----
	// Instruction index 7. Layout: [7, amount(u64 LE)]. For a standard
	// NFT: amount = 1 (mint exactly one unit into the owner's token
	// account, then CreateMasterEditionV3 locks supply at exactly 1
	// forever).
	function buildMintTo({ mint, destination, mintAuthority, amount }) {
		const data = B.concatAll([B.u8(7), B.u64(amount)]);
		return new solanaWeb3.TransactionInstruction({
			programId: pk(TOKEN_PROGRAM_ID),
			keys: [
				{ pubkey: pk(mint), isSigner: false, isWritable: true },
				{ pubkey: pk(destination), isSigner: false, isWritable: true },
				{ pubkey: pk(mintAuthority), isSigner: true, isWritable: false }
			],
			data
		});
	}

	// ---- Associated Token Account Program: CreateIdempotent ----
	// Instruction index 1 ("CreateIdempotent" — succeeds as a no-op if
	// the ATA already exists, rather than failing; this is the modern
	// recommended variant over plain "Create" (index 0), matching the
	// same idempotent-creation pattern already used elsewhere in this
	// project's Jupiter integration). No instruction args beyond the
	// single discriminator byte — everything else is derived from the
	// accounts themselves.
	function buildCreateAssociatedTokenAccountIdempotent({ payer, associatedToken, owner, mint }) {
		const data = B.u8(1);
		return new solanaWeb3.TransactionInstruction({
			programId: pk(ASSOCIATED_TOKEN_PROGRAM_ID),
			keys: [
				{ pubkey: pk(payer), isSigner: true, isWritable: true },
				{ pubkey: pk(associatedToken), isSigner: false, isWritable: true },
				{ pubkey: pk(owner), isSigner: false, isWritable: false },
				{ pubkey: pk(mint), isSigner: false, isWritable: false },
				{ pubkey: pk(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
				{ pubkey: pk(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }
			],
			data
		});
	}

	// ---- VerifyCollection ----
	// Source: mpl-token-metadata 1.3.3 source (docs.rs, fetched 22 Jul
	// 2026 — the actual `verify_collection()` builder function, not
	// just its doc comment, since the two disagree slightly on account
	// 1's writable flag and the CODE is ground truth). Legacy
	// instruction (not the newer unified VerifyCollectionV1 — this
	// project uses Legacy Token Metadata throughout, per the
	// architecture decision in legacy-provider.js, so this matches
	// that same generation of the program). Discriminator 18,
	// cross-checked two ways: (1) mpl-token-metadata 1.2.0's
	// `MetadataInstruction` enum lists VerifyCollection as the very
	// next variant after CreateMasterEditionV3 with no explicit
	// discriminant override, and this project's own
	// buildCreateMasterEditionV3 above already uses 17 (byte-verified
	// separately); Rust enums without explicit values number
	// sequentially, so VerifyCollection = 18. (2) This matches
	// widely-corroborated community documentation of the same value.
	// No instruction args beyond the single discriminator byte — the
	// verify is a permission check (does collection_authority actually
	// control the collection?) and a straight overwrite of one boolean
	// on the NFT's own Metadata account, not something with a payload.
	//
	// Accounts, in the exact order verify_collection() builds them:
	//   0. metadata              [writable]           — the NFT's OWN Metadata account (already has an unverified Collection struct pointing at this collection, set at mint time — see legacy-provider.js/metadata-builder.js for how RELAX's future Collection Verify flow sets that struct)
	//   1. collection_authority  [signer, writable]    — the Collection NFT's update authority (RELAX's dedicated, narrowly-scoped Verify key — see architecture note below)
	//   2. payer                 [signer, writable]    — pays the tx fee; may be the same key as collection_authority
	//   3. collection_mint       [readonly]            — mint of RELAX's Collection NFT
	//   4. collection            [readonly]            — Metadata PDA of RELAX's Collection NFT
	//   5. collection_master_edition_account [readonly] — Master Edition PDA of RELAX's Collection NFT
	// A 7th, optional `collection_authority_record` account exists in
	// the full builder signature for DELEGATED collection authorities
	// (via ApproveCollectionAuthority) — deliberately omitted here:
	// RELAX's Verify key is meant to sign directly as the collection's
	// own update authority, not as a delegate, so there is no such
	// record to pass.
	//
	// SECURITY ARCHITECTURE NOTE (decided 22 Jul 2026): this is the
	// ONE place in the whole NFT Creator where RELAX holds a key that
	// actively signs something — a deliberate, narrow exception to the
	// "RELAX holds no key that matters here, ever" principle stated
	// elsewhere in this project. The exception is scoped as tightly as
	// the account list above allows: this collection_authority key
	// should be a DEDICATED keypair (never reused from anywhere else
	// in the project, same isolation principle as the RELAX Creator
	// brand-identity wallet in legacy-provider.js) whose only real-world
	// capability is signing THIS instruction for THIS one collection
	// mint. It cannot move SOL, cannot mint, cannot touch any other
	// NFT's mint/freeze authority, and never appears in any
	// user-facing transaction except as this one read-only-in-effect
	// signature. If ever compromised, the blast radius is "someone can
	// mark arbitrary NFTs as verified members of RELAX's collection" —
	// a reputational risk, not a funds-custody one — which is why this
	// exception was judged acceptable where holding any
	// funds-adjacent key was not.
	function buildVerifyCollection({ metadata, collectionAuthority, payer, collectionMint, collectionMetadata, collectionMasterEdition }) {
		const discriminator = B.u8(18);

		return new solanaWeb3.TransactionInstruction({
			programId: pk(TOKEN_METADATA_PROGRAM_ID),
			keys: [
				{ pubkey: pk(metadata), isSigner: false, isWritable: true },
				{ pubkey: pk(collectionAuthority), isSigner: true, isWritable: true },
				{ pubkey: pk(payer), isSigner: true, isWritable: true },
				{ pubkey: pk(collectionMint), isSigner: false, isWritable: false },
				{ pubkey: pk(collectionMetadata), isSigner: false, isWritable: false },
				{ pubkey: pk(collectionMasterEdition), isSigner: false, isWritable: false }
			],
			data: discriminator
		});
	}

	// ---- System Program: CreateAccount ----
	// Used to allocate the raw mint account before InitializeMint2 runs
	// on it. This one goes through solanaWeb3's own well-tested helper
	// rather than hand-rolled bytes, since @solana/web3.js (already
	// loaded via CDN, unlike Metaplex) provides this directly and it's
	// pure System Program — zero Metaplex/bundler dependency risk.
	function buildCreateAccount({ payer, newAccount, lamports, space }) {
		return solanaWeb3.SystemProgram.createAccount({
			fromPubkey: pk(payer),
			newAccountPubkey: pk(newAccount),
			lamports,
			space,
			programId: pk(TOKEN_PROGRAM_ID)
		});
	}

	return {
		TOKEN_METADATA_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		SYSTEM_PROGRAM_ID, SYSVAR_RENT_PUBKEY,
		findMetadataPda, findMasterEditionPda, findAssociatedTokenAddress,
		buildCreateMetadataAccountV3, buildCreateMasterEditionV3,
		buildInitializeMint2, buildMintTo, buildCreateAssociatedTokenAccountIdempotent,
		buildVerifyCollection,
		buildCreateAccount
	};
})();
