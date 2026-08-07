import * as ast from "../ast";
import { FunctionObj, OpCode } from "../bytecode";
import { createCompilerState } from "./state";
import { compileStatement } from "./statements";
import { emitByte } from "./emit";

export function compile(document: ast.DocumentBody): FunctionObj {
    const state = createCompilerState();
    
    for (const stmt of document.statements) {
        compileStatement(state, stmt);
    }
    
    emitByte(state, OpCode.OP_NULL);
    emitByte(state, OpCode.OP_RETURN);
    
    const chunk = state.chunks.pop()!;
    return new FunctionObj("main", chunk, 0);
}

export class Compiler {
    public compile(document: ast.DocumentBody): FunctionObj {
        return compile(document);
    }
}
