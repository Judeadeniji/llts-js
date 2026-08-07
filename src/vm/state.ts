import { FunctionObj, type Value } from "../bytecode";

export interface CallFrame {
    func: FunctionObj;
    ip: number;
    baseSlot: number;
}

export interface VMState {
    globals: Map<string, Value>;
    stack: Value[];
    frames: CallFrame[];
    memory: Value[];
    heapPointer: number;
}

export function createVMState(): VMState {
    return {
        globals: new Map<string, Value>(),
        stack: [],
        frames: [],
        memory: new Array(1024 * 1024).fill(null),
        heapPointer: 0
    };
}
