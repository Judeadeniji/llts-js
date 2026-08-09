/**
 * Compile-time constant expression check for `@const` initializers (Go-style).
 */
import type * as ast from "../ast";
import type { CompilerState } from "./state";

/** Names that may appear in a constant expression. */
export interface ConstEnv {
	/** Local/global bindings declared with `@const` (or module aliases). */
	constNames: Set<string>;
}

export function createConstEnv(state: CompilerState): ConstEnv {
	const constNames = new Set<string>(state.globalConsts);
	// Module aliases: `$std` → module:… stored under `$std` in globalTypes
	for (const [k, v] of state.globalTypes) {
		if (k.startsWith("$") && v.startsWith("module:")) {
			constNames.add(k.slice(1));
		}
	}
	return { constNames };
}

/**
 * True if `node` is a compile-time constant expression under `env`.
 * Does not evaluate; validation only.
 */
export function isConstantExpr(
	state: CompilerState,
	env: ConstEnv,
	node: ast.Node | null | undefined,
): boolean {
	if (!node) return false;

	switch (node.nodeName) {
		case "LiteralNode":
			return true;

		case "PrimaryExpression": {
			const prim = node as ast.PrimaryExpression;
			if (prim.kind === "Identifier" || prim.kind === "Register") {
				if (prim.name === "null" || prim.name === "true" || prim.name === "false") {
					return true;
				}
				return env.constNames.has(prim.name);
			}
			return false;
		}

		case "UnaryExpression": {
			const u = node as ast.UnaryExpression;
			return isConstantExpr(state, env, u.arg);
		}

		case "BinaryExpression": {
			const b = node as ast.BinaryExpression;
			// Pipe and range are not constant exprs
			if (b.operator === "|>" || b.operator === "..") return false;
			return (
				isConstantExpr(state, env, b.left) &&
				isConstantExpr(state, env, b.right)
			);
		}

		case "ArrayLiteral": {
			const arr = node as ast.ArrayLiteral;
			return arr.elements.every((e) => isConstantExpr(state, env, e));
		}

		case "StructInitialization": {
			const init = node as ast.StructInitialization;
			// Name may be `Point` or `lib.Point` — both fine; fields must be const
			return init.fields.every((f) => isConstantExpr(state, env, f.value));
		}

		case "ImportNode":
			return true;

		case "CallExpression": {
			const call = node as ast.CallExpression;
			// `@typeOf(e)` is compile-time reflection
			if (
				call.callee.nodeName === "PrimaryExpression" &&
				(call.callee as ast.PrimaryExpression).name === "@typeOf"
			) {
				return true;
			}
			return false;
		}

		case "ErrorExpression": {
			const err = node as ast.ErrorExpression;
			return isConstantExpr(state, env, err.message);
		}

		// Runtime / non-const
		case "IndexExpression":
		case "MemberExpression":
		case "AssignmentExpression":
		case "TryExpression":
		case "IfExpression":
		case "ForExpression":
		case "BlockExpression":
			return false;

		default:
			return false;
	}
}
