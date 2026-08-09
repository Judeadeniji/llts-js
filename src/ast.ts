// others
import type { Location } from "./parser/nodes";
import type { AssignOps, BinOps, Literals, UnaryOps } from "./shared";

// ----------------------------------------------------------------------

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
	| "FunctionDeclaration"
	| "Params"
	| "BlockExpression"
	| "ReturnExpression"
	| "IfExpression"
	| "ForExpression"
	| "IndexExpression"
	| "StructDeclaration"
	| "StructInitialization"
	| "ArrayLiteral"
	| "BreakExpression"
	| "ContinueExpression"
	| "TryExpression"
	| "ErrorExpression"
	| "ExternDeclaration";

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
	public path: string = "<anonymous>";
	public source: string = "";

	constructor(
		public statements: Node[] = [],
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
	public isPublic: boolean = false;
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
		public kind: PrimaryExpressions,
		public name: string,
		override parent: Node | null = null,
		location?: Location,
	) {
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

	constructor(
		public object: Node,
		public property: Node,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class FunctionDeclaration extends Node {
	override readonly nodeName = "FunctionDeclaration";
	public isPublic = false;

	constructor(
		public name: string,
		public params: Params,
		public body: BlockExpression,
		public returnType: string | null = null,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class Params extends Node {
	override readonly nodeName = "Params";
	override parent: FunctionDeclaration | null = null;
	public isVariadic: boolean = false;

	constructor(
		public params: Node[],
		location?: Location,
	) {
		super(location);
		params.forEach((p) => { p.parent = this; });
	}
}

export class BlockExpression extends Node {
	override readonly nodeName = "BlockExpression";

	constructor(
		public statements: Node[],
		override parent: FunctionDeclaration | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class CallExpression extends Node {
	override readonly nodeName = "CallExpression";

	constructor(
		public callee: Node,
		public args: Node[],
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class ArrayLiteral extends Node {
	override readonly nodeName = "ArrayLiteral";

	constructor(
		public elements: Node[],
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class BinaryExpression extends Node {
	override readonly nodeName = "BinaryExpression";

	constructor(
		public left: Node,
		public operator: BinOps,
		public right: Node,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class UnaryExpression extends Node {
	override readonly nodeName = "UnaryExpression";

	constructor(
		public operator: UnaryOps,
		public arg: Node,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class AssignmentExpression extends Node {
	override readonly nodeName = "AssignmentExpression";

	constructor(
		public left: Node,
		public operator: AssignOps,
		public right: Node,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class CompilerNode extends Node {}

export class ImportNode extends CompilerNode {
	override readonly nodeName = "ImportNode";

	constructor(
		public importPath: string,
		location?: Location,
	) {
		super(location);
	}
}

export class ReturnExpression extends Node {
	override readonly nodeName = "ReturnExpression";

	constructor(
		public returnValue: Node | null,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}
export class BreakExpression extends Node {
	override readonly nodeName = "BreakExpression";
	constructor(
		public label: string | null = null,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class ContinueExpression extends Node {
	override readonly nodeName = "ContinueExpression";
	constructor(
		public label: string | null = null,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class IfExpression extends Node {
	override readonly nodeName = "IfExpression";

	constructor(
		public condition: Node,
		public pipeValue: Node | null,
		public body: BlockExpression,
		public elseBody: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class ForExpression extends Node {
	override readonly nodeName = "ForExpression";

	constructor(
		public kind: "condition" | "range" | "iterable",
		public condition: Node | null,
		public rangeStart: Node | null,
		public rangeEnd: Node | null,
		public iterable: Node | null,
		public captures: { name: string; byRef: boolean }[],
		public label: string | null,
		public body: BlockExpression,
		location?: Location,
	) {
		super(location);
	}
}

export class IndexExpression extends Node {
	override readonly nodeName = "IndexExpression";

	constructor(
		public object: Node,
		public index: Node,
		public typeAnnotation: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class StructDeclaration extends Node {
	override readonly nodeName = "StructDeclaration";
	public isPublic = false;

	constructor(
		public name: string,
		public fields: { name: string; type: Node | null }[],
		public methods: FunctionDeclaration[] = [],
		location?: Location,
	) {
		super(location);
	}
}

export class StructInitialization extends Node {
	override readonly nodeName = "StructInitialization";

	constructor(
		public name: string,
		public fields: { name: string; value: Node }[],
		location?: Location,
	) {
		super(location);
	}
}

export class TryExpression extends Node {
	override readonly nodeName = "TryExpression";

	constructor(
		public expression: Node,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class ErrorExpression extends Node {
	override readonly nodeName = "ErrorExpression";

	constructor(
		public message: Node,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}

export class ExternDeclaration extends Node {
	override readonly nodeName = "ExternDeclaration";
	isPublic?: boolean;

	constructor(
		public name: string,
		override parent: Node | null = null,
		location?: Location,
	) {
		super(location);
	}
}
