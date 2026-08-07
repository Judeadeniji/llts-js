// others
import { OpCode } from "../bytecode";
import { emitByte, emitBytes, emitJump, patchJump, emitLoop } from "./emit";
import { compileExpression } from "./expressions";
import { beginScope, endScope } from "./scope";
import { type CompilerState, currentChunk } from "./state";
import * as ast from "../ast";

// ----------------------------------------------------------------------

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
            if (decl.type && decl.type.nodeName === "PrimaryExpression" && (decl.type as ast.PrimaryExpression).kind === "Identifier") {
                typeName = (decl.type as ast.PrimaryExpression).name;
            } else if (decl.value.nodeName === "StructInitialization") {
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
            if (state.inlineReturnJumps.length > 0) {
                const patch = emitJump(state, OpCode.OP_JUMP);
                state.inlineReturnJumps[state.inlineReturnJumps.length - 1].push(patch);
            } else {
                emitByte(state, OpCode.OP_RETURN);
            }
            break;
        }
        case "StructDeclaration": {
            const structDecl = node as ast.StructDeclaration;
            const offsets = new Map<string, number>();
            const types = new Map<string, string>();
            let size = 0;
            
            for (const field of structDecl.fields) {
                offsets.set(field.name, size++);
                if (field.type && field.type.nodeName === "PrimaryExpression" && (field.type as ast.PrimaryExpression).kind === "Identifier") {
                    types.set(field.name, (field.type as ast.PrimaryExpression).name);
                }
            }
            
            state.structs.set(structDecl.name, {
                name: structDecl.name,
                size,
                offsets,
                types
            });
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
        case "ForExpression": {
            const forExpr = node as ast.ForExpression;
            beginScope(state);
            if (forExpr.init) compileStatement(state, forExpr.init);
            const loopStart = currentChunk(state).code.length;
            state.loops.push({ breakJumps: [], continueJumps: [] });
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
            
            const loop = state.loops.pop()!;
            for (const continueJump of loop.continueJumps) {
                patchJump(state, continueJump);
            }
            
            if (forExpr.increment) {
                compileExpression(state, forExpr.increment);
                emitByte(state, OpCode.OP_POP);
            }
            emitLoop(state, loopStart);
            if (exitJump !== -1) {
                patchJump(state, exitJump);
                emitByte(state, OpCode.OP_POP);
            }
            for (const breakJump of loop.breakJumps) {
                patchJump(state, breakJump);
            }
            endScope(state);
            break;
        }
        case "BreakExpression": {
            if (state.loops.length === 0) {
                throw new Error("Cannot break outside of a loop");
            }
            const jump = emitJump(state, OpCode.OP_JUMP);
            state.loops[state.loops.length - 1].breakJumps.push(jump);
            break;
        }
        case "ContinueExpression": {
            if (state.loops.length === 0) {
                throw new Error("Cannot continue outside of a loop");
            }
            const jump = emitJump(state, OpCode.OP_JUMP);
            state.loops[state.loops.length - 1].continueJumps.push(jump);
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
    const outerLocals = state.locals;
    const outerScopeDepth = state.scopeDepth;
    // We do NOT clear locals, because in a flat chunk, they might conflict?
    // Wait, the VM uses baseSlot. So local variables at runtime will be at `baseSlot + index`.
    // But at compile time, if we clear `state.locals`, the compiler will assign `localSlot = 0, 1, 2...`
    // And the VM will read `state.stack[frame.baseSlot + 0]`. This perfectly aligns!
    // So YES, we MUST clear state.locals!
    state.locals = [];
    state.scopeDepth = 0;
    
    beginScope(state);
    let methodStruct: string | undefined;
    if (node.name.includes("::")) {
        methodStruct = node.name.split("::")[0];
    }

    const params = node.params?.params || [];
    for (const p of params) {
        switch (p.nodeName) {
            case "DeclarationNode": {
                const decl = p as ast.DeclarationExpression;
                let pType: string | undefined;
                if (decl.name === "self" && methodStruct) {
                    pType = methodStruct;
                } else if (decl.type && decl.type.nodeName === "PrimaryExpression") {
                    pType = (decl.type as ast.PrimaryExpression).name;
                }
                state.locals.push({ name: decl.name, depth: state.scopeDepth, typeName: pType });
                break;
            }
            case "PrimaryExpression": {
                const prim = p as ast.PrimaryExpression;
                let pType: string | undefined;
                if (prim.kind === "Identifier" && prim.name === "self" && methodStruct) {
                    pType = methodStruct;
                }
                state.locals.push({ name: prim.name, depth: state.scopeDepth, typeName: pType });
                break;
            }
        }
    }
    
    
    for (const stmt of node.body.statements) {
        compileStatement(state, stmt);
    }
    
    emitByte(state, OpCode.OP_NULL);
    emitByte(state, OpCode.OP_RETURN);
    
    state.locals = outerLocals;
    state.scopeDepth = outerScopeDepth;
    // We no longer push a FunctionObj onto the stack or create a new chunk!
}
