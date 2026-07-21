/* =========================================================
   RELAX NFT CREATOR — Borsh Serializer
   =========================================================
   Layer 1 of 4: Adapter -> Provider -> InstructionBuilder -> Serializer

   Pure Borsh primitive encoders. No Solana-specific instruction
   knowledge lives here — just "how do I turn a JS value into the
   exact bytes the Solana runtime expects." Every instruction builder
   composes these primitives; if a future Token Metadata version
   changes a field's encoding, this is the only file that needs to
   change.

   Borsh spec reference: https://borsh.io/
   All integers are little-endian, as Borsh (and Solana) require.

   Browser-safe: no Buffer (Node-only global — see the Swap Hybrid
   Engine's own fix for this exact mistake), no bundler, no external
   library. Pure Uint8Array + DataView.
   ========================================================= */

const RelaxBorsh = (function () {
	// ---- byte buffer builder ----
	// Instructions are small (a few hundred bytes at most), so a
	// simple growable-array approach is plenty fast and much easier
	// to read/audit than manual offset arithmetic into a fixed buffer.
	function createWriter() {
		const chunks = [];
		return {
			pushBytes(bytes) { chunks.push(bytes); },
			pushByte(b) { chunks.push(Uint8Array.of(b)); },
			toBytes() {
				let total = 0;
				for (const c of chunks) total += c.length;
				const out = new Uint8Array(total);
				let offset = 0;
				for (const c of chunks) { out.set(c, offset); offset += c.length; }
				return out;
			}
		};
	}

	// u8: single byte, no encoding needed.
	function u8(n) {
		if (n < 0 || n > 255) throw new Error("u8 out of range: " + n);
		return Uint8Array.of(n);
	}

	// u16: 2 bytes, little-endian.
	function u16(n) {
		const buf = new ArrayBuffer(2);
		new DataView(buf).setUint16(0, n, true);
		return new Uint8Array(buf);
	}

	// u32: 4 bytes, little-endian.
	function u32(n) {
		const buf = new ArrayBuffer(4);
		new DataView(buf).setUint32(0, n, true);
		return new Uint8Array(buf);
	}

	// u64: 8 bytes, little-endian. Accepts Number or BigInt (BigInt
	// recommended for anything that could exceed 2^53, e.g. token
	// amounts with many decimals).
	function u64(n) {
		const big = typeof n === "bigint" ? n : BigInt(n);
		if (big < 0n || big > 0xFFFFFFFFFFFFFFFFn) throw new Error("u64 out of range: " + n);
		const buf = new ArrayBuffer(8);
		const view = new DataView(buf);
		view.setBigUint64(0, big, true);
		return new Uint8Array(buf);
	}

	// bool: Borsh encodes booleans as a single byte, 0 or 1.
	function bool(b) {
		return Uint8Array.of(b ? 1 : 0);
	}

	// string: Borsh strings are (u32 length prefix) + (UTF-8 bytes),
	// no null terminator.
	function str(s) {
		const bytes = new TextEncoder().encode(s);
		const w = createWriter();
		w.pushBytes(u32(bytes.length));
		w.pushBytes(bytes);
		return w.toBytes();
	}

	// pubkey: raw 32 bytes, no length prefix (fixed-size type).
	// Accepts a solanaWeb3.PublicKey instance or a base58 string.
	function pubkey(pk) {
		const bytes = (pk && typeof pk.toBytes === "function")
			? pk.toBytes()
			: new solanaWeb3.PublicKey(pk).toBytes();
		if (bytes.length !== 32) throw new Error("pubkey must be 32 bytes, got " + bytes.length);
		return bytes;
	}

	// option: Borsh encodes Option<T> as a 1-byte discriminant (0 =
	// None, 1 = Some) followed by the encoded value if Some. Pass a
	// value of null/undefined for None, or the value itself for Some
	// along with the encoder function for T.
	function option(value, encodeFn) {
		if (value === null || value === undefined) return Uint8Array.of(0);
		const w = createWriter();
		w.pushBytes(Uint8Array.of(1));
		w.pushBytes(encodeFn(value));
		return w.toBytes();
	}

	// vec: Borsh encodes Vec<T> as a (u32 length prefix) + each
	// element encoded in sequence via encodeFn.
	function vec(items, encodeFn) {
		const w = createWriter();
		w.pushBytes(u32(items.length));
		for (const item of items) w.pushBytes(encodeFn(item));
		return w.toBytes();
	}

	// concat: simple helper for composing struct fields in order —
	// Borsh structs are just their fields serialized one after another,
	// no padding, no alignment, no field names in the byte stream.
	function concatAll(arraysOfBytes) {
		const w = createWriter();
		for (const b of arraysOfBytes) w.pushBytes(b);
		return w.toBytes();
	}

	return { u8, u16, u32, u64, bool, str, pubkey, option, vec, concatAll };
})();
