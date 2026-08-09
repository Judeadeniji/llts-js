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
	let _poppedCount = 0;
	while (
		state.locals.length > 0 &&
		(state.locals[state.locals.length - 1]?.depth ?? 0) > state.scopeDepth
	) {
		const _local = state.locals.pop();
		emitByte(state, OpCode.OP_POP);
		_poppedCount++;
	}
}

export function resolveLocal(state: CompilerState, name: string): number {
	for (let i = state.locals.length - 1; i >= 0; i--) {
		if (state.locals[i]?.name === name) {
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
		// The __ prefix is the language-level native binding convention.
		// Any __name is trusted to be provided by the runtime without explicit listing.
		const isNativeConvention = name.startsWith("__");
		const isKnown = isNativeConvention || state.globalVars.has(name) || state.globalConsts.has(name) || state.functions.has(name) || state.nativeGlobals.has(name) || state.globalTypes.has(`$${name}`);
		
		if (!isKnown) {
			throw new Error(`CompileError: Unknown identifier '${name}'`);
		}

		const nameIdx = currentChunk(state).addConstant(name);
		if (state.functions.has(name)) {
			emitBytes(state, OpCode.OP_GET_FUNCTION, nameIdx);
		} else {
			emitBytes(state, OpCode.OP_GET_GLOBAL, nameIdx);
		}
	}
}
