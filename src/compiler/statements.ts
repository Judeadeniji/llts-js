// others
import { OpCode } from "../bytecode";
import { checkNotNull } from "../shared";
import {
	emitByte,
	emitBytes,
	emitConstant,
	emitJump,
	emitLineIfNeeded,
	emitLoop,
	patchJump,
} from "./emit";
import { compileExpression } from "./expressions";
import { typeAstToDisplay, typeFromAst } from "./type-from-ast";
import { typeTag } from "./type-ir";
import { beginScope, endScope } from "./scope";
import { type CompilerState, currentChunk } from "./state";
import * as ast from "../ast";

// ----------------------------------------------------------------------

export function compileStatement(state: CompilerState, node: ast.Node) {
	emitLineIfNeeded(state, node.loc?.line);
	switch (node.nodeName) {
		case "FunctionDeclaration": {
			compileFunction(state, node as ast.FunctionDeclaration);
			break;
		}
		case "DeclarationNode": {
			const decl = node as ast.DeclarationExpression;
			if (decl.value.nodeName === "ImportNode") {
				// Handled in phase 0 resolveImports
				break;
			}
			compileExpression(state, decl.value);

			let typeName: string | undefined;
			if (decl.type) {
				typeName = typeAstToDisplay(decl.type);
				if (state.debug) {
					const tag = typeTag(typeFromAst(decl.type));
					if (tag !== null) {
						emitBytes(state, OpCode.OP_ASSERT_TYPE, tag);
					}
				}
			} else {
				switch (decl.value.nodeName) {
					case "StructInitialization":
						typeName = (decl.value as ast.StructInitialization).name;
						break;
					case "LiteralNode": {
						const lit = decl.value as ast.LiteralExpression;
						if (lit.literal_type === "string") {
							typeName = `[${lit.value.length}]byte`;
						}
						break;
					}
					case "ArrayLiteral": {
						const arr = decl.value as ast.ArrayLiteral;
						typeName = `[${arr.elements.length}]unknown`;
						break;
					}
				}
			}

			// Scope-first: user bindings live in the current scope (top-level = outer script scope).
			// Module-qualified public exports (`path::name`) stay globals for static module lookup.
			const isModuleExport = decl.name.includes("::");
			if (state.scopeDepth > 0 && !isModuleExport) {
				for (let i = state.locals.length - 1; i >= 0; i--) {
					const local = state.locals[i];
					if (local.depth < state.scopeDepth) break;
					if (local.name === decl.name) {
						throw new Error(`CompileError: Variable '${decl.name}' already declared in this scope`);
					}
				}
				state.locals.push({
					name: decl.name,
					depth: state.scopeDepth,
					typeName,
					isConst: decl.isConst,
				});
				if (decl.isConst) {
					emitBytes(state, OpCode.OP_MARK_CONST, state.locals.length - 1);
				}
			} else {
				if (state.globalVars.has(decl.name)) {
					throw new Error(`CompileError: Variable '${decl.name}' already declared in this scope`);
				}
				state.globalVars.add(decl.name);
				if (typeName) {
					state.globalTypes.set(decl.name, typeName);
				}
				if (decl.isConst) {
					state.globalConsts.add(decl.name);
				}
				const nameIdx = currentChunk(state).addConstant(decl.name);
				emitBytes(state, OpCode.OP_SET_GLOBAL, nameIdx);
				emitByte(state, OpCode.OP_POP);
			}
			break;
		}
		case "ExternDeclaration": {
			const ext = node as ast.ExternDeclaration;
			// Register so the compiler knows this name is valid at runtime (provided natively)
			state.nativeGlobals.add(ext.name);
			// No code emitted — the VM provides the value via globals
			break;
		}
		case "BlockExpression": {
			const block = node as ast.BlockExpression;
			beginScope(state);
			for (const stmt of block.statements) {
				compileStatement(state, stmt);
			}
			endScope(state);
			break;
		}
		case "ReturnExpression": {
			const ret = node as ast.ReturnExpression;
			if (ret.returnValue) {
				compileExpression(state, ret.returnValue);
			} else {
				emitByte(state, OpCode.OP_NULL);
			}
			if (state.inlineReturnJumps.length > 0) {
				const patch = emitJump(state, OpCode.OP_JUMP);
				checkNotNull(
					state.inlineReturnJumps[state.inlineReturnJumps.length - 1],
				).push(patch);
			} else {
				emitByte(state, OpCode.OP_RETURN);
			}
			break;
		}
		case "StructDeclaration": {
			const structDecl = node as ast.StructDeclaration;
			const offsets = new Map<string, number>();
			const types = new Map<string, string>();
			let size = 0;

			for (const field of structDecl.fields) {
				offsets.set(field.name, size++);
				if (field.type) {
					types.set(field.name, typeAstToDisplay(field.type) ?? "unknown");
				}
			}

			state.structs.set(structDecl.name, {
				name: structDecl.name,
				size,
				offsets,
				types,
			});
			break;
		}
		case "IfExpression": {
			const ifExpr = node as ast.IfExpression;
			compileExpression(state, ifExpr.condition);
			const thenJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
			emitByte(state, OpCode.OP_POP);
			beginScope(state);
			for (const stmt of ifExpr.body.statements) {
				compileStatement(state, stmt);
			}
			endScope(state);
			if (ifExpr.elseBody) {
				const elseJump = emitJump(state, OpCode.OP_JUMP);
				patchJump(state, thenJump);
				emitByte(state, OpCode.OP_POP);
				if (ifExpr.elseBody.nodeName === "BlockExpression") {
					beginScope(state);
					for (const stmt of (ifExpr.elseBody as ast.BlockExpression)
						.statements) {
						compileStatement(state, stmt);
					}
					endScope(state);
				} else if (ifExpr.elseBody.nodeName === "IfExpression") {
					compileStatement(state, ifExpr.elseBody);
				}
				patchJump(state, elseJump);
			} else {
				const skipPop = emitJump(state, OpCode.OP_JUMP);
				patchJump(state, thenJump);
				emitByte(state, OpCode.OP_POP);
				patchJump(state, skipPop);
			}
			break;
		}
		case "ForExpression": {
			const forExpr = node as ast.ForExpression;
			beginScope(state);

			// Loop tracking
			state.loops.push({
				label: forExpr.label,
				breakJumps: [],
				continueJumps: [],
			});

			if (forExpr.kind === "condition") {
				const loopStart = currentChunk(state).code.length;
				let exitJump = -1;

				let isInfinite = false;
				if (
					forExpr.condition instanceof ast.LiteralExpression &&
					String(forExpr.condition.value) === "true"
				) {
					isInfinite = true;
				}

				if (!isInfinite && forExpr.condition) {
					compileExpression(state, forExpr.condition);
					exitJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
					emitByte(state, OpCode.OP_POP);
				}

				beginScope(state);
				for (const stmt of forExpr.body.statements) {
					compileStatement(state, stmt);
				}
				endScope(state);

				const loop = checkNotNull(state.loops.pop());
				for (const continueJump of loop.continueJumps) {
					patchJump(state, continueJump);
				}

				emitLoop(state, loopStart);

				if (exitJump !== -1) {
					patchJump(state, exitJump);
					emitByte(state, OpCode.OP_POP);
				}
				for (const breakJump of loop.breakJumps) {
					patchJump(state, breakJump);
				}
			} else if (forExpr.kind === "range") {
				if (!forExpr.rangeStart || !forExpr.rangeEnd) {
					throw new Error("Range loops must have a start and end.");
				}

				compileExpression(state, forExpr.rangeStart);
				const captureName = checkNotNull(forExpr.captures[0]).name;
				state.locals.push({ name: captureName, depth: state.scopeDepth, isConst: true });
				const iIndex = state.locals.length - 1;

				compileExpression(state, forExpr.rangeEnd);
				state.locals.push({ name: ".range_end", depth: state.scopeDepth });
				const endIndex = state.locals.length - 1;

				const loopStart = currentChunk(state).code.length;

				emitByte(state, OpCode.OP_GET_LOCAL);
				emitByte(state, iIndex);
				emitByte(state, OpCode.OP_GET_LOCAL);
				emitByte(state, endIndex);
				emitByte(state, OpCode.OP_LESS);

				const exitJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
				emitByte(state, OpCode.OP_POP);

				beginScope(state);
				for (const stmt of forExpr.body.statements) {
					compileStatement(state, stmt);
				}
				endScope(state);

				const loop = checkNotNull(state.loops.pop());
				for (const continueJump of loop.continueJumps) {
					patchJump(state, continueJump);
				}

				emitByte(state, OpCode.OP_GET_LOCAL);
				emitByte(state, iIndex);

				emitConstant(state, 1);

				emitByte(state, OpCode.OP_ADD);
				emitByte(state, OpCode.OP_SET_LOCAL);
				emitByte(state, iIndex);
				emitByte(state, OpCode.OP_POP);

				emitLoop(state, loopStart);

				patchJump(state, exitJump);
				emitByte(state, OpCode.OP_POP);

				for (const breakJump of loop.breakJumps) {
					patchJump(state, breakJump);
				}
			} else if (forExpr.kind === "iterable") {
				// Evaluate iterable and push to stack
				compileExpression(state, checkNotNull(forExpr.iterable));
				
				// Create a hidden local variable for the iterable pointer
				const iterableIdx = state.locals.length;
				state.locals.push({
					name: ".iterable",
					depth: state.scopeDepth,
				});

				// Create a hidden local variable for the loop counter
				const iIndex = state.locals.length;
				state.locals.push({
					name: ".i",
					depth: state.scopeDepth,
				});
				emitConstant(state, 0);

				const loopStart = currentChunk(state).code.length;

				// Condition: .i < len(iterable)
				emitByte(state, OpCode.OP_GET_LOCAL);
				emitByte(state, iIndex);

				emitBytes(
					state,
					OpCode.OP_GET_GLOBAL,
					currentChunk(state).addConstant("len"),
				);
				emitByte(state, OpCode.OP_GET_LOCAL);
				emitByte(state, iterableIdx);
				emitBytes(state, OpCode.OP_CALL, 1);

				emitByte(state, OpCode.OP_LESS);

				const exitJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
				emitByte(state, OpCode.OP_POP);

				// Body scope
				beginScope(state);

				// Capture variables
				// arr[.i]
				emitByte(state, OpCode.OP_GET_LOCAL);
				emitByte(state, iterableIdx);
				emitByte(state, OpCode.OP_GET_LOCAL);
				emitByte(state, iIndex);
				emitByte(state, OpCode.OP_GET_INDEX);

				state.locals.push({
					name: forExpr.captures[0].name,
					depth: state.scopeDepth,
				});

				// Optional index capture
				if (forExpr.captures.length > 1) {
					emitByte(state, OpCode.OP_GET_LOCAL);
					emitByte(state, iIndex);
					state.locals.push({
						name: forExpr.captures[1].name,
						depth: state.scopeDepth,
					});
				}

				const loop = { breakJumps: [], continueJumps: [], label: forExpr.label };
				state.loops.push(loop);

				for (const stmt of forExpr.body.statements) {
					compileStatement(state, stmt);
				}
				endScope(state); // Pops captured variables

				checkNotNull(state.loops.pop());
				for (const continueJump of loop.continueJumps) {
					patchJump(state, continueJump);
				}

				// .i = .i + 1
				emitByte(state, OpCode.OP_GET_LOCAL);
				emitByte(state, iIndex);
				emitConstant(state, 1);
				emitByte(state, OpCode.OP_ADD);
				emitByte(state, OpCode.OP_SET_LOCAL);
				emitByte(state, iIndex);
				emitByte(state, OpCode.OP_POP);

				emitLoop(state, loopStart);

				patchJump(state, exitJump);
				emitByte(state, OpCode.OP_POP);

				for (const breakJump of loop.breakJumps) {
					patchJump(state, breakJump);
				}

				// .iterable and .i are popped by the outer endScope
			}

			endScope(state);
			break;
		}
		case "BreakExpression": {
			if (state.loops.length === 0) {
				throw new Error("Cannot break outside of a loop");
			}
			const breakExpr = node as ast.BreakExpression;
			let targetLoop = checkNotNull(state.loops[state.loops.length - 1]);
			if (breakExpr.label) {
				targetLoop =
					state.loops.find((l) => l.label === breakExpr.label) || targetLoop;
				if (targetLoop.label !== breakExpr.label) {
					throw new Error(
						`Cannot find loop with label '${breakExpr.label}' to break from.`,
					);
				}
			}
			const jump = emitJump(state, OpCode.OP_JUMP);
			targetLoop.breakJumps.push(jump);
			break;
		}
		case "ContinueExpression": {
			if (state.loops.length === 0) {
				throw new Error("Cannot continue outside of a loop");
			}
			const continueExpr = node as ast.ContinueExpression;
			let targetLoop = checkNotNull(state.loops[state.loops.length - 1]);
			if (continueExpr.label) {
				targetLoop =
					state.loops.find((l) => l.label === continueExpr.label) || targetLoop;
				if (targetLoop.label !== continueExpr.label) {
					throw new Error(
						`Cannot find loop with label '${continueExpr.label}' to continue from.`,
					);
				}
			}
			const jump = emitJump(state, OpCode.OP_JUMP);
			targetLoop.continueJumps.push(jump);
			break;
		}
		default: {
			compileExpression(state, node);
			emitByte(state, OpCode.OP_POP);
			break;
		}
	}
}

export function compileFunction(
	state: CompilerState,
	node: ast.FunctionDeclaration,
) {
	const outerLocals = state.locals;
	const outerScopeDepth = state.scopeDepth;
	// We do NOT clear locals, because in a flat chunk, they might conflict?
	// Wait, the VM uses baseSlot. So local variables at runtime will be at `baseSlot + index`.
	// But at compile time, if we clear `state.locals`, the compiler will assign `localSlot = 0, 1, 2...`
	// And the VM will read `state.stack[frame.baseSlot + 0]`. This perfectly aligns!
	// So YES, we MUST clear state.locals!
	state.locals = [];
	state.scopeDepth = 0;

	beginScope(state);
	let methodStruct: string | undefined;
	if (node.name.includes("::")) {
		methodStruct = node.name.split("::")[0];
	}

	const params = node.params?.params || [];
	if (node.params?.isVariadic) {
		emitBytes(state, OpCode.OP_PACK_REST, params.length - 1);
	}
	
	for (const p of params) {
		switch (p.nodeName) {
			case "DeclarationNode": {
				const decl = p as ast.DeclarationExpression;
				let pType: string | undefined;
				if (decl.name === "self" && methodStruct) {
					pType = methodStruct;
				} else if (decl.type && decl.type.nodeName === "PrimaryExpression") {
					pType = (decl.type as ast.PrimaryExpression).name;
				}
				state.locals.push({
					name: decl.name,
					depth: state.scopeDepth,
					typeName: pType,
				});
				break;
			}
			case "PrimaryExpression": {
				const prim = p as ast.PrimaryExpression;
				let pType: string | undefined;
				if (
					prim.kind === "Identifier" &&
					prim.name === "self" &&
					methodStruct
				) {
					pType = methodStruct;
				}
				state.locals.push({
					name: prim.name,
					depth: state.scopeDepth,
					typeName: pType,
				});
				break;
			}
		}
	}

	for (const stmt of node.body.statements) {
		compileStatement(state, stmt);
	}

	emitByte(state, OpCode.OP_NULL);
	emitByte(state, OpCode.OP_RETURN);

	state.locals = outerLocals;
	state.scopeDepth = outerScopeDepth;
	// We no longer push a FunctionObj onto the stack or create a new chunk!
}
