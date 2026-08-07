import * as ast from "../ast";
import { compile } from "../compiler/index";
import { createVMState, type VMState } from "./state";
import { registerBuiltins } from "./builtins";
import { execute, call } from "./execute";

export function run(document: ast.DocumentBody): VMState {
    const state = createVMState();
    registerBuiltins(state);

    const mainFunc = compile(document);
    
    state.stack.push(mainFunc);
    call(state, mainFunc, 0);
    execute(state);

    return state;
}

export class VM {
    public run(document: ast.DocumentBody) {
        run(document);
    }
}
