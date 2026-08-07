import * as ast from "../ast";
import type { CompilerState } from "./state";
import { resolveLocal } from "./scope";

export function resolveType(state: CompilerState, node: ast.Node): string | undefined {
    if (node instanceof ast.LiteralExpression) {
        if (node.literal_type === "string") return "string";
        if (node.literal_type === "boolean") return "boolean";
        return "int";
    }
    if (node instanceof ast.PrimaryExpression && (node.kind === "Identifier" || node.kind === "Register")) {
        let typeName: string | undefined;
        const localIdx = resolveLocal(state, node.name);
        if (localIdx !== -1) {
            typeName = state.locals[localIdx]?.typeName;
        } else {
            typeName = state.globalTypes.get(node.name);
        }
        
        if (typeName && typeName.includes(".")) {
            const parts = typeName.split(".");
            const modulePath = state.globalTypes.get("$" + parts[0]);
            if (modulePath && modulePath.startsWith("module:")) {
                typeName = modulePath.replace("module:", "") + "::" + parts[1];
            }
        }
        return typeName;
    } else if (node instanceof ast.MemberExpression) {
        const objectType = resolveType(state, node.object);
        if (objectType && node.property instanceof ast.PrimaryExpression && node.property.kind === "Identifier") {
            const structDef = state.structs.get(objectType);
            if (structDef) {
                return structDef.types.get(node.property.name);
            }
        }
    }
    return undefined;
}
