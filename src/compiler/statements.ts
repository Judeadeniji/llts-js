import * as ast from "../ast";
import { OpCode, Chunk, FunctionObj } from "../bytecode";
import { CompilerState, currentChunk } from "./state";
import { emitByte, emitBytes, emitJump, patchJump, emitLoop } from "./emit";
import { beginScope, endScope } from "./scope";
import { compileExpression } from "./expressions";

export function compileStatement(state: CompilerState, node: ast.Node) {
    if (node instanceof ast.FunctionDeclaration) {
        compileFunction(state, node);
    } else if (node instanceof ast.DeclarationExpression) {
        compileExpression(state, node.value);
        
        let typeName: string | undefined;
        if (node.value instanceof ast.StructInitialization) {
            typeName = node.value.name;
        } else if (node.value instanceof ast.ImportNode) {
            state.globalTypes.set("$" + node.name, `module:${node.value.importPath}`);
        }

        if (state.scopeDepth > 0) {
            state.locals.push({ name: node.name, depth: state.scopeDepth, typeName });
        } else {
            if (typeName) {
                state.globalTypes.set(node.name, typeName);
            }
            const nameIdx = currentChunk(state).addConstant(node.name);
            emitBytes(state, OpCode.OP_SET_GLOBAL, nameIdx);
            emitByte(state, OpCode.OP_POP); 
        }
    } else if (node instanceof ast.BlockExpression) {
        beginScope(state);
        for (const stmt of node.statements) {
            compileStatement(state, stmt);
        }
        endScope(state);
    } else if (node instanceof ast.ReturnExpression) {
        if (node.returnValue) {
            compileExpression(state, node.returnValue);
        } else {
            emitByte(state, OpCode.OP_NULL);
        }
        emitByte(state, OpCode.OP_RETURN);
    } else if (node instanceof ast.StructDeclaration) {
        const offsets = new Map<string, number>();
        const types = new Map<string, string>();
        let size = 0;
        for (const field of node.fields) {
            offsets.set(field.name, size++);
            if (field.type instanceof ast.PrimaryExpression && field.type.kind === "Identifier") {
                types.set(field.name, field.type.name);
            }
        }
        state.structs.set(node.name, { name: node.name, size, offsets, types });
    } else if (node instanceof ast.IfExpression) {
        compileExpression(state, node.condition);
        const thenJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
        emitByte(state, OpCode.OP_POP);
        beginScope(state);
        for (const stmt of node.body.statements) {
            compileStatement(state, stmt);
        }
        endScope(state);
        if (node.elseBody) {
            const elseJump = emitJump(state, OpCode.OP_JUMP);
            patchJump(state, thenJump);
            emitByte(state, OpCode.OP_POP);
            if (node.elseBody instanceof ast.BlockExpression) {
                beginScope(state);
                for (const stmt of node.elseBody.statements) {
                    compileStatement(state, stmt);
                }
                endScope(state);
            } else if (node.elseBody instanceof ast.IfExpression) {
                compileStatement(state, node.elseBody);
            }
            patchJump(state, elseJump);
        } else {
            patchJump(state, thenJump);
            emitByte(state, OpCode.OP_POP);
        }
    } else if (node instanceof ast.WhileExpression) {
        const loopStart = currentChunk(state).code.length;
        compileExpression(state, node.condition);
        const exitJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
        emitByte(state, OpCode.OP_POP);
        beginScope(state);
        for (const stmt of node.body.statements) {
            compileStatement(state, stmt);
        }
        endScope(state);
        emitLoop(state, loopStart);
        patchJump(state, exitJump);
        emitByte(state, OpCode.OP_POP);
    } else if (node instanceof ast.ForExpression) {
        beginScope(state);
        if (node.init) compileStatement(state, node.init);
        const loopStart = currentChunk(state).code.length;
        let exitJump = -1;
        if (node.condition) {
            compileExpression(state, node.condition);
            exitJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
            emitByte(state, OpCode.OP_POP);
        }
        beginScope(state);
        for (const stmt of node.body.statements) {
            compileStatement(state, stmt);
        }
        endScope(state);
        if (node.increment) {
            compileExpression(state, node.increment);
            emitByte(state, OpCode.OP_POP);
        }
        emitLoop(state, loopStart);
        if (exitJump !== -1) {
            patchJump(state, exitJump);
            emitByte(state, OpCode.OP_POP);
        }
        endScope(state);
    } else {
        compileExpression(state, node);
        emitByte(state, OpCode.OP_POP);
    }
}

export function compileFunction(state: CompilerState, node: ast.FunctionDeclaration) {
    state.chunks.push(new Chunk());
    
    const outerLocals = state.locals;
    const outerScopeDepth = state.scopeDepth;
    state.locals = [];
    state.scopeDepth = 0;
    
    beginScope(state);
    const params = node.params?.params || [];
    for (const p of params) {
        if (p instanceof ast.DeclarationExpression || p instanceof ast.PrimaryExpression) {
            state.locals.push({ name: p.name, depth: state.scopeDepth });
        }
    }
    
    for (const stmt of node.body.statements) {
        compileStatement(state, stmt);
    }
    
    emitByte(state, OpCode.OP_NULL);
    emitByte(state, OpCode.OP_RETURN);
    
    state.locals = outerLocals;
    state.scopeDepth = outerScopeDepth;
    
    const fnChunk = state.chunks.pop()!;
    const fn = new FunctionObj(node.name, fnChunk, params.length);
    
    const fnIdx = currentChunk(state).addConstant(fn);
    emitBytes(state, OpCode.OP_CONSTANT, fnIdx);
    
    const nameIdx = currentChunk(state).addConstant(node.name);
    emitBytes(state, OpCode.OP_SET_GLOBAL, nameIdx);
    emitByte(state, OpCode.OP_POP);
}
