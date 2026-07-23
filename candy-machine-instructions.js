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
   -> Serializer). serializer.js must be loaded before this file.

   Program ID and every struct layout below is sourced from Metaplex's
   own docs.rs pages for mpl-candy-machine-core 3.0.1 and the
   metaplex-foundation/mpl-candy-machine GitHub repo — cited inline.
   Instruction discriminators are computed via Anchor's own documented,
   deterministic formula (sha256("global:<name>")[0..8]) — NOT yet
   cross-checked against Metaplex's generated JS constants byte-for-
   byte. Treat as provisional until the first real devnet call either
   succeeds or returns a clear "unknown instruction" error confirming/
   denying these bytes.
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

	// ---- Anchor instruction discriminators ----
	// Computed via sha256("global:<instruction_name>").slice(0, 8) —
	// Anchor's own documented convention (see anchor_lang::Discriminator).
	// See file header note on cross-verification status.
	const DISCRIMINATOR = {
		initializeV2: Uint8Array.of(67, 153, 175, 39, 218, 16, 38, 32),
		addConfigLines: Uint8Array.of(223, 50, 224, 227, 151, 8, 115, 106),
		setCollectionV2: Uint8Array.of(229, 35, 61, 91, 15, 14, 99, 160),
		withdraw: Uint8Array.of(183, 18, 70, 156, 148, 109, 161, 34)
	};

	/**
	 * Candy Machine's authority PDA — the on-chain signer the program
	 * itself controls, used for every CPI the Candy Machine makes
	 * (creating metadata, master edition, setting/verifying collection).
	 * Seeds: ["candy_machine", candy_machine_pubkey] — source: candy-guard
	 * README + candy-machine-core README (both independently confirm
	 * this seed pair).
	 */
	async function findCandyMachineAuthorityPda(candyMachinePubkey) {
		const cmPk = new solanaWeb3.PublicKey(candyMachinePubkey);
		const [pda] = await solanaWeb3.PublicKey.findProgramAddress(
			[new TextEncoder().encode("candy_machine"), cmPk.toBuffer()],
			new solanaWeb3.PublicKey(CANDY_MACHINE_CORE_PROGRAM_ID)
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
	// (field name confirmed as `percentage_share` via candy-machine-core
	// mint.rs source: `share: c.percentage_share`)
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

	/* =========================================================
	   Instruction builders
	   ========================================================= */

	/**
	 * InitializeV2 — creates and initializes a new CandyMachine
	 * account. IMPORTANT: per docs.rs, the CandyMachine account must
	 * already exist on-chain, pre-sized, before this instruction runs
	 * (a separate SystemProgram.createAccount call — sizing math is
	 * still open, see migration plan's "batch sizing" section). This
	 * function only builds the InitializeV2 instruction itself.
	 *
	 * Account order sourced from mpl-candy-machine/programs/
	 * candy-machine-core README (InitializeV2 section), cross-checked
	 * against two independent fetches of the same README returning
	 * identical prose/order both times.
	 *
	 * @param {object} params
	 * @param {string|PublicKey} params.candyMachine - the pre-created, pre-sized account
	 * @param {string|PublicKey} params.authority - candy machine authority (RELAX's own key for now)
	 * @param {string|PublicKey} params.payer
	 * @param {string|PublicKey} params.collectionMetadata
	 * @param {string|PublicKey} params.collectionMint
	 * @param {string|PublicKey} params.collectionMasterEdition
	 * @param {string|PublicKey} params.collectionUpdateAuthority
	 * @param {object} params.candyMachineData - see encodeCandyMachineData
	 * @returns {Promise<TransactionInstruction>}
	 */
	async function buildInitializeV2Instruction(params) {
		const authorityPda = await findCandyMachineAuthorityPda(params.candyMachine);

		const keys = [
			{ pubkey: new solanaWeb3.PublicKey(params.candyMachine), isSigner: false, isWritable: true },
			{ pubkey: authorityPda, isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.authority), isSigner: true, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.payer), isSigner: true, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.collectionMetadata), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.collectionMint), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.collectionMasterEdition), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.collectionUpdateAuthority), isSigner: true, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(TOKEN_METADATA_PROGRAM_ID), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false }
			// NOTE: pNFT collections need two more accounts here
			// (Token Authorization Rules program + account) — omitted
			// for RELAX's badge collection, which uses plain NonFungible,
			// not ProgrammableNonFungible. Revisit if that ever changes.
		];

		const data = concatAll([
			DISCRIMINATOR.initializeV2,
			encodeCandyMachineData(params.candyMachineData)
		]);

		return new solanaWeb3.TransactionInstruction({
			programId: new solanaWeb3.PublicKey(CANDY_MACHINE_CORE_PROGRAM_ID),
			keys,
			data
		});
	}

	/**
	 * AddConfigLines — appends a batch of NFT name+URI entries to an
	 * already-initialized CandyMachine account. Must be called
	 * repeatedly to load all items; batch size is limited by Solana's
	 * ~1232-byte transaction limit (see migration plan for the sizing
	 * math this needs to validate on real devnet transactions before
	 * being trusted for a real 1000-item load).
	 *
	 * @param {object} params
	 * @param {string|PublicKey} params.candyMachine
	 * @param {string|PublicKey} params.authority
	 * @param {number} params.startIndex - 0-based index of the first line in this batch
	 * @param {Array<{name: string, uri: string}>} params.lines
	 * @returns {TransactionInstruction}
	 */
	function buildAddConfigLinesInstruction(params) {
		const keys = [
			{ pubkey: new solanaWeb3.PublicKey(params.candyMachine), isSigner: false, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.authority), isSigner: true, isWritable: false }
		];

		const data = concatAll([
			DISCRIMINATOR.addConfigLines,
			u32(params.startIndex),
			vec(params.lines, encodeConfigLine)
		]);

		return new solanaWeb3.TransactionInstruction({
			programId: new solanaWeb3.PublicKey(CANDY_MACHINE_CORE_PROGRAM_ID),
			keys,
			data
		});
	}

	return {
		CANDY_MACHINE_CORE_PROGRAM_ID,
		findCandyMachineAuthorityPda,
		encodeCandyMachineData,
		encodeConfigLine,
		buildInitializeV2Instruction,
		buildAddConfigLinesInstruction
	};
})();
