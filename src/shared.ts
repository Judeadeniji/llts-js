import type { CompilerKeywordToken, IToken } from "./scanner";

export enum CompilerSymbols {
    import = "import",
    const = "const",
    typeOf = "typeOf",
    func = "func",
}

export enum Literals {
    number = "number",
    string = "string",
    boolean = "boolean"
}

export enum BinOps {
    add = "+",
    sub = "-",
    mul = "*",
    div = "/",
    mod = "%",
    pow = "^",
    eq = "==",
    neq = "!=",
    gt = ">",
    gte = ">=",
    lt = "<",
    lte = "<=",
    and = "&&",
    or = "||",
}

export enum UnaryOps {
    not = "!",
    neg = "-",   // careful: '-' is overloaded
}

export enum AssignOps {
    assign = "=",
    addAssign = "+=",
    subAssign = "-=",
    mulAssign = "*=",
    divAssign = "/=",
    modAssign = "%=",
    powAssign = "^=",
    eqAssign = "==",
    neqAssign = "!=",
    gtAssign = ">=",
    gteAssign = ">=",
    ltAssign = "<=",
    lteAssign = "<=",
    andAssign = "&&=",
    orAssign = "||=",
    notAssign = "!=",
}

export const PRECEDENCE: Record<string, number> = {
    "=": 1,
    "+=": 1, "-=": 1,
    "||": 2,
    "&&": 3,
    "==": 4, "!=": 4,
    ">": 5, ">=": 5, "<": 5, "<=": 5,
    "+": 6, "-": 6,
    "*": 7, "/": 7, "%": 7,
    "^": 8
};


export type Operator = BinOps | UnaryOps | AssignOps;

export function isCompilerKeyword(token: string) {
    return token in CompilerSymbols;
}

export function isCompilerKeywordToken(token: IToken): token is CompilerKeywordToken {
    return token.type === "COMPILER_KEYWORD";
}