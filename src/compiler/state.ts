// others
import { Chunk } from "../bytecode";
import type * as ast from "../ast";

// ----------------------------------------------------------------------

export interface Local {
	name: string;
	depth: number;
	typeName?: string;
	isConst?: boolean;
}

export interface StructDef {
	name: string;
	size: number;
	offsets: Map<string, number>;
	types: Map<string, string>;
}

export interface FunctionDef {
	ast: ast.FunctionDeclaration;
	isRecursive: boolean;
	hasLoop: boolean;
	hasReturn: boolean;
	calls: Set<string>;
	address?: number;
	forwardJumps?: number[];
	returnType?: string; // struct name returned, if statically known
}

export interface LoopTracker {
	label: string | null;
	breakJumps: number[];
	continueJumps: number[];
	/** Scope depth of the loop's outer beginScope (break/continue exit to here). */
	scopeDepth: number;
}

export interface CompilerState {
	chunk: Chunk;
	locals: Local[];
	scopeDepth: number;
	functions: Map<string, FunctionDef>;
	structs: Map<string, StructDef>;
	globalTypes: Map<string, string>;
	globalConsts: Set<string>;
	globalVars: Set<string>;
	nativeGlobals: Set<string>; // native function/value names registered at runtime
	inlineReturnJumps: number[][];
	loops: LoopTracker[];
	lastEmittedLine: number;
	/** Emit OP_ASSERT_TYPE at typed boundaries when true. */
	debug: boolean;
	/** Static type display strings for `@typeOf` (filled by typecheck). */
	typeOfResults: Map<ast.Node, string>;
	/** Deferred statement bodies per lexical scope depth (LIFO on exit). */
	deferStacks: Map<number, ast.Node[]>;
}

export function createCompilerState(): CompilerState {
	const state: CompilerState = {
		chunk: new Chunk(),
		locals: [],
		scopeDepth: 0,
		functions: new Map(),
		structs: new Map(),
		globalTypes: new Map(),
		globalConsts: new Set(),
		globalVars: new Set(),
		nativeGlobals: new Set([
			// Core language builtins — provided by the VM unconditionally
			"print", "error", "len",
		]),
		inlineReturnJumps: [],
		loops: [],
		lastEmittedLine: -1,
		debug: true,
		typeOfResults: new Map(),
		deferStacks: new Map(),
	};

	state.structs.set("string", {
		name: "string",
		size: 2,
		offsets: new Map([
			["ptr", 0],
			["len", 1],
		]),
		types: new Map([
			["ptr", "int"],
			["len", "int"],
		]),
	});

	state.structs.set("error", {
		name: "error",
		size: 1,
		offsets: new Map([["message", 0]]),
		types: new Map([["message", "string"]]),
	});

	return state;
}

export function currentChunk(state: CompilerState): Chunk {
	return state.chunk;
}
