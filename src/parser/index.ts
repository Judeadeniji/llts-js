import fs from "node:fs";
import { assert, Delimiters, Keywords, reportError, scan, type Token, type TokenType } from "../scanner";
import { AssignmentExpression, BinaryExpression, BlockExpression, CallExpression, DeclarationExpression, DocumentBody, FunctionDeclaration, ImportNode, LiteralExpression, MemberExpression, Node, Params, PrimaryExpression, ReturnExpression, UnaryExpression, WhileExpression, IfExpression, ForExpression, IndexExpression, StructDeclaration, StructInitialization, type AST } from "../ast";
import { AssignOps, BinOps, CompilerSymbols, isCompilerKeywordToken, Literals, PRECEDENCE, UnaryOps } from "../shared";

export class Parser {
    private tokens: Token[] = [];
    private current = 0; // Point to the current token
    private sourceFile?: Bun.BunFile;
    private source: string = "";

    // 1. HELPER: Look at current token without consuming
    private peek(step = 0): Token | null {
        return this.tokens[this.current + step] || null;
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

        const doc = new DocumentBody(statements);

        statements.forEach(s => {
            s.document = doc;
            s.parent = doc;
        })

        return doc;
    }

    // Decides what kind of statement we are looking at
    private parseStatement(): Node {
        const token = this.peek()!;

        switch (token.type) {
            case "V_REGISTER": {
                const nextToken = this.peek(1);
                if (!nextToken) return this.parseDeclaration();
                if (nextToken.type === "ASSIGN_OP") return this.parseDeclaration();
                return this.parseExpressionStatement();
            }
            case "BIN_OP":
            case "UNARY_OP":
            case "ASSIGN_OP":
            case "IDENTIFIER":
            case "STRING":
            case "NUMBER":
            case "HEX":
            case "BINARY":
            case "OCTAL":
            case "BOOLEAN":
                return this.parseExpressionStatement();

            case "KEYWORD":
                if (token.value === "pub") {
                    this.advance();
                    const stmt = this.parseStatement();
                    if (stmt instanceof StructDeclaration || stmt instanceof FunctionDeclaration) {
                        stmt.isPublic = true;
                    }
                    return stmt;
                }
                if (token.value === "return") return this.parseReturnStatement();
                if (token.value === "true" || token.value === "false") return this.parseExpressionStatement();

                reportError(this.sourceFile?.name!, this.source, token.line, token.column, `Unexpected keyword: ${token.value}`);
                process.exit(1);

            case "COMPILER_KEYWORD":
                return this.parseCompilerKeyword();
            case "DELIMITER":
                if (token.value === Delimiters.LEFT_PAREN) return this.parseExpressionStatement();
                reportError(this.sourceFile?.name!, this.source, token.line, token.column, `Unexpected token: ${token.value} at line ${token.line}`);
                process.exit(1);
            default:
                reportError(this.sourceFile?.name!, this.source, token.line, token.column, `Unexpected token: ${token.value} at line ${token.line}`);
                process.exit(1);
        }
    }

    private parseExpressionStatement(): Node {
        const expr = this.parseExpression();
        this.consume(
            "DELIMITER",
            `Expected ';' after expression, found "${this.peek()!.value}" instead`,
            Delimiters.SEMICOLON
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

            if (tok?.type === "DELIMITER" && tok.value === Delimiters.LEFT_PAREN) {
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

            if (tok?.type === "DELIMITER" && tok.value === Delimiters.LEFT_BRACKET) {
                this.advance();
                const indexExpr = this.parseExpression();
                this.consume("DELIMITER", "Expected ']'", Delimiters.RIGHT_BRACKET);
                expr = new IndexExpression(expr, indexExpr, null, expr.loc);
                continue;
            }

            if (tok?.type === "DELIMITER" && tok.value === Delimiters.LEFT_BRACE) {
                if (expr instanceof PrimaryExpression || expr instanceof MemberExpression) {
                    this.advance(); // consume '{'
                    const fields: { name: string, value: Node }[] = [];
                    
                    while (!this.check("EOF") && !(this.check("DELIMITER") && this.peek()!.value === Delimiters.RIGHT_BRACE)) {
                        const fieldName = this.consume("IDENTIFIER", "Expected field name in struct initialization")!;
                        this.consume("DELIMITER", "Expected ':' after field name", Delimiters.COLON);
                        const fieldValue = this.parseExpression();
                        fields.push({ name: fieldName.value, value: fieldValue });
                        
                        if (this.check("DELIMITER") && this.peek()!.value === Delimiters.COMMA) {
                            this.advance(); // consume ','
                        } else {
                            break;
                        }
                    }
                    
                    this.consume("DELIMITER", "Expected '}' after struct initialization", Delimiters.RIGHT_BRACE);
                    
                    expr = new StructInitialization(this.exprToString(expr), fields, {
                        column: tok.column,
                        line: tok.line,
                        path: this.sourceFile?.name!
                    });
                    continue;
                }
            }

            break;
        }

        return expr;
    }
    
    private exprToString(expr: Node): string {
        if (expr instanceof PrimaryExpression) return expr.name;
        if (expr instanceof MemberExpression && expr.property instanceof PrimaryExpression) return this.exprToString(expr.object) + "." + expr.property.name;
        reportError(this.sourceFile?.name!, this.source, expr.loc?.line!, expr.loc?.column!, "Invalid struct name expression");
        process.exit(1);
    }

    private finishCall(callee: Node): Node {
        this.consume("DELIMITER", "Expected '('", Delimiters.LEFT_PAREN);

        const args: Node[] = [];

        if (!(this.peek()!.type === "DELIMITER" && this.peek()!.value === Delimiters.RIGHT_PAREN)) {
            do {
                args.push(this.parseExpression());
                if (this.check("DELIMITER") && this.peek()!.value === ",") {
                    this.advance(); // consume ","
                } else {
                    break;
                }
            } while (true);
        }

        this.consume("DELIMITER", "Expected ')'", Delimiters.RIGHT_PAREN);

        return new CallExpression(callee, args, null, callee.loc);
    }

    private parsePrimary(): Node {
        const token = this.peek()!;

        switch (token.type) {
            case "BOOLEAN":
            case "STRING":
            case "NUMBER":
            case "HEX":
            case "BINARY":
            case "OCTAL":
                return this.parseLiteral();

            case "IDENTIFIER": {
                this.advance();
                return new PrimaryExpression("Identifier", token.value, null, {
                    column: token.column,
                    line: token.line,
                    path: this.sourceFile?.name!
                });
            }

            case "V_REGISTER":
                this.advance();
                return new PrimaryExpression("Register", token.value, null, {
                    column: token.column,
                    line: token.line,
                    path: this.sourceFile?.name!
                });

            case "DELIMITER":
                if (token.value === Delimiters.LEFT_PAREN) {
                    this.advance();
                    const expr = this.parseExpression();
                    this.consume("DELIMITER", "Expected ')'", Delimiters.RIGHT_PAREN);
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
            case "BOOLEAN":
                return new LiteralExpression(Literals.boolean, token.value, null, undefined, {
                    column: token.column,
                    line: token.line,
                    path: this.sourceFile?.name!
                });
            case "STRING":
                return new LiteralExpression(Literals.string, token.value, null, undefined, {
                    column: token.column,
                    line: token.line,
                    path: this.sourceFile?.name!
                });
            case "HEX":
                return new LiteralExpression(Literals.hex, token.value, null, undefined, {
                    column: token.column,
                    line: token.line,
                    path: this.sourceFile?.name!
                });
            case "BINARY":
                return new LiteralExpression(Literals.binary, token.value, null, undefined, {
                    column: token.column,
                    line: token.line,
                    path: this.sourceFile?.name!
                });
            case "OCTAL":
                return new LiteralExpression(Literals.octal, token.value, null, undefined, {
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
        const register = this.consume("V_REGISTER", `Expected $RegisterName but found "${this.peek()!.value}" instead.`)!;
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
        this.consume("ASSIGN_OP", `Expected "=" after "${register.value}"`, "=");
        const value = this.parseStatement();
        const t = this.peek()!;

        if (t.type === "DELIMITER" && t.value === Delimiters.SEMICOLON) {
            this.advance();
        }

        return new DeclarationExpression(register.value, value, isConst, null, undefined, {
            column: register.column,
            line: register.line,
            path: this.sourceFile?.name!
        })
    }

    private parseParamsList(): Node[] {
        const peek = this.peek()!;

        if (peek.type === "DELIMITER" && peek.value === Delimiters.RIGHT_PAREN) {
            this.advance();
            return [];
        }

        const params: Node[] = [];

        do {
            const name = this.consume("IDENTIFIER", "Expected parameter name");
            if (!name) break;

            let typeNode: Node | undefined;
            if (this.check("DELIMITER") && this.peek()!.value === ":") {
                this.advance();
                const typeName = this.consume("IDENTIFIER", "Expected type name");
                if (typeName) {
                    typeNode = new PrimaryExpression("Identifier", typeName.value, null, {
                        line: typeName.line,
                        column: typeName.column,
                        path: this.sourceFile?.name!
                    });
                }
            }

            // Create a dummy value for the parameter declaration
            const dummyValue = new LiteralExpression(Literals.number, "0", null, undefined, {
                line: name.line,
                column: name.column,
                path: this.sourceFile?.name!
            });

            const param = new DeclarationExpression(name.value, dummyValue, false, null, typeNode, {
                line: name.line,
                column: name.column,
                path: this.sourceFile?.name!
            });

            params.push(param);

        } while (this.match("DELIMITER") && this.previous()!.value === ",");

        return params;
    }

    private parseCompilerKeyword(): Node {
        const keyword = this.advance()!;
        if (!isCompilerKeywordToken(keyword)) {
            throw new Error(`Unexpected token: ${this.peek()!.value} at line ${this.peek()!.line}`);
        }

        switch (keyword.value) {
            case CompilerSymbols.import:
                return this.parsecompilerImport();
            case CompilerSymbols.const:
                return this.parseCompilerConst();
            case CompilerSymbols.typeOf:
                return this.parseCompilerTypof();
            case CompilerSymbols.func:
                return this.parseCompilerFunc();
            case CompilerSymbols.while:
                return this.parseWhileExpression();
            case CompilerSymbols.for:
                return this.parseForExpression();
            case CompilerSymbols.if:
                return this.parseIfExpression();
            case CompilerSymbols.struct:
                return this.parseCompilerStruct();
        }
        throw new Error(`Unhandled compiler keyword: ${keyword.value}`);
    }

    private parseCompilerStruct(): Node {
        const structToken = this.previous()!;
        const name = this.consume("IDENTIFIER", "Expected struct name")!;
        
        this.consume("DELIMITER", "Expected '{' before struct body", Delimiters.LEFT_BRACE);
        
        const fields: { name: string, type: Node | null }[] = [];
        
        while (!this.check("EOF") && !(this.check("DELIMITER") && this.peek()!.value === Delimiters.RIGHT_BRACE)) {
            const fieldName = this.consume("IDENTIFIER", "Expected field name in struct declaration")!;
            this.consume("DELIMITER", "Expected ':' after field name", Delimiters.COLON);
            
            const typeName = this.consume("IDENTIFIER", "Expected type name")!;
            const fieldType = new PrimaryExpression("Identifier", typeName.value, null, {
                line: typeName.line,
                column: typeName.column,
                path: this.sourceFile?.name!
            });
            
            this.consume("DELIMITER", "Expected ';' after field declaration", Delimiters.SEMICOLON);
            
            fields.push({ name: fieldName.value, type: fieldType });
        }
        
        this.consume("DELIMITER", "Expected '}' after struct body", Delimiters.RIGHT_BRACE);
        
        return new StructDeclaration(name.value, fields, {
            line: structToken.line,
            column: structToken.column,
            path: this.sourceFile?.name!
        });
    }

    private parseIfExpression(): Node {
        const ifToken = this.previous()!;
        this.consume("DELIMITER", `Expects "${Delimiters.LEFT_PAREN}" but found "${this.peek()?.value}" instead.`, Delimiters.LEFT_PAREN);
        const cond = this.parseExpression();
        this.consume("DELIMITER", `Expects "${Delimiters.RIGHT_PAREN}" but found "${this.peek()?.value}" instead.`, Delimiters.RIGHT_PAREN);

        const pipeToken = this.peek()!;
        let pipeValue: Node | null = null;

        if (pipeToken && pipeToken.type === "DELIMITER" && pipeToken.value === Delimiters.PIPE) {
            this.advance();
            pipeValue = this.parsePrimary();
            this.consume("DELIMITER", `Unexpected token "${this.peek()?.value}" expected "${Delimiters.PIPE}" instead.`, Delimiters.PIPE);
        }

        const body = this.parseBlock();
        let elseBody: Node | null = null;

        // Check for @else
        if (this.match("COMPILER_KEYWORD") && this.previous()?.value === CompilerSymbols.else) {
            // It could be @else @if ... or just @else { ... }
            if (this.match("COMPILER_KEYWORD") && this.previous()?.value === CompilerSymbols.if) {
                elseBody = this.parseIfExpression();
            } else {
                elseBody = this.parseBlock();
            }
        }

        return new IfExpression(cond, pipeValue, body, elseBody, {
            line: ifToken.line,
            column: ifToken.column,
            path: this.sourceFile?.name!
        });
    }

    private parseWhileExpression(): Node {
        const whileToken = this.peek()!;
        this.consume("DELIMITER", `Expects "${Delimiters.LEFT_PAREN}" but found "${this.peek()?.value}" instead.`, Delimiters.LEFT_PAREN);
        const cond = this.parseExpression();
        this.consume("DELIMITER", `Expects "${Delimiters.RIGHT_PAREN}" but found "${this.peek()?.value}" instead.`, Delimiters.RIGHT_PAREN);

        const pipeToken = this.peek()!;
        let pipeValue: Node | null = null;

        if (pipeToken.type === "DELIMITER" && pipeToken.value === Delimiters.PIPE) {
            this.advance();
            pipeValue = this.parsePrimary(); // only primary expressions are allowed
            this.consume("DELIMITER", `Unexpected token "${this.peek()?.value}" expected "${Delimiters.PIPE}" instead.`, Delimiters.PIPE);
        }

        const body = this.parseBlock();

        // TODO: Add support for else block
        // const else block = this.parseControlFlowTail();

        const whileExpr = new WhileExpression(cond, pipeValue, body, null, {
            line: whileToken.line,
            column: whileToken.column,
            path: this.sourceFile?.name!
        })

        return whileExpr;
    }

    private parseForExpression(): Node {
        const forToken = this.previous()!;
        this.consume("DELIMITER", `Expects "${Delimiters.LEFT_PAREN}" but found "${this.peek()?.value}" instead.`, Delimiters.LEFT_PAREN);
        
        let init: Node | null = null;
        if (!this.check("DELIMITER") || this.peek()!.value !== Delimiters.SEMICOLON) {
            init = this.parseExpression(); // This handles assignment / declaration
        }
        this.consume("DELIMITER", `Expects "${Delimiters.SEMICOLON}" after for init.`, Delimiters.SEMICOLON);
        
        let condition: Node | null = null;
        if (!this.check("DELIMITER") || this.peek()!.value !== Delimiters.SEMICOLON) {
            condition = this.parseExpression();
        }
        this.consume("DELIMITER", `Expects "${Delimiters.SEMICOLON}" after for condition.`, Delimiters.SEMICOLON);
        
        let increment: Node | null = null;
        if (!this.check("DELIMITER") || this.peek()!.value !== Delimiters.RIGHT_PAREN) {
            increment = this.parseExpression();
        }
        this.consume("DELIMITER", `Expects "${Delimiters.RIGHT_PAREN}" after for clauses.`, Delimiters.RIGHT_PAREN);

        const pipeToken = this.peek()!;
        let pipeValue: Node | null = null;

        if (pipeToken && pipeToken.type === "DELIMITER" && pipeToken.value === Delimiters.PIPE) {
            this.advance();
            pipeValue = this.parsePrimary();
            this.consume("DELIMITER", `Unexpected token "${this.peek()?.value}" expected "${Delimiters.PIPE}" instead.`, Delimiters.PIPE);
        }

        const body = this.parseBlock();

        return new ForExpression(init, condition, increment, pipeValue, body, {
            line: forToken.line,
            column: forToken.column,
            path: this.sourceFile?.name!
        });
    }


    private parseReturnStatement(): Node {
        const keyword = this.consume("KEYWORD", `Expected "${Keywords.return}"`, Keywords.return)!;
        let returnValue: Node | null = null;
        if (!this.check("DELIMITER") || this.peek()!.value !== Delimiters.SEMICOLON) {
            returnValue = this.parseExpression();
        }
        this.consume("DELIMITER", `Expected "${Delimiters.SEMICOLON}"`, Delimiters.SEMICOLON);
        return new ReturnExpression(returnValue, null, {
            line: keyword.line,
            column: keyword.column,
            path: this.sourceFile?.name!
        });
    }

    private parseBlock(): BlockExpression {
        this.consume("DELIMITER", "Expected '{'", Delimiters.LEFT_BRACE);
        const statements: Node[] = [];

        while (!this.isAtEnd() && !(this.peek()?.type === "DELIMITER" && this.peek()?.value === Delimiters.RIGHT_BRACE)) {
            const stmt = this.parseStatement();
            if (stmt) statements.push(stmt);
        }

        this.consume("DELIMITER", "Expected '}'", Delimiters.RIGHT_BRACE);

        return new BlockExpression(statements, null as any, {
            line: this.peek()?.line || 0,
            column: 0,
            path: this.sourceFile?.name!
        });
    }

    parseCompilerFunc(): Node {
        const name = this.advance();

        if (!name || name.type !== "IDENTIFIER") {
            reportError(this.sourceFile?.name!, this.source, name!.line, name!.column, `Expected a valid function name but found "${name?.value}" instead.`);
            process.exit(1);
        }

        this.consume("DELIMITER", `Expected "${Delimiters.LEFT_PAREN}" after function name but found "${this.peek()!.value}" instead.`, Delimiters.LEFT_PAREN)

        const params = new Params(this.parseParamsList());

        // check if return type
        if (this.check("DELIMITER") && this.peek()?.value === ":") {
            this.advance(); // eat ":"
            // handle return types
            const typeName = this.consume("IDENTIFIER", "Expected type name");
            if (!typeName) {
                reportError(this.sourceFile?.name!, this.source, typeName!.line, typeName!.column, `Expected a valid type name instead.`);
                process.exit(1);
            }
        }


        const body = this.parseBlock();

        const func = new FunctionDeclaration(name.value, params, body, null, {
            line: name.line,
            column: name.column,
            path: this.sourceFile?.name!
        });

        // Fix up parents
        body.parent = func;
        params.parent = func;

        return func;
    }

    parseCompilerTypof(): Node {
        throw new Error("Method not implemented.");
    }

    parseCompilerConst(): Node {
        return this.parseDeclaration(true);
    }

    parsecompilerImport(): Node {
        const leftParen = this.peek()!;

        assert(this.sourceFile?.name!, this.source, leftParen.value === Delimiters.LEFT_PAREN, "Expected \"(\" after import", leftParen.line, leftParen.column)
        this.advance();

        const _import = this.peek()!;

        if (_import.type !== "STRING") {
            reportError(this.sourceFile?.name!, this.source, _import.line, _import.column, `Unexpected import value "${_import.value}". Expected a valid path.`)
        }

        const importPath = this.advance()!;

        assert(
            this.sourceFile?.name!,
            this.source,
            this.peek()!.value === Delimiters.RIGHT_PAREN, "Expected \")\" after import path",
            this.peek()!.line,
            this.peek()!.column
        )

        this.advance();
        this.consume("DELIMITER", `Expected "${Delimiters.SEMICOLON}" after import statement, found "${this.peek()!.value}" instead`, Delimiters.SEMICOLON)

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

        // console.log(...this.tokens)
        // process.exit(0);

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