import { type VMState } from "./state";
import { type Value } from "../bytecode";

export function push(state: VMState, val: Value) {
    state.stack.push(val);
}

export function pop(state: VMState): Value {
    return state.stack.pop()!;
}

export function peek(state: VMState, dist: number): Value {
    return state.stack[state.stack.length - 1 - dist]!;
}
