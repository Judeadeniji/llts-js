import { OpCode, FunctionObj, NativeFunction, type Value } from "../bytecode";
import { type VMState, CallFrame } from "./state";
import { push, pop, peek } from "./stack";
import fs from "node:fs";
import path from "node:path";
import { Parser } from "../parser";
import { compile } from "../compiler/index";
import { run } from "./index";

export function execute(state: VMState) {
    while (state.frames.length > 0) {
        const frame = state.frames[state.frames.length - 1]!;
        const chunk = frame.func.chunk;
        
        const readByte = () => chunk.code[frame.ip++]!;
        const readShort = () => (readByte() << 8) | readByte();
        const readConstant = () => chunk.constants[readByte()]!;
        
        const instruction = readByte();
        
        switch (instruction) {
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
            case OpCode.OP_POP:
                pop(state);
                break;
            case OpCode.OP_DUP:
                push(state, peek(state, 0));
                break;
            case OpCode.OP_MAKE_STRING: {
                const strIdx = readByte();
                const str = chunk.constants[strIdx] as string;
                const charPtr = state.heapPointer;
                state.heapPointer += str.length;
                for (let i = 0; i < str.length; i++) {
                    state.memory[charPtr + i] = str.charCodeAt(i);
                }
                const structPtr = state.heapPointer;
                state.heapPointer += 2;
                state.memory[structPtr] = charPtr;
                state.memory[structPtr + 1] = str.length;
                push(state, structPtr);
                break;
            }
            case OpCode.OP_GET_LOCAL:
                const localSlot = readByte();
                push(state, state.stack[frame.baseSlot + localSlot]!);
                break;
            case OpCode.OP_SET_LOCAL:
                const setLocalSlot = readByte();
                state.stack[frame.baseSlot + setLocalSlot] = peek(state, 0);
                break;
            case OpCode.OP_GET_INDEX: {
                const index = pop(state) as number;
                const ptr = pop(state) as number;
                push(state, state.memory[ptr + index]!);
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
            case OpCode.OP_GET_GLOBAL:
                const globalName = readConstant() as string;
                if (!state.globals.has(globalName)) {
                    throw new Error(`Undefined variable: ${globalName}`);
                }
                push(state, state.globals.get(globalName)!);
                break;
            case OpCode.OP_SET_GLOBAL:
                const setGlobalName = readConstant() as string;
                state.globals.set(setGlobalName, state.stack[state.stack.length - 1]!);
                break;
            case OpCode.OP_GET_PROPERTY:
                const propName = readConstant() as string;
                const obj = pop(state) as Record<string, any>;
                push(state, obj[propName]);
                break;
            case OpCode.OP_EQUAL:
                const bEq = pop(state);
                const aEq = pop(state);
                push(state, aEq === bEq);
                break;
            case OpCode.OP_NOT_EQUAL:
                const bNeq = pop(state);
                const aNeq = pop(state);
                push(state, aNeq !== bNeq);
                break;
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
                
                if (instruction === OpCode.OP_STRING_NOT_EQUAL) {
                    push(state, !isEqual);
                } else {
                    push(state, isEqual);
                }
                break;
            }
            case OpCode.OP_LESS:
                const bLt = pop(state) as number;
                const aLt = pop(state) as number;
                push(state, aLt < bLt);
                break;
            case OpCode.OP_LESS_EQUAL:
                const bLte = pop(state) as number;
                const aLte = pop(state) as number;
                push(state, aLte <= bLte);
                break;
            case OpCode.OP_GREATER:
                const bGt = pop(state) as number;
                const aGt = pop(state) as number;
                push(state, aGt > bGt);
                break;
            case OpCode.OP_GREATER_EQUAL:
                const bGte = pop(state) as number;
                const aGte = pop(state) as number;
                push(state, aGte >= bGte);
                break;
            case OpCode.OP_ADD:
                const bAdd = pop(state) as any;
                const aAdd = pop(state) as any;
                push(state, aAdd + bAdd);
                break;
            case OpCode.OP_SUB:
                const bSub = pop(state) as number;
                const aSub = pop(state) as number;
                push(state, aSub - bSub);
                break;
            case OpCode.OP_MUL:
                const bMul = pop(state) as number;
                const aMul = pop(state) as number;
                push(state, aMul * bMul);
                break;
            case OpCode.OP_DIV:
                const bDiv = pop(state) as number;
                const aDiv = pop(state) as number;
                push(state, aDiv / bDiv);
                break;
            case OpCode.OP_MOD:
                const bMod = pop(state) as number;
                const aMod = pop(state) as number;
                push(state, aMod % bMod);
                break;
            case OpCode.OP_POW:
                const bPow = pop(state) as number;
                const aPow = pop(state) as number;
                push(state, aPow ** bPow);
                break;
            case OpCode.OP_NOT:
                const val = pop(state);
                push(state, !val);
                break;
            case OpCode.OP_NEGATE:
                const num = pop(state) as number;
                push(state, -num);
                break;
            case OpCode.OP_JUMP:
                const offset = readShort();
                frame.ip += offset;
                break;
            case OpCode.OP_JUMP_IF_FALSE:
                const jumpOffset = readShort();
                const peekVal = state.stack[state.stack.length - 1];
                if (!peekVal) {
                    frame.ip += jumpOffset;
                }
                break;
            case OpCode.OP_LOOP:
                const loopOffset = readShort();
                frame.ip -= loopOffset;
                break;
            case OpCode.OP_CALL:
                const argCount = readByte();
                callValue(state, state.stack[state.stack.length - 1 - argCount]!, argCount);
                break;
            case OpCode.OP_PRINT:
                const pArgCount = readByte();
                const args = [];
                for (let i = 0; i < pArgCount; i++) {
                    args.push(pop(state));
                }
                console.log(...args.reverse());
                break;
            case OpCode.OP_IMPORT:
                let importPath = readConstant() as string;
                if (importPath === "std") {
                    importPath = "std/index.lls";
                } else if (!importPath.endsWith(".lls")) {
                    importPath += ".lls";
                }

                const fullPath = path.resolve(process.cwd(), importPath);
                if (!fs.existsSync(fullPath)) {
                    throw new Error(`Module not found: ${fullPath}`);
                }

                const source = fs.readFileSync(fullPath, "utf-8");
                const parser = new Parser();
                const doc = parser.parse(source, fullPath);
                
                const moduleFunc = compile(doc);
                
                // Execute the module immediately in a fresh VM (to get its exports)
                const modVMState = run(doc);
                
                const modExports: Record<string, any> = {};
                for (const [k, v] of modVMState.globals.entries()) {
                    // Omit native builtins we provided
                    if (k === "print" || k === "__printLn" || k === "__alloc") continue;
                    modExports[k] = v;
                }
                push(state, modExports);
                break;
            case OpCode.OP_RETURN:
                const result = pop(state);
                const poppingFrame = state.frames.pop()!;
                if (state.frames.length === 0) {
                    // VM finishes execution
                    return;
                }
                
                // Pop the function and its arguments from the stack
                state.stack.length = poppingFrame.baseSlot - 1;
                push(state, result!);
                break;
        }
    }
}

export function callValue(state: VMState, callee: Value, argCount: number) {
    if (callee instanceof NativeFunction) {
        const args = [];
        for (let i = 0; i < argCount; i++) {
            args.push(pop(state)!);
        }
        args.reverse();
        const result = callee.func(...args);
        pop(state); // pop native function
        push(state, result);
        return;
    }
    
    if (callee instanceof FunctionObj) {
        call(state, callee, argCount);
        return;
    }
    
    throw new Error("Can only call functions and classes.");
}

export function call(state: VMState, func: FunctionObj, argCount: number) {
    let actualArgCount = argCount;
    if (argCount < func.arity) {
        for (let i = argCount; i < func.arity; i++) {
            push(state, null);
            actualArgCount++;
        }
    }
    
    const frame = new CallFrame(func, 0, state.stack.length - actualArgCount);
    state.frames.push(frame);
}
