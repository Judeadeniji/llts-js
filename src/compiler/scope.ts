// others
import { OpCode } from "../bytecode";
import { emitByte, emitBytes } from "./emit";
import { compileExpression } from "./expressions";
import { compileStatement } from "./statements";
import { type CompilerState, currentChunk } from "./state";
import type * as ast from "../ast";

// ----------------------------------------------------------------------

export function beginScope(state: CompilerState) {
	state.scopeDepth++;
	state.deferStacks.set(state.scopeDepth, []);
}

/** Emit deferred bodies for one depth (LIFO). Does not clear the stack. */
export function emitDefersForDepth(state: CompilerState, depth: number) {
	const list = state.deferStacks.get(depth);
	if (!list || list.length === 0) return;
	for (let i = list.length - 1; i >= 0; i--) {
		const body = list[i]!;
		if (body.nodeName === "BlockExpression") {
			compileStatement(state, body);
		} else {
			compileExpression(state, body);
			emitByte(state, OpCode.OP_POP);
		}
	}
}

/** Run defers for scopes with depth > targetDepth (innermost first). */
export function emitDefersUntil(state: CompilerState, targetDepth: number) {
	for (let d = state.scopeDepth; d > targetDepth; d--) {
		emitDefersForDepth(state, d);
	}
}

/** Emit OP_POP for locals deeper than targetDepth without mutating compiler locals. */
export function emitPopsUntil(state: CompilerState, targetDepth: number) {
	let count = 0;
	for (let i = state.locals.length - 1; i >= 0; i--) {
		if ((state.locals[i]?.depth ?? 0) > targetDepth) count++;
		else break;
	}
	for (let i = 0; i < count; i++) {
		emitByte(state, OpCode.OP_POP);
	}
}

/** Defers for all scopes in the current function (depth >= 1). */
export function emitFunctionExitDefers(state: CompilerState) {
	emitDefersUntil(state, 0);
}

export function endScope(state: CompilerState) {
	emitDefersForDepth(state, state.scopeDepth);
	state.deferStacks.delete(state.scopeDepth);
	state.scopeDepth--;
	while (
		state.locals.length > 0 &&
		(state.locals[state.locals.length - 1]?.depth ?? 0) > state.scopeDepth
	) {
		state.locals.pop();
		emitByte(state, OpCode.OP_POP);
	}
}

export function pushDefer(state: CompilerState, body: ast.Node) {
	if (state.scopeDepth <= 0) {
		throw new Error("CompileError: defer is not allowed outside a scope");
	}
	const list = state.deferStacks.get(state.scopeDepth);
	if (!list) {
		throw new Error("CompileError: defer stack missing for scope");
	}
	list.push(body);
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
		const isKnown =
			isNativeConvention ||
			state.globalVars.has(name) ||
			state.globalConsts.has(name) ||
			state.functions.has(name) ||
			state.nativeGlobals.has(name) ||
			state.globalTypes.has(`$${name}`);

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
