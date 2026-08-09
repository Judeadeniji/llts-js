// others
import { compile } from "../compiler/index";
import type { CompilerState } from "../compiler/state";
import { registerBuiltins } from "./builtins";
import { execute } from "./execute";
import { createVMState, type VMState } from "./state";
import type * as ast from "../ast";

// ----------------------------------------------------------------------

export function run(document: ast.DocumentBody, parentState?: VMState): { vmState: VMState, compilerState: CompilerState } {
	const { chunk, compilerState } = compile(document);

	const state = createVMState(chunk, parentState);
	registerBuiltins(state);

	execute(state);

	return { vmState: state, compilerState };
}

export class VM {
	public run(document: ast.DocumentBody) {
		run(document);
	}
}
