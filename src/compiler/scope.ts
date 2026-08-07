// others
import { OpCode } from "../bytecode";
import { emitByte, emitBytes } from "./emit";
import { type CompilerState, currentChunk } from "./state";

// ----------------------------------------------------------------------

export function beginScope(state: CompilerState) {
    state.scopeDepth++;
}

export function endScope(state: CompilerState) {
    state.scopeDepth--;
    while (state.locals.length > 0 && state.locals[state.locals.length - 1]!.depth > state.scopeDepth) {
        state.locals.pop();
        emitByte(state, OpCode.OP_POP);
    }
}

export function resolveLocal(state: CompilerState, name: string): number {
    for (let i = state.locals.length - 1; i >= 0; i--) {
        if (state.locals[i]!.name === name) {
            return i;
        }
    }
    return -1;
}

export function resolveVariable(state: CompilerState, name: string) {
    const arg = resolveLocal(state, name);
    if (arg !== -1) {
        emitBytes(state, OpCode.OP_GET_LOCAL, arg);
    } else {
        const nameIdx = currentChunk(state).addConstant(name);
        emitBytes(state, OpCode.OP_GET_GLOBAL, nameIdx);
    }
}
