// others
import { Chunk } from "../bytecode";
import * as ast from "../ast";

// ----------------------------------------------------------------------

export interface Local {
    name: string;
    depth: number;
    typeName?: string;
}

export interface StructDef {
    name: string;
    size: number;
    offsets: Map<string, number>;
    types: Map<string, string>;
}

export interface FunctionDef {
    ast: ast.FunctionDeclaration;
    address?: number;
    isRecursive: boolean;
    hasLoop: boolean;
    calls: Set<string>;
    forwardJumps?: number[];
}

export interface CompilerState {
    chunk: Chunk;
    locals: Local[];
    scopeDepth: number;
    functions: Map<string, FunctionDef>;
    structs: Map<string, StructDef>;
    globalTypes: Map<string, string>;
    inlineReturnJumps: number[][];
}

export function createCompilerState(): CompilerState {
    const state: CompilerState = {
        chunk: new Chunk(),
        locals: [],
        scopeDepth: 0,
        functions: new Map(),
        structs: new Map(),
        globalTypes: new Map(),
        inlineReturnJumps: []
    };
    
    state.structs.set("string", {
        name: "string",
        size: 2,
        offsets: new Map([["ptr", 0], ["len", 1]]),
        types: new Map([["ptr", "int"], ["len", "int"]])
    });
    
    return state;
}

export function currentChunk(state: CompilerState): Chunk {
    return state.chunk;
}
