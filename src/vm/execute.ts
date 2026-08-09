// others
import { type LLTSFunction, NativeFunction, OpCode, type Value } from "../bytecode";
import { TypeTag } from "../compiler/type-ir";
import { checkNotNull } from "../shared";
import { reportError } from "../scanner";
import { peek, pop, push } from "./stack";
import type { VMState } from "./state";

// ----------------------------------------------------------------------

function runtimeError(state: VMState, message: string): never {
	const file = state.chunk.file || "<anonymous>";
	const source = state.chunk.source || "";
	const line = state.currentLine || 1;
	reportError(file, source, line, 1, message);
	throw new Error(`RuntimeError: ${message}`);
}

function isErrorValue(state: VMState, val: Value): boolean {
	if (typeof val !== "number") return false;
	const header = state.memory[val - 1];
	return header === 0xE2202;
}

function assertValueType(state: VMState, val: Value, tag: number): boolean {
	switch (tag) {
		case TypeTag.INT:
			return typeof val === "number" && !isErrorValue(state, val);
		case TypeTag.BOOL:
			return typeof val === "boolean";
		case TypeTag.STRING:
			return typeof val === "string" || typeof val === "number";
		case TypeTag.NULL:
			return val === null;
		case TypeTag.ERROR:
			return isErrorValue(state, val);
		case TypeTag.ERROR_UNION:
			return true;
		case TypeTag.ARRAY:
		case TypeTag.STRUCT:
			return typeof val === "number";
		default:
			return true;
	}
}

export function execute(state: VMState, startIp: number = 0) {
	const chunk = state.chunk;
	let ip = startIp;
	let frame = checkNotNull(state.frames[state.frames.length - 1]);

	const readByte = () => checkNotNull(chunk.code[ip++]);
	const readShort = () => (readByte() << 8) | readByte();
	const readConstant = () => checkNotNull(chunk.constants[readByte()]);

	while (ip < chunk.code.length) {
		const op = readByte();
		switch (op) {
			case OpCode.OP_LINE: {
				state.currentLine = readShort();
				break;
			}
			case OpCode.OP_MARK_CONST: {
				const slot = readByte();
				frame.constSlots.add(slot);
				break;
			}
			case OpCode.OP_ASSERT_TYPE: {
				const tag = readByte();
				const val = peek(state, 0);
				const ok = assertValueType(state, val, tag);
				if (!ok) {
					runtimeError(
						state,
						`Type assertion failed: value does not match expected type tag ${tag}`,
					);
				}
				break;
			}
			case OpCode.OP_CONSTANT:
				push(state, readConstant());
				break;
			case OpCode.OP_NULL:
				push(state, null);
				break;
			case OpCode.OP_TRUE:
				push(state, true);
				break;
			case OpCode.OP_FALSE:
				push(state, false);
				break;
			case OpCode.OP_POP: {
				const relativeSlot = state.stack.length - 1 - frame.baseSlot;
				if (relativeSlot >= 0) {
					frame.constSlots.delete(relativeSlot);
				}
				pop(state);
				break;
			}
			case OpCode.OP_DUP:
				push(state, peek(state, 0));
				break;
			case OpCode.OP_MAKE_ERROR: {
				const msgPtr = pop(state) as number;
				const ptr = state.heap.ptr;
				state.memory[ptr] = 0xE2202; // ERROR_TAG
				state.memory[ptr + 1] = msgPtr;
				state.heap.ptr += 2;
				push(state, ptr + 1); // point to struct fields
				break;
			}
			case OpCode.OP_IS_ERROR: {
				const val = pop(state);
				let isErr = false;
				if (typeof val === "number" && val >= 1024 && val <= state.heap.ptr) {
					if (state.memory[val - 1] === 0xE2202) {
						isErr = true;
					}
				}
				push(state, isErr);
				break;
			}

			case OpCode.OP_GET_LOCAL: {
				const localSlot = readByte();
				const val = state.stack[frame.baseSlot + localSlot];
				if (val === undefined) {
					push(state, null);
				} else {
					push(state, val);
				}
				break;
			}
			case OpCode.OP_SET_LOCAL: {
				const setLocalSlot = readByte();
				if (frame.constSlots.has(setLocalSlot)) {
					runtimeError(state, "Cannot reassign to constant binding");
				}
				state.stack[frame.baseSlot + setLocalSlot] = peek(state, 0);
				break;
			}
			case OpCode.OP_GET_INDEX: {
				const index = pop(state) as number;
				const ptr = pop(state) as number;
				push(state, checkNotNull(state.memory[ptr + index]));
				break;
			}
			case OpCode.OP_SET_INDEX: {
				const value = pop(state) as number;
				const index = pop(state) as number;
				const ptr = pop(state) as number;
				state.memory[ptr + index] = value;
				push(state, value);
				break;
			}
			case OpCode.OP_GET_ARRAY: {
				const index = pop(state) as number;
				const ptr = pop(state) as number;
				const len = state.memory[ptr - 1] as number;
				if (index < 0 || index >= len) {
					runtimeError(
						state,
						`Array index out of bounds: ${index} (len ${len}); use len(arr)`,
					);
				}
				push(state, checkNotNull(state.memory[ptr + index]));
				break;
			}
			case OpCode.OP_SET_ARRAY: {
				const value = pop(state) as number;
				const index = pop(state) as number;
				const ptr = pop(state) as number;
				const len = state.memory[ptr - 1] as number;
				if (index < 0 || index >= len) {
					runtimeError(
						state,
						`Array index out of bounds: ${index} (len ${len}); use len(arr)`,
					);
				}
				state.memory[ptr + index] = value;
				push(state, value);
				break;
			}
			case OpCode.OP_GET_GLOBAL: {
				const globalName = readConstant() as string;
				if (!state.globals.has(globalName)) {
					throw new Error(`Undefined variable: ${globalName}`);
				}
				const val = state.globals.get(globalName);
				if (val === undefined) {
					throw new Error("Value is undefined");
				}
				push(state, val);
				break;
			}
			case OpCode.OP_SET_GLOBAL: {
				const setGlobalName = readConstant() as string;
				const val = state.stack[state.stack.length - 1];
				if (val === undefined) {
					throw new Error("Value is undefined");
				}
				state.globals.set(setGlobalName, val);
				break;
			}
			case OpCode.OP_GET_PROPERTY: {
				const propName = readConstant() as string;
				const obj = pop(state);
				
				if (typeof obj === "number" && obj >= 1024 && obj <= state.heap.ptr) {
					if (state.memory[obj - 1] === 0xE2202 && propName === "message") {
						const msgPtr = state.memory[obj] as number;
						push(state, msgPtr);
						break;
					}
				}
				
				const value = (obj as Record<string, Value>)[propName];

				if (value === undefined) {
					throw new Error(`Undefined property: ${propName}`);
				}

				push(state, value);
				break;
			}
			case OpCode.OP_SET_PROPERTY: {
				const setPropName = readConstant() as string;
				const setPropValue = pop(state);
				const setPropObj = pop(state) as Record<string, Value>;
				setPropObj[setPropName] = setPropValue;
				push(state, setPropValue); // assignment expression leaves value on stack
				break;
			}
			case OpCode.OP_EQUAL: {
				const bEq = pop(state);
				const aEq = pop(state);
				push(state, aEq === bEq);
				break;
			}
			case OpCode.OP_NOT_EQUAL: {
				const bNeq = pop(state);
				const aNeq = pop(state);
				push(state, aNeq !== bNeq);
				break;
			}
			case OpCode.OP_STRING_EQUAL:
			case OpCode.OP_STRING_NOT_EQUAL: {
				const bPtr = pop(state) as number;
				const aPtr = pop(state) as number;

				const aLen = state.memory[aPtr + 1] as number;
				const bLen = state.memory[bPtr + 1] as number;

				let isEqual = true;
				if (aLen !== bLen) {
					isEqual = false;
				} else {
					const aCharPtr = state.memory[aPtr] as number;
					const bCharPtr = state.memory[bPtr] as number;
					for (let i = 0; i < aLen; i++) {
						if (state.memory[aCharPtr + i] !== state.memory[bCharPtr + i]) {
							isEqual = false;
							break;
						}
					}
				}

				if (op === OpCode.OP_STRING_NOT_EQUAL) {
					push(state, !isEqual);
				} else {
					push(state, isEqual);
				}
				break;
			}
			case OpCode.OP_LESS: {
				const bLt = pop(state) as number;
				const aLt = pop(state) as number;
				push(state, aLt < bLt);
				break;
			}
			case OpCode.OP_LESS_EQUAL: {
				const bLte = pop(state) as number;
				const aLte = pop(state) as number;
				push(state, aLte <= bLte);
				break;
			}
			case OpCode.OP_GREATER: {
				const bGt = pop(state) as number;
				const aGt = pop(state) as number;
				push(state, aGt > bGt);
				break;
			}
			case OpCode.OP_GREATER_EQUAL: {
				const bGte = pop(state) as number;
				const aGte = pop(state) as number;
				push(state, aGte >= bGte);
				break;
			}
			case OpCode.OP_ADD: {
				const bAdd = pop(state) as number;
				const aAdd = pop(state) as number;
				push(state, aAdd + bAdd);
				break;
			}
			case OpCode.OP_STRING_ADD: {
				const bAdd = pop(state) as string | number;
				const aAdd = pop(state) as string | number;

				const readStr = (val: string | number): string | null => {
					if (typeof val === "string") return val;
					if (typeof val === "number" && val >= 1024 && val <= state.heap.ptr) {
						const length = state.memory[val - 1] as number;
						if (length >= 0 && length < 1000) {
							let str = "";
							let isString = true;
							for (let j = 0; j < length; j++) {
								const char = state.memory[val + j] as number;
								if (char === undefined || char < 32 || char > 126) {
									isString = false;
									break;
								}
								str += String.fromCharCode(char);
							}
							if (isString) return str;
						}
					}
					return null;
				};

				const aStr = readStr(aAdd);
				const bStr = readStr(bAdd);
				const finalStr = (aStr !== null ? aStr : String(aAdd)) + (bStr !== null ? bStr : String(bAdd));
				
				const ptr = state.heap.ptr;
				state.memory[ptr] = finalStr.length;
				for (let i = 0; i < finalStr.length; i++) {
					state.memory[ptr + 1 + i] = finalStr.charCodeAt(i);
				}
				state.heap.ptr += 1 + finalStr.length;
				push(state, ptr + 1);
				break;
			}
			case OpCode.OP_SUB: {
				const bSub = pop(state) as number;
				const aSub = pop(state) as number;
				push(state, aSub - bSub);
				break;
			}
			case OpCode.OP_MUL: {
				const bMul = pop(state) as number;
				const aMul = pop(state) as number;
				push(state, aMul * bMul);
				break;
			}
			case OpCode.OP_DIV: {
				const bDiv = pop(state) as number;
				const aDiv = pop(state) as number;
				push(state, aDiv / bDiv);
				break;
			}
			case OpCode.OP_MOD: {
				const bMod = pop(state) as number;
				const aMod = pop(state) as number;
				push(state, aMod % bMod);
				break;
			}
			case OpCode.OP_POW: {
				const bPow = pop(state) as number;
				const aPow = pop(state) as number;
				push(state, aPow ** bPow);
				break;
			}
			case OpCode.OP_NOT: {
				const val = pop(state);
				push(state, !val);
				break;
			}
			case OpCode.OP_NEGATE: {
				const num = pop(state) as number;
				push(state, -num);
				break;
			}
			case OpCode.OP_JUMP: {
				const offset = readShort();
				ip += offset;
				break;
			}
			case OpCode.OP_JUMP_IF_FALSE: {
				const jumpOffset = readShort();
				const peekVal = state.stack[state.stack.length - 1];
				if (!peekVal) {
					ip += jumpOffset;
				}
				break;
			}
			case OpCode.OP_LOOP: {
				const loopOffset = readShort();
				ip -= loopOffset;
				break;
			}
			case OpCode.OP_GET_FUNCTION: {
				const funcName = readConstant() as string;
				const func = state.chunk.functions.get(funcName);
				if (!func) {
					throw new Error(`Undefined function: ${funcName}`);
				}
				push(state, func);
				break;
			}
			case OpCode.OP_GET_MODULE: {
				const moduleName = readConstant() as string;
				const modObj: Record<string, any> = {};
				for (const [key, func] of state.chunk.functions.entries()) {
					if (key.startsWith(`${moduleName}::`)) {
						const shortName = key.substring(moduleName.length + 2);
						modObj[shortName] = func;
					}
				}
				for (const [key, func] of state.globals.entries()) {
					if (key.startsWith(`${moduleName}::`)) {
						const shortName = key.substring(moduleName.length + 2);
						modObj[shortName] = func;
					}
				}
				push(state, modObj);
				break;
			}
			case OpCode.OP_CALL: {
				const argCount = readByte();
				const callee = checkNotNull(
					state.stack[state.stack.length - 1 - argCount],
				);
				
				// Import LLTSFunction here dynamically or assume it's imported (wait, we can just use callee.address check)
				// Wait, we need to import LLTSFunction at the top of the file!
				if (callee instanceof NativeFunction) {
					const args = [];
					for (let i = 0; i < argCount; i++) {
						args.push(pop(state));
					}
					args.reverse();
					const result = callee.func(...args);
					pop(state); // pop native function
					push(state, result);
				} else if (typeof callee === "object" && callee !== null && "address" in callee && "arity" in callee) {
					// LLTSFunction
					const func = callee as LLTSFunction;
					
					// Overwrite the callee with the arguments to match OP_CALL_STATIC stack layout
					const calleeIndex = state.stack.length - 1 - argCount;
					for (let i = 0; i < argCount; i++) {
						state.stack[calleeIndex + i] = state.stack[calleeIndex + i + 1];
					}
					state.stack.pop(); // remove the duplicated last argument

					frame.returnIp = ip;
					frame = {
						returnIp: 0,
						baseSlot: state.stack.length - argCount,
						argCount,
						constSlots: new Set(),
					};
					state.frames.push(frame);
					if (state.frames.length > 256)
						runtimeError(state, "Maximum call stack size exceeded");
					ip = func.address;
				} else {
					throw new Error("Can only dynamic call NativeFunctions or LLTSFunctions.");
				}
				break;
			}
			case OpCode.OP_PACK_REST: {
				const namedParamCount = readByte();
				const restCount = frame.argCount - namedParamCount;
				if (restCount < 0) throw new Error("Not enough arguments for variadic function");
				
				const ptr = state.heap.ptr;
				state.memory[ptr] = restCount; // length
				
				for (let i = 0; i < restCount; i++) {
					state.memory[ptr + 1 + i] = state.stack[frame.baseSlot + namedParamCount + i] as number;
				}
				
				state.heap.ptr += 1 + restCount;
				
				state.stack.length = frame.baseSlot + namedParamCount;
				push(state, ptr + 1); // push array ptr (pointing to first element)
				break;
			}
			case OpCode.OP_MAKE_STRING: {
				const constantIdx = readByte();
				const str = state.chunk.constants[constantIdx] as string;

				// Allocate string on heap
				const ptr = state.heap.ptr;
				state.memory[ptr] = str.length; // Length

				for (let i = 0; i < str.length; i++) {
					state.memory[ptr + 1 + i] = str.charCodeAt(i);
				}
				state.heap.ptr += 1 + str.length;

				push(state, ptr + 1); // Pointer to first char
				break;
			}
			case OpCode.OP_CALL_STATIC: {
				const address = readShort();
				const argCount = readByte();

				frame.returnIp = ip;
				frame = {
					returnIp: 0,
					baseSlot: state.stack.length - argCount,
					argCount,
					constSlots: new Set(),
				};
				state.frames.push(frame);
				if (state.frames.length > 256)
					runtimeError(state, "Maximum call stack size exceeded");
				ip = address;
				break;
			}
			case OpCode.OP_PRINT: {
				const pArgCount = readByte();
				const args = [];
				for (let i = 0; i < pArgCount; i++) {
					args.push(pop(state));
				}
				const formattedArgs = args.reverse().map((arg) => {
					if (typeof arg === "number" && arg >= 1024 && arg <= state.heap.ptr) {
						const charPtr = arg;
						const length = state.memory[arg - 1] as number;

						if (length === 0xE2202) {
							const msgPtr = state.memory[arg] as number;
							if (msgPtr >= 1024 && msgPtr <= state.heap.ptr) {
								const msgLen = state.memory[msgPtr - 1] as number;
								let str = "";
								for (let j = 0; j < msgLen; j++) {
									str += String.fromCharCode(state.memory[msgPtr + j] as number);
								}
								return `Error: ${str}`;
							}
							return "Error: Unknown Error";
						}

						if (
							charPtr !== undefined &&
							length !== undefined &&
							charPtr >= 1 &&
							charPtr <= state.heap.ptr &&
							length >= 1 &&
							length < 10000
						) {
							let str = "";
							let isString = true;
							for (let j = 0; j < length; j++) {
								const char = state.memory[charPtr + j] as number;
								if (char === undefined || char < 32 || char > 126) {
									isString = false;
									break;
								}
								str += String.fromCharCode(char);
							}
							if (isString) return str;
						}
						// length === 0 means empty string allocation
						if (length === 0 && charPtr > 1024 && charPtr <= state.heap.ptr) {
							return "";
						}
					}
					return arg;
				});
				console.log(...formattedArgs);
				push(state, null);
				break;
			}

			case OpCode.OP_RETURN: {
				const result = pop(state);
				const poppingFrame = checkNotNull(state.frames.pop());
				state.stack.length = poppingFrame.baseSlot; // clean up args
				push(state, result);
				
				if (state.frames.length === 0) return; // End of execution
				frame = checkNotNull(state.frames[state.frames.length - 1]);
				ip = frame.returnIp;
				break;
			}
		}
	}
}
