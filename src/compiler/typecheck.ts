/**
 * Gradual typechecker — separate pass before bytecode emit.
 * Unannotated = Unknown (skip checks). Annotated sites are enforced.
 */
import type * as ast from "../ast";
import { createConstEnv, isConstantExpr, type ConstEnv } from "./const-expr";
import { lookupNativeSig } from "./native-sigs";
import { tryResolveStaticPath } from "./expressions";
import type { CompilerState } from "./state";
import { typeFromAst } from "./type-from-ast";
import {
	allowsError,
	arrayType,
	displayType,
	involvesUnknown,
	isByteSlice,
	isErrorUnion,
	isSubtype,
	namedType,
	parseDisplayType,
	type Type,
	TBool,
	TByte,
	TError,
	TInt,
	TNull,
	TString,
	TUnknown,
	unionType,
	unwrapError,
} from "./type-ir";

export class TypeCheckError extends Error {
	constructor(message: string) {
		super(`CompileError: ${message}`);
		this.name = "TypeCheckError";
	}
}

interface Env {
	locals: Map<string, Type>[];
	globals: Map<string, Type>;
	/** Expected return type of the enclosing function, if known. */
	expectedReturn: Type | null;
	/** Annotated return (for ? propagation checks). */
	annotatedReturn: Type | null;
	/** Names usable in `@const` initializers (Go-style constant exprs). */
	constNames: Set<string>;
}

function pushScope(env: Env) {
	env.locals.push(new Map());
}
function popScope(env: Env) {
	env.locals.pop();
}
function define(env: Env, name: string, t: Type) {
	const top = env.locals[env.locals.length - 1];
	if (top) top.set(name, t);
	else env.globals.set(name, t);
}
function lookup(env: Env, name: string): Type | undefined {
	for (let i = env.locals.length - 1; i >= 0; i--) {
		const t = env.locals[i]!.get(name);
		if (t) return t;
	}
	return env.globals.get(name);
}

function requireAssign(got: Type, expected: Type, ctx: string) {
	if (involvesUnknown(got) || involvesUnknown(expected)) return;
	if (!isSubtype(got, expected)) {
		throw new TypeCheckError(
			`${ctx}: type '${displayType(got)}' is not assignable to '${displayType(expected)}'`,
		);
	}
}

function inferLiteral(lit: ast.LiteralExpression): Type {
	switch (lit.literal_type) {
		case "string":
			// string literal → [N]byte
			return arrayType(TByte, lit.value.length);
		case "boolean":
			return TBool;
		case "null":
			return TNull;
		default:
			return TInt;
	}
}

function resolveModuleType(
	state: CompilerState,
	typeName: string,
): string {
	if (typeName.includes(".")) {
		const parts = typeName.split(".");
		const modulePath = state.globalTypes.get(`$${parts[0]}`);
		if (modulePath?.startsWith("module:")) {
			const qualified = `${modulePath.replace("module:", "")}::${parts[1]}`;
			if (
				!state.chunk.exports.has(qualified) &&
				!state.globalTypes.get(`$${qualified}`)?.startsWith("module:")
			) {
				throw new TypeCheckError(
					`'${parts[0]}' has no export '${parts[1]}'`,
				);
			}
			return qualified;
		}
	}
	return typeName;
}

/** Struct field types stored as display strings. */
function fieldTypeFromStruct(
	state: CompilerState,
	structName: string,
	field: string,
): Type {
	const name = resolveModuleType(state, structName);
	const def = state.structs.get(name);
	if (!def) return TUnknown;
	const raw = def.types.get(field);
	if (!raw) return TUnknown;
	return parseDisplayType(raw);
}

function fnReturnType(
	state: CompilerState,
	funcName: string,
): Type {
	const native = lookupNativeSig(funcName);
	if (native) return native.ret;

	const def = state.functions.get(funcName);
	if (def?.returnType) {
		return parseDisplayType(def.returnType);
	}
	if (def?.ast.returnType) return typeFromAst(def.ast.returnType, state);
	return TUnknown;
}

function fnParamTypes(
	state: CompilerState,
	funcName: string,
): { params: Type[]; rest?: Type; variadic?: boolean } | null {
	const native = lookupNativeSig(funcName);
	if (native) {
		return {
			params: native.params,
			rest: native.rest,
			variadic: native.variadic,
		};
	}
	const def = state.functions.get(funcName);
	if (!def) return null;
	const params: Type[] = [];
	let rest: Type | undefined;
	const plist = def.ast.params?.params ?? [];
	const isVariadic = def.ast.params?.isVariadic ?? false;
	for (let i = 0; i < plist.length; i++) {
		const p = plist[i]!;
		let t: Type = TUnknown;
		if (p.nodeName === "DeclarationNode") {
			const d = p as ast.DeclarationExpression;
			if (d.type) t = typeFromAst(d.type, state);
			if (isVariadic && i === plist.length - 1) {
				rest = t.kind === "array" ? t : arrayType(t.kind === "unknown" ? TUnknown : t);
				continue;
			}
		}
		params.push(t);
	}
	return { params, rest, variadic: isVariadic };
}

function resolveCalleeName(
	state: CompilerState,
	env: Env,
	call: ast.CallExpression,
): string | undefined {
	if (call.callee.nodeName === "PrimaryExpression") {
		return (call.callee as ast.PrimaryExpression).name;
	}
	if (call.callee.nodeName === "MemberExpression") {
		const mem = call.callee as ast.MemberExpression;
		const objType = inferExpr(state, env, mem.object);
		if (
			objType.kind === "struct" &&
			mem.property.nodeName === "PrimaryExpression"
		) {
			const prop = (mem.property as ast.PrimaryExpression).name;
			const method = `${objType.name}::${prop}`;
			if (state.functions.has(method) || state.structs.get(objType.name)) {
				return method;
			}
		}
		const staticPath = tryResolveStaticPath(state, call.callee);
		if (staticPath) {
			if (
				staticPath.includes("::") &&
				!state.chunk.exports.has(staticPath) &&
				!state.globalTypes.get(`$${staticPath}`)?.startsWith("module:")
			) {
				const mem = call.callee as ast.MemberExpression;
				const modName =
					mem.object.nodeName === "PrimaryExpression"
						? (mem.object as ast.PrimaryExpression).name
						: "Module";
				const propName =
					mem.property.nodeName === "PrimaryExpression"
						? (mem.property as ast.PrimaryExpression).name
						: "property";
				throw new TypeCheckError(
					`'${modName}' has no export '${propName}'`,
				);
			}
			return staticPath;
		}
	}
	const staticPath = tryResolveStaticPath(state, call.callee);
	return staticPath;
}

function inferExpr(
	state: CompilerState,
	env: Env,
	node: ast.Node | null | undefined,
): Type {
	if (!node) return TUnknown;
	switch (node.nodeName) {
		case "LiteralNode":
			return inferLiteral(node as ast.LiteralExpression);

		case "PrimaryExpression": {
			const prim = node as ast.PrimaryExpression;
			if (prim.kind === "Identifier" || prim.kind === "Register") {
				const staticPath = tryResolveStaticPath(state, node);
				if (staticPath?.endsWith(".lls")) {
					return { kind: "struct", name: `module:${staticPath}` };
				}
				if (staticPath && state.functions.has(staticPath)) {
					return fnReturnType(state, staticPath);
				}
				const t = lookup(env, prim.name);
				if (t) return t;
				const gt = state.globalTypes.get(prim.name);
				if (gt?.startsWith("module:")) {
					return { kind: "struct", name: gt };
				}
				if (gt) return namedType(gt);
				if (lookupNativeSig(prim.name)) {
					return TUnknown; // function value
				}
				return TUnknown;
			}
			return TUnknown;
		}

		case "UnaryExpression": {
			const u = node as ast.UnaryExpression;
			const t = inferExpr(state, env, u.operand);
			if (u.operator === "!") return TBool;
			return t;
		}

		case "BinaryExpression": {
			const b = node as ast.BinaryExpression;
			const l = inferExpr(state, env, b.left);
			const r = inferExpr(state, env, b.right);
			const op = b.operator;
			if (["==", "!=", "<", "<=", ">", ">=", "&&", "||"].includes(op)) {
				if (
					!involvesUnknown(l) &&
					!involvesUnknown(r) &&
					["+", "-", "*", "/", "%", "^", "**"].includes(op) === false
				) {
					// comparison / logic — allow if both known and compatible-ish
					if (
						["==", "!="].includes(op) &&
						!involvesUnknown(l) &&
						!involvesUnknown(r) &&
						isByteSlice(l) &&
						isByteSlice(r)
					) {
						return TBool;
					}
					if (
						["<", "<=", ">", ">="].includes(op) &&
						!involvesUnknown(l) &&
						!involvesUnknown(r)
					) {
						requireAssign(l, TInt, `operator '${op}' left`);
						requireAssign(r, TInt, `operator '${op}' right`);
					}
				}
				return TBool;
			}
			if (op === "+" || op === "==" || op === "!=") {
				// handled above for ==; + below
			}
			if (op === "+") {
				if (isByteSlice(l) || isByteSlice(r)) {
					if (!involvesUnknown(l) && !involvesUnknown(r)) {
						if (!isByteSlice(l) || !isByteSlice(r)) {
							throw new TypeCheckError(
								`string +: cannot concatenate '${displayType(l)}' and '${displayType(r)}'`,
							);
						}
					}
					return TString;
				}
				if (!involvesUnknown(l) && !involvesUnknown(r)) {
					requireAssign(l, TInt, "numeric +");
					requireAssign(r, TInt, "numeric +");
				}
				return TInt;
			}
			if (["-", "*", "/", "%", "^", "**"].includes(op)) {
				if (!involvesUnknown(l) && !involvesUnknown(r)) {
					requireAssign(l, TInt, `operator '${op}'`);
					requireAssign(r, TInt, `operator '${op}'`);
				}
				return TInt;
			}
			return TUnknown;
		}

		case "CallExpression": {
			const call = node as ast.CallExpression;
			if (
				call.callee.nodeName === "PrimaryExpression" &&
				(call.callee as ast.PrimaryExpression).name === "@isError"
			) {
				if (call.args.length !== 1) {
					throw new TypeCheckError("@isError expects exactly 1 argument");
				}
				inferExpr(state, env, call.args[0]!);
				return TBool;
			}
			if (
				call.callee.nodeName === "PrimaryExpression" &&
				(call.callee as ast.PrimaryExpression).name === "@typeOf"
			) {
				if (call.args.length !== 1) {
					throw new TypeCheckError("@typeOf expects exactly 1 argument");
				}
				const argType = inferExpr(state, env, call.args[0]!);
				state.typeOfResults.set(call, displayType(argType));
				return TString;
			}
			const name = resolveCalleeName(state, env, call);
			if (!name) {
				for (const a of call.args) inferExpr(state, env, a);
				return TUnknown;
			}

			// Method call: first arg is receiver (not for module.fn calls)
			let args = [...call.args];
			let sig = fnParamTypes(state, name);
			if (
				call.callee.nodeName === "MemberExpression" &&
				name.includes("::") &&
				!name.includes(".lls::")
			) {
				const mem = call.callee as ast.MemberExpression;
				args = [mem.object, ...call.args];
			}

			if (sig) {
				const namedCount = sig.params.length;
				if (sig.variadic || sig.rest) {
					if (args.length < namedCount) {
						throw new TypeCheckError(
							`Function '${name}' expected at least ${namedCount} arguments, got ${args.length}`,
						);
					}
					for (let i = 0; i < namedCount; i++) {
						const at = inferExpr(state, env, args[i]!);
						requireAssign(at, sig.params[i]!, `argument ${i + 1} of '${name}'`);
					}
					const restElem =
						sig.rest?.kind === "array" ? sig.rest.elem : TUnknown;
					for (let i = namedCount; i < args.length; i++) {
						const at = inferExpr(state, env, args[i]!);
						requireAssign(
							at,
							restElem,
							`rest argument of '${name}'`,
						);
					}
				} else {
					if (
						sig.params.some((p) => !involvesUnknown(p)) &&
						args.length !== namedCount
					) {
						// Only enforce arity when at least one param is annotated
						const anyAnnotated = sig.params.some((p) => p.kind !== "unknown");
						if (anyAnnotated && args.length !== namedCount) {
							throw new TypeCheckError(
								`Function '${name}' expected ${namedCount} arguments, got ${args.length}`,
							);
						}
					}
					for (let i = 0; i < Math.min(args.length, namedCount); i++) {
						const at = inferExpr(state, env, args[i]!);
						requireAssign(at, sig.params[i]!, `argument ${i + 1} of '${name}'`);
					}
					for (let i = namedCount; i < args.length; i++) {
						inferExpr(state, env, args[i]!);
					}
				}
			} else {
				for (const a of args) inferExpr(state, env, a);
			}
			return fnReturnType(state, name);
		}

		case "MemberExpression": {
			const mem = node as ast.MemberExpression;
			const staticPath = tryResolveStaticPath(state, node);
			if (staticPath && state.functions.has(staticPath)) {
				if (
					staticPath.includes("::") &&
					!state.chunk.exports.has(staticPath) &&
					!state.globalTypes.get(`$${staticPath}`)?.startsWith("module:")
				) {
					const modName =
						mem.object.nodeName === "PrimaryExpression"
							? (mem.object as ast.PrimaryExpression).name
							: "Module";
					const propName =
						mem.property.nodeName === "PrimaryExpression"
							? (mem.property as ast.PrimaryExpression).name
							: "property";
					throw new TypeCheckError(
						`'${modName}' has no export '${propName}'`,
					);
				}
				return fnReturnType(state, staticPath);
			}
			const objType = inferExpr(state, env, mem.object);
			if (
				objType.kind === "struct" &&
				mem.property.nodeName === "PrimaryExpression"
			) {
				const prop = (mem.property as ast.PrimaryExpression).name;
				if (objType.name.startsWith("module:")) {
					// module namespace — pub exports have known types; other
					// properties stay Unknown (dynamic bag / privacy).
					const path = objType.name.replace("module:", "");
					const exportName = `${path}::${prop}`;
					const re = state.globalTypes.get(`$${exportName}`);
					if (
						!state.chunk.exports.has(exportName) &&
						!re?.startsWith("module:")
					) {
						return TUnknown;
					}
					if (state.functions.has(exportName)) {
						return fnReturnType(state, exportName);
					}
					const gt = state.globalTypes.get(`$${exportName}`);
					if (gt) return namedType(gt);
					if (state.structs.has(exportName)) {
						return { kind: "struct", name: exportName };
					}
					return TUnknown;
				}
				return fieldTypeFromStruct(state, objType.name, prop);
			}
			return TUnknown;
		}

		case "IndexExpression": {
			const idx = node as ast.IndexExpression;
			const obj = inferExpr(state, env, idx.object);
			const i = inferExpr(state, env, idx.index);
			if (!involvesUnknown(i)) requireAssign(i, TInt, "index");
			if (obj.kind === "array") return obj.elem;
			if (!involvesUnknown(obj) && obj.kind !== "unknown") {
				throw new TypeCheckError(
					`Cannot index type '${displayType(obj)}'`,
				);
			}
			return TUnknown;
		}

		case "ArrayLiteral": {
			const arr = node as ast.ArrayLiteral;
			if (arr.elements.length === 0) return arrayType(TUnknown, 0);
			const types = arr.elements.map((e) => inferExpr(state, env, e));
			let elem = types[0]!;
			for (let i = 1; i < types.length; i++) {
				const ti = types[i]!;
				if (involvesUnknown(elem) || involvesUnknown(ti)) {
					if (elem.kind === "unknown") elem = ti;
					continue;
				}
				// Nested arrays: unify lengths
				if (elem.kind === "array" && ti.kind === "array") {
					if (
						elem.length !== null &&
						ti.length !== null &&
						elem.length !== ti.length
					) {
						throw new TypeCheckError(
							`Array elements have inconsistent lengths [${elem.length}] vs [${ti.length}]`,
						);
					}
					if (!isSubtype(ti.elem, elem.elem) && !isSubtype(elem.elem, ti.elem)) {
						throw new TypeCheckError(
							`Array elements have inconsistent types '${displayType(elem)}' and '${displayType(ti)}'`,
						);
					}
					// Prefer sized length if one side has it
					const len =
						elem.length !== null ? elem.length : ti.length;
					const inner =
						isSubtype(ti.elem, elem.elem) ? elem.elem : ti.elem;
					elem = arrayType(inner, len);
					continue;
				}
				if (!isSubtype(ti, elem) && !isSubtype(elem, ti)) {
					throw new TypeCheckError(
						`Array elements have inconsistent types '${displayType(elem)}' and '${displayType(ti)}'`,
					);
				}
				if (isSubtype(ti, elem)) {
					/* keep elem */
				} else {
					elem = ti;
				}
			}
			return arrayType(elem, arr.elements.length);
		}

		case "StructInitialization": {
			const init = node as ast.StructInitialization;
			let structName = init.name;
			if (structName.includes(".")) {
				structName = resolveModuleType(state, structName);
			}
			const def = state.structs.get(structName);
			if (!def) {
				throw new TypeCheckError(`Unknown struct '${init.name}'`);
			}
			for (const field of init.fields) {
				const expected = fieldTypeFromStruct(state, structName, field.name);
				const got = inferExpr(state, env, field.value);
				requireAssign(
					got,
					expected,
					`field '${field.name}' of '${structName}'`,
				);
			}
			return { kind: "struct", name: structName };
		}

		case "ErrorExpression": {
			const err = node as ast.ErrorExpression;
			const msg = inferExpr(state, env, err.message);
			requireAssign(msg, TString, "error(...)");
			return TError;
		}

		case "TryExpression": {
			const tr = node as ast.TryExpression;
			const inner = inferExpr(state, env, tr.expression);
			if (!involvesUnknown(inner)) {
				if (inner.kind !== "error" && !isErrorUnion(inner) && inner.kind !== "unknown") {
					if (!allowsError(inner)) {
						throw new TypeCheckError(
							`'?' operator used on non-error-union type '${displayType(inner)}'`,
						);
					}
				}
				if (env.annotatedReturn && !allowsError(env.annotatedReturn)) {
					throw new TypeCheckError(
						`Cannot use '?' here: enclosing function return type '${displayType(env.annotatedReturn)}' does not allow error`,
					);
				}
			}
			return unwrapError(inner);
		}

		case "AssignmentExpression": {
			const a = node as ast.AssignmentExpression;
			const val = inferExpr(state, env, a.right);
			if (a.left.nodeName === "PrimaryExpression") {
				const name = (a.left as ast.PrimaryExpression).name;
				const existing = lookup(env, name);
				if (existing) requireAssign(val, existing, `assignment to '${name}'`);
			} else if (a.left.nodeName === "MemberExpression") {
				const mem = a.left as ast.MemberExpression;
				const objType = inferExpr(state, env, mem.object);
				if (
					objType.kind === "struct" &&
					mem.property.nodeName === "PrimaryExpression"
				) {
					const prop = (mem.property as ast.PrimaryExpression).name;
					const ft = fieldTypeFromStruct(state, objType.name, prop);
					requireAssign(val, ft, `assignment to field '${prop}'`);
				}
			} else if (a.left.nodeName === "IndexExpression") {
				inferExpr(state, env, a.left);
			}
			return val;
		}

		case "BlockExpression": {
			const block = node as ast.BlockExpression;
			pushScope(env);
			let last: Type = TUnknown;
			for (const s of block.statements) {
				last = checkStmt(state, env, s) ?? TUnknown;
			}
			popScope(env);
			return last;
		}

		case "IfExpression": {
			const iff = node as ast.IfExpression;
			inferExpr(state, env, iff.condition);
			inferExpr(state, env, iff.body);
			if (iff.elseBody) inferExpr(state, env, iff.elseBody);
			return TUnknown;
		}

		case "ForExpression": {
			const f = node as ast.ForExpression;
			if (f.condition) inferExpr(state, env, f.condition);
			if (f.rangeStart) inferExpr(state, env, f.rangeStart);
			if (f.rangeEnd) inferExpr(state, env, f.rangeEnd);
			if (f.iterable) inferExpr(state, env, f.iterable);
			pushScope(env);
			for (const cap of f.captures) {
				define(env, cap.name, TInt);
			}
			inferExpr(state, env, f.body);
			popScope(env);
			return TUnknown;
		}

		default:
			return TUnknown;
	}
}

function checkStmt(
	state: CompilerState,
	env: Env,
	node: ast.Node,
): Type | null {
	switch (node.nodeName) {
		case "DeclarationNode": {
			const decl = node as ast.DeclarationExpression;
			if (decl.value.nodeName === "ImportNode") {
				const mod = state.globalTypes.get(`$${decl.name}`);
				if (mod?.startsWith("module:")) {
					define(env, decl.name, { kind: "struct", name: mod });
				}
				// `@const $std = @import(...)` and bare import aliases are comptime
				if (decl.isConst || mod?.startsWith("module:")) {
					env.constNames.add(decl.name);
				}
				return null;
			}
			if (decl.isConst) {
				const cenv: ConstEnv = { constNames: env.constNames };
				if (!isConstantExpr(state, cenv, decl.value)) {
					throw new TypeCheckError(
						`'${decl.name}' is @const but initializer is not a compile-time constant`,
					);
				}
			}
			const valueType = inferExpr(state, env, decl.value);
			const annot = decl.type ? typeFromAst(decl.type, state) : null;
			if (annot) {
				requireAssign(valueType, annot, `declaration of '${decl.name}'`);
				define(env, decl.name, annot);
				if (!decl.name.includes("::")) {
					state.globalTypes.set(decl.name, displayType(annot));
				}
			} else if (valueType.kind === "struct") {
				define(env, decl.name, valueType);
				state.globalTypes.set(decl.name, valueType.name);
			} else {
				define(env, decl.name, valueType);
			}
			if (decl.isConst) {
				env.constNames.add(decl.name);
			}
			return null;
		}
		case "ReturnExpression": {
			const ret = node as ast.ReturnExpression;
			const t = ret.returnValue
				? inferExpr(state, env, ret.returnValue)
				: TNull;
			if (env.expectedReturn) {
				requireAssign(t, env.expectedReturn, "return value");
			}
			return t;
		}
		case "DeferStatement": {
			const def = node as ast.DeferStatement;
			checkStmt(state, env, def.body);
			return null;
		}
		case "FunctionDeclaration":
		case "StructDeclaration":
		case "ExternDeclaration":
			return null;
		case "BlockExpression":
			return inferExpr(state, env, node);
		default:
			inferExpr(state, env, node);
			return null;
	}
}

function checkFunction(
	state: CompilerState,
	fn: ast.FunctionDeclaration,
	topLevelConsts: Set<string>,
) {
	const env: Env = {
		locals: [],
		globals: new Map(),
		expectedReturn: null,
		annotatedReturn: null,
		constNames: new Set(topLevelConsts),
	};
	// Seed globals from state
	for (const [k, v] of state.globalTypes) {
		if (k.startsWith("$")) continue;
		if (v.startsWith("module:")) {
			env.globals.set(k, { kind: "struct", name: v });
		} else {
			env.globals.set(k, namedType(v));
		}
	}
	for (const name of state.nativeGlobals) {
		env.globals.set(name, TUnknown);
	}

	const annotated = fn.returnType ? typeFromAst(fn.returnType, state) : null;
	env.annotatedReturn = annotated;
	env.expectedReturn = annotated;

	pushScope(env);
	const params = fn.params?.params ?? [];
	const isVariadic = fn.params?.isVariadic ?? false;
	for (let i = 0; i < params.length; i++) {
		const p = params[i]!;
		if (p.nodeName !== "DeclarationNode") continue;
		const d = p as ast.DeclarationExpression;
		let t = d.type ? typeFromAst(d.type, state) : TUnknown;
		if (d.name === "self" && fn.name.includes("::")) {
			t = { kind: "struct", name: fn.name.slice(0, fn.name.lastIndexOf("::")) };
		}
		if (isVariadic && i === params.length - 1 && t.kind !== "array") {
			t = arrayType(t.kind === "unknown" ? TUnknown : t);
		}
		define(env, d.name, t);
	}

	for (const stmt of fn.body.statements) {
		checkStmt(state, env, stmt);
	}
	popScope(env);

	// Sync FunctionDef.returnType for emit
	const def = state.functions.get(fn.name);
	if (def && annotated) {
		def.returnType = displayType(annotated);
	}
}

function checkStructFieldTypes(state: CompilerState, s: ast.StructDeclaration) {
	// Rewrite struct field type strings to normalized display forms
	const def = state.structs.get(s.name);
	if (!def) return;
	for (const field of s.fields) {
		if (!field.type) continue;
		const t = typeFromAst(field.type, state);
		def.types.set(field.name, displayType(t));
	}
}

export function typecheck(state: CompilerState, document: ast.DocumentBody) {
	// Normalize struct field types first
	for (const stmt of document.statements) {
		if (stmt.nodeName === "StructDeclaration") {
			checkStructFieldTypes(state, stmt as ast.StructDeclaration);
		}
	}

	// Seed: module aliases are always comptime; top-level @const names for functions
	const moduleAliases = createConstEnv(state).constNames;
	for (const stmt of document.statements) {
		if (stmt.nodeName !== "DeclarationNode") continue;
		const decl = stmt as ast.DeclarationExpression;
		if (decl.value.nodeName === "ImportNode") {
			moduleAliases.add(decl.name);
		}
	}
	const topLevelConsts = new Set(moduleAliases);
	for (const stmt of document.statements) {
		if (stmt.nodeName !== "DeclarationNode") continue;
		const decl = stmt as ast.DeclarationExpression;
		if (decl.isConst) topLevelConsts.add(decl.name);
	}

	// Check all functions
	for (const stmt of document.statements) {
		if (stmt.nodeName === "FunctionDeclaration") {
			checkFunction(state, stmt as ast.FunctionDeclaration, topLevelConsts);
		} else if (stmt.nodeName === "StructDeclaration") {
			const s = stmt as ast.StructDeclaration;
			for (const m of s.methods) {
				checkFunction(state, m, topLevelConsts);
			}
		}
	}

	// Top-level script — add @const names in order (no forward refs)
	const env: Env = {
		locals: [new Map()],
		globals: new Map(),
		expectedReturn: null,
		annotatedReturn: null,
		constNames: new Set(moduleAliases),
	};
	for (const [k, v] of state.globalTypes) {
		if (k.startsWith("$")) {
			const name = k.slice(1);
			if (v.startsWith("module:")) {
				env.globals.set(name, { kind: "struct", name: v });
			}
			continue;
		}
		if (v.startsWith("module:")) {
			env.globals.set(k, { kind: "struct", name: v });
		} else {
			env.globals.set(k, namedType(v));
		}
	}

	for (const stmt of document.statements) {
		if (
			stmt.nodeName === "FunctionDeclaration" ||
			stmt.nodeName === "StructDeclaration" ||
			stmt.nodeName === "ExternDeclaration"
		) {
			continue;
		}
		checkStmt(state, env, stmt);
	}
}
