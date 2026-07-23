/* =========================================================
   RELAX — Candy Machine V3 (Candy Machine Core) Instruction Builder
   =========================================================
   FIRST WORKING SLICE (23 Jul 2026) — covers only what's needed for
   the very first devnet test: creating a CandyMachine account
   (InitializeV2) and uploading NFT metadata in batches
   (AddConfigLines). Candy Guard's own instructions (initialize,
   mint_v2, route) are a separate file, not written yet — see
   SWAP_V2_MIGRATION_PLAN.md's Candy Machine V3 research section for
   the full plan this implements.

   Reuses RelaxBorsh (serializer.js) for every primitive — no new
   encoding logic invented here, same architecture layering as the
   Token Metadata NFT Creator (Adapter -> Provider -> InstructionBuilder
   -> Serializer). serializer.js AND instruction-builder.js must both
   be loaded before this file.

   ---------------------------------------------------------
   REVISION 2 (23 Jul 2026) — after the first real devnet error
   ---------------------------------------------------------
   Devnet returned: AnchorError caused by account: candy_machine,
   Error Code: ConstraintRaw, Error Number: 2003 (0x7d3).

   That is InitializeV2's `#[account(zero, constraint = ...)]` raw
   constraint failing. The constraint is:

       candy_machine.owner == program_id
       && candy_machine.data_len() >= data.get_space_for_candy()?

   The owner half was fine (SystemProgram.createAccount already
   assigns the account to the Candy Machine program). The SIZE half
   was not: getSpaceForCandy() below was computing the header
   DYNAMICALLY (153 + actual creators + actual ConfigLineSettings),
   but the program reserves the header at MAXIMUM sizes and treats
   the hidden section as starting at a FIXED byte offset.

   Metaplex's own account layout table (mpl-candy-machine-core 3.0.1
   bundled README.md, "Account" section) states the hidden section
   begins at offset 850 — regardless of how many creators there are,
   how long the symbol is, or how short prefix_name/prefix_uri are.
   Space is always reserved for 5 creators (MAX_CREATOR_LIMIT), a
   10-byte symbol, a 32-byte name + 200-byte uri prefix, and a full
   HiddenSettings block, whether they're used or not.

   Old formula for the 20-item test: 2330 bytes.
   Program's requirement:              2737 bytes.
   -> 407 bytes short -> ConstraintRaw, every single time, for every
   configuration (verified across 16 / 20 / 100 / 1000 items).

   Two smaller bugs in the same function, also fixed:
     - byte mask was Math.ceil(items/8); the program uses
       (items / 8) + 1 with INTEGER division. These agree only when
       items is not a multiple of 8 — at items=16 the old version
       was 1 byte short on top of everything else.
     - mint indices (items * 4) were skipped when isSequential was
       true. The program allocates them unconditionally.

   Also note what was NOT wrong, so it doesn't get "fixed" by
   mistake later: the four instruction discriminators are correct
   (the devnet log itself printed "Instruction: InitializeV2", which
   only happens after the 8 discriminator bytes matched), and the
   15-account list matches Metaplex's own initialize_v2 table
   exactly.
   ---------------------------------------------------------

   Program ID and every struct layout below is sourced from Metaplex's
   own docs.rs pages for mpl-candy-machine-core 3.0.1 and the
   metaplex-foundation/mpl-candy-machine GitHub repo — cited inline.
   ========================================================= */

const RelaxCandyMachine = (function () {
	const { u8, u16, u32, u64, bool, str, pubkey, option, vec, concatAll } = RelaxBorsh;

	// Verified program ID — metaplex-foundation/mpl-candy-machine repo
	// README (root), cross-checked against an independent program-
	// address reference table. NOT the newer, incompatible "Core
	// Candy Machine" (CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J) —
	// that mints Metaplex Core assets, a different standard, already
	// ruled out for RELAX (22 Jul 2026 decision).
	const CANDY_MACHINE_CORE_PROGRAM_ID = "CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR";

	const TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
	const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
	const SYSVAR_INSTRUCTIONS_ID = "Sysvar1nstructions1111111111111111111111111";

	/**
	 * Byte offset at which the CandyMachine account's "hidden section"
	 * (config lines + byte mask + mint indices) begins. FIXED — the
	 * whole struct header above it is reserved at maximum sizes, not
	 * at the sizes actually used.
	 *
	 * Source: mpl-candy-machine-core 3.0.1 bundled README.md account
	 * table, which lists `_hidden section_` at offset 850. Adds up
	 * field by field:
	 *   8   discriminator
	 *   1   account_version      (offset 8)
	 *   1   token_standard       (offset 9)
	 *   6   features             (offset 10)
	 *   32  authority            (offset 16)
	 *   32  mint_authority       (offset 48)
	 *   32  collection_mint      (offset 80)
	 *   8   items_redeemed       (offset 112)
	 *   8   items_available      (offset 120)
	 *   14  symbol   (4 + MAX_SYMBOL_LENGTH 10)        (offset 128)
	 *   2   seller_fee_basis_points                    (offset 142)
	 *   8   max_supply                                 (offset 144)
	 *   1   is_mutable                                 (offset 152)
	 *   174 creators (4 + 5 * 34, ALWAYS 5 slots)      (offset 153)
	 *   250 config_line_settings (1 + 36 + 4 + 204 + 4 + 1)
	 *   273 hidden_settings      (1 + 36 + 204 + 32)
	 *   = 850
	 */
	const HIDDEN_SECTION = 850;

	/**
	 * Trailing "rule set flag" (1 byte) + "rule set" pubkey (32 bytes)
	 * that the account layout lists after the mint indices. Only
	 * meaningful for pNFTs, but always reserved here.
	 *
	 * Why reserve it even though RELAX mints plain NFTs: the on-chain
	 * constraint is `data_len() >= get_space_for_candy()`, a GREATER-
	 * THAN-OR-EQUAL. Over-allocating is always accepted, costs 33
	 * bytes of rent (~0.00023 SOL), and removes any risk of the
	 * program writing a trailing flag byte one past the end of the
	 * account. Under-allocating is the failure mode we just spent an
	 * evening on. The trade is not close.
	 */
	const RULE_SET_RESERVE = 33;

	// ---- Anchor instruction discriminators ----
	// Computed via sha256("global:<instruction_name>").slice(0, 8) —
	// Anchor's own documented convention (see anchor_lang::Discriminator).
	// CONFIRMED CORRECT 23 Jul 2026, two independent ways: recomputed
	// from the formula, and confirmed live on devnet (the program
	// logged "Instruction: InitializeV2" before failing on a LATER
	// check, which it could only do after matching these bytes).
	const DISCRIMINATOR = {
		initializeV2: Uint8Array.of(67, 153, 175, 39, 218, 16, 38, 32),
		addConfigLines: Uint8Array.of(223, 50, 224, 227, 151, 8, 115, 106),
		setCollectionV2: Uint8Array.of(229, 35, 61, 91, 15, 14, 99, 160),
		withdraw: Uint8Array.of(183, 18, 70, 156, 148, 109, 161, 34)
	};

	function pk(x) {
		return x instanceof solanaWeb3.PublicKey ? x : new solanaWeb3.PublicKey(x);
	}

	/**
	 * Candy Machine's authority PDA — the on-chain signer the program
	 * itself controls, used for every CPI the Candy Machine makes
	 * (creating metadata, master edition, setting/verifying collection).
	 * Seeds: ["candy_machine", candy_machine_pubkey] — source: candy-guard
	 * README + candy-machine-core README (both independently confirm
	 * this seed pair).
	 */
	async function findCandyMachineAuthorityPda(candyMachinePubkey) {
		const [pda] = await solanaWeb3.PublicKey.findProgramAddress(
			[new TextEncoder().encode("candy_machine"), pk(candyMachinePubkey).toBuffer()],
			pk(CANDY_MACHINE_CORE_PROGRAM_ID)
		);
		return pda;
	}

	/**
	 * Token Metadata's MetadataDelegateRecord PDA for the "collection"
	 * delegate role.
	 *
	 * ADDED 23 Jul 2026 — replaces the `collectionDelegateRecord`
	 * PLACEHOLDER that the devnet harness was passing (it was passing
	 * the wallet's own pubkey, which would have failed on the next
	 * run even after the size fix).
	 *
	 * Seeds, per Token Metadata's ProgrammableNFTGuide.md:
	 *   ["metadata", token_metadata_program_id, mint,
	 *    delegate_role, update_authority, delegate]
	 * ...with delegate_role for the Collection role serialized as the
	 * literal ASCII string "collection_delegate".
	 *
	 * IMPORTANT CORRECTION to the earlier note in this file: this
	 * record does NOT need to be approved beforehand as a separate
	 * prerequisite step. InitializeV2 CREATES it itself, via CPI into
	 * Token Metadata, which is exactly why `collection_update_authority`
	 * has to be BOTH a signer and writable in the account list below
	 * (Metaplex's own JS docs: "This needs to be a signer so the candy
	 * machine can approve a delegate to verify minted NFTs to the
	 * collection"). All the caller has to do is derive the right
	 * address and have the collection's update authority sign.
	 *
	 * @param {object} params
	 * @param {string|PublicKey} params.collectionMint
	 * @param {string|PublicKey} params.collectionUpdateAuthority - the approver
	 * @param {string|PublicKey} params.delegate - the Candy Machine authority PDA
	 * @returns {Promise<PublicKey>}
	 */
	async function findCollectionDelegateRecordPda({ collectionMint, collectionUpdateAuthority, delegate }) {
		const enc = new TextEncoder();
		const tokenMetadata = pk(TOKEN_METADATA_PROGRAM_ID);
		const [pda] = await solanaWeb3.PublicKey.findProgramAddress(
			[
				enc.encode("metadata"),
				tokenMetadata.toBuffer(),
				pk(collectionMint).toBuffer(),
				enc.encode("collection_delegate"),
				pk(collectionUpdateAuthority).toBuffer(),
				pk(delegate).toBuffer()
			],
			tokenMetadata
		);
		return pda;
	}

	/* =========================================================
	   Struct encoders — field order and types from docs.rs
	   mpl-candy-machine-core 3.0.1 (struct.CandyMachineData.html,
	   struct.ConfigLine.html, struct.ConfigLineSettings.html,
	   struct.HiddenSettings.html, struct.Creator.html). Every field
	   verified against the actual Rust struct definition, not guessed.
	   ========================================================= */

	// pub struct Creator { pub address: Pubkey, pub verified: bool, pub percentage_share: u8 }
	function encodeCreator(creator) {
		return concatAll([
			pubkey(creator.address),
			bool(!!creator.verified),
			u8(creator.percentageShare)
		]);
	}

	// pub struct ConfigLineSettings {
	//   pub prefix_name: String, pub name_length: u32,
	//   pub prefix_uri: String, pub uri_length: u32,
	//   pub is_sequential: bool,
	// }
	function encodeConfigLineSettings(settings) {
		return concatAll([
			str(settings.prefixName || ""),
			u32(settings.nameLength),
			str(settings.prefixUri || ""),
			u32(settings.uriLength),
			bool(!!settings.isSequential)
		]);
	}

	// pub struct HiddenSettings { pub name: String, pub uri: String, pub hash: [u8; 32] }
	function encodeHiddenSettings(settings) {
		if (settings.hash.length !== 32) {
			throw new Error("HiddenSettings.hash must be exactly 32 bytes");
		}
		return concatAll([
			str(settings.name),
			str(settings.uri),
			settings.hash
		]);
	}

	// pub struct CandyMachineData {
	//   pub items_available: u64, pub symbol: String,
	//   pub seller_fee_basis_points: u16, pub max_supply: u64,
	//   pub is_mutable: bool, pub creators: Vec<Creator>,
	//   pub config_line_settings: Option<ConfigLineSettings>,
	//   pub hidden_settings: Option<HiddenSettings>,
	// }
	function encodeCandyMachineData(data) {
		return concatAll([
			u64(data.itemsAvailable),
			str(data.symbol || ""),
			u16(data.sellerFeeBasisPoints || 0),
			u64(data.maxSupply || 0),
			bool(data.isMutable !== false),
			vec(data.creators || [], encodeCreator),
			option(data.configLineSettings || null, encodeConfigLineSettings),
			option(data.hiddenSettings || null, encodeHiddenSettings)
		]);
	}

	// pub struct ConfigLine { pub name: String, pub uri: String }
	function encodeConfigLine(line) {
		return concatAll([str(line.name), str(line.uri)]);
	}

	/**
	 * Client-side validation of CandyMachineData BEFORE building a
	 * transaction, so obviously-doomed configs fail with a readable
	 * message instead of a hex program error after a wallet popup.
	 *
	 * The limits below are the program's own, from
	 * candy-machine-core's constants + CandyError variants:
	 *   - symbol: max 10 bytes (MAX_SYMBOL_LENGTH)
	 *   - creators: max 4 entries (MAX_CREATOR_LIMIT is 5, and the
	 *     candy machine itself occupies one slot -> "Can only provide
	 *     up to 4 creators to candy machine (because candy machine is
	 *     one)")
	 *   - creator shares must total 100
	 *   - name_length + prefix_name <= 32, uri_length + prefix_uri
	 *     <= 200 (the on-chain name/uri fields these compress into)
	 *   - exactly one of configLineSettings / hiddenSettings
	 */
	function validateCandyMachineData(data) {
		const errors = [];
		const symbolBytes = new TextEncoder().encode(data.symbol || "").length;
		if (symbolBytes > 10) errors.push("symbol is " + symbolBytes + " bytes, max is 10");

		const creators = data.creators || [];
		if (creators.length > 4) errors.push("too many creators (" + creators.length + "), max is 4");
		if (creators.length > 0) {
			const totalShare = creators.reduce((sum, c) => sum + Number(c.percentageShare || 0), 0);
			if (totalShare !== 100) errors.push("creator shares total " + totalShare + ", must be exactly 100");
		}

		const hasConfigLines = !!data.configLineSettings;
		const hasHidden = !!data.hiddenSettings;
		if (hasConfigLines === hasHidden) {
			errors.push("provide exactly one of configLineSettings / hiddenSettings, not both and not neither");
		}

		if (hasConfigLines) {
			const s = data.configLineSettings;
			const prefixNameBytes = new TextEncoder().encode(s.prefixName || "").length;
			const prefixUriBytes = new TextEncoder().encode(s.prefixUri || "").length;
			if (prefixNameBytes + Number(s.nameLength) > 32) {
				errors.push("prefixName (" + prefixNameBytes + ") + nameLength (" + s.nameLength + ") exceeds 32");
			}
			if (prefixUriBytes + Number(s.uriLength) > 200) {
				errors.push("prefixUri (" + prefixUriBytes + ") + uriLength (" + s.uriLength + ") exceeds 200");
			}
		}

		if (!(Number(data.itemsAvailable) > 0)) errors.push("itemsAvailable must be greater than 0");

		if (errors.length) {
			throw new Error("Invalid CandyMachineData:\n  - " + errors.join("\n  - "));
		}
		return true;
	}

	/* =========================================================
	   Account sizing
	   ========================================================= */

	/**
	 * Computes the exact byte size a CandyMachine account needs,
	 * before it's created via SystemProgram.createAccount.
	 *
	 * Mirrors the program's own get_space_for_candy():
	 *   hidden_settings ? HIDDEN_SECTION
	 *                   : HIDDEN_SECTION
	 *                     + 4                              // items loaded counter
	 *                     + items * (name_length+uri_length) // config lines
	 *                     + (items / 8) + 1                // byte mask
	 *                     + items * 4                      // mint indices
	 * ...plus RULE_SET_RESERVE (see the constant's own note on why
	 * over-allocating is the correct side to err on here).
	 *
	 * @param {object} candyMachineData - same shape as encodeCandyMachineData expects
	 * @returns {number} total bytes to allocate for the account
	 */
	function getSpaceForCandy(candyMachineData) {
		return describeSpaceForCandy(candyMachineData).total;
	}

	/**
	 * Same math as getSpaceForCandy(), but returns the breakdown too —
	 * so the devnet harness (and later the real Creator UI) can SHOW
	 * where the bytes go instead of printing one opaque number. The
	 * whole reason the ConstraintRaw bug survived a code review is
	 * that nothing ever displayed a per-section breakdown to compare
	 * against Metaplex's table.
	 *
	 * @returns {{total:number, breakdown:Array<{label:string,bytes:number}>}}
	 */
	function describeSpaceForCandy(candyMachineData) {
		if (candyMachineData.hiddenSettings) {
			return {
				total: HIDDEN_SECTION,
				breakdown: [{ label: "fixed header (hidden settings mode, no config lines)", bytes: HIDDEN_SECTION }]
			};
		}

		const settings = candyMachineData.configLineSettings;
		if (!settings) {
			throw new Error("getSpaceForCandy: must provide either configLineSettings or hiddenSettings");
		}

		const items = Number(candyMachineData.itemsAvailable);
		if (!Number.isFinite(items) || items <= 0) {
			throw new Error("getSpaceForCandy: itemsAvailable must be a positive number, got " + candyMachineData.itemsAvailable);
		}

		const configLineSize = Number(settings.nameLength) + Number(settings.uriLength);

		const breakdown = [
			{ label: "fixed header (HIDDEN_SECTION, offset of hidden data)", bytes: HIDDEN_SECTION },
			{ label: "items-loaded counter (u32)", bytes: 4 },
			{ label: "config lines (" + items + " x " + configLineSize + ")", bytes: items * configLineSize },
			{ label: "byte mask ((items / 8) + 1)", bytes: Math.floor(items / 8) + 1 },
			{ label: "mint indices (" + items + " x u32)", bytes: items * 4 },
			{ label: "rule set flag + pubkey (reserved)", bytes: RULE_SET_RESERVE }
		];

		return {
			total: breakdown.reduce((sum, b) => sum + b.bytes, 0),
			breakdown
		};
	}

	/**
	 * How many ConfigLines fit in one AddConfigLines transaction.
	 *
	 * Conservative estimate only — the devnet harness measures the
	 * REAL serialized size and reports it, which is what should be
	 * trusted before a 1000-item load. Budget assumes: ~1232-byte
	 * packet limit, ~350 bytes of signatures/header/account keys/
	 * blockhash overhead for a 2-account single-instruction tx, 12
	 * bytes of instruction data before the vec (discriminator 8 +
	 * index 4 + vec length 4 -> 16, rounded up), and 8 bytes of Borsh
	 * length prefixes per line (u32 for name + u32 for uri).
	 */
	function estimateLinesPerTransaction(nameLength, uriLength) {
		const perLine = Number(nameLength) + Number(uriLength) + 8;
		const budget = 1232 - 350 - 16;
		return Math.max(1, Math.floor(budget / perLine));
	}

	/* =========================================================
	   Instruction builders
	   ========================================================= */

	/**
	 * InitializeV2 — initializes a CandyMachine account that MUST
	 * already exist on-chain, pre-sized via a separate
	 * SystemProgram.createAccount using getSpaceForCandy() above and
	 * assigned to CANDY_MACHINE_CORE_PROGRAM_ID.
	 *
	 * Account order sourced from mpl-candy-machine-core's own bundled
	 * README.md ("initialize_v2" section) — the authoritative table,
	 * not prose paraphrase. 15 accounts, in this exact order:
	 *
	 *   0  candy_machine                writable
	 *   1  authority_pda                writable
	 *   2  authority
	 *   3  payer                        writable, signer
	 *   4  rule_set                     (optional)
	 *   5  collection_metadata
	 *   6  collection_mint
	 *   7  collection_master_edition
	 *   8  collection_update_authority  writable, signer
	 *   9  collection_delegate_record   writable
	 *   10 token_metadata_program
	 *   11 system_program
	 *   12 sysvar_instructions
	 *   13 authorization_rules_program  (optional)
	 *   14 authorization_rules          (optional)
	 *
	 * The three "(optional)" accounts use Anchor v0.26's positional-
	 * optional-account convention: signaling None means passing the
	 * EXECUTING PROGRAM'S OWN ID as a placeholder, not omitting the
	 * slot. Omitting them is what produced AccountNotEnoughKeys on an
	 * earlier run.
	 *
	 * @param {object} params
	 * @param {string|PublicKey} params.candyMachine - the pre-created, pre-sized account
	 * @param {string|PublicKey} params.authority - candy machine authority
	 * @param {string|PublicKey} params.payer
	 * @param {string|PublicKey} params.collectionMint
	 * @param {string|PublicKey} params.collectionMetadata - optional, derived from collectionMint if omitted
	 * @param {string|PublicKey} params.collectionMasterEdition - optional, derived if omitted
	 * @param {string|PublicKey} params.collectionUpdateAuthority - must sign
	 * @param {string|PublicKey} [params.collectionDelegateRecord] - optional; DERIVED automatically if omitted (recommended — do not pass a placeholder)
	 * @param {object} params.candyMachineData
	 * @param {number} [params.tokenStandard=0] - 0 = NFT, 4 = pNFT
	 * @returns {Promise<TransactionInstruction>}
	 */
	async function buildInitializeV2Instruction(params) {
		validateCandyMachineData(params.candyMachineData);

		const authorityPda = await findCandyMachineAuthorityPda(params.candyMachine);

		// Derive anything the caller didn't supply, rather than let a
		// placeholder through. Every one of these is a pure function of
		// collectionMint, so there is no reason for the caller to guess.
		const collectionMetadata = params.collectionMetadata
			|| await RelaxInstructionBuilder.findMetadataPda(params.collectionMint);
		const collectionMasterEdition = params.collectionMasterEdition
			|| await RelaxInstructionBuilder.findMasterEditionPda(params.collectionMint);
		const collectionDelegateRecord = params.collectionDelegateRecord
			|| await findCollectionDelegateRecordPda({
				collectionMint: params.collectionMint,
				collectionUpdateAuthority: params.collectionUpdateAuthority,
				delegate: authorityPda
			});

		const nonePlaceholder = pk(CANDY_MACHINE_CORE_PROGRAM_ID);

		const keys = [
			{ pubkey: pk(params.candyMachine), isSigner: false, isWritable: true },
			{ pubkey: authorityPda, isSigner: false, isWritable: true },
			{ pubkey: pk(params.authority), isSigner: false, isWritable: false },
			{ pubkey: pk(params.payer), isSigner: true, isWritable: true },
			// rule_set: None (plain NFT) -> program's own ID as placeholder
			{ pubkey: nonePlaceholder, isSigner: false, isWritable: false },
			{ pubkey: pk(collectionMetadata), isSigner: false, isWritable: false },
			{ pubkey: pk(params.collectionMint), isSigner: false, isWritable: false },
			{ pubkey: pk(collectionMasterEdition), isSigner: false, isWritable: false },
			{ pubkey: pk(params.collectionUpdateAuthority), isSigner: true, isWritable: true },
			{ pubkey: pk(collectionDelegateRecord), isSigner: false, isWritable: true },
			{ pubkey: pk(TOKEN_METADATA_PROGRAM_ID), isSigner: false, isWritable: false },
			{ pubkey: pk(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
			{ pubkey: pk(SYSVAR_INSTRUCTIONS_ID), isSigner: false, isWritable: false },
			// authorization_rules_program / authorization_rules: None
			{ pubkey: nonePlaceholder, isSigner: false, isWritable: false },
			{ pubkey: nonePlaceholder, isSigner: false, isWritable: false }
		];

		const data = concatAll([
			DISCRIMINATOR.initializeV2,
			encodeCandyMachineData(params.candyMachineData),
			u8(params.tokenStandard !== undefined ? params.tokenStandard : 0)
		]);

		return new solanaWeb3.TransactionInstruction({
			programId: pk(CANDY_MACHINE_CORE_PROGRAM_ID),
			keys,
			data
		});
	}

	/**
	 * AddConfigLines — appends a batch of NFT name+URI entries to an
	 * already-initialized CandyMachine account. Must be called
	 * repeatedly to load all items; batch size is limited by Solana's
	 * ~1232-byte transaction limit (see estimateLinesPerTransaction).
	 *
	 * @param {object} params
	 * @param {string|PublicKey} params.candyMachine
	 * @param {string|PublicKey} params.authority
	 * @param {number} params.startIndex - 0-based index of the first line in this batch
	 * @param {Array<{name: string, uri: string}>} params.lines
	 * @returns {TransactionInstruction}
	 */
	function buildAddConfigLinesInstruction(params) {
		if (!Array.isArray(params.lines) || params.lines.length === 0) {
			throw new Error("buildAddConfigLinesInstruction: lines must be a non-empty array");
		}

		const keys = [
			{ pubkey: pk(params.candyMachine), isSigner: false, isWritable: true },
			{ pubkey: pk(params.authority), isSigner: true, isWritable: false }
		];

		const data = concatAll([
			DISCRIMINATOR.addConfigLines,
			u32(params.startIndex),
			vec(params.lines, encodeConfigLine)
		]);

		return new solanaWeb3.TransactionInstruction({
			programId: pk(CANDY_MACHINE_CORE_PROGRAM_ID),
			keys,
			data
		});
	}

	/**
	 * Turns a raw Candy Machine / Anchor program error code into
	 * something readable. Anchor's own ranges: 2000-2999 are constraint
	 * violations, 3000-3999 account errors, 6000+ are the program's own
	 * CandyError variants.
	 */
	function explainErrorCode(code) {
		const n = typeof code === "string" && code.startsWith("0x") ? parseInt(code, 16) : Number(code);
		const known = {
			2003: "ConstraintRaw — the candy_machine account failed the raw constraint: either it isn't owned by the Candy Machine program, or its allocated data_len is SMALLER than get_space_for_candy(). Check getSpaceForCandy() against the CandyMachineData you actually sent.",
			3003: "AccountDiscriminatorNotZero — the candy_machine account isn't blank. It's already been initialized; generate a fresh keypair.",
			3005: "AccountNotEnoughKeys — fewer accounts passed than the instruction expects. InitializeV2 needs all 15 slots, including the optional ones filled with the program's own ID.",
			6005: "TooManyCreators — max 4 creators (the candy machine itself takes the 5th slot).",
			6012: "IncorrectCollectionAuthority — the signer isn't the collection's update authority."
		};
		return known[n] || ("Unmapped error code " + n + " (0x" + n.toString(16) + ").");
	}

	return {
		CANDY_MACHINE_CORE_PROGRAM_ID,
		TOKEN_METADATA_PROGRAM_ID,
		HIDDEN_SECTION,
		findCandyMachineAuthorityPda,
		findCollectionDelegateRecordPda,
		encodeCandyMachineData,
		encodeConfigLine,
		validateCandyMachineData,
		getSpaceForCandy,
		describeSpaceForCandy,
		estimateLinesPerTransaction,
		buildInitializeV2Instruction,
		buildAddConfigLinesInstruction,
		explainErrorCode
	};
})();
