// Convert AST type nodes → Type IR / display strings.
import type * as ast from "../ast";
import type { CompilerState } from "./state";
import {
	arrayType,
	displayType,
	namedType,
	type Type,
	TUnknown,
	unionType,
} from "./type-ir";

export function typeFromAst(
	node: ast.Node | null | undefined,
	state?: CompilerState,
): Type {
	if (!node) return TUnknown;
	switch (node.nodeName) {
		case "PrimaryExpression": {
			const prim = node as ast.PrimaryExpression;
			return resolveNamedType(prim.name, state);
		}
		case "ArrayTypeExpression": {
			const arr = node as ast.ArrayTypeExpression;
			return arrayType(typeFromAst(arr.elem, state), arr.length);
		}
		case "UnionTypeExpression": {
			const u = node as ast.UnionTypeExpression;
			return unionType(typeFromAst(u.left, state), typeFromAst(u.right, state));
		}
		default:
			return TUnknown;
	}
}

/** Resolve a type name; validate structs when state is provided. */
export function resolveNamedType(name: string, state?: CompilerState): Type {
	const t = namedType(name);
	if (t.kind === "struct" && state) {
		if (!state.structs.has(t.name)) {
			throw new Error(`CompileError: Unknown type '${name}'`);
		}
	}
	return t;
}

export function typeAstToDisplay(
	node: ast.Node | null | undefined,
	state?: CompilerState,
): string | undefined {
	if (!node) return undefined;
	return displayType(typeFromAst(node, state));
}
