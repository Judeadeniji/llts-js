import { OpCode } from "../bytecode";
import { type CompilerState, currentChunk } from "./state";

export function emitByte(state: CompilerState, byte: number) {
    currentChunk(state).write(byte);
}

export function emitBytes(state: CompilerState, byte1: number, byte2: number) {
    emitByte(state, byte1);
    emitByte(state, byte2);
}

export function emitConstant(state: CompilerState, value: any) {
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
