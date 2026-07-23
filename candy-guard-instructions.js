/* =========================================================
   RELAX — Candy Guard Instruction Builder
   =========================================================
   Covers: initialize (create + configure guards), mint_v2 (the
   actual gated mint), route (for AllowList Merkle-proof submission).

   Every byte layout below is NOT inferred from README prose (which
   turned out to have real errors — see the Allocation correction
   below) — it's transcribed directly from the ACTUAL, PUBLISHED,
   WORKING npm package source (@metaplex-foundation/mpl-candy-guard,
   installed and read directly, 23 Jul 2026). This is the same code
   real production Candy Machine mints use today — as authoritative
   as it gets short of the Rust source itself.

   Reuses RelaxBorsh (serializer.js) for primitives. Requires
   serializer.js and candy-machine-instructions.js (for
   CANDY_MACHINE_CORE_PROGRAM_ID, findCandyMachineAuthorityPda) to be
   loaded first.
   ========================================================= */

const RelaxCandyGuard = (function () {
	const { u8, u16, u32, u64, bool, str, pubkey, concatAll } = RelaxBorsh;

	// Verified: metaplex-foundation/mpl-candy-machine repo + independently
	// confirmed program-address reference table (22-23 Jul 2026 research).
	const CANDY_GUARD_PROGRAM_ID = "Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g";
	const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

	const DISCRIMINATOR = {
		initialize: Uint8Array.of(175, 175, 109, 31, 13, 152, 155, 237),
		mintV2: Uint8Array.of(120, 121, 23, 146, 173, 110, 199, 205),
		route: Uint8Array.of(229, 23, 203, 151, 122, 227, 173, 42),
		wrap: Uint8Array.of(178, 40, 10, 189, 228, 129, 186, 140)
	};

	/* =========================================================
	   Guard set — the bitmask + packed-data serialization
	   =========================================================
	   Source: @metaplex-foundation/mpl-candy-guard/dist/src/parser.js
	   (real, installed, read directly — not guessed).

	   Format per guard-set (used for both the "default" set and each
	   group's set):
	     - u64 (little-endian) "features" bitmask. Bit i sions whether
	       GUARDS_NAME[i] is present (Some) or absent (None).
	     - Then, in GUARDS_NAME order, the fixed-size Borsh bytes for
	       every guard whose bit is set — NOT Borsh Option<T> (no
	       per-field 1-byte flag); the bitmask covers all of them
	       up front instead, which is why "custom serialization" is
	       needed (this isn't derivable from a plain #[derive(Borsh)]).

	   GUARDS_SIZE confirmed field-by-field against each guard's own
	   generated struct (types/*.js) — e.g. Allocation is CORRECTED
	   here vs. an earlier (wrong) reading of the README prose, which
	   described it as `{ id: u8, size: u16 }` (3 bytes). The real,
	   published, working code has `{ id: u8, limit: u32 }` = 5 bytes,
	   matching GUARDS_SIZE.allocation = 5 exactly. Trust this file,
	   not the earlier README-derived note in the migration plan.
	   ========================================================= */
	const GUARDS_NAME = [
		"botTax", "solPayment", "tokenPayment", "startDate", "thirdPartySigner",
		"tokenGate", "gatekeeper", "endDate", "allowList", "mintLimit",
		"nftPayment", "redeemedAmount", "addressGate", "nftGate", "nftBurn",
		"tokenBurn", "freezeSolPayment", "freezeTokenPayment", "programGate",
		"allocation", "token2022Payment"
	];

	const GUARDS_SIZE = {
		botTax: 9, solPayment: 40, tokenPayment: 72, startDate: 8,
		thirdPartySigner: 32, tokenGate: 40, gatekeeper: 33, endDate: 8,
		allowList: 32, mintLimit: 3, nftPayment: 64, redeemedAmount: 8,
		addressGate: 32, nftGate: 32, nftBurn: 32, tokenBurn: 40,
		freezeSolPayment: 40, freezeTokenPayment: 72, programGate: 164,
		allocation: 5, token2022Payment: 72
	};

	// GuardType enum values — used by the `route` instruction to say
	// which guard's route logic to invoke. Order matches GUARDS_NAME
	// (confirmed: generated/types/GuardType.js, BotTax=0 ... Token2022Payment=20).
	const GUARD_TYPE = {
		botTax: 0, solPayment: 1, tokenPayment: 2, startDate: 3,
		thirdPartySigner: 4, tokenGate: 5, gatekeeper: 6, endDate: 7,
		allowList: 8, mintLimit: 9, nftPayment: 10, redeemedAmount: 11,
		addressGate: 12, nftGate: 13, nftBurn: 14, tokenBurn: 15,
		freezeSolPayment: 16, freezeTokenPayment: 17, programGate: 18,
		allocation: 19, token2022Payment: 20
	};

	const MAX_LABEL_LENGTH = 6;

	// ---- individual guard encoders ----
	// Field layouts confirmed against generated/types/*.js (real source).
	function encodeAllowList(g) {
		if (g.merkleRoot.length !== 32) throw new Error("AllowList.merkleRoot must be 32 bytes");
		return g.merkleRoot;
	}
	function encodeMintLimit(g) {
		return concatAll([u8(g.id), u16(g.limit)]);
	}
	function encodeAllocation(g) {
		// CORRECTED field: `limit` (u32), not `size` (u16) — see note above.
		return concatAll([u8(g.id), u32(g.limit)]);
	}
	function encodeNftGate(g) {
		return pubkey(g.requiredCollection);
	}
	function encodeStartDate(g) {
		return u64(BigInt(g.date));
	}
	function encodeEndDate(g) {
		return u64(BigInt(g.date));
	}
	function encodeBotTax(g) {
		return concatAll([u64(g.lamports), bool(!!g.lastInstruction)]);
	}

	const GUARD_ENCODERS = {
		allowList: encodeAllowList,
		mintLimit: encodeMintLimit,
		allocation: encodeAllocation,
		nftGate: encodeNftGate,
		startDate: encodeStartDate,
		endDate: encodeEndDate,
		botTax: encodeBotTax
		// Other guard types (solPayment, tokenPayment, gatekeeper, etc.)
		// not implemented — RELAX's plan doesn't use them. Add here if
		// a future collection needs one, following the same pattern
		// (confirm the real field layout from the installed npm
		// package's generated/types/*.js first, never guess).
	};

	/**
	 * Encodes one guard-set (either the CandyGuardData "default" set,
	 * or one Group's "guards" set) into its bitmask + packed bytes.
	 *
	 * @param {object} guardSet - keys are guard names (e.g. "allowList",
	 *   "mintLimit"), values are the guard's config object, or
	 *   omitted/null/undefined if that guard isn't enabled.
	 * @returns {Uint8Array}
	 */
	function encodeGuardSet(guardSet) {
		guardSet = guardSet || {};
		let features = 0n;
		const dataChunks = [];

		GUARDS_NAME.forEach((name, index) => {
			const value = guardSet[name];
			if (value) {
				const encoder = GUARD_ENCODERS[name];
				if (!encoder) {
					throw new Error("RelaxCandyGuard: no encoder implemented for guard '" + name + "' — see GUARD_ENCODERS comment.");
				}
				const encoded = encoder(value);
				if (encoded.length !== GUARDS_SIZE[name]) {
					throw new Error("RelaxCandyGuard: encoded size mismatch for '" + name + "' — expected " + GUARDS_SIZE[name] + ", got " + encoded.length);
				}
				dataChunks.push(encoded);
				features |= (1n << BigInt(index));
			}
		});

		return concatAll([u64(features), concatAll(dataChunks)]);
	}

	/**
	 * Encodes the full CandyGuardData: the default guard set, followed
	 * by an optional list of named Groups (each with their own guard
	 * set). Source: parser.js `serialize()`/`size()` — real, installed
	 * package code.
	 *
	 * @param {object} candyGuardData
	 * @param {object} candyGuardData.default - the default guard set (see encodeGuardSet)
	 * @param {Array<{label: string, guards: object}>} [candyGuardData.groups] - optional named groups
	 * @returns {Uint8Array}
	 */
	function encodeCandyGuardData(candyGuardData) {
		const chunks = [encodeGuardSet(candyGuardData.default)];

		const groups = candyGuardData.groups || [];
		chunks.push(u32(groups.length));

		for (const group of groups) {
			if (group.label.length > MAX_LABEL_LENGTH) {
				throw new Error("RelaxCandyGuard: group label '" + group.label + "' exceeds max length " + MAX_LABEL_LENGTH);
			}
			// 6-byte label field: UTF-8 bytes, zero-padded to 6 bytes
			// (matches parser.js's `buffer.write(label, offset, 6, 'utf8')`
			// into a zero-initialized buffer).
			const labelBytes = new Uint8Array(MAX_LABEL_LENGTH);
			labelBytes.set(new TextEncoder().encode(group.label));
			chunks.push(labelBytes);
			chunks.push(encodeGuardSet(group.guards));
		}

		return concatAll(chunks);
	}

	/**
	 * Candy Guard PDA — seeds ["candy_guard", base_pubkey]. `base` is
	 * any keypair RELAX generates and controls purely as a seed (it
	 * doesn't need any other role) — source: candy-guard README,
	 * confirmed 22 Jul 2026 research.
	 */
	async function findCandyGuardPda(basePubkey) {
		const [pda] = await solanaWeb3.PublicKey.findProgramAddress(
			[new TextEncoder().encode("candy_guard"), new solanaWeb3.PublicKey(basePubkey).toBytes()],
			new solanaWeb3.PublicKey(CANDY_GUARD_PROGRAM_ID)
		);
		return pda;
	}

	/**
	 * `initialize` — creates a new CandyGuard account and sets its
	 * guard configuration in the same instruction. Does NOT wrap a
	 * Candy Machine yet — that's a separate `wrap` instruction (not
	 * yet implemented here, needed before minting can go through the
	 * guard).
	 *
	 * Accounts confirmed verbatim from generated/instructions/initialize.js
	 * (real installed package source, 23 Jul 2026):
	 *   candyGuard (w), base (signer), authority, payer (w, signer),
	 *   systemProgram
	 *
	 * @param {object} params
	 * @param {string|PublicKey} params.candyGuard - the PDA from findCandyGuardPda()
	 * @param {string|PublicKey} params.base - the seed keypair's pubkey (must co-sign)
	 * @param {string|PublicKey} params.authority
	 * @param {string|PublicKey} params.payer
	 * @param {object} params.candyGuardData - see encodeCandyGuardData
	 * @returns {TransactionInstruction}
	 */
	function buildInitializeInstruction(params) {
		const keys = [
			{ pubkey: new solanaWeb3.PublicKey(params.candyGuard), isSigner: false, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.base), isSigner: true, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.authority), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.payer), isSigner: true, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false }
		];

		const encodedData = encodeCandyGuardData(params.candyGuardData);
		// `data` arg is beet.bytes = u32 length prefix + raw bytes
		// (confirmed: beet's `uint8Array` type, dist/cjs/src/beets/collections.js).
		const data = concatAll([
			DISCRIMINATOR.initialize,
			u32(encodedData.length),
			encodedData
		]);

		return new solanaWeb3.TransactionInstruction({
			programId: new solanaWeb3.PublicKey(CANDY_GUARD_PROGRAM_ID),
			keys,
			data
		});
	}

	/**
	 * `route` — used to submit an AllowList Merkle proof before a
	 * gated mint (two-instruction flow: route first, then mintV2, per
	 * the migration plan's Groups research). Also used for other
	 * guards' custom pre-mint logic if ever needed.
	 *
	 * Base accounts confirmed from generated/instructions/route.js:
	 *   candyGuard, candyMachine (w), payer (w, signer)
	 * — any guard-specific extra accounts (e.g. the AllowList proof
	 * PDA) go in `remainingAccounts`.
	 *
	 * @param {object} params
	 * @param {string|PublicKey} params.candyGuard
	 * @param {string|PublicKey} params.candyMachine
	 * @param {string|PublicKey} params.payer
	 * @param {string} params.guardName - e.g. "allowList" (must exist in GUARD_TYPE)
	 * @param {Uint8Array} params.routeData - guard-specific route payload (e.g. Merkle proof bytes for allow_list)
	 * @param {string} [params.label] - group label, if minting under a specific group
	 * @param {Array<{pubkey: PublicKey, isSigner: boolean, isWritable: boolean}>} [params.remainingAccounts]
	 * @returns {TransactionInstruction}
	 */
	function buildRouteInstruction(params) {
		if (!(params.guardName in GUARD_TYPE)) {
			throw new Error("RelaxCandyGuard: unknown guard name '" + params.guardName + "' for route instruction");
		}

		const keys = [
			{ pubkey: new solanaWeb3.PublicKey(params.candyGuard), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.candyMachine), isSigner: false, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.payer), isSigner: true, isWritable: true },
			...(params.remainingAccounts || [])
		];

		const routeData = params.routeData || new Uint8Array(0);
		const labelOption = params.label
			? concatAll([Uint8Array.of(1), u32(new TextEncoder().encode(params.label).length), new TextEncoder().encode(params.label)])
			: Uint8Array.of(0);

		const data = concatAll([
			DISCRIMINATOR.route,
			u8(GUARD_TYPE[params.guardName]),
			u32(routeData.length),
			routeData,
			labelOption
		]);

		return new solanaWeb3.TransactionInstruction({
			programId: new solanaWeb3.PublicKey(CANDY_GUARD_PROGRAM_ID),
			keys,
			data
		});
	}

	/**
	 * `mint_v2` — the actual gated mint call. 24 accounts, confirmed
	 * verbatim from generated/instructions/mintV2.js (real installed
	 * package source) — several are optional per Anchor's positional-
	 * optional convention (token, tokenRecord, splAtaProgram,
	 * authorizationRulesProgram/authorizationRules use this program's
	 * OWN id as the "None" placeholder, matching the pattern already
	 * established in candy-machine-instructions.js).
	 *
	 * @param {object} params - see field comments; mirrors mintV2.js's `accounts` shape closely
	 * @returns {TransactionInstruction}
	 */
	function buildMintV2Instruction(params) {
		const keys = [
			{ pubkey: new solanaWeb3.PublicKey(params.candyGuard), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(RelaxCandyMachine.CANDY_MACHINE_CORE_PROGRAM_ID), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.candyMachine), isSigner: false, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.candyMachineAuthorityPda), isSigner: false, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.payer), isSigner: true, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.minter), isSigner: true, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.nftMint), isSigner: false, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.nftMintAuthority), isSigner: true, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.nftMetadata), isSigner: false, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.nftMasterEdition), isSigner: false, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.token || CANDY_GUARD_PROGRAM_ID), isSigner: false, isWritable: !!params.token },
			{ pubkey: new solanaWeb3.PublicKey(params.tokenRecord || CANDY_GUARD_PROGRAM_ID), isSigner: false, isWritable: !!params.tokenRecord },
			{ pubkey: new solanaWeb3.PublicKey(params.collectionDelegateRecord), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.collectionMint), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.collectionMetadata), isSigner: false, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(params.collectionMasterEdition), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.collectionUpdateAuthority), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.tokenMetadataProgram), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.splTokenProgram), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.splAtaProgram || CANDY_GUARD_PROGRAM_ID), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.sysvarInstructions), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.recentSlothashes), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.authorizationRulesProgram || CANDY_GUARD_PROGRAM_ID), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.authorizationRules || CANDY_GUARD_PROGRAM_ID), isSigner: false, isWritable: false },
			...(params.remainingAccounts || [])
		];

		const mintArgs = params.mintArgs || new Uint8Array(0);
		const labelOption = params.label
			? concatAll([Uint8Array.of(1), u32(new TextEncoder().encode(params.label).length), new TextEncoder().encode(params.label)])
			: Uint8Array.of(0);

		const data = concatAll([
			DISCRIMINATOR.mintV2,
			u32(mintArgs.length),
			mintArgs,
			labelOption
		]);

		return new solanaWeb3.TransactionInstruction({
			programId: new solanaWeb3.PublicKey(CANDY_GUARD_PROGRAM_ID),
			keys,
			data
		});
	}

	/**
	 * `wrap` — attaches an already-`initialize`d Candy Guard to a
	 * Candy Machine as its mint_authority. After this, the Candy
	 * Machine can ONLY be minted from through the Guard (its own raw
	 * `mint_v2` becomes unusable directly). This is the step that was
	 * still missing after `initialize` alone.
	 *
	 * Accounts + discriminator confirmed verbatim from
	 * generated/instructions/wrap.js (real installed package source,
	 * 23 Jul 2026) — discriminator also independently cross-checked
	 * against this project's own earlier sha256("global:wrap")
	 * computation, which matched exactly.
	 *
	 * @param {object} params
	 * @param {string|PublicKey} params.candyGuard
	 * @param {string|PublicKey} params.authority - the Candy Guard's authority, must sign
	 * @param {string|PublicKey} params.candyMachine
	 * @param {string|PublicKey} params.candyMachineAuthority - the Candy Machine's own authority, must sign (proves consent to hand over mint_authority)
	 * @returns {TransactionInstruction}
	 */
	function buildWrapInstruction(params) {
		const keys = [
			{ pubkey: new solanaWeb3.PublicKey(params.candyGuard), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.authority), isSigner: true, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.candyMachine), isSigner: false, isWritable: true },
			{ pubkey: new solanaWeb3.PublicKey(RelaxCandyMachine.CANDY_MACHINE_CORE_PROGRAM_ID), isSigner: false, isWritable: false },
			{ pubkey: new solanaWeb3.PublicKey(params.candyMachineAuthority), isSigner: true, isWritable: false }
		];

		return new solanaWeb3.TransactionInstruction({
			programId: new solanaWeb3.PublicKey(CANDY_GUARD_PROGRAM_ID),
			keys,
			data: concatAll([DISCRIMINATOR.wrap])
		});
	}

	return {
		CANDY_GUARD_PROGRAM_ID,
		GUARD_TYPE,
		findCandyGuardPda,
		encodeGuardSet,
		encodeCandyGuardData,
		buildInitializeInstruction,
		buildWrapInstruction,
		buildRouteInstruction,
		buildMintV2Instruction
	};
})();
