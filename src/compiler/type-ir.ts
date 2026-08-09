// Type IR for the gradual typechecker.

export type Type =
	| { kind: "int" }
	| { kind: "bool" }
	| { kind: "string" }
	| { kind: "null" }
	| { kind: "error" }
	| { kind: "struct"; name: string }
	| { kind: "array"; elem: Type }
	| { kind: "union"; arms: Type[] }
	| { kind: "fn"; params: Type[]; ret: Type; rest?: Type }
	| { kind: "unknown" }
	| { kind: "never" };

export const TInt: Type = { kind: "int" };
export const TBool: Type = { kind: "bool" };
export const TString: Type = { kind: "string" };
export const TNull: Type = { kind: "null" };
export const TError: Type = { kind: "error" };
export const TUnknown: Type = { kind: "unknown" };
export const TNever: Type = { kind: "never" };

const ALIASES: Record<string, string> = {
	i32: "int",
	number: "int",
	boolean: "bool",
};

/** Normalize a bare type name (aliases → canonical). */
export function normalizeName(name: string): string {
	return ALIASES[name] ?? name;
}

export function namedType(name: string): Type {
	const n = normalizeName(name);
	switch (n) {
		case "int":
			return TInt;
		case "bool":
			return TBool;
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

export function arrayType(elem: Type): Type {
	return { kind: "array", elem };
}

export function unionType(...arms: Type[]): Type {
	const flat: Type[] = [];
	for (const a of arms) {
		if (a.kind === "union") flat.push(...a.arms);
		else if (a.kind !== "never") flat.push(a);
	}
	// dedupe by display
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
		case "string":
		case "null":
		case "error":
		case "unknown":
		case "never":
			return t.kind;
		case "struct":
			return t.name;
		case "array":
			return `[]${displayType(t.elem)}`;
		case "union":
			return t.arms.map(displayType).join(" | ");
		case "fn": {
			const params = t.params.map(displayType);
			if (t.rest) params.push(`...${displayType(t.rest)}`);
			return `(${params.join(", ")}) -> ${displayType(t.ret)}`;
		}
	}
}

/** Structural equality after normalize (for invariant array elems, etc.). */
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
		case "array":
			return typeEquals(a.elem, (b as Extract<Type, { kind: "array" }>).elem);
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
 * Gradual subtyping: Unknown is top for checking (anything <: Unknown,
 * and Unknown <: anything so checks involving Unknown are skipped by callers).
 * T <: T | error; struct names are nominal.
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

	// array: invariant elements for v1
	if (a.kind === "array" && b.kind === "array") {
		return typeEquals(a.elem, b.elem);
	}

	return false;
}

/** True if either side is Unknown (gradual: skip enforcement). */
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

/** Unwrap T from T | error; otherwise return t. */
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

/** Runtime assert kind tags for OP_ASSERT_TYPE. */
export enum TypeTag {
	INT = 1,
	BOOL = 2,
	STRING = 3,
	NULL = 4,
	ERROR = 5,
	ARRAY = 6,
	STRUCT = 7,
	// soft: accept T or error
	ERROR_UNION = 8,
}

export function typeTag(t: Type): TypeTag | null {
	switch (t.kind) {
		case "int":
			return TypeTag.INT;
		case "bool":
			return TypeTag.BOOL;
		case "string":
			return TypeTag.STRING;
		case "null":
			return TypeTag.NULL;
		case "error":
			return TypeTag.ERROR;
		case "array":
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
