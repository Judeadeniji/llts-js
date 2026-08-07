import { Chunk } from "../bytecode";
import * as ast from "../ast";

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

export interface CompilerState {
    chunks: Chunk[];
    locals: Local[];
    scopeDepth: number;
    functions: ast.FunctionDeclaration[];
    structs: Map<string, StructDef>;
    globalTypes: Map<string, string>;
}

export function createCompilerState(): CompilerState {
    const state: CompilerState = {
        chunks: [new Chunk()],
        locals: [],
        scopeDepth: 0,
        functions: [],
        structs: new Map(),
        globalTypes: new Map()
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
    const chunk = state.chunks[state.chunks.length - 1];
    if (!chunk) throw new Error("No current chunk");
    return chunk;
}
