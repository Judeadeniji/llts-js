// others
import { tryResolveStaticPath } from "./expressions";
import { resolveLocal } from "./scope";
import type { CompilerState } from "./state";
import type * as ast from "../ast";

// ----------------------------------------------------------------------

/** Emit-time: treat string / []byte / [N]byte as stringy for opcodes. */
export function isStringyType(t: string | undefined): boolean {
	if (!t) return false;
	if (t === "string") return true;
	return /^\[\d*\]byte$/.test(t);
}

export function resolveType(
	state: CompilerState,
	node: ast.Node,
): string | undefined {
	switch (node.nodeName) {
		case "LiteralNode": {
			const lit = node as ast.LiteralExpression;
			if (lit.literal_type === "string") return `[${lit.value.length}]byte`;
			if (lit.literal_type === "boolean") return "bool";
			return "int";
		}
		case "PrimaryExpression": {
			const prim = node as ast.PrimaryExpression;
			if (prim.kind === "Identifier" || prim.kind === "Register") {
				let typeName: string | undefined;
				const localIdx = resolveLocal(state, prim.name);
				if (localIdx !== -1) {
					typeName = state.locals[localIdx]?.typeName;
				} else {
					typeName = state.globalTypes.get(prim.name);
				}

				if (typeName?.includes(".")) {
					const parts = typeName.split(".");
					const modulePath = state.globalTypes.get(`$${parts[0]}`);
					if (modulePath?.startsWith("module:")) {
						typeName = `${modulePath.replace("module:", "")}::${parts[1]}`;
					}
				}
				return typeName;
			}
			break;
		}
		case "MemberExpression": {
			const mem = node as ast.MemberExpression;
			const objectType = resolveType(state, mem.object);
			if (
				objectType &&
				mem.property.nodeName === "PrimaryExpression" &&
				(mem.property as ast.PrimaryExpression).kind === "Identifier"
			) {
				const structDef = state.structs.get(objectType);
				if (structDef) {
					return structDef.types.get(
						(mem.property as ast.PrimaryExpression).name,
					);
				}
			}
			break;
		}
		case "CallExpression": {
			const call = node as ast.CallExpression;
			let funcName: string | undefined;

			if (call.callee.nodeName === "PrimaryExpression") {
				funcName = (call.callee as ast.PrimaryExpression).name;
			} else if (call.callee.nodeName === "MemberExpression") {
				const mem = call.callee as ast.MemberExpression;
				const objType = resolveType(state, mem.object);
				if (objType && mem.property.nodeName === "PrimaryExpression") {
					const propName = (mem.property as ast.PrimaryExpression).name;
					funcName = `${objType}::${propName}`;
				}
			}

			if (!funcName) {
				const staticPath = tryResolveStaticPath(state, call.callee);
				if (staticPath) funcName = staticPath;
			}

			if (funcName) {
				return state.functions.get(funcName)?.returnType;
			}
			return undefined;
		}
	}
	return undefined;
}
