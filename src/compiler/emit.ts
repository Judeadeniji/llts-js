// others
import { OpCode, type Value } from "../bytecode";
import { type CompilerState, currentChunk } from "./state";

// ----------------------------------------------------------------------

export function emitByte(state: CompilerState, byte: number) {
	currentChunk(state).write(byte);
	if (byte === OpCode.OP_POP) {
	}
}

export function emitBytes(state: CompilerState, ...bytes: number[]) {
	for (const b of bytes) {
		emitByte(state, b);
	}
}

export function emitConstant(state: CompilerState, value: Value) {
	const index = currentChunk(state).addConstant(value);
	emitBytes(state, OpCode.OP_CONSTANT, index);
}

export function emitJump(state: CompilerState, instruction: OpCode): number {
	emitByte(state, instruction);
	emitByte(state, 0xff);
	emitByte(state, 0xff);
	return currentChunk(state).code.length - 2;
}

export function patchJump(state: CompilerState, offset: number) {
	const jump = currentChunk(state).code.length - offset - 2;
	currentChunk(state).code[offset] = (jump >> 8) & 0xff;
	currentChunk(state).code[offset + 1] = jump & 0xff;
}

export function emitLoop(state: CompilerState, loopStart: number) {
	emitByte(state, OpCode.OP_LOOP);
	const offset = currentChunk(state).code.length - loopStart + 2;
	emitByte(state, (offset >> 8) & 0xff);
	emitByte(state, offset & 0xff);
}

/** Emit OP_LINE when the source line changes (debug marker in the bytecode stream). */
export function emitLineIfNeeded(state: CompilerState, line: number | undefined) {
	if (line === undefined || line === state.lastEmittedLine) return;
	state.lastEmittedLine = line;
	emitBytes(state, OpCode.OP_LINE, (line >> 8) & 0xff, line & 0xff);
}
