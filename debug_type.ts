import { Parser } from "./src/parser";
import { createCompilerState } from "./src/compiler/state";
const parser = new Parser();
const ast = parser.parse("@struct Player { x: int; } @func printStatus(p: Player) { print(p.x); }", "test.lls");
const state = createCompilerState();
const st = require("./src/compiler/statements");
st.compileStatement(state, ast.statements[0]);
st.compileStatement(state, ast.statements[1]);
console.log(state.chunks[1].code);
