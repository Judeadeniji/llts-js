import { AssignOps, BinOps, CompilerSymbols, UnaryOps } from "./shared";

// 1. --- TYPES & DEFINITIONS ---
export type TokenType =
    | "KEYWORD"
    | "IDENTIFIER"
    | "V_REGISTER"
    | "COMPILER_KEYWORD"
    | "STRING"
    | "NUMBER"
    | "HEX"
    | "OCTAL"
    | "FLOAT"
    | "BOOLEAN"
    | "DELIMITER"
    | "TYPE_DECL"
    | "BIN_OP"
    | "UNARY_OP"
    | "ASSIGN_OP"
    | "EOF";

export interface IToken {
    type: TokenType;
    value: string;
    line: number;
    column: number;
}

export type CompilerError = {
    line: number;
    column: number;
    message: string;
};

export type ScanResult = {
    tokens: Token[];
    errors: CompilerError[];
};

export class Token implements IToken {
    constructor(
        public column: number,
        public line: number,
        public type: TokenType,
        public value: string,
    ) { }
}

export class CompilerKeywordToken extends Token {
    override readonly type = "COMPILER_KEYWORD";
    override value: CompilerSymbols;
    constructor(
        column: number,
        line: number,
        value: CompilerSymbols,
    ) {
        super(column, line, "COMPILER_KEYWORD", value);
        this.value = value;
    }
}

enum Keywords {
    true = "true",
    false = "false",
    return = "return"
}

const Delimiters = {
    COMMA: ",",
    SEMICOLON: ";",
    COLON: ":",
    LEFT_PAREN: "(",
    RIGHT_PAREN: ")",
    LEFT_BRACE: "{",
    RIGHT_BRACE: "}",
    DOT: "."
} as const;

// 2. --- HELPERS ---

const isAlpha = (char: string) => /[a-zA-Z_]/.test(char);
const isDigit = (char: string) => /[0-9]/.test(char);
const isAlphaNumeric = (char: string) => /[a-zA-Z0-9_]/.test(char);
const isKeyword = (w: string): boolean => w in Keywords;
// compiler keywords e.g @sizeOf, @import, @include, etc. 
const isCompilerKeyword = (w: string): boolean => w === "@";
const isBool = (w: string) => (w === "true" || w === "false");
const isDelimiter = (char: string) => Object.values(Delimiters).includes(char as any);

// ANSI Colors for the console
const colors = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
    bold: "\x1b[1m"
};

// 3. --- ERROR REPORTER ---

export function reportError(path: string, source: string, line: number, column: number, message: string) {
    const lines = source.split('\n');
    const lineIndex = line - 1;
    const lineContent = lines[lineIndex];

    if (typeof lineContent === 'undefined') {
        console.error(`${path}: ${colors.red}Error:${colors.reset} ${message} (at line ${line})`);
        return;
    }

    const lineNumberStr = line.toString();
    const gutterPadding = " ".repeat(lineNumberStr.length);
    const pointerPadding = " ".repeat(Math.max(0, column - 1));
    const error = new Error();
    error.name = "LLTS Error";
    error.message = `\n${path}: ${colors.red}${colors.bold}Error:${colors.reset} ${message}`;

    console.log(`${colors.gray}   ${line - 1} |${colors.reset} ${lines[lineIndex - 1]}`);
    console.log(`${colors.cyan}  ${gutterPadding}--> line ${line}:${column}${colors.reset}`);
    console.log(`${colors.gray}   ${lineNumberStr} |${colors.reset} ${lineContent}`);
    console.log(`${colors.gray}   ${gutterPadding} |${colors.reset} ${pointerPadding}${colors.red}^${colors.reset}`);
    console.log(`${colors.gray}   ${line + 1} |${colors.reset} ${lines[lineIndex + 1]}`);
    console.log(error.stack);
}

/**
 * Asserts a condition, if the condition is false, it reports an error and exits the program.
 * @param path The path to the source file.
 * @param source The source code.
 * @param condition The condition to assert.
 * @param msg The error message.
 * @param line The line number.
 * @param column The column number.
 */
export function assert(path: string, source: string, condition: boolean, msg: string, line: number, column: number) {
    if (!condition) {
        reportError(path, source, line, column, msg);
        process.exit(1);
    }
}

// 4. --- THE SCANNER ---
export function scan(source: string, path: string): ScanResult {
    const tokens: Token[] = [];
    const errors: CompilerError[] = [];

    // Create Reverse Lookup Maps (Symbol -> Key Name)
    // This allows us to turn "+" into "ADD" or "PLUS"
    // function createReverseMap(obj: Record<string, string>) {
    //     return Object.fromEntries(Object.entries(obj).map(([k, v]) => [v, k]));
    // }

    // const BinOpMap = createReverseMap(BinOps);
    // const UnaryOpMap = createReverseMap(UnaryOps);
    // const AssignOpMap = createReverseMap(AssignOps);

    // Sets for quick existence checking (same as before)
    const BinOpValues = new Set(Object.values(BinOps));
    const UnaryOpValues = new Set(Object.values(UnaryOps));
    const AssignOpValues = new Set(Object.values(AssignOps));
    let pos = 0;
    let line = 1;
    let column = 1;

    const advance = () => {
        const ch = source[pos++];
        if (ch === '\n') { line++; column = 1; }
        else column++;
        return ch;
    };

    const peek = (
        step = 0
    ) => (pos < source.length ? source[pos + step] : null);
    const previousToken = () => tokens[tokens.length - 1];

    const error = (msg: string, l = line, c = column) => {
        reportError(path, source, l, c, msg);
        process.exit(1);
    };

    const handleTypeDecl = () => {
        const startCol = column;
        advance(); // ':'
        while (peek() && /\s/.test(peek()!)) advance();

        let type = "";
        while (peek() && !/\s/.test(peek()!) && peek() !== '%' && peek() !== '\n') {
            type += advance();
        }
        if (!type) error("Expected type after ':'", line, startCol);

        tokens.push(new Token(startCol, line, "TYPE_DECL", type));
        while (peek() && /\s/.test(peek()!)) advance();
    };

    const scanString = () => {
        const quote = advance();
        const startCol = column - 1;
        let value = "";

        while (peek() !== quote && peek() !== null) {
            if (peek() === '\n') error("String cannot span multiple lines", line, column);
            value += advance();
        }
        if (peek() === null) error("Unterminated string literal", line, startCol);
        advance();
        tokens.push(new Token(startCol, line, "STRING", value));
    };

    const scanNumber = () => {
        const startCol = column;
        let num = "";

        // Check for Bases: Hex (0x), Binary (0b), Octal (0o)
        if (peek() === '0') {
            const next = peek(1);
            
            // Hexadecimal
            if (next === 'x' || next === 'X') {
                num += advance(); // 0
                num += advance(); // x
                while (peek() && /[0-9a-fA-F]/.test(peek()!)) {
                    num += advance();
                }
                tokens.push(new Token(startCol, line, "HEX", num));
                return;
            }

            // Binary
            if (next === 'b' || next === 'B') {
                num += advance(); // 0
                num += advance(); // b
                while (peek() && /[0-1]/.test(peek()!)) {
                    num += advance();
                }
                tokens.push(new Token(startCol, line, "BINARY", num));
                return;
            }

            // Octal
            if (next === 'o' || next === 'O') {
                num += advance(); // 0
                num += advance(); // o
                while (peek() && /[0-7]/.test(peek()!)) {
                    num += advance();
                }
                tokens.push(new Token(startCol, line, "OCTAL", num));
                return;
            }
        }

        // Standard Integer
        while (peek() && isDigit(peek()!)) {
            num += advance();
        }

        // Floating Point
        // We only consume the dot if it is strictly followed by a digit.
        // This handles "1.5" correctly, while leaving "1.toString()" for the dot delimiter.
        if (peek() === '.' && peek(1) && isDigit(peek(1)!)) {
            num += advance(); // consume '.'
            while (peek() && isDigit(peek()!)) {
                num += advance();
            }
        }

        tokens.push(new Token(startCol, line, "NUMBER", num));
    };


    const scanIdentifierOrKeyword = () => {
        const startCol = column;
        let word = "";
        while (peek() && isAlphaNumeric(peek()!)) word += advance();

        if (isBool(word)) {
            tokens.push(new Token(startCol, line, "BOOLEAN", word));
            return;
        }

        if (!word) return;

        tokens.push(new Token(startCol, line, isKeyword(word) ? "KEYWORD" : "IDENTIFIER", word));
    };

    const scanRegister = () => {
        const startCol = column;
        advance(); // '$'
        let name = "";
        while (peek() && isAlphaNumeric(peek()!)) name += advance();
        // if (peek() === " ") return scanNext();
        if (!name) error(`Expected register name after '$' but found "${peek()}" instead`, line, column);
        if (peek() === ':') handleTypeDecl();
        tokens.push(new Token(startCol, line, "V_REGISTER", name));
    };

    const scanCompilerKeyword = () => {
        const startCol = column;
        advance(); // '@'
        let kw = "";
        while (peek() && isAlphaNumeric(peek()!)) kw += advance();
        if (!kw) error("Expected keyword after '@'", line, column);

        assert(
            path,
            source,
            kw in CompilerSymbols,
            `Expected compiler keyword after "@":\n    "@${kw}" is not a compiler keyword`,
            line,
            startCol
        );
        tokens.push(new CompilerKeywordToken(startCol, line, kw as CompilerSymbols));
    };

    const scanDelimiter = () => {
        const char = peek();
        if (!char) return;
        if (!isDelimiter(char)) return;
        tokens.push({ type: "DELIMITER", value: peek()!, line, column } as Token);
        advance();
    };

    const skipComment = () => {
        while (peek() !== '\n' && peek() !== null) advance();
    };

    // --- MEMBER & CALL EXPRESSION SUPPORT ---

    const scanMemberExpression = () => {
        // assumes previous token is IDENTIFIER or V_REGISTER
        const base = previousToken();
        if (!base) error('Invalid member expression', line, column);
        if (base?.type !== "V_REGISTER" && base?.type !== "IDENTIFIER") {
            error('Invalid member expression', line, column);
        }

        while (peek() === '.') {
            scanDelimiter();
            if (!peek() || !isAlphaNumeric(peek()!)) {
                error('Expected identifier after "."', line, column);
            }
            scanIdentifierOrKeyword();
        }
    };

    // --- RECURSIVE CORE ---
    const scanNext = (): void => {
        if (pos >= source.length) return;

        const ch = peek();
        if (ch === null || ch === undefined) return;

        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
            advance();
            return scanNext();
        }

        if (ch === '#') {
            skipComment();
            return scanNext();
        }

        if (ch === '"' || ch === "'") {
            scanString();
            return scanNext();
        }

        if (Object.values(Delimiters).includes(ch as any)) {
            scanDelimiter();
            return scanNext();
        }

        if (ch === '$') {
            scanRegister();
            if (peek() === '.') scanMemberExpression();
            return scanNext();
        }

        if (isCompilerKeyword((ch))) {
            scanCompilerKeyword();
            return scanNext();
        }

        if (isDigit(ch)) {
            scanNumber();
            return scanNext();
        }

        if (isAlpha(ch)) {
            scanIdentifierOrKeyword();
            if (peek() === '.') scanMemberExpression();
            return scanNext();
        }

        // Check two-char operators (like >=, <=, ==, !=, &&, ||)
        const twoCharOp = ch + peek(1);

        if (AssignOpValues.has(twoCharOp as AssignOps)) {
            const startCol = column;
            advance();
            advance();
            tokens.push(new Token(startCol, line, "ASSIGN_OP", twoCharOp));
            return scanNext();
        }

        if (BinOpValues.has(twoCharOp as BinOps)) {
            const startCol = column;
            advance();
            advance();

            tokens.push(new Token(startCol, line, BinOpValues.has(twoCharOp as BinOps) ? "BIN_OP" : "UNARY_OP", twoCharOp));
            return scanNext();
        }

        if (BinOpValues.has(ch as BinOps) || UnaryOpValues.has(ch as UnaryOps) ||
            AssignOpValues.has(ch as AssignOps)) {
            const startCol = column;
            let op = advance() || "";

            tokens.push(new Token(startCol, line, BinOpValues.has(op as BinOps) ? "BIN_OP" : AssignOpValues.has(op as AssignOps) ? "ASSIGN_OP" : "UNARY_OP", op));
            return scanNext();
        }



        error(`Unexpected character: '${ch}'`, line, column);
        advance();
        scanNext();
    };

    scanNext();

    tokens.push(new Token(column, line, "EOF", ""));
    return { tokens, errors };
}
