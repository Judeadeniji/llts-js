// others
import { compile } from "../compiler/index";
import { registerBuiltins } from "./builtins";
import { execute, call } from "./execute";
import { createVMState, type VMState } from "./state";
import * as ast from "../ast";

// ----------------------------------------------------------------------

export function run(document: ast.DocumentBody): VMState {
    const chunk = compile(document);
    
    const state = createVMState(chunk);
    registerBuiltins(state);

    execute(state);

    return state;
}

export class VM {
    public run(document: ast.DocumentBody) {
        run(document);
    }
}
