import fs from "node:fs";
import { assert, reportError, scan, type Token, type TokenType } from "../scanner";
import { AssignmentExpression, BinaryExpression, CallExpression, DeclarationExpression, DocumentBody, ImportNode, LiteralExpression, MemberExpression, Node, PrimaryExpression, UnaryExpression, type AST } from "../ast"; // Assuming you have these AST nodes
import { AssignOps, BinOps, CompilerKeywords, isCompilerKeywordToken, Literals, PRECEDENCE, UnaryOps } from "../shared";

export class Parser {
    private tokens: Token[] = [];
    private current = 0; // Point to the current token
    private sourceFile?: Bun.BunFile;
    private source: string = "";

    // 1. HELPER: Look at current token without consuming
    private peek(): Token | null {
        return this.tokens[this.current] || null;
    }

    // 2. HELPER: Look at previous token
    private previous(): Token | null {
        return this.tokens[this.current - 1] || null;
    }

    // 3. HELPER: Consume token if it matches type, otherwise throw error
    private consume(type: TokenType, message: string, value?: string) {

        if (value) {
            const t = this.peek()!;
            assert(this.sourceFile?.name!, this.source, (t.value === value && this.check(type)) || t.type === "EOF", message, t.line, t.column);
            return this.advance();
        }

        if (this.check(type)) {
            return this.advance();
        }

        const next = this.peek();
        if (!next) return null;
        throw new Error(`${message} at line ${next.line}`);
    }

    private check(type: TokenType): boolean {
        if (this.isAtEnd()) return false;

        const next = this.peek();
        if (!next) return false;
        return next.type === type;
    }

    private advance() {
        if (!this.isAtEnd()) this.current++;
        return this.previous();
    }

    private isAtEnd(): boolean {
        const next = this.peek();
        if (!next) return true;
        return next.type === "EOF";
    }

    // --- PARSING LOGIC ---

    // The entry point for building the AST
    private buildAst(): DocumentBody {
        const statements: Node[] = [];

        while (!this.isAtEnd()) {
            const statement = this.parseStatement();
            if (statement) statements.push(statement);
        }

        return new DocumentBody(statements);
    }

    // Decides what kind of statement we are looking at
    private parseStatement(): Node {
        const token = this.peek()!;

        console.log({ token })

        switch (token.type) {
            case "V_REGISTER":
                return this.parseDeclaration();
            case "BIN_OP":
            case "UNARY_OP":
            case "ASSIGN_OP":
            case "IDENTIFIER":
            case "STRING":
            case "NUMBER":
                return this.parseExpressionStatement();

            case "COMPILER_KEYWORD":
                return this.parseCompilerKeyword();
            default:
                reportError(this.sourceFile?.name!, this.source, token.line, token.column, `Unexpected token: ${token.value} at line ${token.line}`);
                process.exit(1);
        }
    }

    private parseExpressionStatement(): Node {
        const expr = this.parseExpression();
        console.log({ p: this.peek() })
        this.consume(
            "DELIMITER",
            `Expected ';' after expression, found "${this.peek()!.value}" instead`,
            ";"
        );
        return expr;
    }

    private parseExpression(): Node {
        return this.parseAssignment();
    }

    private parseAssignment(): Node {
        const left = this.parseBinary(0);

        const tok = this.peek();
        if (tok?.type === "ASSIGN_OP") {
            this.advance();
            const right = this.parseAssignment();

            return new AssignmentExpression(left, tok.value as AssignOps, right, null, left.loc)
        }

        return left;
    }

    private parseBinary(minPrec: number): Node {
        let left = this.parseUnary();

        while (true) {
            const tok = this.peek();
            if (!tok || tok.type !== "BIN_OP") break;

            const prec = PRECEDENCE[tok.value];
            if (prec === undefined || prec < minPrec) break;

            this.advance(); // eat operator

            const right = this.parseBinary(prec + 1); // ← critical line

            left = new BinaryExpression(left, tok.value as BinOps, right, null, left.loc)
        }

        return left;
    }

    private parseUnary(): Node {
        const tok = this.peek();

        // Check for explicit UNARY_OPs (like '!' or '~' if you have them)
        if (tok?.type === "UNARY_OP") {
            this.advance();
            const expr = this.parseUnary();
            return new UnaryExpression(tok.value as UnaryOps, expr, null, expr.loc);
        }

        // FIX: Also check for BIN_OPs that are valid in unary position (+ and -)
        if (tok?.type === "BIN_OP" && (tok.value === "+" || tok.value === "-")) {
            this.advance();
            const expr = this.parseUnary();
            return new UnaryExpression(tok.value as UnaryOps, expr, null, expr.loc);
        }

        return this.parsePostfix();
    }

    private parsePostfix(): Node {
        let expr = this.parsePrimary();

        while (true) {
            const tok = this.peek();

            if (tok?.type === "DELIMITER" && tok.value === "(") {
                expr = this.finishCall(expr);
                continue;
            }

            if (tok?.type === "DELIMITER" && tok.value === ".") {
                this.advance();
                const prop = this.consume("IDENTIFIER", "Expected property name");

                expr = new MemberExpression(
                    expr,
                    new PrimaryExpression("Identifier", prop!.value),
                    null,
                    expr.loc
                );
                continue;
            }

            break;
        }

        return expr;
    }

    private finishCall(callee: Node): Node {
        this.consume("DELIMITER", "Expected '('", "(");

        const args: Node[] = [];

        if (!(this.peek()!.type === "DELIMITER" && this.peek()!.value === ")")) {
            do {
                args.push(this.parseExpression());
            } while (
                this.match("DELIMITER") &&
                this.previous()!.value === ","
            );
        }

        const next = this.peek()!;
        if (next.type === "DELIMITER" && next.value === ")") {
            this.advance();
        }

        return new CallExpression(callee, args, null, callee.loc);
    }

    private parsePrimary(): Node {
        const token = this.peek()!;

        switch (token.type) {
            case "NUMBER":
            case "STRING":
                return this.parseLiteral();

            case "IDENTIFIER":
                this.advance();
                return new PrimaryExpression("Identifier", token.value);

            case "V_REGISTER":
                this.advance();
                return new PrimaryExpression("Register", token.value);

            case "DELIMITER":
                if (token.value === "(") {
                    this.advance();
                    const expr = this.parseExpression();
                    this.consume("DELIMITER", "Expected ')'", ")");
                    return expr;
                }
        }

        throw new Error(
            `Unexpected token in expression: ${token.value} at line ${token.line}`
        );
    }


    private parseLiteral() {
        const token = this.advance()!;

        switch (token.type) {
            case "STRING":
                return new LiteralExpression(Literals.string, token.value, null, undefined, {
                    column: token.column,
                    line: token.line,
                    path: this.sourceFile?.name!
                });
            case "NUMBER":
                return new LiteralExpression(Literals.number, token.value, null, undefined, {
                    column: token.column,
                    line: token.line,
                    path: this.sourceFile?.name!
                });
            default:
                reportError(this.sourceFile?.name!, this.source, token.line, token.column, `Invalid literal "${token.value}"`);
                process.exit(1);
        }
    }

    // Handles "DEC var1, var2;"
    private parseDeclaration(isConst = false) {
        const register = this.consume("V_REGISTER", "Expected %{registerName}")!;
        // next thing could be a type declaration
        const peek = this.peek()!;
        switch (peek.type) {
            case "TYPE_DECL":
                return this.parseDeclarationWithType(register, isConst);
            default:
                return this.parseDeclarationWithoutType(register, isConst);
        }
    }

    private parseDeclarationWithType(register: Token, isConst: boolean) {
        const value = this.parseStatement();
        return new DeclarationExpression(register.value, value, isConst, null, undefined, {
            column: register.column,
            line: register.line,
            path: this.sourceFile?.name!
        })
    }

    private parseDeclarationWithoutType(register: Token, isConst: boolean) {
        console.log({ register, isConst })
        const value = this.parseStatement();

        const t = this.peek()!;

        if (t.type === "DELIMITER" && t.value === ";") {
            this.advance();
        }

        return new DeclarationExpression(register.value, value, isConst, null, undefined, {
            column: register.column,
            line: register.line,
            path: this.sourceFile?.name!
        })
    }

    private parseCompilerKeyword(): Node {
        const keyword = this.advance()!;
        if (!isCompilerKeywordToken(keyword)) {
            throw new Error(`Unexpected token: ${this.peek()!.value} at line ${this.peek()!.line}`);
        }

        switch (keyword.value) {
            case CompilerKeywords.import:
                return this.parsecompilerImport();
            case CompilerKeywords.const:
                return this.parseCompilerConst();
            case CompilerKeywords.typeOf:
                return this.parseCompilerTypof()
        }
    }

    parseCompilerTypof(): Node {
        throw new Error("Method not implemented.");
    }

    parseCompilerConst(): Node {
        return this.parseDeclaration(true);
    }

    parsecompilerImport(): Node {
        const leftParen = this.peek()!;

        assert(this.sourceFile?.name!, this.source, leftParen.value === "(", "Expected \"(\" after import", leftParen.line, leftParen.column)
        this.advance();

        const _import = this.peek()!;

        if (_import.type !== "STRING") {
            reportError(this.sourceFile?.name!, this.source, _import.line, _import.column, `Unexpected import value "${_import.value}". Expected a valid path.`)
        }

        const importPath = this.advance()!;

        assert(
            this.sourceFile?.name!,
            this.source,
            this.peek()!.value === ")", "Expected \")\" after import path",
            this.peek()!.line,
            this.peek()!.column
        )

        this.advance();
        this.consume("DELIMITER", `Expected ";" after import statement, found "${this.peek()!.value}" instead`, ";")

        return new ImportNode(importPath.value, {
            line: importPath.line,
            column: importPath.column,
            path: this.sourceFile?.name!
        });
    }

    // Helper to check and consume in one step if match found
    private match(type: TokenType): boolean {
        if (this.check(type)) {
            this.advance();
            return true;
        }
        return false;
    }

    // --- PUBLIC API ---

    public parse(source: string, path: string = "<anonymous>"): DocumentBody {
        const scannerResult = scan(source, path);
        // Note: You should check scannerResult.errors here before proceeding!

        this.tokens = scannerResult.tokens;
        this.current = 0;

        console.log(...this.tokens)
        process.exit(0);

        return this.buildAst();
    }

    public async parseFile(path: string): Promise<{
        stats: fs.Stats;
        code: string;
        parsed: DocumentBody

    }> {

        const file = Bun.file(path)
        if (!(await file.exists())) {
            throw Error(`File not found: ${path}`)
        }
        const stats = await file.stat();
        const content = await file.text();
        this.sourceFile = file;
        this.source = content;

        return { stats, code: content, parsed: this.parse(content, path) }

    }
}