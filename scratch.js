import { scan } from "./src/scanner.ts";
import fs from "node:fs";
const content = fs.readFileSync("./examples/loop_test.lls", "utf-8");
console.log(scan(content, "loop_test.lls").tokens.map(t => t.type + ":" + t.value).slice(10, 40));
