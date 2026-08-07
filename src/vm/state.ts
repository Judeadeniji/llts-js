// others
import { type Value, Chunk } from "../bytecode";

// ----------------------------------------------------------------------

export interface CallFrame {
    returnIp: number;
    baseSlot: number;
}

export interface VMState {
    globals: Map<string, Value>;
    stack: Value[];
    frames: CallFrame[];
    memory: Int32Array;
    heapPointer: number;
    chunk: Chunk;
}

export function createVMState(chunk: Chunk): VMState {
    return {
        globals: new Map<string, Value>(),
        stack: [],
        frames: [{ returnIp: 0, baseSlot: 0 }], // Initial frame for main script
        memory: new Int32Array(1024 * 1024),
        heapPointer: 1024,
        chunk
    };
}
