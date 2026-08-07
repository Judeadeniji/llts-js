import * as ast from "./src/ast";
function test(node: ast.Node) {
    switch (node.nodeName) {
        case "FunctionDeclaration":
            console.log(node.name);
            break;
    }
}
