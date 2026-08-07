import * as ast from "../ast";
import { CompilerState } from "./state";
import { resolveLocal } from "./scope";

export function resolveType(state: CompilerState, node: ast.Node): string | undefined {
    switch (node.nodeName) {
        case "LiteralNode": {
            const lit = node as ast.LiteralExpression;
            if (lit.literal_type === "string") return "string";
            if (lit.literal_type === "boolean") return "boolean";
            return "int";
        }
        case "PrimaryExpression": {
            const prim = node as ast.PrimaryExpression;
            if (prim.kind === "Identifier" || prim.kind === "Register") {
                let typeName: string | undefined;
                const localIdx = resolveLocal(state, prim.name);
                if (localIdx !== -1) {
                    typeName = state.locals[localIdx]?.typeName;
                } else {
                    typeName = state.globalTypes.get(prim.name);
                }
                
                if (typeName && typeName.includes(".")) {
                    const parts = typeName.split(".");
                    const modulePath = state.globalTypes.get("$" + parts[0]);
                    if (modulePath && modulePath.startsWith("module:")) {
                        typeName = modulePath.replace("module:", "") + "::" + parts[1];
                    }
                }
                return typeName;
            }
            break;
        }
        case "MemberExpression": {
            const mem = node as ast.MemberExpression;
            const objectType = resolveType(state, mem.object);
            if (objectType && mem.property.nodeName === "PrimaryExpression" && (mem.property as ast.PrimaryExpression).kind === "Identifier") {
                const structDef = state.structs.get(objectType);
                if (structDef) {
                    return structDef.types.get((mem.property as ast.PrimaryExpression).name);
                }
            }
            break;
        }
    }
    return undefined;
}
