import { NativeFunction, type Value } from "../bytecode";
import { type VMState } from "./state";

export function defineNative(state: VMState, name: string, func: (...args: Value[]) => Value | Value[]) {
    state.globals.set(name, new NativeFunction(name, func, 0));
}

export function registerBuiltins(state: VMState) {
    defineNative(state, "print", (...args: Value[]) => {
        console.log(...args);
        return null;
    });

    defineNative(state, "__printLn", (...args: Value[]) => {
        const ptr = args[0] as number;
        const charPtr = state.memory[ptr] as number;
        const len = state.memory[ptr + 1] as number;
        let msg = "";
        for (let i = 0; i < len; i++) {
            msg += String.fromCharCode(state.memory[charPtr + i] as number);
        }
        
        for (let i = 1; i < args.length; i++) {
            if (args[i] !== undefined) {
                if (msg.includes("{s}")) {
                    const strPtr = args[i] as number;
                    const charPtr = state.memory[strPtr] as number;
                    const len = state.memory[strPtr + 1] as number;
                    let s = "";
                    for (let j = 0; j < len; j++) {
                        s += String.fromCharCode(state.memory[charPtr + j] as number);
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

    defineNative(state, "__alloc", (...args: Value[]) => {
        const size = args[0] as number;
        const ptr = state.heapPointer;
        state.heapPointer += size;
        return ptr;
    });
}
