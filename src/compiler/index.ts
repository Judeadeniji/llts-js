// others
import { OpCode, Chunk } from "../bytecode";
import { emitByte, emitJump, patchJump } from "./emit";
import { type CompilerState, createCompilerState } from "./state";
import { compileStatement, compileFunction } from "./statements";
import * as ast from "../ast";

// ----------------------------------------------------------------------

function registerFunctions(state: CompilerState, document: ast.DocumentBody) {
    const visitedNodes = new Set<ast.Node>();
    
    // Collect all functions
    const collectFuncs = (node: ast.Node, prefix = "") => {
        if (!node || visitedNodes.has(node)) return;
        visitedNodes.add(node);
        
        if (node.nodeName === "FunctionDeclaration") {
            const fn = node as ast.FunctionDeclaration;
            const fullName = prefix ? `${prefix}::${fn.name}` : fn.name;
            
            // Analyze for loops and calls
            let hasLoop = false;
            const calls = new Set<string>();
            
            const analyze = (n: ast.Node) => {
                if (!n || visitedNodes.has(n)) return;
                visitedNodes.add(n);
                
                if (n.nodeName === "ForExpression" || n.nodeName === "WhileExpression") {
                    hasLoop = true;
                }
                if (n.nodeName === "CallExpression") {
                    const call = n as ast.CallExpression;
                    if (call.callee.nodeName === "PrimaryExpression") {
                        const prim = call.callee as ast.PrimaryExpression;
                        if (prim.kind === "Identifier") {
                            calls.add(prim.name);
                        }
                    } else if (call.callee.nodeName === "MemberExpression") {
                        const mem = call.callee as ast.MemberExpression;
                        if (mem.property.nodeName === "PrimaryExpression") {
                            const prim = mem.property as ast.PrimaryExpression;
                            if (prim.kind === "Identifier") {
                                calls.add(prim.name);
                            }
                        }
                    }
                }
                // Recurse children
                for (const key of Object.keys(n)) {
                    if (key === "parent") continue;
                    const val = (n as any)[key];
                    if (val instanceof ast.Node) analyze(val);
                    else if (Array.isArray(val)) {
                        for (const item of val) {
                            if (item instanceof ast.Node) analyze(item);
                        }
                    }
                }
            };
            
            // clear visited for body so we can traverse it again if needed?
            // Actually visitedNodes being global to this phase is fine, 
            // since we just want to visit every node once!
            // BUT wait, fn.body is part of the AST, if we visit it in `analyze`, 
            // we won't visit it in `collectFuncs`. That's actually correct because 
            // `collectFuncs` doesn't need to look inside fn.body for more FunctionDeclarations
            // (LLTS doesn't have nested functions).
            analyze(fn.body);
            
            state.functions.set(fullName, {
                ast: fn,
                isRecursive: false,
                hasLoop,
                calls
            });
        } else if (node.nodeName === "StructDeclaration") {
            const st = node as ast.StructDeclaration;
            for (const method of st.methods) {
                collectFuncs(method, "");
            }
        } else {
            // Recurse
            for (const key of Object.keys(node)) {
                if (key === "parent") continue;
                const val = (node as any)[key];
                if (val instanceof ast.Node) collectFuncs(val, prefix);
                else if (Array.isArray(val)) {
                    for (const item of val) {
                        if (item instanceof ast.Node) collectFuncs(item, prefix);
                    }
                }
            }
        }
    };
    
    collectFuncs(document);
    
    // Cycle detection for mutual recursion
    const visited = new Set<string>();
    const stack = new Set<string>();
    
    const dfs = (funcName: string) => {
        if (stack.has(funcName)) {
            // Cycle detected!
            return true;
        }
        if (visited.has(funcName)) return false;
        
        visited.add(funcName);
        stack.add(funcName);
        
        const def = state.functions.get(funcName);
        if (def) {
            for (const callName of def.calls) {
                // If it calls a method, we might only have `takeDamage` but the real name is `Player::takeDamage`.
                // We should check all functions that end with `::${callName}` or exactly `callName`.
                const targets = [];
                if (state.functions.has(callName)) targets.push(callName);
                for (const k of state.functions.keys()) {
                    if (k.endsWith(`::${callName}`)) targets.push(k);
                }
                
                for (const target of targets) {
                    if (dfs(target)) {
                        def.isRecursive = true;
                        // Mark all in the cycle as recursive
                        for (const s of stack) {
                            const d = state.functions.get(s);
                            if (d) d.isRecursive = true;
                        }
                    }
                }
            }
        }
        
        stack.delete(funcName);
        return def?.isRecursive || false;
    };
    
    for (const name of state.functions.keys()) {
        if (!visited.has(name)) {
            dfs(name);
        }
    }
    
    // DEBUG
    for (const [name, def] of state.functions.entries()) {

    }
}

export function compile(document: ast.DocumentBody): Chunk {
    const state = createCompilerState();
    
    // Phase 1: Register functions and compute call graph for recursion
    registerFunctions(state, document);
    // Phase 2: Compile main script statements
    // We emit a jump over the static functions
    const mainJump = emitJump(state, OpCode.OP_JUMP);
    
    // Compile static jump functions
    for (const [name, def] of state.functions.entries()) {
        if (def.hasLoop || def.isRecursive || def.ast.body.statements.length > 5) {
            def.address = state.chunk.code.length;
            
            // Patch forward jumps
            if (def.forwardJumps) {
                for (const patch of def.forwardJumps) {
                    state.chunk.code[patch] = (def.address >> 8) & 0xff;
                    state.chunk.code[patch + 1] = def.address & 0xff;
                }
            }
            
            compileFunction(state, def.ast);
        }
    }
    
    patchJump(state, mainJump);
    
    // We only compile non-function/struct statements in the main body
    for (const stmt of document.statements) {
        if (stmt.nodeName !== "FunctionDeclaration" && stmt.nodeName !== "StructDeclaration") {
            compileStatement(state, stmt);
        }
        // Struct declarations are still compiled to register the struct types!
        if (stmt.nodeName === "StructDeclaration") {
            compileStatement(state, stmt);
        }
    }
    
    // Emit halt for main script
    emitByte(state, OpCode.OP_NULL);
    emitByte(state, OpCode.OP_RETURN);
    return state.chunk;
}

export class Compiler {
    public compile(document: ast.DocumentBody): Chunk {
        return compile(document);
    }
}
