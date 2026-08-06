import * as ast from "./ast";
import { Parser } from "./parser";
import { Compiler } from "./compiler";
import { FunctionObj, NativeFunction, OpCode,  type Value } from "./bytecode";
import fs from "node:fs";
import path from "node:path";

class CallFrame {
    constructor(
        public func: FunctionObj,
        public ip: number,
        public baseSlot: number
    ) {}
}

export class VM {
    private globals = new Map<string, Value>();
    private stack: Value[] = [];
    private frames: CallFrame[] = [];
    private memory: Value[] = new Array(1024 * 1024).fill(null);
    private heapPointer = 0;

    constructor() {
        this.defineNative("print", (args: Value[]) => {
            console.log(...args);
            return null;
        });

        this.defineNative("__printLn", (args: Value[]) => {
            const ptr = args[0] as number;
            const charPtr = this.memory[ptr] as number;
            const len = this.memory[ptr + 1] as number;
            let msg = "";
            for (let i = 0; i < len; i++) {
                msg += String.fromCharCode(this.memory[charPtr + i] as number);
            }
            
            for (let i = 1; i < args.length; i++) {
                if (args[i] !== undefined) {
                    if (msg.includes("{s}")) {
                        const strPtr = args[i] as number;
                        const charPtr = this.memory[strPtr] as number;
                        const len = this.memory[strPtr + 1] as number;
                        let s = "";
                        for (let j = 0; j < len; j++) {
                            s += String.fromCharCode(this.memory[charPtr + j] as number);
                        }
                        msg = msg.replace("{s}", s);
                    } else if (msg.includes("{i}")) {
                        msg = msg.replace("{i}", String(args[i]));
                    }
                }
            }
            console.log(msg);
            return null;
        });

        this.defineNative("__alloc", (args: Value[]) => {
            const size = args[0] as number;
            const ptr = this.heapPointer;
            this.heapPointer += size;
            return ptr;
        });
    }
    
    private defineNative(name: string, func: (...args: Value[]) => Value | Value[]) {
        this.globals.set(name, new NativeFunction(name, func, 0)); // arity ignored for natives
    }

    private push(val: Value) { this.stack.push(val); }
    private pop() { return this.stack.pop(); }
    private peek(dist: number) { return this.stack[this.stack.length - 1 - dist]; }

    public run(document: ast.DocumentBody) {
        const compiler = new Compiler();
        const mainFunc = compiler.compile(document);
        
        this.stack.push(mainFunc);
        this.call(mainFunc, 0);
        this.execute();
    }
    
    private execute() {
        while (this.frames.length > 0) {
            const frame = this.frames[this.frames.length - 1]!;
            const chunk = frame.func.chunk;
            
            const readByte = () => chunk.code[frame.ip++]!;
            const readShort = () => (readByte() << 8) | readByte();
            const readConstant = () => chunk.constants[readByte()]!;
            
            const instruction = readByte();
            
            switch (instruction) {
                case OpCode.OP_CONSTANT:
                    this.stack.push(readConstant());
                    break;
                case OpCode.OP_NULL:
                    this.stack.push(null);
                    break;
                case OpCode.OP_TRUE:
                    this.stack.push(true);
                    break;
                case OpCode.OP_FALSE:
                    this.stack.push(false);
                    break;
                case OpCode.OP_POP:
                    this.stack.pop();
                    break;
                case OpCode.OP_DUP:
                    this.push(this.peek(0));
                    break;
                case OpCode.OP_MAKE_STRING: {
                    const strIdx = readByte();
                    const str = chunk.constants[strIdx] as string;
                    const charPtr = this.heapPointer;
                    this.heapPointer += str.length;
                    for (let i = 0; i < str.length; i++) {
                        this.memory[charPtr + i] = str.charCodeAt(i);
                    }
                    const structPtr = this.heapPointer;
                    this.heapPointer += 2;
                    this.memory[structPtr] = charPtr;
                    this.memory[structPtr + 1] = str.length;
                    this.push(structPtr);
                    break;
                }
                case OpCode.OP_GET_LOCAL:
                    const localSlot = readByte();
                    this.push(this.stack[frame.baseSlot + localSlot]);
                    break;
                case OpCode.OP_SET_LOCAL:
                    const setLocalSlot = readByte();
                    this.stack[frame.baseSlot + setLocalSlot] = this.peek(0);
                    break;
                case OpCode.OP_GET_INDEX: {
                    const index = this.pop() as number;
                    const ptr = this.pop() as number;
                    this.push(this.memory[ptr + index]);
                    break;
                }
                case OpCode.OP_SET_INDEX: {
                    const value = this.pop() as number;
                    const index = this.pop() as number;
                    const ptr = this.pop() as number;
                    this.memory[ptr + index] = value;
                    this.push(value);
                    break;
                }
                case OpCode.OP_GET_GLOBAL:
                    const globalName = readConstant() as string;
                    if (!this.globals.has(globalName)) {
                        throw new Error(`Undefined variable: ${globalName}`);
                    }
                    this.stack.push(this.globals.get(globalName)!);
                    break;
                case OpCode.OP_SET_GLOBAL:
                    const setGlobalName = readConstant() as string;
                    this.globals.set(setGlobalName, this.stack[this.stack.length - 1]);
                    break;
                case OpCode.OP_GET_PROPERTY:
                    const propName = readConstant() as string;
                    const obj = this.stack.pop() as Record<string, any>;
                    this.stack.push(obj[propName]);
                    break;
                case OpCode.OP_EQUAL:
                    const bEq = this.stack.pop();
                    const aEq = this.stack.pop();
                    this.stack.push(aEq === bEq);
                    break;
                case OpCode.OP_NOT_EQUAL:
                    const bNeq = this.stack.pop();
                    const aNeq = this.stack.pop();
                    this.stack.push(aNeq !== bNeq);
                    break;
                case OpCode.OP_LESS:
                    const bLt = this.stack.pop() as number;
                    const aLt = this.stack.pop() as number;
                    this.stack.push(aLt < bLt);
                    break;
                case OpCode.OP_LESS_EQUAL:
                    const bLte = this.stack.pop() as number;
                    const aLte = this.stack.pop() as number;
                    this.stack.push(aLte <= bLte);
                    break;
                case OpCode.OP_GREATER:
                    const bGt = this.stack.pop() as number;
                    const aGt = this.stack.pop() as number;
                    this.stack.push(aGt > bGt);
                    break;
                case OpCode.OP_GREATER_EQUAL:
                    const bGte = this.stack.pop() as number;
                    const aGte = this.stack.pop() as number;
                    this.stack.push(aGte >= bGte);
                    break;
                case OpCode.OP_ADD:
                    const bAdd = this.stack.pop() as any;
                    const aAdd = this.stack.pop() as any;
                    this.stack.push(aAdd + bAdd);
                    break;
                case OpCode.OP_SUB:
                    const bSub = this.stack.pop() as number;
                    const aSub = this.stack.pop() as number;
                    this.stack.push(aSub - bSub);
                    break;
                case OpCode.OP_MUL:
                    const bMul = this.stack.pop() as number;
                    const aMul = this.stack.pop() as number;
                    this.stack.push(aMul * bMul);
                    break;
                case OpCode.OP_DIV:
                    const bDiv = this.stack.pop() as number;
                    const aDiv = this.stack.pop() as number;
                    this.stack.push(aDiv / bDiv);
                    break;
                case OpCode.OP_MOD:
                    const bMod = this.stack.pop() as number;
                    const aMod = this.stack.pop() as number;
                    this.stack.push(aMod % bMod);
                    break;
                case OpCode.OP_POW:
                    const bPow = this.stack.pop() as number;
                    const aPow = this.stack.pop() as number;
                    this.stack.push(aPow ** bPow);
                    break;
                case OpCode.OP_NOT:
                    const val = this.stack.pop();
                    this.stack.push(!val);
                    break;
                case OpCode.OP_NEGATE:
                    const num = this.stack.pop() as number;
                    this.stack.push(-num);
                    break;
                case OpCode.OP_JUMP:
                    const offset = readShort();
                    frame.ip += offset;
                    break;
                case OpCode.OP_JUMP_IF_FALSE:
                    const jumpOffset = readShort();
                    const peekVal = this.stack[this.stack.length - 1];
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
                    this.callValue(this.stack[this.stack.length - 1 - argCount], argCount);
                    break;
                case OpCode.OP_PRINT:
                    const pArgCount = readByte();
                    const args = [];
                    for (let i = 0; i < pArgCount; i++) {
                        args.push(this.stack.pop());
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
                    
                    const compiler = new Compiler();
                    const moduleFunc = compiler.compile(doc);
                    
                    // Execute the module immediately in a fresh VM (to get its exports)
                    const modVM = new VM();
                    modVM.run(doc);
                    
                    const modExports: Record<string, any> = {};
                    for (const [k, v] of modVM.globals.entries()) {
                        // Omit native builtins we provided
                        if (k === "print" || k === "__printLn") continue;
                        modExports[k] = v;
                    }
                    this.stack.push(modExports);
                    break;
                case OpCode.OP_RETURN:
                    const result = this.stack.pop();
                    const poppingFrame = this.frames.pop()!;
                    if (this.frames.length === 0) {
                        // VM finishes execution
                        return;
                    }
                    
                    // Pop the function and its arguments from the stack
                    this.stack.length = poppingFrame.baseSlot - 1;
                    this.stack.push(result!);
                    break;
            }
        }
    }
    
    private callValue(callee: Value, argCount: number) {
        if (callee instanceof NativeFunction) {
            const args = [];
            for (let i = 0; i < argCount; i++) {
                args.push(this.stack.pop());
            }
            args.reverse();
            const result = callee.func(args);
            this.stack.pop(); // pop native function
            this.stack.push(result);
            return;
        }
        
        if (callee instanceof FunctionObj) {
            this.call(callee, argCount);
            return;
        }
        
        throw new Error("Can only call functions and classes.");
    }
    
    private call(func: FunctionObj, argCount: number) {
        let actualArgCount = argCount;
        if (argCount < func.arity) {
            for (let i = argCount; i < func.arity; i++) {
                this.stack.push(null);
                actualArgCount++;
            }
        }
        
        const frame = new CallFrame(func, 0, this.stack.length - actualArgCount);
        this.frames.push(frame);
    }
}