// Convert AST type nodes → Type IR / display strings.
import type * as ast from "../ast";
import {
	arrayType,
	displayType,
	namedType,
	type Type,
	TUnknown,
	unionType,
} from "./type-ir";

export function typeFromAst(node: ast.Node | null | undefined): Type {
	if (!node) return TUnknown;
	switch (node.nodeName) {
		case "PrimaryExpression": {
			const prim = node as ast.PrimaryExpression;
			return namedType(prim.name);
		}
		case "ArrayTypeExpression": {
			const arr = node as ast.ArrayTypeExpression;
			return arrayType(typeFromAst(arr.elem));
		}
		case "UnionTypeExpression": {
			const u = node as ast.UnionTypeExpression;
			return unionType(typeFromAst(u.left), typeFromAst(u.right));
		}
		default:
			return TUnknown;
	}
}

export function typeAstToDisplay(node: ast.Node | null | undefined): string | undefined {
	if (!node) return undefined;
	return displayType(typeFromAst(node));
}
