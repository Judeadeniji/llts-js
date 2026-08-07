import * as ast from "../ast";
import { OpCode } from "../bytecode";
import { type CompilerState, currentChunk } from "./state";
import { emitByte, emitBytes, emitConstant, emitJump, patchJump } from "./emit";
import { resolveVariable, resolveLocal } from "./scope";
import { resolveType } from "./types";
import { compileStatement } from "./statements";

export function compileExpression(state: CompilerState, node: ast.Node) {
    if (node instanceof ast.LiteralExpression) {
        if (node.literal_type === "number") {
            emitConstant(state, parseFloat(node.value));
        } else if (node.literal_type === "string") {
            const idx = currentChunk(state).addConstant(node.value);
            emitBytes(state, OpCode.OP_MAKE_STRING, idx);
        } else if (node.literal_type === "boolean") {
            emitByte(state, node.value === "true" ? OpCode.OP_TRUE : OpCode.OP_FALSE);
        }
    } else if (node instanceof ast.PrimaryExpression) {
        if (node.kind === "Identifier" || node.kind === "Register") {
            resolveVariable(state, node.name);
        }
    } else if (node instanceof ast.AssignmentExpression) {
        if (node.left instanceof ast.IndexExpression) {
            compileExpression(state, node.left.object);
            compileExpression(state, node.left.index);
            compileExpression(state, node.right);
            emitByte(state, OpCode.OP_SET_INDEX);
        } else if (node.left instanceof ast.MemberExpression) {
            const typeName = resolveType(state, node.left.object);
            if (typeName) {
                const structDef = state.structs.get(typeName);
                if (structDef && node.left.property instanceof ast.PrimaryExpression) {
                    const offset = structDef.offsets.get(node.left.property.name);
                    const expectedType = structDef.types.get(node.left.property.name);
                    
                    if (offset !== undefined) {
                        const assignedType = resolveType(state, node.right);
                        if (expectedType && assignedType && expectedType !== assignedType) {
                            throw new Error(`Type mismatch: cannot assign type '${assignedType}' to field '${node.left.property.name}' of type '${expectedType}'`);
                        }
                        
                        compileExpression(state, node.left.object);
                        const offsetIdx = currentChunk(state).addConstant(offset);
                        emitBytes(state, OpCode.OP_CONSTANT, offsetIdx);
                        compileExpression(state, node.right);
                        emitByte(state, OpCode.OP_SET_INDEX);
                        return;
                    }
                }
            }
            compileExpression(state, node.left.object);
            compileExpression(state, node.right);
            if (node.left.property instanceof ast.PrimaryExpression && node.left.property.kind === "Identifier") {
                const nameIdx = currentChunk(state).addConstant(node.left.property.name);
                emitBytes(state, OpCode.OP_SET_PROPERTY, nameIdx);
            }
        } else {
            compileExpression(state, node.right);
            if (node.left instanceof ast.PrimaryExpression && (node.left.kind === "Identifier" || node.left.kind === "Register")) {
                const arg = resolveLocal(state, node.left.name);
                if (arg !== -1) {
                    emitBytes(state, OpCode.OP_SET_LOCAL, arg);
                } else {
                    const nameIdx = currentChunk(state).addConstant(node.left.name);
                    emitBytes(state, OpCode.OP_SET_GLOBAL, nameIdx);
                }
            }
        }
    } else if (node instanceof ast.BinaryExpression) {
        if (node.operator === "&&") {
            compileExpression(state, node.left);
            const endJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
            emitByte(state, OpCode.OP_POP);
            compileExpression(state, node.right);
            patchJump(state, endJump);
            return;
        }
        if (node.operator === "||") {
            compileExpression(state, node.left);
            const elseJump = emitJump(state, OpCode.OP_JUMP_IF_FALSE);
            const endJump = emitJump(state, OpCode.OP_JUMP);
            patchJump(state, elseJump);
            emitByte(state, OpCode.OP_POP);
            compileExpression(state, node.right);
            patchJump(state, endJump);
            return;
        }
        if (node.operator === "|>") {
            if (node.right instanceof ast.CallExpression) {
                compileExpression(state, node.right.callee);
                compileExpression(state, node.left);
                for (const arg of node.right.args) {
                    compileExpression(state, arg);
                }
                emitBytes(state, OpCode.OP_CALL, node.right.args.length + 1);
            } else {
                compileExpression(state, node.right);
                compileExpression(state, node.left);
                emitBytes(state, OpCode.OP_CALL, 1);
            }
            return;
        }
        
        compileExpression(state, node.left);
        compileExpression(state, node.right);
        
        switch (node.operator) {
            case "+": emitByte(state, OpCode.OP_ADD); break;
            case "-": emitByte(state, OpCode.OP_SUB); break;
            case "*": emitByte(state, OpCode.OP_MUL); break;
            case "/": emitByte(state, OpCode.OP_DIV); break;
            case "%": emitByte(state, OpCode.OP_MOD); break;
            case "**": emitByte(state, OpCode.OP_POW); break;
            case "==": 
                if (resolveType(state, node.left) === "string" && resolveType(state, node.right) === "string") {
                    emitByte(state, OpCode.OP_STRING_EQUAL);
                } else {
                    emitByte(state, OpCode.OP_EQUAL);
                }
                break;
            case "!=": 
                if (resolveType(state, node.left) === "string" && resolveType(state, node.right) === "string") {
                    emitByte(state, OpCode.OP_STRING_NOT_EQUAL);
                } else {
                    emitByte(state, OpCode.OP_NOT_EQUAL);
                }
                break;
            case "<": emitByte(state, OpCode.OP_LESS); break;
            case "<=": emitByte(state, OpCode.OP_LESS_EQUAL); break;
            case ">": emitByte(state, OpCode.OP_GREATER); break;
            case ">=": emitByte(state, OpCode.OP_GREATER_EQUAL); break;
        }
    } else if (node instanceof ast.UnaryExpression) {
        compileExpression(state, node.arg);
        switch (node.operator) {
            case "-": emitByte(state, OpCode.OP_NEGATE); break;
            case "!": emitByte(state, OpCode.OP_NOT); break;
        }
    } else if (node instanceof ast.IndexExpression) {
        compileExpression(state, node.object);
        compileExpression(state, node.index);
        emitByte(state, OpCode.OP_GET_INDEX);
    } else if (node instanceof ast.StructInitialization) {
        let structName = node.name;
        if (structName.includes(".")) {
            const parts = structName.split(".");
            const modulePath = state.globalTypes.get("$" + parts[0]);
            if (modulePath && modulePath.startsWith("module:")) {
                structName = modulePath.replace("module:", "") + "::" + parts[1];
            }
        }
        
        const structDef = state.structs.get(structName);
        if (!structDef) throw new Error(`Unknown struct: ${structName} (original: ${node.name})`);
        
        const allocIdx = currentChunk(state).addConstant("__alloc");
        emitBytes(state, OpCode.OP_GET_GLOBAL, allocIdx);
        const sizeIdx = currentChunk(state).addConstant(structDef.size);
        emitBytes(state, OpCode.OP_CONSTANT, sizeIdx);
        emitBytes(state, OpCode.OP_CALL, 1);
        
        for (const field of node.fields) {
            const offset = structDef.offsets.get(field.name);
            const expectedType = structDef.types.get(field.name);
            
            if (offset === undefined) throw new Error(`Unknown field ${field.name}`);
            
            const assignedType = resolveType(state, field.value);
            if (expectedType && assignedType && expectedType !== assignedType) {
                throw new Error(`Type mismatch in struct initialization: cannot assign type '${assignedType}' to field '${field.name}' of type '${expectedType}'`);
            }
            
            emitByte(state, OpCode.OP_DUP);
            
            const offsetIdx = currentChunk(state).addConstant(offset);
            emitBytes(state, OpCode.OP_CONSTANT, offsetIdx);
            
            compileExpression(state, field.value);
            
            emitByte(state, OpCode.OP_SET_INDEX);
            emitByte(state, OpCode.OP_POP);
        }
    } else if (node instanceof ast.MemberExpression) {
        let typeName = resolveType(state, node.object);
        if (typeName) {
            if (typeName.includes(".")) {
                const parts = typeName.split(".");
                const modulePath = state.globalTypes.get("$" + parts[0]);
                if (modulePath && modulePath.startsWith("module:")) {
                    typeName = modulePath.replace("module:", "") + "::" + parts[1];
                }
            }
            
            const structDef = state.structs.get(typeName);
            if (structDef && node.property instanceof ast.PrimaryExpression) {
                const offset = structDef.offsets.get(node.property.name);
                if (offset !== undefined) {
                    compileExpression(state, node.object);
                    const offsetIdx = currentChunk(state).addConstant(offset);
                    emitBytes(state, OpCode.OP_CONSTANT, offsetIdx);
                    emitByte(state, OpCode.OP_GET_INDEX);
                    return;
                }
            }
        }
        
        compileExpression(state, node.object);
        if (node.property instanceof ast.PrimaryExpression && node.property.kind === "Identifier") {
            const nameIdx = currentChunk(state).addConstant(node.property.name);
            emitBytes(state, OpCode.OP_GET_PROPERTY, nameIdx);
        }
    } else if (node instanceof ast.CallExpression) {
        if (node.callee instanceof ast.PrimaryExpression && node.callee.name === "print") {
            for (const arg of node.args) {
                compileExpression(state, arg);
            }
            emitBytes(state, OpCode.OP_PRINT, node.args.length);
            return;
        }

        compileExpression(state, node.callee);
        for (const arg of node.args) {
            compileExpression(state, arg);
        }
        emitBytes(state, OpCode.OP_CALL, node.args.length);
    } else if (node instanceof ast.ImportNode) {
        let importPath = node.importPath;
        if (importPath === "std") {
            importPath = "std/index.lls";
        } else if (!importPath.endsWith(".lls")) {
            importPath += ".lls";
        }
        const fullPath = require("path").resolve(process.cwd(), importPath);
        if (require("fs").existsSync(fullPath)) {
            const source = require("fs").readFileSync(fullPath, "utf-8");
            const parser = new (require("../parser").Parser)();
            const doc = parser.parse(source, fullPath);
            for (const stmt of doc.statements) {
                if (stmt instanceof ast.StructDeclaration) {
                    if (stmt.isPublic) {
                        const origName = stmt.name;
                        stmt.name = `${node.importPath}::${origName}`;
                        
                        const currentSize = currentChunk(state).code.length;
                        compileStatement(state, stmt);
                        currentChunk(state).code.length = currentSize;
                        
                        stmt.name = origName;
                    }
                } else if (stmt instanceof ast.ImportNode) {
                    const currentSize = currentChunk(state).code.length;
                    compileStatement(state, stmt);
                    currentChunk(state).code.length = currentSize;
                }
            }
        }

        const nameIdx = currentChunk(state).addConstant(node.importPath);
        emitBytes(state, OpCode.OP_IMPORT, nameIdx);
    }
}
