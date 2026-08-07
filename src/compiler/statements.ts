import * as ast from "../ast";
import { OpCode, Chunk, FunctionObj } from "../bytecode";
import { type CompilerState, currentChunk } from "./state";
import { emitByte, emitBytes, emitJump, patchJump, emitLoop } from "./emit";
import { beginScope, endScope } from "./scope";
import { compileExpression } from "./expressions";

export function compileStatement(state: CompilerState, node: ast.Node) {
    switch (node.nodeName) {
        case "FunctionDeclaration": {
            compileFunction(state, node as ast.FunctionDeclaration);
            break;
        }
        case "DeclarationNode": {
            const decl = node as ast.DeclarationExpression;
            compileExpression(state, decl.value);
            
            let typeName: string | undefined;
            if (decl.value.nodeName === "StructInitialization") {
                typeName = (decl.value as ast.StructInitialization).name;
            } else if (decl.value.nodeName === "ImportNode") {
                state.globalTypes.set("$" + decl.name, `module:${(decl.value as ast.ImportNode).importPath}`);
            }

            if (state.scopeDepth > 0) {
                state.locals.push({ name: decl.name, depth: state.scopeDepth, typeName });
            } else {
                if (typeName) {
                    state.globalTypes.set(decl.name, typeName);
                }
                const nameIdx = currentChunk(state).addConstant(decl.name);
                emitBytes(state, OpCode.OP_SET_GLOBAL, nameIdx);
                emitByte(state, OpCode.OP_POP); 
            }
            break;
        }
        case "BlockExpression": {
            const block = node as ast.BlockExpression;
            beginScope(state);
            for (const stmt of block.statements) {
                compileStatement(state, stmt);
            }
            endScope(state);
            break;
        }
        case "ReturnExpression": {
            const ret = node as ast.ReturnExpression;
            if (ret.returnValue) {
                compileExpression(state, ret.returnValue);
            } else {
                emitByte(state, OpCode.OP_NULL);
            }
            emitByte(state, OpCode.OP_RETURN);
            break;
        }
        case "StructDeclaration": {
            const structDecl = node as ast.StructDeclaration;
            const offsets = new Map<string, number>();
            const types = new Map<string, string>();
            let size = 0;
            for (const field of structDecl.fields) {
                offsets.set(field.name, size++);
                if (field.type.nodeName === "PrimaryExpression" && (field.type as ast.PrimaryExpression).kind === "Identifier") {
                    types.set(field.name, (field.type as ast.PrimaryExpression).name);
                }
            }
            state.structs.set(structDecl.name, { name: structDecl.name, size, offsets, types });
            break;
        }
        case "IfExpression": {
            const ifExpr = node as ast.IfExpression;
            compileExpression(state, ifExpr.condition);
            const thenJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
            emitByte(state, OpCode.OP_POP);
            beginScope(state);
            for (const stmt of ifExpr.body.statements) {
                compileStatement(state, stmt);
            }
            endScope(state);
            if (ifExpr.elseBody) {
                const elseJump = emitJump(state, OpCode.OP_JUMP);
                patchJump(state, thenJump);
                emitByte(state, OpCode.OP_POP);
                if (ifExpr.elseBody.nodeName === "BlockExpression") {
                    beginScope(state);
                    for (const stmt of (ifExpr.elseBody as ast.BlockExpression).statements) {
                        compileStatement(state, stmt);
                    }
                    endScope(state);
                } else if (ifExpr.elseBody.nodeName === "IfExpression") {
                    compileStatement(state, ifExpr.elseBody);
                }
                patchJump(state, elseJump);
            } else {
                patchJump(state, thenJump);
                emitByte(state, OpCode.OP_POP);
            }
            break;
        }
        case "WhileExpression": {
            const whileExpr = node as ast.WhileExpression;
            const loopStart = currentChunk(state).code.length;
            compileExpression(state, whileExpr.condition);
            const exitJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
            emitByte(state, OpCode.OP_POP);
            beginScope(state);
            for (const stmt of whileExpr.body.statements) {
                compileStatement(state, stmt);
            }
            endScope(state);
            emitLoop(state, loopStart);
            patchJump(state, exitJump);
            emitByte(state, OpCode.OP_POP);
            break;
        }
        case "ForExpression": {
            const forExpr = node as ast.ForExpression;
            beginScope(state);
            if (forExpr.init) compileStatement(state, forExpr.init);
            const loopStart = currentChunk(state).code.length;
            let exitJump = -1;
            if (forExpr.condition) {
                compileExpression(state, forExpr.condition);
                exitJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
                emitByte(state, OpCode.OP_POP);
            }
            beginScope(state);
            for (const stmt of forExpr.body.statements) {
                compileStatement(state, stmt);
            }
            endScope(state);
            if (forExpr.increment) {
                compileExpression(state, forExpr.increment);
                emitByte(state, OpCode.OP_POP);
            }
            emitLoop(state, loopStart);
            if (exitJump !== -1) {
                patchJump(state, exitJump);
                emitByte(state, OpCode.OP_POP);
            }
            endScope(state);
            break;
        }
        default: {
            compileExpression(state, node);
            emitByte(state, OpCode.OP_POP);
            break;
        }
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
        if (p.nodeName === "DeclarationNode" || p.nodeName === "PrimaryExpression") {
            state.locals.push({ name: (p as any).name, depth: state.scopeDepth });
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
