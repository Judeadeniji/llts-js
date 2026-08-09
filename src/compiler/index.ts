// others
import * as fs from "node:fs";
import * as path from "node:path";
import { LLTSFunction, type Chunk, OpCode } from "../bytecode";
import { Parser } from "../parser";
import { emitByte, emitBytes, emitJump, patchJump } from "./emit";
import {
	collectLocalBindings,
	qualifyModuleDecls,
	rewriteModuleRefs,
} from "./modules";
import { type CompilerState, createCompilerState } from "./state";
import { typeAstToDisplay } from "./type-from-ast";
import { typecheck } from "./typecheck";
import { beginScope } from "./scope";
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
			let returnType: string | undefined =
				fn.returnType ? typeAstToDisplay(fn.returnType) : undefined;
			const calls = new Set<string>();

			const analyze = (n: ast.Node) => {
				if (!n || visitedNodes.has(n)) return;
				visitedNodes.add(n);

				if (n.nodeName === "ForExpression") {
					hasLoop = true;
				} else if (n.nodeName === "ReturnExpression") {
					hasReturn = true;
					// Infer return type only when the function has no annotation
					if (!fn.returnType) {
						const ret = n as ast.ReturnExpression;
						if (ret.returnValue?.nodeName === "StructInitialization") {
							returnType = (ret.returnValue as ast.StructInitialization).name;
						} else if (
							ret.returnValue?.nodeName === "PrimaryExpression" &&
							(ret.returnValue as ast.PrimaryExpression).name === "self" &&
							fullName.includes("::")
						) {
							returnType = fullName.split("::")[0];
						}
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

function resolveImportPath(
	projectRoot: string,
	importerDir: string,
	rawPath: string,
): { fullPath: string; moduleKey: string } {
	let spec = rawPath;
	if (!spec.endsWith(".lls")) spec += ".lls";
	const isRelative = spec.startsWith("./") || spec.startsWith("../");
	const fullPath = path.resolve(isRelative ? importerDir : projectRoot, spec);
	const moduleKey = isRelative
		? path.relative(projectRoot, fullPath).split(path.sep).join("/")
		: spec;
	return { fullPath, moduleKey };
}

function resolveImports(
	state: CompilerState,
	document: ast.DocumentBody,
	importerDir: string,
	projectRoot: string = process.cwd(),
	visited: Set<string> = new Set(),
	currentModulePath?: string,
) {
	const newStatements: ast.Node[] = [];

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
			const { fullPath, moduleKey } = resolveImportPath(
				projectRoot,
				importerDir,
				importNode.importPath,
			);

			if (declNode) {
				state.globalTypes.set(`$${declNode.name}`, `module:${moduleKey}`);
				if (declNode.isPublic && currentModulePath) {
					state.globalTypes.set(
						`$${currentModulePath}::${declNode.name}`,
						`module:${moduleKey}`,
					);
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

				resolveImports(
					state,
					doc,
					path.dirname(fullPath),
					projectRoot,
					visited,
					moduleKey,
				);

				const localMap = collectLocalBindings(doc.statements, moduleKey);
				qualifyModuleDecls(doc.statements, moduleKey, localMap, state.chunk.exports);
				for (const istmt of doc.statements) {
					// Only rewrite this module's own decls (skip already-qualified nested inlines)
					const name =
						istmt.nodeName === "StructDeclaration"
							? (istmt as ast.StructDeclaration).name
							: istmt.nodeName === "FunctionDeclaration"
								? (istmt as ast.FunctionDeclaration).name
								: istmt.nodeName === "DeclarationNode"
									? (istmt as ast.DeclarationExpression).name
									: istmt.nodeName === "ExternDeclaration"
										? (istmt as ast.ExternDeclaration).name
										: null;
					if (name?.startsWith(`${moduleKey}::`)) {
						rewriteModuleRefs(istmt, localMap);
					}
					newStatements.push(istmt);
				}
			}
			continue; // Do not emit the original import node to runtime
		}

		newStatements.push(stmt);
	}
	document.statements = newStatements;
}

export interface CompileOptions {
	/** When true (default), emit OP_ASSERT_TYPE at typed boundaries. */
	debug?: boolean;
}

export function compile(
	document: ast.DocumentBody,
	options: CompileOptions = {},
): { chunk: Chunk, compilerState: CompilerState } {
	const debug = options.debug !== false;
	const state = createCompilerState();
	state.debug = debug;
	state.chunk.file = document.path || "<anonymous>";
	state.chunk.source = document.source || "";

	// Phase 0: Resolve imports; inline module decls (pub = exported)
	const projectRoot = process.cwd();
	const entryDir =
		document.path && document.path !== "<anonymous>"
			? path.dirname(path.resolve(projectRoot, document.path))
			: projectRoot;
	resolveImports(state, document, entryDir, projectRoot);

	// Phase 1: Register functions and compute call graph for recursion
	registerFunctions(state, document);

	// Phase 1.5: Register structs (layout) before typecheck
	for (const stmt of document.statements) {
		if (stmt.nodeName === "StructDeclaration") {
			compileStatement(state, stmt);
		}
	}

	// Phase 1.75: Gradual typecheck
	typecheck(state, document);

	// Phase 2: Compile main script statements
	// We emit a jump over the static functions
	const mainJump = emitJump(state, OpCode.OP_JUMP);

	// Compile all functions so they get an address (for dynamic calls / exports)
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

	// Top-level script is the outermost scope of the main frame
	beginScope(state);

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
	public compile(document: ast.DocumentBody, options?: CompileOptions): { chunk: Chunk, compilerState: CompilerState } {
		return compile(document, options);
	}
}
