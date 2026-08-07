import { Parser } from "./src/parser";
const parser = new Parser();
const ast = parser.parse("@func f(p: Player) {}", "test.lls");
const f = ast.statements[0] as any;
const p = f.params.params[0];
console.log(p.nodeName);
console.log(p.name);
if (p.typeNode || p.type) {
  console.log("type field:", (p.typeNode || p.type).nodeName, (p.typeNode || p.type).name);
}
