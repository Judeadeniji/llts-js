// types
import { resolveType } from "./types";
// others
import { OpCode } from "../bytecode";
import { emitByte, emitBytes, emitConstant, emitJump, patchJump } from "./emit";
import { beginScope, endScope, resolveVariable, resolveLocal } from "./scope";
import { type CompilerState, currentChunk } from "./state";
import { compileStatement } from "./statements";
import type * as ast from "../ast";

// ----------------------------------------------------------------------

export function compileExpression(state: CompilerState, node: ast.Node) {
	switch (node.nodeName) {
		case "LiteralNode": {
			const lit = node as ast.LiteralExpression;
			if (lit.literal_type === "number") {
				emitConstant(state, parseFloat(lit.value));
			} else if (lit.literal_type === "string") {
				const idx = currentChunk(state).addConstant(lit.value);
				emitBytes(state, OpCode.OP_MAKE_STRING, idx);
			} else if (lit.literal_type === "boolean") {
				emitByte(
					state,
					lit.value === "true" ? OpCode.OP_TRUE : OpCode.OP_FALSE,
				);
			}
			break;
		}
		case "PrimaryExpression": {
			const prim = node as ast.PrimaryExpression;
			if (prim.kind === "Identifier" || prim.kind === "Register") {
				resolveVariable(state, prim.name);
			}
			break;
		}
		case "AssignmentExpression": {
			const assign = node as ast.AssignmentExpression;
			if (assign.left.nodeName === "IndexExpression") {
				const idxExpr = assign.left as ast.IndexExpression;
				compileExpression(state, idxExpr.object);
				compileExpression(state, idxExpr.index);
				compileExpression(state, assign.right);
				emitByte(state, OpCode.OP_SET_INDEX);
			} else if (assign.left.nodeName === "MemberExpression") {
				const memExpr = assign.left as ast.MemberExpression;
				const typeName = resolveType(state, memExpr.object);
				if (typeName) {
					const structDef = state.structs.get(typeName);
					if (structDef && memExpr.property.nodeName === "PrimaryExpression") {
						const propName = (memExpr.property as ast.PrimaryExpression).name;
						const offset = structDef.offsets.get(propName);
						const expectedType = structDef.types.get(propName);

						if (offset !== undefined) {
							const assignedType = resolveType(state, assign.right);
							if (
								expectedType &&
								assignedType &&
								expectedType !== assignedType
							) {
								throw new Error(
									`Type mismatch: cannot assign type '${assignedType}' to field '${propName}' of type '${expectedType}'`,
								);
							}

							compileExpression(state, memExpr.object);
							const offsetIdx = currentChunk(state).addConstant(offset);
							emitBytes(state, OpCode.OP_CONSTANT, offsetIdx);
							compileExpression(state, assign.right);
							emitByte(state, OpCode.OP_SET_INDEX);
							return;
						}
					}
				}
				compileExpression(state, memExpr.object);
				compileExpression(state, assign.right);
				if (
					memExpr.property.nodeName === "PrimaryExpression" &&
					(memExpr.property as ast.PrimaryExpression).kind === "Identifier"
				) {
					const nameIdx = currentChunk(state).addConstant(
						(memExpr.property as ast.PrimaryExpression).name,
					);
					emitBytes(state, OpCode.OP_SET_PROPERTY, nameIdx);
				}
			} else {
				compileExpression(state, assign.right);
				if (assign.left.nodeName === "PrimaryExpression") {
					const primLeft = assign.left as ast.PrimaryExpression;
					if (primLeft.kind === "Identifier" || primLeft.kind === "Register") {
						const arg = resolveLocal(state, primLeft.name);
						if (arg !== -1) {
							emitBytes(state, OpCode.OP_SET_LOCAL, arg);
						} else {
							const nameIdx = currentChunk(state).addConstant(primLeft.name);
							emitBytes(state, OpCode.OP_SET_GLOBAL, nameIdx);
						}
					}
				}
			}
			break;
		}
		case "BinaryExpression": {
			const bin = node as ast.BinaryExpression;
			if (bin.operator === "&&") {
				compileExpression(state, bin.left);
				const endJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
				emitByte(state, OpCode.OP_POP);
				compileExpression(state, bin.right);
				patchJump(state, endJump);
				return;
			}
			if (bin.operator === "||") {
				compileExpression(state, bin.left);
				const elseJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
				const endJump = emitJump(state, OpCode.OP_JUMP);
				patchJump(state, elseJump);
				emitByte(state, OpCode.OP_POP);
				compileExpression(state, bin.right);
				patchJump(state, endJump);
				return;
			}
			if (bin.operator === "|>") {
				let callArgs: ast.Node[];
				let callee: ast.Node;
				if (bin.right.nodeName === "CallExpression") {
					const rightCall = bin.right as ast.CallExpression;
					callee = rightCall.callee;
					callArgs = [bin.left, ...rightCall.args];
				} else {
					callee = bin.right;
					callArgs = [bin.left];
				}
				compileExpression(state, {
					nodeName: "CallExpression",
					callee: callee,
					args: callArgs,
				} as ast.CallExpression);
				return;
			}

			compileExpression(state, bin.left);
			compileExpression(state, bin.right);

			switch (bin.operator) {
				case "+":
					emitByte(state, OpCode.OP_ADD);
					break;
				case "-":
					emitByte(state, OpCode.OP_SUB);
					break;
				case "*":
					emitByte(state, OpCode.OP_MUL);
					break;
				case "/":
					emitByte(state, OpCode.OP_DIV);
					break;
				case "%":
					emitByte(state, OpCode.OP_MOD);
					break;
				case "**":
					emitByte(state, OpCode.OP_POW);
					break;
				case "==":
					if (
						resolveType(state, bin.left) === "string" &&
						resolveType(state, bin.right) === "string"
					) {
						emitByte(state, OpCode.OP_STRING_EQUAL);
					} else {
						emitByte(state, OpCode.OP_EQUAL);
					}
					break;
				case "!=":
					if (
						resolveType(state, bin.left) === "string" &&
						resolveType(state, bin.right) === "string"
					) {
						emitByte(state, OpCode.OP_STRING_NOT_EQUAL);
					} else {
						emitByte(state, OpCode.OP_NOT_EQUAL);
					}
					break;
				case "<":
					emitByte(state, OpCode.OP_LESS);
					break;
				case "<=":
					emitByte(state, OpCode.OP_LESS_EQUAL);
					break;
				case ">":
					emitByte(state, OpCode.OP_GREATER);
					break;
				case ">=":
					emitByte(state, OpCode.OP_GREATER_EQUAL);
					break;
			}
			break;
		}
		case "UnaryExpression": {
			const unary = node as ast.UnaryExpression;
			compileExpression(state, unary.arg);
			switch (unary.operator) {
				case "-":
					emitByte(state, OpCode.OP_NEGATE);
					break;
				case "!":
					emitByte(state, OpCode.OP_NOT);
					break;
			}
			break;
		}
		case "IndexExpression": {
			const indexExpr = node as ast.IndexExpression;
			compileExpression(state, indexExpr.object);
			compileExpression(state, indexExpr.index);
			emitByte(state, OpCode.OP_GET_INDEX);
			break;
		}
		case "StructInitialization": {
			const structInit = node as ast.StructInitialization;
			let structName = structInit.name;
			if (structName.includes(".")) {
				const parts = structName.split(".");
				const modulePath = state.globalTypes.get("$" + parts[0]);
				if (modulePath && modulePath.startsWith("module:")) {
					structName = modulePath.replace("module:", "") + "::" + parts[1];
				}
			}

			const structDef = state.structs.get(structName);
			if (!structDef)
				throw new Error(
					`Unknown struct: ${structName} (original: ${structInit.name})`,
				);

			const allocIdx = currentChunk(state).addConstant("__alloc");
			emitBytes(state, OpCode.OP_GET_GLOBAL, allocIdx);
			const sizeIdx = currentChunk(state).addConstant(structDef.size);
			emitBytes(state, OpCode.OP_CONSTANT, sizeIdx);
			emitBytes(state, OpCode.OP_CALL, 1);

			for (const field of structInit.fields) {
				const offset = structDef.offsets.get(field.name);
				const expectedType = structDef.types.get(field.name);

				if (offset === undefined)
					throw new Error(`Unknown field ${field.name}`);

				const assignedType = resolveType(state, field.value);
				if (expectedType && assignedType && expectedType !== assignedType) {
					throw new Error(
						`Type mismatch in struct initialization: cannot assign type '${assignedType}' to field '${field.name}' of type '${expectedType}'`,
					);
				}

				emitByte(state, OpCode.OP_DUP);

				const offsetIdx = currentChunk(state).addConstant(offset);
				emitBytes(state, OpCode.OP_CONSTANT, offsetIdx);

				compileExpression(state, field.value);

				emitByte(state, OpCode.OP_SET_INDEX);
				emitByte(state, OpCode.OP_POP);
			}
			break;
		}
		case "MemberExpression": {
			const mem = node as ast.MemberExpression;
			let typeName = resolveType(state, mem.object);
			if (typeName) {
				if (typeName.includes(".")) {
					const parts = typeName.split(".");
					const modulePath = state.globalTypes.get("$" + parts[0]);
					if (modulePath && modulePath.startsWith("module:")) {
						typeName = modulePath.replace("module:", "") + "::" + parts[1];
					}
				}

				const structDef = state.structs.get(typeName);
				if (structDef && mem.property.nodeName === "PrimaryExpression") {
					const offset = structDef.offsets.get(
						(mem.property as ast.PrimaryExpression).name,
					);
					if (offset !== undefined) {
						compileExpression(state, mem.object);
						const offsetIdx = currentChunk(state).addConstant(offset);
						emitBytes(state, OpCode.OP_CONSTANT, offsetIdx);
						emitByte(state, OpCode.OP_GET_INDEX);
						return;
					}
				}
			}

			compileExpression(state, mem.object);
			if (
				mem.property.nodeName === "PrimaryExpression" &&
				(mem.property as ast.PrimaryExpression).kind === "Identifier"
			) {
				const nameIdx = currentChunk(state).addConstant(
					(mem.property as ast.PrimaryExpression).name,
				);
				emitBytes(state, OpCode.OP_GET_PROPERTY, nameIdx);
			}
			break;
		}
		case "ArrayLiteral": {
			const arr = node as ast.ArrayLiteral;

			// Allocate memory for array elements
			emitBytes(
				state,
				OpCode.OP_GET_GLOBAL,
				currentChunk(state).addConstant("__alloc"),
			);
			emitBytes(
				state,
				OpCode.OP_CONSTANT,
				currentChunk(state).addConstant(arr.elements.length),
			);
			emitBytes(state, OpCode.OP_CALL, 1);

			for (let i = 0; i < arr.elements.length; i++) {
				emitByte(state, OpCode.OP_DUP);
				const offsetIdx = currentChunk(state).addConstant(i);
				emitBytes(state, OpCode.OP_CONSTANT, offsetIdx);
				compileExpression(state, arr.elements[i]);
				emitByte(state, OpCode.OP_SET_INDEX);
				emitByte(state, OpCode.OP_POP);
			}
			break;
		}
		case "CallExpression": {
			const call = node as ast.CallExpression;

			// Handle builtin print
			if (
				call.callee.nodeName === "PrimaryExpression" &&
				(call.callee as ast.PrimaryExpression).name === "print"
			) {
				for (const arg of call.args) {
					compileExpression(state, arg);
				}
				emitBytes(state, OpCode.OP_PRINT, call.args.length);
				return;
			}

			let funcName = "";
			if (call.callee.nodeName === "PrimaryExpression") {
				funcName = (call.callee as ast.PrimaryExpression).name;
			} else if (call.callee.nodeName === "MemberExpression") {
				const mem = call.callee as ast.MemberExpression;
				let typeName = resolveType(state, mem.object);
				if (typeName) {
					if (typeName.includes(".")) {
						const parts = typeName.split(".");
						const modulePath = state.globalTypes.get("$" + parts[0]);
						if (modulePath && modulePath.startsWith("module:")) {
							typeName = modulePath.replace("module:", "") + "::" + parts[1];
						}
					}
					const structDef = state.structs.get(typeName);
					if (structDef && mem.property.nodeName === "PrimaryExpression") {
						const propName = (mem.property as ast.PrimaryExpression).name;
						if (!structDef.offsets.has(propName)) {
							funcName = `${typeName}::${propName}`;
							// The first argument is the object itself (self)
							call.args.unshift(mem.object);
						}
					}
				}
			}

			if (funcName) {
				// DEBUG
				if (!state.functions.has(funcName)) {
					console.log(
						"DEBUG: funcName not found in state.functions:",
						funcName,
					);
					console.log(
						"DEBUG: Available functions:",
						Array.from(state.functions.keys()),
					);
				}
			}

			if (funcName && state.functions.has(funcName)) {
				const fnDef = state.functions.get(funcName)!;
				
				if (fnDef.hasLoop || fnDef.isRecursive || fnDef.ast.body.statements.length > 5) {
					// Static jump
					for (const arg of call.args) {
						compileExpression(state, arg);
					}
					if (fnDef.address !== undefined) {
                        
						emitBytes(state, OpCode.OP_CALL_STATIC, fnDef.address >> 8, fnDef.address & 0xff, call.args.length);
					} else {
						// Forward reference, patch later
						const { emitJump } = require("./emit");
						const patch = emitJump(state, OpCode.OP_CALL_STATIC);
						emitByte(state, call.args.length);
						// Store the patch somewhere to be resolved
						if (!fnDef.forwardJumps) fnDef.forwardJumps = [];
						fnDef.forwardJumps.push(patch);
					}
				} else {
					// Inline
					// Push arguments to stack
					for (const arg of call.args) {
						compileExpression(state, arg);
					}

					beginScope(state);

					// Bind parameters to the arguments we just pushed
					const params = fnDef.ast.params?.params || [];
					for (let i = 0; i < params.length; i++) {
						const p = params[i];
						if (p.nodeName === "DeclarationNode") {
							const decl = p as ast.DeclarationExpression;
							let pType: string | undefined;
							if (decl.type && decl.type.nodeName === "PrimaryExpression") {
								pType = (decl.type as ast.PrimaryExpression).name;
							} else if (decl.name === "self" && funcName.includes("::")) {
								pType = funcName.split("::")[0];
							}
							state.locals.push({
								name: decl.name,
								depth: state.scopeDepth,
								typeName: pType,
							});
						} else if (p.nodeName === "PrimaryExpression") {
							const prim = p as ast.PrimaryExpression;
							let pType: string | undefined;
							if (prim.name === "self" && funcName.includes("::")) {
								pType = funcName.split("::")[0];
							}
							state.locals.push({
								name: prim.name,
								depth: state.scopeDepth,
								typeName: pType,
							});
						}
					}

					state.inlineReturnJumps.push([]);

					for (const stmt of fnDef.ast.body.statements) {
						compileStatement(state, stmt);
					}

					const jumps = state.inlineReturnJumps.pop()!;
					const { patchJump } = require("./emit");
					for (const jump of jumps) {
						patchJump(state, jump);
					}

					endScope(state);
				}
			} else {
				// Dynamic call (native function)
				if (call.callee.nodeName === "MemberExpression") {
					// Was a method call but couldn't resolve, compile normally as dynamic call (won't work for user methods, only native if any)
					const mem = call.callee as ast.MemberExpression;
					compileExpression(state, mem.object);
					// we already unshifted it? No, if funcName wasn't resolved, it didn't unshift. Wait, the unshift is inside `if (!structDef.offsets.has(propName))`.
					// But if it wasn't a method, it compiles as normal expression.
					// Actually let's just compile the callee.
				}

				// If it was a failed method resolution, the callee AST still exists unchanged (except if we unshifted args, let's remove it if we did)
				if (
					funcName?.includes("::") &&
					call.args[0] === (call.callee as ast.MemberExpression).object
				) {
					call.args.shift();
				}

				compileExpression(state, call.callee);
				for (const arg of call.args) {
					compileExpression(state, arg);
				}
				emitBytes(state, OpCode.OP_CALL, call.args.length);
			}
			break;
		}
		case "ImportNode": {
			const importNode = node as ast.ImportNode;
			let importPath = importNode.importPath;
			if (importPath === "std") {
				importPath = "std/index.lls";
			} else if (!importPath.endsWith(".lls")) {
				importPath += ".lls";
			}
			const fullPath = require("path").resolve(process.cwd(), importPath);
			if (require("fs").existsSync(fullPath)) {
				const source = require("fs").readFileSync(fullPath, "utf-8");
				const parser = new (require("../parser").Parser)();
				const doc = parser.parse(source, fullPath);
				for (const stmt of doc.statements) {
					if (stmt.nodeName === "StructDeclaration") {
						const structDecl = stmt as ast.StructDeclaration;
						if (structDecl.isPublic) {
							const origName = structDecl.name;
							structDecl.name = `${importNode.importPath}::${origName}`;

							const currentSize = currentChunk(state).code.length;
							compileStatement(state, structDecl);
							currentChunk(state).code.length = currentSize;

							structDecl.name = origName;
						}
					} else if (stmt.nodeName === "ImportNode") {
						const currentSize = currentChunk(state).code.length;
						compileStatement(state, stmt);
						currentChunk(state).code.length = currentSize;
					}
				}
			}

			const nameIdx = currentChunk(state).addConstant(importNode.importPath);
			emitBytes(state, OpCode.OP_IMPORT, nameIdx);
			break;
		}
	}
}
