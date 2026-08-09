// types
import { resolveType } from "./types";
// others
import { OpCode } from "../bytecode";
import { checkNotNull } from "../shared";
import { emitByte, emitBytes, emitConstant, emitJump, patchJump } from "./emit";
import { beginScope, endScope, resolveLocal, resolveVariable } from "./scope";
import { type CompilerState, currentChunk } from "./state";
import { compileStatement } from "./statements";
import type * as ast from "../ast";

// ----------------------------------------------------------------------

export function tryResolveStaticPath(state: CompilerState, node: ast.Node): string | undefined {
	if (node.nodeName === "PrimaryExpression") {
		const prim = node as ast.PrimaryExpression;
		if (prim.kind === "Identifier") {
			const mod = state.globalTypes.get(`$${prim.name}`);
			if (mod?.startsWith("module:")) return mod.replace("module:", "");
		}
	} else if (node.nodeName === "MemberExpression") {
		const mem = node as ast.MemberExpression;
		const objPath = tryResolveStaticPath(state, mem.object);
		if (objPath) {
			const prop = (mem.property as ast.PrimaryExpression).name;
			const reExport = state.globalTypes.get(`$${objPath}::${prop}`);
			if (reExport?.startsWith("module:")) return reExport.replace("module:", "");
			return `${objPath}::${prop}`;
		}
	}
	return undefined;
}

// ----------------------------------------------------------------------

export function compileExpression(state: CompilerState, node: ast.Node) {
	switch (node.nodeName) {
		case "LiteralNode": {
			const lit = node as ast.LiteralExpression;
			if (lit.literal_type === "number") {
				emitConstant(state, parseFloat(lit.value));
			} else if (lit.literal_type === "hex") {
				emitConstant(state, parseInt(lit.value.slice(2), 16));
			} else if (lit.literal_type === "binary") {
				emitConstant(state, parseInt(lit.value.slice(2), 2));
			} else if (lit.literal_type === "octal") {
				emitConstant(state, parseInt(lit.value.slice(2), 8));
			} else if (lit.literal_type === "string") {
				const idx = currentChunk(state).addConstant(lit.value);
				emitBytes(state, OpCode.OP_MAKE_STRING, idx);
			} else if (lit.literal_type === "boolean") {
				emitByte(
					state,
					lit.value === "true" ? OpCode.OP_TRUE : OpCode.OP_FALSE,
				);
			} else if (lit.literal_type === "null") {
				emitByte(state, OpCode.OP_NULL);
			}
			break;
		}
		case "PrimaryExpression": {
			const prim = node as ast.PrimaryExpression;
			if (prim.kind === "Identifier" || prim.kind === "Register") {
				const staticPath = tryResolveStaticPath(state, node);
				if (staticPath) {
					const nameIdx = currentChunk(state).addConstant(staticPath);
					if (state.functions.has(staticPath)) {
						emitBytes(state, OpCode.OP_GET_FUNCTION, nameIdx);
					} else if (staticPath.endsWith(".lls")) {
						emitBytes(state, OpCode.OP_GET_MODULE, nameIdx);
					} else {
						emitBytes(state, OpCode.OP_GET_GLOBAL, nameIdx);
					}
					break;
				}
				resolveVariable(state, prim.name);
			}
			break;
		}
		case "AssignmentExpression": {
			const assign = node as ast.AssignmentExpression;

			// Map compound operator → arithmetic opcode (undefined = plain =)
			const compoundOp: Record<string, OpCode | undefined> = {
				"+=": OpCode.OP_ADD,
				"-=": OpCode.OP_SUB,
				"*=": OpCode.OP_MUL,
				"/=": OpCode.OP_DIV,
				"%=": OpCode.OP_MOD,
			};
			const arithOp = compoundOp[assign.operator];

			if (assign.left.nodeName === "IndexExpression") {
				// arr[idx] = rhs  or  arr[idx] op= rhs
				const idxExpr = assign.left as ast.IndexExpression;
				// Pattern for SET_INDEX: [obj, idx, val] → val
				// For compound: val = arr[idx] op rhs
				// Emit: obj, idx, (obj[idx] op rhs) but we need obj+idx before the value.
				// Since object/index are side-effect-free, double-emit is safe.
				if (arithOp !== undefined) {
					// [obj, idx, (GET(obj,idx) op rhs)]
					compileExpression(state, idxExpr.object); // obj
					compileExpression(state, idxExpr.index);  // obj, idx
					// compute new value on top separately, then we need to re-push obj+idx
					// Use the safe double-emit pattern:
					compileExpression(state, idxExpr.object); // obj, idx, obj2
					compileExpression(state, idxExpr.index);  // obj, idx, obj2, idx2
					emitByte(state, OpCode.OP_GET_INDEX);      // obj, idx, currentVal
					compileExpression(state, assign.right);    // obj, idx, currentVal, rhs
					emitByte(state, arithOp);                  // obj, idx, newVal
				} else {
					compileExpression(state, idxExpr.object);
					compileExpression(state, idxExpr.index);
					compileExpression(state, assign.right);
				}
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
							if (expectedType && assignedType && expectedType !== assignedType) {
								throw new Error(
									`Type mismatch: cannot assign type '${assignedType}' to field '${propName}' of type '${expectedType}'`,
								);
							}

							if (arithOp !== undefined) {
								// Struct field compound: [obj, offset, (obj[offset] op rhs)] → SET_INDEX
								// obj and offset are side-effect-free — double-emit is safe.
								compileExpression(state, memExpr.object);           // obj
								const oi0 = currentChunk(state).addConstant(offset);
								emitBytes(state, OpCode.OP_CONSTANT, oi0);          // obj, offset
								compileExpression(state, memExpr.object);           // obj, offset, obj2
								const oi1 = currentChunk(state).addConstant(offset);
								emitBytes(state, OpCode.OP_CONSTANT, oi1);          // obj, offset, obj2, offset2
								emitByte(state, OpCode.OP_GET_INDEX);               // obj, offset, currentVal
								compileExpression(state, assign.right);             // obj, offset, currentVal, rhs
								emitByte(state, arithOp);                           // obj, offset, newVal
							} else {
								compileExpression(state, memExpr.object);
								const oi = currentChunk(state).addConstant(offset);
								emitBytes(state, OpCode.OP_CONSTANT, oi);
								compileExpression(state, assign.right);
							}
							emitByte(state, OpCode.OP_SET_INDEX);
							return;
						}
					}
				}

				// Dynamic property assignment: obj.prop = rhs  or  obj.prop op= rhs
				if (
					memExpr.property.nodeName === "PrimaryExpression" &&
					(memExpr.property as ast.PrimaryExpression).kind === "Identifier"
				) {
					const propName = (memExpr.property as ast.PrimaryExpression).name;
					if (arithOp !== undefined) {
						// obj.prop op= rhs
						// Stack pattern using DUP: [obj, obj] → GET_PROP → [obj, currentVal] → rhs → arithOp → [obj, newVal] → SET_PROP
						compileExpression(state, memExpr.object); // obj
						emitByte(state, OpCode.OP_DUP);           // obj, obj
						const getIdx = currentChunk(state).addConstant(propName);
						emitBytes(state, OpCode.OP_GET_PROPERTY, getIdx); // obj, currentVal
						compileExpression(state, assign.right);   // obj, currentVal, rhs
						emitByte(state, arithOp);                 // obj, newVal
					} else {
						compileExpression(state, memExpr.object); // obj
						compileExpression(state, assign.right);   // obj, rhs
					}
					const setIdx = currentChunk(state).addConstant(propName);
					emitBytes(state, OpCode.OP_SET_PROPERTY, setIdx);
				}

			} else if (assign.left.nodeName === "PrimaryExpression") {
				// Variable assignment: $a = rhs  or  a op= rhs
				const primLeft = assign.left as ast.PrimaryExpression;
				if (primLeft.kind === "Identifier" || primLeft.kind === "Register") {
					const name = primLeft.name;
					const localArg = resolveLocal(state, name);
					const isConst = localArg !== -1 ? !!state.locals[localArg]?.isConst : state.globalConsts.has(name);
					if (isConst) {
						throw new Error(`CompileError: Cannot reassign to constant variable '${name}'`);
					}

					if (arithOp !== undefined) {
						resolveVariable(state, primLeft.name); // push current value
						compileExpression(state, assign.right);
						emitByte(state, arithOp);
					} else {
						compileExpression(state, assign.right);
					}
					const arg = resolveLocal(state, primLeft.name);
					if (arg !== -1) {
						emitBytes(state, OpCode.OP_SET_LOCAL, arg);
					} else {
						const nameIdx = currentChunk(state).addConstant(primLeft.name);
						emitBytes(state, OpCode.OP_SET_GLOBAL, nameIdx);
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
				case "+": {
					const lType = resolveType(state, bin.left);
					const rType = resolveType(state, bin.right);
					if (lType === "string" || rType === "string") {
						emitByte(state, OpCode.OP_STRING_ADD);
					} else {
						emitByte(state, OpCode.OP_ADD);
					}
					break;
				}
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
				case "^":
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
				const modulePath = state.globalTypes.get(`$${parts[0]}`);
				if (modulePath?.startsWith("module:")) {
					structName = `${modulePath.replace("module:", "")}::${parts[1]}`;
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
			
			const staticPath = tryResolveStaticPath(state, node);
			if (staticPath) {
				if (staticPath.includes("::") && !state.functions.has(staticPath) && !state.globalVars.has(staticPath) && !state.globalConsts.has(staticPath) && !state.structs.has(staticPath) && !state.nativeGlobals.has(staticPath)) {
					const modName = mem.object.nodeName === "PrimaryExpression" ? (mem.object as ast.PrimaryExpression).name : "Module";
					const propName = mem.property.nodeName === "PrimaryExpression" ? (mem.property as ast.PrimaryExpression).name : "property";
					throw new Error(`CompileError: '${modName}' has no function '${propName}'`);
				}
				const nameIdx = currentChunk(state).addConstant(staticPath);
				if (state.functions.has(staticPath)) {
					emitBytes(state, OpCode.OP_GET_FUNCTION, nameIdx);
				} else if (staticPath.endsWith(".lls")) {
					emitBytes(state, OpCode.OP_GET_MODULE, nameIdx);
				} else {
					emitBytes(state, OpCode.OP_GET_GLOBAL, nameIdx);
				}
				break;
			}
			
			let typeName = resolveType(state, mem.object);
			if (typeName) {
				if (typeName.includes(".")) {
					const parts = typeName.split(".");
					const modulePath = state.globalTypes.get(`$${parts[0]}`);
					if (modulePath?.startsWith("module:")) {
						typeName = `${modulePath.replace("module:", "")}::${parts[1]}`;
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
			const length = arr.elements.length;

			// Allocate memory for array elements + 1 for length
			emitBytes(state, OpCode.OP_GET_GLOBAL, currentChunk(state).addConstant("__alloc"));
			emitBytes(state, OpCode.OP_CONSTANT, currentChunk(state).addConstant(length + 1));
			emitBytes(state, OpCode.OP_CALL, 1);

			// ptr is on stack.
			// write length to ptr[0]
			emitByte(state, OpCode.OP_DUP);
			emitBytes(state, OpCode.OP_CONSTANT, currentChunk(state).addConstant(0));
			emitBytes(state, OpCode.OP_CONSTANT, currentChunk(state).addConstant(length));
			emitByte(state, OpCode.OP_SET_INDEX);
			emitByte(state, OpCode.OP_POP);

			// add 1 to ptr so it points to the first element
			emitBytes(state, OpCode.OP_CONSTANT, currentChunk(state).addConstant(1));
			emitByte(state, OpCode.OP_ADD);

			for (let i = 0; i < length; i++) {
				emitByte(state, OpCode.OP_DUP); // [base, base]
				const offsetIdx = currentChunk(state).addConstant(i);
				emitBytes(state, OpCode.OP_CONSTANT, offsetIdx); // [base, base, i]
				compileExpression(state, checkNotNull(arr.elements[i])); // [base, base, i, val]
				emitByte(state, OpCode.OP_SET_INDEX); // [base, val]
				emitByte(state, OpCode.OP_POP); // [base]
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
			// Handle builtin @isError
			if (
				call.callee.nodeName === "PrimaryExpression" &&
				(call.callee as ast.PrimaryExpression).name === "@isError"
			) {
				if (call.args.length !== 1) {
					throw new Error("@isError expects exactly 1 argument");
				}
				compileExpression(state, call.args[0] as ast.Node);
				emitByte(state, OpCode.OP_IS_ERROR);
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
						const modulePath = state.globalTypes.get(`$${parts[0]}`);
						if (modulePath?.startsWith("module:")) {
							typeName = `${modulePath.replace("module:", "")}::${parts[1]}`;
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

			if (!funcName) {
				const staticPath = tryResolveStaticPath(state, call.callee);
				if (staticPath) {
					funcName = staticPath;
				}
			}

			if (funcName && state.functions.has(funcName) && checkNotNull(state.functions.get(funcName)).ast.body.statements.length > 0) {
				const fnDef = checkNotNull(state.functions.get(funcName));

				// Variadic functions must use CALL_STATIC so OP_PACK_REST can
				// collapse trailing args into the rest local at runtime.
				if (
					fnDef.ast.params?.isVariadic ||
					fnDef.hasLoop ||
					fnDef.isRecursive ||
					fnDef.ast.body.statements.length > 5 ||
					fnDef.hasReturn
				) {
					// Static jump
					for (const arg of call.args) {
						compileExpression(state, arg);
					}
					if (fnDef.address !== undefined) {
						emitBytes(
							state,
							OpCode.OP_CALL_STATIC,
							fnDef.address >> 8,
							fnDef.address & 0xff,
							call.args.length,
						);
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
					// Push arguments to stack
					for (const arg of call.args) {
						compileExpression(state, arg);
					}
					
					const params = fnDef.ast.params?.params || [];
					const missingArgs = params.length - call.args.length;
					for (let i = 0; i < missingArgs; i++) {
						emitByte(state, OpCode.OP_NULL);
					}

					beginScope(state);

					// Bind parameters to the arguments we just pushed
					for (let i = 0; i < params.length; i++) {
						const p = params[i];
						if (checkNotNull(p).nodeName === "DeclarationNode") {
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
						} else if (checkNotNull(p).nodeName === "PrimaryExpression") {
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

					endScope(state);
					emitByte(state, OpCode.OP_NULL);

					const jumps = checkNotNull(state.inlineReturnJumps.pop());
					const { patchJump } = require("./emit");
					for (const jump of jumps) {
						patchJump(state, jump);
					}
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
		case "ErrorExpression": {
			const errorExpr = node as any; // ast.ErrorExpression
			compileExpression(state, errorExpr.message);
			emitByte(state, OpCode.OP_MAKE_ERROR);
			break;
		}
		case "TryExpression": {
			const tryExpr = node as any; // ast.TryExpression
			const typeName = resolveType(state, tryExpr.expression);
			if (typeName && !typeName.includes("error")) {
				throw new Error(`CompileError: '?' operator used on non-error-union type '${typeName}'`);
			}
			compileExpression(state, tryExpr.expression);
			// Stack: [value]
			emitByte(state, OpCode.OP_DUP); // [value, value]
			emitByte(state, OpCode.OP_IS_ERROR); // [value, isError]
			const skipRet = emitJump(state, OpCode.OP_JUMP_IF_FALSE); // jumps if isError is false
			
			// --- If we are here, isError was TRUE. ---
			emitByte(state, OpCode.OP_POP); // pop the true
			emitByte(state, OpCode.OP_RETURN); // return the error value
			
			// --- If we jumped, isError was FALSE. ---
			patchJump(state, skipRet);
			emitByte(state, OpCode.OP_POP); // pop the false, leaving the value
			break;
		}
		case "ImportNode": {
			// Handled at compile time during module resolution phase
			break;
		}
	}
}
