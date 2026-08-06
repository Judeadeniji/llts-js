import * as ast from "./ast";
import { Chunk, FunctionObj, OpCode } from "./bytecode";

class Local {
    constructor(public name: string, public depth: number) {}
}

export class Compiler {
    private chunks: Chunk[] = [];
    private locals: Local[] = [];
    private scopeDepth = 0;
    
    constructor() {
        // Start with a top-level script chunk
        this.chunks.push(new Chunk());
    }
    
    private currentChunk(): Chunk {
        const chunk = this.chunks[this.chunks.length - 1];
        if (!chunk) throw new Error("No current chunk");
        return chunk;
    }
    
    private emitByte(byte: number) {
        this.currentChunk().write(byte);
    }
    
    private emitBytes(byte1: number, byte2: number) {
        this.emitByte(byte1);
        this.emitByte(byte2);
    }
    
    private emitConstant(value: any) {
        const index = this.currentChunk().addConstant(value);
        this.emitBytes(OpCode.OP_CONSTANT, index);
    }
    
    public compile(document: ast.DocumentBody): FunctionObj {
        for (const stmt of document.statements) {
            this.compileStatement(stmt);
        }
        
        this.emitByte(OpCode.OP_NULL);
        this.emitByte(OpCode.OP_RETURN);
        
        const chunk = this.chunks.pop()!;
        return new FunctionObj("main", chunk, 0);
    }
    
    private compileStatement(node: ast.Node) {
        if (node instanceof ast.FunctionDeclaration) {
            this.compileFunction(node);
        } else if (node instanceof ast.DeclarationExpression) {
            this.compileExpression(node.value);
            
            if (this.scopeDepth > 0) {
                this.locals.push(new Local(node.name, this.scopeDepth));
            } else {
                const nameIdx = this.currentChunk().addConstant(node.name);
                this.emitBytes(OpCode.OP_SET_GLOBAL, nameIdx);
                this.emitByte(OpCode.OP_POP); // Declaration doesn't leave value on stack
            }
        } else if (node instanceof ast.BlockExpression) {
            this.beginScope();
            for (const stmt of node.statements) {
                this.compileStatement(stmt);
            }
            this.endScope();
        } else if (node instanceof ast.ReturnExpression) {
            if (node.returnValue) {
                this.compileExpression(node.returnValue);
            } else {
                this.emitByte(OpCode.OP_NULL);
            }
            this.emitByte(OpCode.OP_RETURN);
        } else if (node instanceof ast.WhileExpression) {
            const loopStart = this.currentChunk().code.length;
            
            this.compileExpression(node.condition);
            
            // If false, jump to end
            const exitJump = this.emitJump(OpCode.OP_JUMP_IF_FALSE);
            this.emitByte(OpCode.OP_POP); // pop condition
            
            this.beginScope();
            // TODO: pipeValue binding for `|item|` if present
            
            for (const stmt of node.body.statements) {
                this.compileStatement(stmt);
            }
            
            this.endScope();
            this.emitLoop(loopStart);
            
            this.patchJump(exitJump);
            this.emitByte(OpCode.OP_POP); // pop condition
        } else {
            // Expression statement
            this.compileExpression(node);
            this.emitByte(OpCode.OP_POP);
        }
    }
    
    private compileExpression(node: ast.Node) {
        if (node instanceof ast.LiteralExpression) {
            if (node.literal_type === "number") {
                this.emitConstant(parseFloat(node.value));
            } else if (node.literal_type === "string") {
                this.emitConstant(node.value);
            } else if (node.literal_type === "boolean") {
                this.emitByte(node.value === "true" ? OpCode.OP_TRUE : OpCode.OP_FALSE);
            }
        } else if (node instanceof ast.PrimaryExpression) {
            if (node.kind === "Identifier" || node.kind === "Register") {
                this.resolveVariable(node.name);
            }
        } else if (node instanceof ast.AssignmentExpression) {
            this.compileExpression(node.right);
            if (node.left instanceof ast.PrimaryExpression && (node.left.kind === "Identifier" || node.left.kind === "Register")) {
                const arg = this.resolveLocal(node.left.name);
                if (arg !== -1) {
                    this.emitBytes(OpCode.OP_SET_LOCAL, arg);
                } else {
                    const nameIdx = this.currentChunk().addConstant(node.left.name);
                    this.emitBytes(OpCode.OP_SET_GLOBAL, nameIdx);
                }
            }
        } else if (node instanceof ast.BinaryExpression) {
            if (node.operator === "&&") {
                this.compileExpression(node.left);
                const endJump = this.emitJump(OpCode.OP_JUMP_IF_FALSE);
                this.emitByte(OpCode.OP_POP);
                this.compileExpression(node.right);
                this.patchJump(endJump);
                return;
            }
            if (node.operator === "||") {
                this.compileExpression(node.left);
                const elseJump = this.emitJump(OpCode.OP_JUMP_IF_FALSE);
                const endJump = this.emitJump(OpCode.OP_JUMP);
                this.patchJump(elseJump);
                this.emitByte(OpCode.OP_POP);
                this.compileExpression(node.right);
                this.patchJump(endJump);
                return;
            }
            
            this.compileExpression(node.left);
            this.compileExpression(node.right);
            
            switch (node.operator) {
                case "+": this.emitByte(OpCode.OP_ADD); break;
                case "-": this.emitByte(OpCode.OP_SUB); break;
                case "*": this.emitByte(OpCode.OP_MUL); break;
                case "/": this.emitByte(OpCode.OP_DIV); break;
                case "%": this.emitByte(OpCode.OP_MOD); break;
                case "**": this.emitByte(OpCode.OP_POW); break;
                case "==": this.emitByte(OpCode.OP_EQUAL); break;
                case "!=": this.emitByte(OpCode.OP_NOT_EQUAL); break;
                case "<": this.emitByte(OpCode.OP_LESS); break;
                case "<=": this.emitByte(OpCode.OP_LESS_EQUAL); break;
                case ">": this.emitByte(OpCode.OP_GREATER); break;
                case ">=": this.emitByte(OpCode.OP_GREATER_EQUAL); break;
            }
        } else if (node instanceof ast.UnaryExpression) {
            this.compileExpression(node.arg);
            switch (node.operator) {
                case "-": this.emitByte(OpCode.OP_NEGATE); break;
                case "!": this.emitByte(OpCode.OP_NOT); break;
            }
        } else if (node instanceof ast.CallExpression) {
            // Builtin print hack for now
            if (node.callee instanceof ast.PrimaryExpression && node.callee.name === "print") {
                for (const arg of node.args) {
                    this.compileExpression(arg);
                }
                this.emitBytes(OpCode.OP_PRINT, node.args.length);
                return;
            }

            this.compileExpression(node.callee);
            for (const arg of node.args) {
                this.compileExpression(arg);
            }
            this.emitBytes(OpCode.OP_CALL, node.args.length);
        } else if (node instanceof ast.MemberExpression) {
            this.compileExpression(node.object);
            if (node.property instanceof ast.PrimaryExpression && node.property.kind === "Identifier") {
                const nameIdx = this.currentChunk().addConstant(node.property.name);
                this.emitBytes(OpCode.OP_GET_PROPERTY, nameIdx);
            }
        } else if (node instanceof ast.ImportNode) {
            const nameIdx = this.currentChunk().addConstant(node.importPath);
            this.emitBytes(OpCode.OP_IMPORT, nameIdx);
        }
    }
    
    private compileFunction(node: ast.FunctionDeclaration) {
        this.chunks.push(new Chunk());
        
        // Save outer locals and start fresh for this function
        const outerLocals = this.locals;
        const outerScopeDepth = this.scopeDepth;
        this.locals = [];
        this.scopeDepth = 0;
        
        this.beginScope();
        
        const params = node.params?.params || [];
        for (const p of params) {
            if (p instanceof ast.DeclarationExpression || p instanceof ast.PrimaryExpression) {
                this.locals.push(new Local(p.name, this.scopeDepth));
            }
        }
        
        for (const stmt of node.body.statements) {
            this.compileStatement(stmt);
        }
        
        this.emitByte(OpCode.OP_NULL);
        this.emitByte(OpCode.OP_RETURN);
        
        // Restore outer locals
        this.locals = outerLocals;
        this.scopeDepth = outerScopeDepth;
        
        const fnChunk = this.chunks.pop()!;
        const fn = new FunctionObj(node.name, fnChunk, params.length);
        
        // Push the function object as a constant in the surrounding chunk
        const fnIdx = this.currentChunk().addConstant(fn);
        this.emitBytes(OpCode.OP_CONSTANT, fnIdx);
        
        // Define it globally (we only support global functions for now)
        const nameIdx = this.currentChunk().addConstant(node.name);
        this.emitBytes(OpCode.OP_SET_GLOBAL, nameIdx);
        this.emitByte(OpCode.OP_POP);
    }
    
    private beginScope() {
        this.scopeDepth++;
    }
    
    private endScope() {
        this.scopeDepth--;
        while (this.locals.length > 0 && this.locals[this.locals.length - 1]!.depth > this.scopeDepth) {
            this.locals.pop();
            this.emitByte(OpCode.OP_POP);
        }
    }
    
    private resolveVariable(name: string) {
        const arg = this.resolveLocal(name);
        if (arg !== -1) {
            this.emitBytes(OpCode.OP_GET_LOCAL, arg);
        } else {
            const nameIdx = this.currentChunk().addConstant(name);
            this.emitBytes(OpCode.OP_GET_GLOBAL, nameIdx);
        }
    }
    
    private resolveLocal(name: string): number {
        for (let i = this.locals.length - 1; i >= 0; i--) {
            if (this.locals[i]!.name === name) {
                return i;
            }
        }
        return -1;
    }
    
    private emitJump(instruction: OpCode): number {
        this.emitByte(instruction);
        this.emitByte(0xff);
        this.emitByte(0xff);
        return this.currentChunk().code.length - 2;
    }
    
    private patchJump(offset: number) {
        const jump = this.currentChunk().code.length - offset - 2;
        this.currentChunk().code[offset] = (jump >> 8) & 0xff;
        this.currentChunk().code[offset + 1] = jump & 0xff;
    }
    
    private emitLoop(loopStart: number) {
        this.emitByte(OpCode.OP_LOOP);
        const offset = this.currentChunk().code.length - loopStart + 2;
        this.emitByte((offset >> 8) & 0xff);
        this.emitByte(offset & 0xff);
    }
}
