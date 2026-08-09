// others
import type { Chunk, Value } from "../bytecode";

// ----------------------------------------------------------------------

export interface CallFrame {
	returnIp: number;
	baseSlot: number;
	argCount: number;
	/** Relative local slots whose bindings are @const (shallow). */
	constSlots: Set<number>;
	/** LLTS function name for this frame (`<script>` for top-level). */
	funcName: string;
	/** Last known source line inside this frame. */
	line: number;
}

export interface VMState {
	globals: Map<string, Value>;
	stack: Value[];
	frames: CallFrame[];
	memory: Int32Array;
	heap: { ptr: number };
	chunk: Chunk;
	currentLine: number;
}

export function createVMState(chunk: Chunk, parentState?: VMState): VMState {
	return {
		globals: new Map<string, Value>(),
		stack: [],
		frames: [
			{
				returnIp: 0,
				baseSlot: 0,
				argCount: 0,
				constSlots: new Set(),
				funcName: "<script>",
				line: 1,
			},
		],
		memory: parentState?.memory ?? new Int32Array(1024 * 1024),
		heap: parentState?.heap ?? { ptr: 1024 },
		chunk,
		currentLine: 1,
	};
}
