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
	// RELAX never sets `collection` (no Certified Collection — see
	// architecture decision) or `uses` (not a v1 feature) — both
	// always encoded as None (0x00), which needs no knowledge of
	// their internal layout at all.
	function encodeCreator(creator) {
		return B.concatAll([
			B.pubkey(creator.address),
			B.bool(creator.verified),
			B.u8(creator.share)
		]);
	}

	function encodeDataV2({ name, symbol, uri, sellerFeeBasisPoints, creators }) {
		return B.concatAll([
			B.str(name),
			B.str(symbol),
			B.str(uri),
			B.u16(sellerFeeBasisPoints),
			B.option(creators && creators.length ? creators : null, (list) => B.vec(list, encodeCreator)),
			B.option(null, () => new Uint8Array(0)), // collection — always None, see above
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
		buildCreateAccount
	};
})();
