// Type IR for the gradual typechecker.

export type Type =
	| { kind: "int" }
	| { kind: "bool" }
	| { kind: "byte" }
	| { kind: "null" }
	| { kind: "error" }
	| { kind: "struct"; name: string }
	| { kind: "array"; elem: Type; length: number | null } // null = []T (slice)
	| { kind: "union"; arms: Type[] }
	| { kind: "fn"; params: Type[]; ret: Type; rest?: Type }
	| { kind: "unknown" }
	| { kind: "never" };

export const TInt: Type = { kind: "int" };
export const TBool: Type = { kind: "bool" };
export const TByte: Type = { kind: "byte" };
export const TNull: Type = { kind: "null" };
export const TError: Type = { kind: "error" };
export const TUnknown: Type = { kind: "unknown" };
export const TNever: Type = { kind: "never" };

/** string ≡ []byte */
export const TString: Type = { kind: "array", elem: TByte, length: null };

const ALIASES: Record<string, string> = {
	i32: "int",
	number: "int",
	boolean: "bool",
	u8: "byte",
	string: "[]byte", // special-cased in namedType
};

/** Normalize a bare type name (aliases → canonical). */
export function normalizeName(name: string): string {
	if (name === "string") return "string"; // handled as []byte in namedType
	return ALIASES[name] ?? name;
}

export function arrayType(elem: Type, length: number | null = null): Type {
	return { kind: "array", elem, length };
}

export function namedType(name: string): Type {
	const n = ALIASES[name] === "[]byte" || name === "string" ? "string" : (ALIASES[name] ?? name);
	switch (n) {
		case "int":
			return TInt;
		case "bool":
			return TBool;
		case "byte":
			return TByte;
		case "string":
			return TString;
		case "null":
			return TNull;
		case "error":
			return TError;
		case "unknown":
			return TUnknown;
		default:
			return { kind: "struct", name: n };
	}
}

export function unionType(...arms: Type[]): Type {
	const flat: Type[] = [];
	for (const a of arms) {
		if (a.kind === "union") flat.push(...a.arms);
		else if (a.kind !== "never") flat.push(a);
	}
	const seen = new Set<string>();
	const unique: Type[] = [];
	for (const a of flat) {
		const key = displayType(a);
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(a);
		}
	}
	if (unique.length === 0) return TNever;
	if (unique.length === 1) return unique[0]!;
	return { kind: "union", arms: unique };
}

export function displayType(t: Type): string {
	switch (t.kind) {
		case "int":
		case "bool":
		case "byte":
		case "null":
		case "error":
		case "unknown":
		case "never":
			return t.kind;
		case "struct":
			return t.name;
		case "array": {
			const lenPart = t.length === null ? "[]" : `[${t.length}]`;
			return `${lenPart}${displayType(t.elem)}`;
		}
		case "union":
			return t.arms.map(displayType).join(" | ");
		case "fn": {
			const params = t.params.map(displayType);
			if (t.rest) params.push(`...${displayType(t.rest)}`);
			return `(${params.join(", ")}) -> ${displayType(t.ret)}`;
		}
	}
}

/** Structural equality after normalize. */
export function typeEquals(a: Type, b: Type): boolean {
	if (a.kind !== b.kind) {
		if (a.kind === "union" || b.kind === "union") {
			return displayType(a) === displayType(b);
		}
		return false;
	}
	switch (a.kind) {
		case "struct":
			return a.name === (b as Extract<Type, { kind: "struct" }>).name;
		case "array": {
			const bb = b as Extract<Type, { kind: "array" }>;
			return a.length === bb.length && typeEquals(a.elem, bb.elem);
		}
		case "union": {
			const bb = b as Extract<Type, { kind: "union" }>;
			if (a.arms.length !== bb.arms.length) return false;
			const keys = new Set(a.arms.map(displayType));
			return bb.arms.every((arm) => keys.has(displayType(arm)));
		}
		case "fn": {
			const bb = b as Extract<Type, { kind: "fn" }>;
			if (a.params.length !== bb.params.length) return false;
			if (!typeEquals(a.ret, bb.ret)) return false;
			if (!!a.rest !== !!bb.rest) return false;
			if (a.rest && bb.rest && !typeEquals(a.rest, bb.rest)) return false;
			return a.params.every((p, i) => typeEquals(p, bb.params[i]!));
		}
		default:
			return true;
	}
}

/**
 * Gradual subtyping.
 * [N]T <: []T when elems match; nested rules compose.
 */
export function isSubtype(a: Type, b: Type): boolean {
	if (a.kind === "never") return true;
	if (b.kind === "unknown" || a.kind === "unknown") return true;
	if (typeEquals(a, b)) return true;

	if (b.kind === "union") {
		return b.arms.some((arm) => isSubtype(a, arm));
	}
	if (a.kind === "union") {
		return a.arms.every((arm) => isSubtype(arm, b));
	}

	if (a.kind === "array" && b.kind === "array") {
		// Elem must be subtype (allow [2][3]int <: [][3]int etc.)
		if (!isSubtype(a.elem, b.elem)) return false;
		// Sized <: unsized; same size <: same size; unsized </: sized
		if (b.length === null) return true;
		if (a.length === null) return false;
		return a.length === b.length;
	}

	return false;
}

export function involvesUnknown(t: Type): boolean {
	switch (t.kind) {
		case "unknown":
			return true;
		case "array":
			return involvesUnknown(t.elem);
		case "union":
			return t.arms.some(involvesUnknown);
		case "fn":
			return (
				t.params.some(involvesUnknown) ||
				involvesUnknown(t.ret) ||
				(t.rest ? involvesUnknown(t.rest) : false)
			);
		default:
			return false;
	}
}

export function isErrorUnion(t: Type): t is { kind: "union"; arms: Type[] } {
	return t.kind === "union" && t.arms.some((a) => a.kind === "error");
}

export function unwrapError(t: Type): Type {
	if (t.kind === "union") {
		const rest = t.arms.filter((a) => a.kind !== "error");
		if (rest.length === 0) return TError;
		if (rest.length === 1) return rest[0]!;
		return unionType(...rest);
	}
	return t;
}

export function allowsError(t: Type): boolean {
	if (t.kind === "error" || t.kind === "unknown") return true;
	if (t.kind === "union") return t.arms.some((a) => a.kind === "error");
	return false;
}

/** True if t is []byte / [N]byte (string-like). */
export function isByteSlice(t: Type): boolean {
	return t.kind === "array" && t.elem.kind === "byte";
}

export enum TypeTag {
	INT = 1,
	BOOL = 2,
	STRING = 3, // []byte / [N]byte at runtime
	NULL = 4,
	ERROR = 5,
	ARRAY = 6,
	STRUCT = 7,
	ERROR_UNION = 8,
	BYTE = 9,
}

export function typeTag(t: Type): TypeTag | null {
	switch (t.kind) {
		case "int":
			return TypeTag.INT;
		case "bool":
			return TypeTag.BOOL;
		case "byte":
			return TypeTag.BYTE;
		case "null":
			return TypeTag.NULL;
		case "error":
			return TypeTag.ERROR;
		case "array":
			if (t.elem.kind === "byte") return TypeTag.STRING;
			return TypeTag.ARRAY;
		case "struct":
			return TypeTag.STRUCT;
		case "union":
			if (isErrorUnion(t)) return TypeTag.ERROR_UNION;
			return null;
		default:
			return null;
	}
}

/** Parse a display string like `[2][3]int` / `[]byte` / `[]byte | error` back into Type. */
export function parseDisplayType(s: string): Type {
	s = s.trim();
	// Top-level union (respect brackets)
	const unionParts = splitTopLevel(s, " | ");
	if (unionParts.length > 1) {
		return unionType(...unionParts.map(parseDisplayType));
	}
	if (s.startsWith("[")) {
		let i = 1;
		let length: number | null = null;
		if (s[i] === "]") {
			i = 2;
		} else {
			const m = s.slice(1).match(/^(\d+)\]/);
			if (!m) return namedType(s);
			length = parseInt(m[1]!, 10);
			i = 1 + m[0]!.length;
		}
		return arrayType(parseDisplayType(s.slice(i)), length);
	}
	return namedType(s);
}

function splitTopLevel(s: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (ch === "[") depth++;
		else if (ch === "]") depth--;
		else if (depth === 0 && s.startsWith(sep, i)) {
			parts.push(s.slice(start, i).trim());
			i += sep.length - 1;
			start = i + 1;
		}
	}
	parts.push(s.slice(start).trim());
	return parts.filter(Boolean);
}
