import {
	arrayType,
	namedType,
	type Type,
	TError,
	TInt,
	TString,
	TUnknown,
	unionType,
} from "./type-ir";

export interface NativeSig {
	params: Type[];
	ret: Type;
	rest?: Type;
	variadic?: boolean;
}

function fn(
	params: Type[],
	ret: Type,
	opts?: { rest?: Type; variadic?: boolean },
): NativeSig {
	return { params, ret, rest: opts?.rest, variadic: opts?.variadic };
}

/** Hand-written signatures for language + host natives. */
export const NATIVE_SIGS: Record<string, NativeSig> = {
	print: fn([], TUnknown, { rest: TUnknown, variadic: true }),
	len: fn([TUnknown], TInt),
	error: fn([TString], TError),

	__printLn: fn([TString], TUnknown, { rest: TUnknown, variadic: true }),
	__alloc: fn([TInt], TInt),
	__arena_create: fn([TInt], TInt),
	__arena_alloc: fn([TInt, TInt], TInt),
	__arena_reset: fn([TInt], TUnknown),
	__arena_deinit: fn([TInt], TUnknown),
	__strlen: fn([TString], TInt),
	__substr: fn([TString, TInt, TInt], TString),
	__indexOf: fn([TString, TString], TInt),
	__split: fn([TString, TString], arrayType(TString)),
	__toUpper: fn([TString], TString),
	__toLower: fn([TString], TString),
	__trim: fn([TString], TString),
	__replace: fn([TString, TString, TString], TString),
	__concat: fn([TString, TString], TString),
	__repeat: fn([TString, TInt], TString),
	__startsWith: fn([TString, TString], namedType("bool")),
	__endsWith: fn([TString, TString], namedType("bool")),

	__floor: fn([TInt], TInt),
	__ceil: fn([TInt], TInt),
	__round: fn([TInt], TInt),
	__sqrt: fn([TInt], unionType(TInt, TError)),
	__pow: fn([TInt, TInt], TInt),
	__min: fn([arrayType(TInt)], TInt),
	__max: fn([arrayType(TInt)], TInt),

	__readFile: fn([TString], unionType(TString, TError)),
	__readLine: fn([], unionType(TString, TError)),
	__writeFile: fn([TString, TString], TUnknown),
	__appendFile: fn([TString, TString], TUnknown),
	__deleteFile: fn([TString], TUnknown),
	__exists: fn([TString], namedType("bool")),
};

export function lookupNativeSig(name: string): NativeSig | undefined {
	return NATIVE_SIGS[name];
}
