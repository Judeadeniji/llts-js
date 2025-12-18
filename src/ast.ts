import type { Location } from "./parser/nodes";
import type { AssignOps, BinOps, Literals, UnaryOps } from "./shared";

export type NodeTypes =
  | "DocumentBody"
  | "Node"
  | "StringNode"
  | "DeclarationNode"
  | "LiteralNode"
  | "ImportNode"
  | "MemberExpression"
  | "CallExpression"
  | "PrimaryExpression"
  | "BinaryExpression"
  | "UnaryExpression"
  | "AssignmentExpression"

export type PrimaryExpressions =
  | "Literal"
  | "Register"
  | "Memory"
  | "Immediate"
  | "Identifier";

export interface AST {
  loc?: Location;
  parent: Node | null;
  nodeName: string;
}

export class Node implements AST {
  loc?: Location;
  document: Node | null = null;
  nodeName: NodeTypes = "Node";

  constructor(
    location?: Location,
    public parent: Node | null = null,
  ) {
    this.loc = location;
  }
}

export class DocumentBody extends Node {
  override readonly nodeName = "DocumentBody";

  constructor(
    public children: Node[] = [],
    location?: Location,
  ) {
    super(location);
    this.document = this;
    this.parent = null;
  }
}

export class StringNode extends Node {
  override readonly nodeName = "StringNode";
}

export class DeclarationExpression extends Node {
  override readonly nodeName = "DeclarationNode";
  constructor(
    public name: string,
    public value: Node,
    public isConst = false,
    override parent: Node | null = null,
    public type?: Node,
    location?: Location,
  ) {
    super(location);
  }
}

export class PrimaryExpression extends Node {
  override readonly nodeName = "PrimaryExpression";

  constructor(
    public kind: PrimaryExpressions, public name: string, override parent: Node | null = null, location?: Location) {
    super(location);
  }
}

export class LiteralExpression extends Node {
  override readonly nodeName = "LiteralNode";
  constructor(
    public literal_type: Literals,
    public value: string,
    override parent: Node | null = null,
    public type?: string,
    location?: Location,
  ) {
    super(location);
  }
}

export class MemberExpression extends Node {
  override readonly nodeName = "MemberExpression";

  constructor(public object: Node, public property: Node, override parent: Node | null = null, location?: Location) {
    super(location);
  }
}

export class CallExpression extends Node {
  override readonly nodeName = "CallExpression";

  constructor(public callee: Node, public args: Node[], override parent: Node | null = null, location?: Location) {
    super(location);
  }
}

export class BinaryExpression extends Node {
  override readonly nodeName = "BinaryExpression";

  constructor(public left: Node, public operator: BinOps, public right: Node, override parent: Node | null = null, location?: Location) {
    super(location);
  }
}

export class UnaryExpression extends Node {
  override readonly nodeName = "UnaryExpression";

  constructor(public operator: UnaryOps, public arg: Node, override parent: Node | null = null, location?: Location) {
    super(location);
  }
}

export class AssignmentExpression extends Node {
  override readonly nodeName = "AssignmentExpression";

  constructor(public left: Node, public operator: AssignOps, public right: Node, override parent: Node | null = null, location?: Location) {
    super(location);
  }
}

export class CompilerNode extends Node { }

export class ImportNode extends CompilerNode {
  override readonly nodeName = "ImportNode";

  constructor(
    public importPath: string,
    location?: Location,
  ) {
    super(location);
  }
}
