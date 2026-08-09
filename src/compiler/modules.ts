// Module inlining: qualify names, rewrite intra-module refs, track pub exports.
import * as ast from "../ast";

/** Short name → `modulePath::name` for a module's own top-level decls. */
export function collectLocalBindings(
	statements: ast.Node[],
	modulePath: string,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const stmt of statements) {
		switch (stmt.nodeName) {
			case "StructDeclaration": {
				const s = stmt as ast.StructDeclaration;
				if (!s.name.includes("::")) {
					map.set(s.name, `${modulePath}::${s.name}`);
				}
				break;
			}
			case "FunctionDeclaration": {
				const f = stmt as ast.FunctionDeclaration;
				if (!f.name.includes("::")) {
					map.set(f.name, `${modulePath}::${f.name}`);
				}
				break;
			}
			case "DeclarationNode": {
				const d = stmt as ast.DeclarationExpression;
				if (!d.name.includes("::")) {
					map.set(d.name, `${modulePath}::${d.name}`);
				}
				break;
			}
			case "ExternDeclaration": {
				const e = stmt as ast.ExternDeclaration;
				if (!e.name.includes("::")) {
					map.set(e.name, `${modulePath}::${e.name}`);
				}
				break;
			}
		}
	}
	return map;
}

/** Rename this module's top-level decls; record pub names in `exports`. */
export function qualifyModuleDecls(
	statements: ast.Node[],
	modulePath: string,
	localMap: Map<string, string>,
	exports: Set<string>,
): void {
	for (const stmt of statements) {
		switch (stmt.nodeName) {
			case "StructDeclaration": {
				const s = stmt as ast.StructDeclaration;
				if (s.name.includes("::")) break;
				const short = s.name;
				s.name = localMap.get(short) ?? `${modulePath}::${short}`;
				for (const m of s.methods) {
					if (m.name.startsWith(`${short}::`)) {
						m.name = `${modulePath}::${m.name}`;
					}
				}
				if (s.isPublic) exports.add(s.name);
				break;
			}
			case "FunctionDeclaration": {
				const f = stmt as ast.FunctionDeclaration;
				if (f.name.includes("::")) break;
				f.name = localMap.get(f.name) ?? `${modulePath}::${f.name}`;
				if (f.isPublic) exports.add(f.name);
				break;
			}
			case "DeclarationNode": {
				const d = stmt as ast.DeclarationExpression;
				if (d.name.includes("::")) break;
				d.name = localMap.get(d.name) ?? `${modulePath}::${d.name}`;
				if (d.isPublic) exports.add(d.name);
				break;
			}
			case "ExternDeclaration": {
				const e = stmt as ast.ExternDeclaration;
				if (e.name.includes("::")) break;
				e.name = localMap.get(e.name) ?? `${modulePath}::${e.name}`;
				if (e.isPublic) exports.add(e.name);
				break;
			}
		}
	}
}

/**
 * Rewrite identifiers that refer to this module's top-level symbols,
 * respecting local bindings so shadowing still works.
 */
export function rewriteModuleRefs(
	node: ast.Node,
	localMap: Map<string, string>,
	bound: Set<string> = new Set(),
): void {
	if (!node) return;

	switch (node.nodeName) {
		case "FunctionDeclaration": {
			const fn = node as ast.FunctionDeclaration;
			const inner = new Set(bound);
			const params = fn.params?.params ?? [];
			for (const p of params) {
				if (p.nodeName === "DeclarationNode") {
					inner.add((p as ast.DeclarationExpression).name);
				}
			}
			if (fn.returnType) rewriteModuleRefs(fn.returnType, localMap, inner);
			rewriteModuleRefs(fn.body, localMap, inner);
			return;
		}
		case "StructDeclaration": {
			const s = node as ast.StructDeclaration;
			for (const field of s.fields) {
				if (field.type) rewriteModuleRefs(field.type, localMap, bound);
			}
			for (const m of s.methods) {
				rewriteModuleRefs(m, localMap, bound);
			}
			return;
		}
		case "BlockExpression": {
			const block = node as ast.BlockExpression;
			const inner = new Set(bound);
			for (const stmt of block.statements) {
				rewriteModuleRefs(stmt, localMap, inner);
			}
			return;
		}
		case "DeclarationNode": {
			const d = node as ast.DeclarationExpression;
			if (d.type) rewriteModuleRefs(d.type, localMap, bound);
			rewriteModuleRefs(d.value, localMap, bound);
			bound.add(d.name);
			return;
		}
		case "PrimaryExpression": {
			const prim = node as ast.PrimaryExpression;
			if (
				prim.kind === "Identifier" &&
				localMap.has(prim.name) &&
				!bound.has(prim.name)
			) {
				prim.name = localMap.get(prim.name)!;
			}
			return;
		}
		case "StructInitialization": {
			const init = node as ast.StructInitialization;
			if (localMap.has(init.name) && !bound.has(init.name)) {
				init.name = localMap.get(init.name)!;
			}
			for (const field of init.fields) {
				rewriteModuleRefs(field.value, localMap, bound);
			}
			return;
		}
		case "ForExpression": {
			const forExpr = node as ast.ForExpression;
			if (forExpr.condition) rewriteModuleRefs(forExpr.condition, localMap, bound);
			if (forExpr.rangeStart) rewriteModuleRefs(forExpr.rangeStart, localMap, bound);
			if (forExpr.rangeEnd) rewriteModuleRefs(forExpr.rangeEnd, localMap, bound);
			if (forExpr.iterable) rewriteModuleRefs(forExpr.iterable, localMap, bound);
			const inner = new Set(bound);
			for (const c of forExpr.captures) inner.add(c.name);
			rewriteModuleRefs(forExpr.body, localMap, inner);
			return;
		}
		case "IfExpression": {
			const ifExpr = node as ast.IfExpression;
			rewriteModuleRefs(ifExpr.condition, localMap, bound);
			rewriteModuleRefs(ifExpr.body, localMap, bound);
			if (ifExpr.elseBody) rewriteModuleRefs(ifExpr.elseBody, localMap, bound);
			return;
		}
		default: {
			for (const key of Object.keys(node)) {
				if (key === "parent" || key === "document") continue;
				const val = (node as unknown as Record<string, unknown>)[key];
				if (val instanceof ast.Node) rewriteModuleRefs(val, localMap, bound);
				else if (Array.isArray(val)) {
					for (const item of val) {
						if (item instanceof ast.Node) {
							rewriteModuleRefs(item, localMap, bound);
						}
					}
				}
			}
		}
	}
}
