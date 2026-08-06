import * as ast from "./ast";
import { Chunk, FunctionObj, OpCode } from "./bytecode";
import * as fs from "fs";
import * as path from "path";
import { Parser } from "./parser";

class Local {
    public typeName?: string;
    constructor(public name: string, public depth: number) {}
}

interface StructDef {
    name: string;
    size: number;
    offsets: Map<string, number>;
    types: Map<string, string>;
}

export class Compiler {
    private chunks: Chunk[] = [new Chunk()];
    private locals: Local[] = [];
    private scopeDepth = 0;
    private functions: ast.FunctionDeclaration[] = [];
    private structs: Map<string, StructDef> = new Map();
    private globalTypes: Map<string, string> = new Map();
    
    private resolveType(node: ast.Node): string | undefined {
        if (node instanceof ast.LiteralExpression) {
            if (node.literal_type === "string") {
                return "string";
            } else if (node.literal_type === "boolean") {
                return "boolean";
            }
            return "int"; // Assume number is int for now
        }
        if (node instanceof ast.PrimaryExpression && (node.kind === "Identifier" || node.kind === "Register")) {
            const localIdx = this.resolveLocal(node.name);
            if (localIdx !== -1) {
                return this.locals[localIdx]?.typeName;
            }
            return this.globalTypes.get(node.name);
        } else if (node instanceof ast.MemberExpression) {
            const objectType = this.resolveType(node.object);
            if (objectType && node.property instanceof ast.PrimaryExpression && node.property.kind === "Identifier") {
                const structDef = this.structs.get(objectType);
                if (structDef) {
                    return structDef.types.get(node.property.name);
                }
            }
        }
        return undefined;
    }
    
    constructor() {
        // Define builtin string struct
        this.structs.set("string", {
            name: "string",
            size: 2,
            offsets: new Map([["ptr", 0], ["len", 1]]),
            types: new Map([["ptr", "int"], ["len", "int"]])
        });
        
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
            
            let typeName: string | undefined;
            if (node.value instanceof ast.StructInitialization) {
                typeName = node.value.name;
            }

            if (this.scopeDepth > 0) {
                const local = new Local(node.name, this.scopeDepth);
                local.typeName = typeName;
                this.locals.push(local);
            } else {
                if (typeName) {
                    this.globalTypes.set(node.name, typeName);
                }
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
            this.structs.set(node.name, { name: node.name, size, offsets, types });
        } else if (node instanceof ast.IfExpression) {
            this.compileExpression(node.condition);
            
            const thenJump = this.emitJump(OpCode.OP_JUMP_IF_FALSE);
            this.emitByte(OpCode.OP_POP); // pop condition
            
            this.beginScope();
            // TODO: pipeValue binding for `|item|` if present
            for (const stmt of node.body.statements) {
                this.compileStatement(stmt);
            }
            this.endScope();
            
            if (node.elseBody) {
                const elseJump = this.emitJump(OpCode.OP_JUMP);
                this.patchJump(thenJump);
                this.emitByte(OpCode.OP_POP); // pop condition from false path
                
                if (node.elseBody instanceof ast.BlockExpression) {
                    this.beginScope();
                    for (const stmt of node.elseBody.statements) {
                        this.compileStatement(stmt);
                    }
                    this.endScope();
                } else if (node.elseBody instanceof ast.IfExpression) {
                    this.compileStatement(node.elseBody);
                }
                this.patchJump(elseJump);
            } else {
                this.patchJump(thenJump);
                this.emitByte(OpCode.OP_POP); // pop condition from false path
            }
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
        } else if (node instanceof ast.ForExpression) {
            this.beginScope(); // Scope for init variables
            if (node.init) {
                this.compileStatement(node.init);
            }
            
            const loopStart = this.currentChunk().code.length;
            
            let exitJump = -1;
            if (node.condition) {
                this.compileExpression(node.condition);
                exitJump = this.emitJump(OpCode.OP_JUMP_IF_FALSE);
                this.emitByte(OpCode.OP_POP); // pop condition
            }
            
            this.beginScope();
            for (const stmt of node.body.statements) {
                this.compileStatement(stmt);
            }
            this.endScope();
            
            if (node.increment) {
                this.compileExpression(node.increment);
                this.emitByte(OpCode.OP_POP);
            }
            
            this.emitLoop(loopStart);
            
            if (exitJump !== -1) {
                this.patchJump(exitJump);
                this.emitByte(OpCode.OP_POP);
            }
            this.endScope(); // End init scope
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
                const idx = this.currentChunk().addConstant(node.value);
                this.emitBytes(OpCode.OP_MAKE_STRING, idx);
            } else if (node.literal_type === "boolean") {
                this.emitByte(node.value === "true" ? OpCode.OP_TRUE : OpCode.OP_FALSE);
            }
        } else if (node instanceof ast.PrimaryExpression) {
            if (node.kind === "Identifier" || node.kind === "Register") {
                this.resolveVariable(node.name);
            }
        } else if (node instanceof ast.AssignmentExpression) {
            if (node.left instanceof ast.IndexExpression) {
                this.compileExpression(node.left.object);
                this.compileExpression(node.left.index);
                this.compileExpression(node.right);
                this.emitByte(OpCode.OP_SET_INDEX);
            } else if (node.left instanceof ast.MemberExpression) {
                const typeName = this.resolveType(node.left.object);
                if (typeName) {
                    const structDef = this.structs.get(typeName);
                    if (structDef && node.left.property instanceof ast.PrimaryExpression) {
                        const offset = structDef.offsets.get(node.left.property.name);
                        const expectedType = structDef.types.get(node.left.property.name);
                        
                        if (offset !== undefined) {
                            const assignedType = this.resolveType(node.right);
                            if (expectedType && assignedType && expectedType !== assignedType) {
                                throw new Error(`Type mismatch: cannot assign type '${assignedType}' to field '${node.left.property.name}' of type '${expectedType}'`);
                            }
                            
                            this.compileExpression(node.left.object);
                            const offsetIdx = this.currentChunk().addConstant(offset);
                            this.emitBytes(OpCode.OP_CONSTANT, offsetIdx);
                            this.compileExpression(node.right);
                            this.emitByte(OpCode.OP_SET_INDEX);
                            return;
                        }
                    }
                }
                // Fallback to dynamic property set (modules, etc)
                this.compileExpression(node.left.object);
                this.compileExpression(node.right);
                if (node.left.property instanceof ast.PrimaryExpression && node.left.property.kind === "Identifier") {
                    const nameIdx = this.currentChunk().addConstant(node.left.property.name);
                    this.emitBytes(OpCode.OP_SET_PROPERTY, nameIdx);
                }
            } else {
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
                case "==": 
                    if (this.resolveType(node.left) === "string" && this.resolveType(node.right) === "string") {
                        this.emitByte(OpCode.OP_STRING_EQUAL);
                    } else {
                        this.emitByte(OpCode.OP_EQUAL);
                    }
                    break;
                case "!=": 
                    if (this.resolveType(node.left) === "string" && this.resolveType(node.right) === "string") {
                        this.emitByte(OpCode.OP_STRING_NOT_EQUAL);
                    } else {
                        this.emitByte(OpCode.OP_NOT_EQUAL);
                    }
                    break;
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
        } else if (node instanceof ast.IndexExpression) {
            this.compileExpression(node.object);
            this.compileExpression(node.index);
            this.emitByte(OpCode.OP_GET_INDEX);
        } else if (node instanceof ast.StructInitialization) {
            const structDef = this.structs.get(node.name);
            if (!structDef) throw new Error(`Unknown struct: ${node.name}`);
            
            const allocIdx = this.currentChunk().addConstant("__alloc");
            this.emitBytes(OpCode.OP_GET_GLOBAL, allocIdx);
            const sizeIdx = this.currentChunk().addConstant(structDef.size);
            this.emitBytes(OpCode.OP_CONSTANT, sizeIdx);
            this.emitBytes(OpCode.OP_CALL, 1);
            
            for (const field of node.fields) {
                const offset = structDef.offsets.get(field.name);
                const expectedType = structDef.types.get(field.name);
                
                if (offset === undefined) throw new Error(`Unknown field ${field.name}`);
                
                const assignedType = this.resolveType(field.value);
                if (expectedType && assignedType && expectedType !== assignedType) {
                    throw new Error(`Type mismatch in struct initialization: cannot assign type '${assignedType}' to field '${field.name}' of type '${expectedType}'`);
                }
                
                this.emitByte(OpCode.OP_DUP);
                
                const offsetIdx = this.currentChunk().addConstant(offset);
                this.emitBytes(OpCode.OP_CONSTANT, offsetIdx);
                
                this.compileExpression(field.value);
                
                this.emitByte(OpCode.OP_SET_INDEX);
                this.emitByte(OpCode.OP_POP);
            }
        } else if (node instanceof ast.MemberExpression) {
            const typeName = this.resolveType(node.object);
            if (typeName) {
                const structDef = this.structs.get(typeName);
                if (structDef && node.property instanceof ast.PrimaryExpression) {
                    const offset = structDef.offsets.get(node.property.name);
                    if (offset !== undefined) {
                        this.compileExpression(node.object);
                        const offsetIdx = this.currentChunk().addConstant(offset);
                        this.emitBytes(OpCode.OP_CONSTANT, offsetIdx);
                        this.emitByte(OpCode.OP_GET_INDEX);
                        return;
                    }
                }
            }
            
            // Fallback to dynamic property get
            this.compileExpression(node.object);
            if (node.property instanceof ast.PrimaryExpression && node.property.kind === "Identifier") {
                const nameIdx = this.currentChunk().addConstant(node.property.name);
                this.emitBytes(OpCode.OP_GET_PROPERTY, nameIdx);
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
        } else if (node instanceof ast.ImportNode) {
            let importPath = node.importPath;
            if (importPath === "std") {
                importPath = "std/index.lls";
            } else if (!importPath.endsWith(".lls")) {
                importPath += ".lls";
            }
            const fullPath = path.resolve(process.cwd(), importPath);
            if (fs.existsSync(fullPath)) {
                const source = fs.readFileSync(fullPath, "utf-8");
                const parser = new Parser();
                const doc = parser.parse(source, fullPath);
                for (const stmt of doc.statements) {
                    if (stmt instanceof ast.StructDeclaration || stmt instanceof ast.ImportNode) {
                        // Recursively compile declarations and nested imports to hoist structs
                        // We do this by temporarily disabling bytecode emission
                        const currentSize = this.currentChunk().code.length;
                        this.compileStatement(stmt);
                        // Revert bytecode emission since we only want to extract types
                        this.currentChunk().code.length = currentSize;
                    }
                }
            }

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
