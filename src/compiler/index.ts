// others
import { type Chunk, OpCode } from "../bytecode";
import { emitByte, emitBytes, emitJump, patchJump } from "./emit";
import { type CompilerState, createCompilerState } from "./state";
import { compileFunction, compileStatement } from "./statements";
import * as ast from "../ast";

// ----------------------------------------------------------------------

function registerFunctions(state: CompilerState, document: ast.DocumentBody) {
	const visitedNodes = new Set<ast.Node>();

	// Collect all functions
	const collectFuncs = (node: ast.Node, prefix = "") => {
		if (!node || visitedNodes.has(node)) return;
		visitedNodes.add(node);

		if (node.nodeName === "FunctionDeclaration") {
			const fn = node as ast.FunctionDeclaration;
			const fullName = prefix ? `${prefix}::${fn.name}` : fn.name;

			// Analyze for loops and calls
			let hasLoop = false;
			let hasReturn = false;
			let returnType: string | undefined = fn.returnType || undefined;
			const calls = new Set<string>();

			const analyze = (n: ast.Node) => {
				if (!n || visitedNodes.has(n)) return;
				visitedNodes.add(n);

				if (n.nodeName === "ForExpression") {
					hasLoop = true;
				} else if (n.nodeName === "ReturnExpression") {
					hasReturn = true;
					// Infer return type from struct literal returns
					const ret = n as ast.ReturnExpression;
					if (ret.returnValue?.nodeName === "StructInitialization") {
						returnType = (ret.returnValue as ast.StructInitialization).name;
					} else if (
						ret.returnValue?.nodeName === "PrimaryExpression" &&
						(ret.returnValue as ast.PrimaryExpression).name === "self" &&
						fullName.includes("::")
					) {
						// `return self` inside a method → same struct type
						// fullName is e.g. "Builder::build", so the struct is the part before "::"
						returnType = fullName.split("::")[0];
					}
				}
				if (n.nodeName === "CallExpression") {
					const call = n as ast.CallExpression;
					if (call.callee.nodeName === "PrimaryExpression") {
						const prim = call.callee as ast.PrimaryExpression;
						if (prim.kind === "Identifier") {
							calls.add(prim.name);
						}
					} else if (call.callee.nodeName === "MemberExpression") {
						const mem = call.callee as ast.MemberExpression;
						if (mem.property.nodeName === "PrimaryExpression") {
							const prim = mem.property as ast.PrimaryExpression;
							if (prim.kind === "Identifier") {
								calls.add(prim.name);
							}
						}
					}
				}
				// Recurse children
				for (const key of Object.keys(n)) {
					if (key === "parent") continue;
					const val = (n as unknown as Record<string, unknown>)[key];
					if (val instanceof ast.Node) analyze(val);
					else if (Array.isArray(val)) {
						for (const item of val) {
							if (item instanceof ast.Node) analyze(item);
						}
					}
				}
			};

			// clear visited for body so we can traverse it again if needed?
			// Actually visitedNodes being global to this phase is fine,
			// since we just want to visit every node once!
			// BUT wait, fn.body is part of the AST, if we visit it in `analyze`,
			// we won't visit it in `collectFuncs`. That's actually correct because
			// `collectFuncs` doesn't need to look inside fn.body for more FunctionDeclarations
			// (LLTS doesn't have nested functions).
			analyze(fn.body);

			state.functions.set(fullName, {
				ast: fn,
				isRecursive: false,
				hasLoop,
				hasReturn,
				calls,
				returnType,
			});
		} else if (node.nodeName === "StructDeclaration") {
			const st = node as ast.StructDeclaration;
			for (const method of st.methods) {
				collectFuncs(method, "");
			}
		} else {
			// Recurse
			for (const key of Object.keys(node)) {
				if (key === "parent") continue;
				const val = (node as unknown as Record<string, unknown>)[key];
				if (val instanceof ast.Node) collectFuncs(val, prefix);
				else if (Array.isArray(val)) {
					for (const item of val) {
						if (item instanceof ast.Node) collectFuncs(item, prefix);
					}
				}
			}
		}
	};

	collectFuncs(document);

	// Cycle detection for mutual recursion
	const visited = new Set<string>();
	const stack = new Set<string>();

	const dfs = (funcName: string) => {
		if (stack.has(funcName)) {
			// Cycle detected!
			return true;
		}
		if (visited.has(funcName)) return false;

		visited.add(funcName);
		stack.add(funcName);

		const def = state.functions.get(funcName);
		if (def) {
			for (const callName of def.calls) {
				// If it calls a method, we might only have `takeDamage` but the real name is `Player::takeDamage`.
				// We should check all functions that end with `::${callName}` or exactly `callName`.
				const targets = [];
				if (state.functions.has(callName)) targets.push(callName);
				for (const k of state.functions.keys()) {
					if (k.endsWith(`::${callName}`)) targets.push(k);
				}

				for (const target of targets) {
					if (dfs(target)) {
						def.isRecursive = true;
						// Mark all in the cycle as recursive
						for (const s of stack) {
							const d = state.functions.get(s);
							if (d) d.isRecursive = true;
						}
					}
				}
			}
		}

		stack.delete(funcName);
		return def?.isRecursive || false;
	};

	for (const name of state.functions.keys()) {
		if (!visited.has(name)) {
			dfs(name);
		}
	}

	// DEBUG
	for (const [_name, _def] of state.functions.entries()) {
	}
}

function resolveImports(
	state: CompilerState,
	document: ast.DocumentBody,
	baseDir: string,
	visited: Set<string> = new Set(),
	currentModulePath?: string
) {
	const newStatements: ast.Node[] = [];
	const fs = require("node:fs");
	const path = require("node:path");
	const Parser = require("../parser").Parser;

	for (const stmt of document.statements) {
		let isImport = false;
		let importNode: ast.ImportNode | null = null;
		let declNode: ast.DeclarationExpression | null = null;

		if (stmt.nodeName === "ImportNode") {
			isImport = true;
			importNode = stmt as ast.ImportNode;
		} else if (stmt.nodeName === "DeclarationNode") {
			const decl = stmt as ast.DeclarationExpression;
			if (decl.value.nodeName === "ImportNode") {
				isImport = true;
				importNode = decl.value as ast.ImportNode;
				declNode = decl;
			}
		}

		if (isImport && importNode) {
			let importPath = importNode.importPath;
			if (importPath === "std") {
				importPath = "std/index.lls";
			} else if (["string", "math", "io", "mem", "debug"].includes(importPath)) {
				importPath = "std/" + importPath + ".lls";
			} else if (!importPath.endsWith(".lls")) {
				importPath += ".lls";
			}

			const fullPath = path.resolve(baseDir, importPath);

			if (declNode) {
				state.globalTypes.set(`$${declNode.name}`, `module:${importPath}`);
				if ((declNode as any).isPublic && currentModulePath) {
					state.globalTypes.set(`$${currentModulePath}::${declNode.name}`, `module:${importPath}`);
				}
			}

			if (!visited.has(fullPath)) {
				visited.add(fullPath);
				if (!fs.existsSync(fullPath)) {
					throw new Error(`CompileError: Unknown module '${importNode.importPath}'`);
				}

				const source = fs.readFileSync(fullPath, "utf-8");
				const parser = new Parser();
				const doc = parser.parse(source, fullPath);

				resolveImports(state, doc, process.cwd(), visited, importPath);

				for (const istmt of doc.statements) {
					if (istmt.nodeName === "StructDeclaration" && (istmt as any).isPublic) {
						const s = istmt as ast.StructDeclaration;
						if (!s.name.includes("::")) s.name = `${importPath}::${s.name}`;
						newStatements.push(s);
					} else if (istmt.nodeName === "FunctionDeclaration" && (istmt as any).isPublic) {
						const f = istmt as ast.FunctionDeclaration;
						if (!f.name.includes("::")) f.name = `${importPath}::${f.name}`;
						newStatements.push(f);
					} else if (istmt.nodeName === "DeclarationNode" && (istmt as any).isPublic) {
						const d = istmt as ast.DeclarationExpression;
						if (!d.name.includes("::")) d.name = `${importPath}::${d.name}`;
						newStatements.push(d);
					} else if (istmt.nodeName === "ExternDeclaration" && (istmt as any).isPublic) {
						const e = istmt as ast.ExternDeclaration;
						if (!e.name.includes("::")) e.name = `${importPath}::${e.name}`;
						newStatements.push(e);
					}
				}
			}
			continue; // Do not emit the original import node to runtime
		}

		newStatements.push(stmt);
	}
	document.statements = newStatements;
}

export function compile(document: ast.DocumentBody): Chunk {
	const state = createCompilerState();

	// Phase 0: Resolve imports and inline public declarations
	resolveImports(state, document, process.cwd());

	// Phase 1: Register functions and compute call graph for recursion
	registerFunctions(state, document);
	// Phase 2: Compile main script statements
	// We emit a jump over the static functions
	const mainJump = emitJump(state, OpCode.OP_JUMP);

	// Phase 1.5: Register structs
	for (const stmt of document.statements) {
		if (stmt.nodeName === "StructDeclaration") {
			compileStatement(state, stmt);
		}
	}

	// Compile all functions so they get an address (for dynamic calls / exports)
	const { LLTSFunction } = require("../bytecode");
	for (const [_name, def] of state.functions.entries()) {
		def.address = state.chunk.code.length;
		state.chunk.functions.set(_name, new LLTSFunction(_name, def.address, def.ast.params?.params.length ?? 0, def.ast.params?.isVariadic ?? false));

		// Patch forward jumps
		if (def.forwardJumps) {
			for (const patch of def.forwardJumps) {
				state.chunk.code[patch] = (def.address >> 8) & 0xff;
				state.chunk.code[patch + 1] = def.address & 0xff;
			}
		}

		compileFunction(state, def.ast);
	}

	patchJump(state, mainJump);

	// We only compile non-function/struct statements in the main body
	for (const stmt of document.statements) {
		if (
			stmt.nodeName !== "FunctionDeclaration" &&
			stmt.nodeName !== "StructDeclaration"
		) {
			compileStatement(state, stmt);
		}
	}

	// Auto-invoke `main` when defined (entry point after top-level statements)
	const mainDef = state.functions.get("main");
	if (mainDef?.address !== undefined) {
		emitBytes(
			state,
			OpCode.OP_CALL_STATIC,
			mainDef.address >> 8,
			mainDef.address & 0xff,
			0,
		);
		emitByte(state, OpCode.OP_POP); // discard main's return value
	}

	// Emit halt for main script
	emitByte(state, OpCode.OP_NULL);
	emitByte(state, OpCode.OP_RETURN);
	return { chunk: state.chunk, compilerState: state };
}

export class Compiler {
	public compile(document: ast.DocumentBody): { chunk: Chunk, compilerState: CompilerState } {
		return compile(document);
	}
}
