import { Parser } from "./src/parser";
import { CompilerState } from "./src/compiler/state";
import { compileFunction } from "./src/compiler/statements";
const parser = new Parser();
const ast = parser.parse("@struct Player { x: int; } @func printStatus(p: Player) { print(p.x); }", "test.lls");
const state = new CompilerState();
const st = require("./src/compiler/statements");
st.compileStatement(state, ast.statements[0]);

// Intercept state.locals.push
const originalPush = state.locals.push;
state.locals.push = function(...args) {
    console.log("Pushing local:", args);
    return originalPush.apply(this, args);
};

st.compileStatement(state, ast.statements[1]);
