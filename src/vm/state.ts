// others
import type { Chunk, Value } from "../bytecode";

// ----------------------------------------------------------------------

export interface CallFrame {
	returnIp: number;
	baseSlot: number;
	argCount: number;
}

export interface VMState {
	globals: Map<string, Value>;
	stack: Value[];
	frames: CallFrame[];
	memory: Int32Array;
	heap: { ptr: number };
	chunk: Chunk;
}

export function createVMState(chunk: Chunk, parentState?: VMState): VMState {
	return {
		globals: new Map<string, Value>(),
		stack: [],
		frames: [{ returnIp: 0, baseSlot: 0, argCount: 0 }], // Initial frame for main script
		memory: parentState?.memory ?? new Int32Array(1024 * 1024),
		heap: parentState?.heap ?? { ptr: 1024 },
		chunk,
	};
}
