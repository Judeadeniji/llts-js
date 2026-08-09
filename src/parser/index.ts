// others
import {
	ArrayLiteral,
	AssignmentExpression,
	BinaryExpression,
	BlockExpression,
	BreakExpression,
	CallExpression,
	ContinueExpression,
	DeclarationExpression,
	DeferStatement,
	DocumentBody,
	ForExpression,
	FunctionDeclaration,
	IfExpression,
	ImportNode,
	IndexExpression,
	LiteralExpression,
	MemberExpression,
	type Node,
	Params,
	PrimaryExpression,
	ReturnExpression,
	StructDeclaration,
	StructInitialization,
	UnaryExpression,
	ErrorExpression,
	TryExpression,
	ExternDeclaration,
	ArrayTypeExpression,
	UnionTypeExpression,
} from "../ast";
import {
	assert,
	Delimiters,
	Keywords,
	scan,
	type Token,
	type TokenType,
} from "../scanner";
import {
	type AssignOps,
	type BinOps,
	CompilerSymbols,
	checkNotNull,
	isCompilerKeywordToken,
	Literals,
	PRECEDENCE,
	type UnaryOps,
} from "../shared";
import { ReportedError, reportLocationFrame, reportSourceError } from "../errors";
import type fs from "node:fs";

// ----------------------------------------------------------------------

export class Parser {
	private tokens: Token[] = [];
	private current = 0; // Point to the current token
	private sourceFile?: Bun.BunFile;
	private source: string = "";

	/** Report source context + location frame, then abort parse. */
	private failAtLoc(line: number, column: number, message: string): never {
		const path = this.sourceFile?.name ?? "<anonymous>";
		reportSourceError(path, this.source, line, column, message);
		reportLocationFrame(path, line);
		throw new ReportedError(`ParseError: ${message}`, "ParseError");
	}

	private failAt(token: Token, message: string): never {
		return this.failAtLoc(token.line, token.column, message);
	}

	/** `$name` is declaration-only; uses and assignments omit the sigil. */
	private rejectRegisterSigil(token: Token, next?: Token | null): never {
		const name = token.value;
		const hint =
			next?.type === "ASSIGN_OP"
				? `write '${name} ${next.value} ...' without '$'`
				: `write '${name}' without '$'`;
		this.failAt(
			token,
			`'$' is only used in declarations (@const $name / $name = ...); ${hint}`,
		);
	}

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
			const t = checkNotNull(this.peek());
			if (!((t.value === value && this.check(type)) || t.type === "EOF")) {
				this.failAt(t, message);
			}
			return this.advance();
		}

		if (this.check(type)) {
			return this.advance();
		}

		const next = this.peek();
		if (!next) return null;
		this.failAt(next, message);
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

		statements.forEach((s) => {
			s.document = doc;
			s.parent = doc;
		});

		return doc;
	}

	// Decides what kind of statement we are looking at
	private parseStatement(): Node {
		const token = checkNotNull(this.peek());

		switch (token.type) {
			case "V_REGISTER": {
				const nextToken = this.peek(1);
				// `$name = ...` / `$name: Type = ...` / `@const $name ...` — declaration only
				if (nextToken?.type === "ASSIGN_OP" && nextToken.value === "=") {
					return this.parseDeclaration();
				}
				if (nextToken?.type === "DELIMITER" && nextToken.value === ":") {
					return this.parseDeclaration();
				}
				this.rejectRegisterSigil(token, nextToken);
			}
			case "BIN_OP":
			case "UNARY_OP":
			case "ASSIGN_OP":
			case "IDENTIFIER":
				if (this.peek(1)?.type === "DELIMITER" && this.peek(1)?.value === ":") {
					const label = checkNotNull(this.advance()).value;
					this.advance(); // ':'
					const stmt = this.parseStatement();
					if (stmt instanceof ForExpression) {
						stmt.label = label;
					}
					return stmt;
				}
				return this.parseExpressionStatement();
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
					if (
						stmt instanceof StructDeclaration ||
						stmt instanceof FunctionDeclaration ||
						stmt instanceof DeclarationExpression ||
						stmt instanceof ExternDeclaration
					) {
						(stmt).isPublic = true;
					}
					return stmt;
				}
				if (token.value === "return") return this.parseReturnStatement();
				if (token.value === "break") return this.parseBreakStatement();
				if (token.value === "continue") return this.parseContinueStatement();
				if (token.value === "defer") return this.parseDeferStatement();
				if (token.value === "true" || token.value === "false" || token.value === "error" || token.value === "null")
					return this.parseExpressionStatement();

				this.failAt(token, `Unexpected keyword: ${token.value}`);

			case "COMPILER_KEYWORD":
				return this.parseCompilerKeyword();
			case "DELIMITER":
				if (
					token.value === Delimiters.LEFT_PAREN ||
					token.value === Delimiters.LEFT_BRACKET
				)
					return this.parseExpressionStatement();
				this.failAt(
					token,
					`Unexpected token: ${token.value} at line ${token.line}`,
				);
			default:
				this.failAt(
					token,
					`Unexpected token: ${token.value} at line ${token.line}`,
				);
		}
	}

	private parseExpressionStatement(): Node {
		const expr = this.parseExpression();
		this.consume(
			"DELIMITER",
			`Expected ';' after expression, found "${this.peek()?.value}" instead`,
			Delimiters.SEMICOLON,
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

			return new AssignmentExpression(
				left,
				tok.value as AssignOps,
				right,
				null,
				left.loc,
			);
		}

		return left;
	}

	private parseBinary(minPrec: number): Node {
		let left = this.parseUnary();

		while (true) {
			const tok = this.peek();
			if (tok?.type !== "BIN_OP") break;

			const prec = PRECEDENCE[tok.value];
			if (prec === undefined || prec < minPrec) break;

			this.advance(); // eat operator

			const right = this.parseBinary(prec + 1); // ← critical line

			left = new BinaryExpression(
				left,
				tok.value as BinOps,
				right,
				null,
				left.loc,
			);
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
					new PrimaryExpression("Identifier", checkNotNull(prop).value),
					null,
					expr.loc,
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
				if (
					expr instanceof PrimaryExpression ||
					expr instanceof MemberExpression
				) {
					this.advance(); // consume '{'
					const fields: { name: string; value: Node }[] = [];

					while (
						!this.check("EOF") &&
						!(
							this.check("DELIMITER") &&
							checkNotNull(this.peek()).value === Delimiters.RIGHT_BRACE
						)
					) {
						const fieldName = checkNotNull(
							this.consume(
								"IDENTIFIER",
								"Expected field name in struct initialization",
							),
						);
						this.consume(
							"DELIMITER",
							"Expected ':' after field name",
							Delimiters.COLON,
						);
						const fieldValue = this.parseExpression();
						fields.push({ name: fieldName.value, value: fieldValue });

						if (
							this.check("DELIMITER") &&
							checkNotNull(this.peek()).value === Delimiters.COMMA
						) {
							this.advance(); // consume ','
						} else {
							break;
						}
					}

					this.consume(
						"DELIMITER",
						"Expected '}' after struct initialization",
						Delimiters.RIGHT_BRACE,
					);

					expr = new StructInitialization(this.exprToString(expr), fields, {
						column: tok.column,
						line: tok.line,
						path: checkNotNull(this.sourceFile?.name),
					});
					continue;
				}
			}
			if (tok?.type === "DELIMITER" && tok.value === "?") {
				this.advance();
				expr = new TryExpression(expr, null, expr.loc);
				continue;
			}

			break;
		}

		return expr;
	}

	private exprToString(expr: Node): string {
		if (expr instanceof PrimaryExpression) return expr.name;
		if (
			expr instanceof MemberExpression &&
			expr.property instanceof PrimaryExpression
		)
			return `${this.exprToString(expr.object)}.${expr.property.name}`;
		this.failAtLoc(
			checkNotNull(expr.loc?.line),
			checkNotNull(expr.loc?.column),
			"Invalid struct name expression",
		);
	}

	private finishCall(callee: Node): Node {
		this.consume("DELIMITER", "Expected '('", Delimiters.LEFT_PAREN);

		const args: Node[] = [];

		if (
			!(
				checkNotNull(this.peek()).type === "DELIMITER" &&
				checkNotNull(this.peek()).value === Delimiters.RIGHT_PAREN
			)
		) {
			let hasMoreArgs = true;
			do {
				args.push(this.parseExpression());
				if (
					this.check("DELIMITER") &&
					checkNotNull(this.peek()).value === ","
				) {
					this.advance(); // consume ","
				} else {
					hasMoreArgs = false;
				}
			} while (hasMoreArgs);
		}

		this.consume("DELIMITER", "Expected ')'", Delimiters.RIGHT_PAREN);

		return new CallExpression(callee, args, null, callee.loc);
	}

	private parsePrimary(): Node {
		const token = checkNotNull(this.peek());

		switch (token.type) {
			case "BOOLEAN":
			case "STRING":
			case "NUMBER":
			case "HEX":
			case "BINARY":
			case "OCTAL":
				return this.parseLiteral();

			case "KEYWORD":
				if (token.value === "error") {
					this.advance();
					this.consume("DELIMITER", "Expected '(' after error", Delimiters.LEFT_PAREN);
					const expr = this.parseExpression();
					this.consume("DELIMITER", "Expected ')' after error message", Delimiters.RIGHT_PAREN);
					return new ErrorExpression(expr, null, {
						column: token.column,
						line: token.line,
						path: checkNotNull(this.sourceFile?.name),
					});
				}
				if (token.value === "null") {
					this.advance();
					return new LiteralExpression("null", "null", null, undefined, {
						column: token.column,
						line: token.line,
						path: checkNotNull(this.sourceFile?.name),
					});
				}
				break;

			case "COMPILER_KEYWORD":
				this.advance();
				return new PrimaryExpression("Identifier", "@" + token.value, null, {
					column: token.column,
					line: token.line,
					path: checkNotNull(this.sourceFile?.name),
				});

			case "IDENTIFIER": {
				this.advance();
				return new PrimaryExpression("Identifier", token.value, null, {
					column: token.column,
					line: token.line,
					path: checkNotNull(this.sourceFile?.name),
				});
			}

			case "V_REGISTER":
				this.rejectRegisterSigil(token, this.peek(1));
				break;

			case "DELIMITER":
				if (token.value === Delimiters.LEFT_PAREN) {
					this.advance();
					const expr = this.parseExpression();
					this.consume("DELIMITER", "Expected ')'", Delimiters.RIGHT_PAREN);
					return expr;
				}
				if (token.value === Delimiters.LEFT_BRACKET) {
					this.advance();
					const elements: Node[] = [];
					if (
						!(
							this.check("DELIMITER") &&
							checkNotNull(this.peek()).value === Delimiters.RIGHT_BRACKET
						)
					) {
						let hasMoreElements = true;
						do {
							elements.push(this.parseExpression());
							if (this.check("DELIMITER") && checkNotNull(this.peek()).value === Delimiters.COMMA) {
								this.advance();
							} else {
								hasMoreElements = false;
							}
						} while (hasMoreElements);
					}
					this.consume("DELIMITER", "Expected ']'", Delimiters.RIGHT_BRACKET);
					return new ArrayLiteral(elements, null, {
						column: token.column,
						line: token.line,
						path: this.sourceFile?.name ?? "unknown",
					});
				}
		}

		this.failAt(
			token,
			`Unexpected token in expression: ${token.value} at line ${token.line}`,
		);
	}

	private parseLiteral() {
		const token = checkNotNull(this.advance());

		switch (token.type) {
			case "BOOLEAN":
				return new LiteralExpression(
					Literals.boolean,
					token.value,
					null,
					undefined,
					{
						column: token.column,
						line: token.line,
						path: checkNotNull(this.sourceFile?.name),
					},
				);
			case "STRING":
				return new LiteralExpression(
					Literals.string,
					token.value,
					null,
					undefined,
					{
						column: token.column,
						line: token.line,
						path: checkNotNull(this.sourceFile?.name),
					},
				);
			case "HEX":
				return new LiteralExpression(
					Literals.hex,
					token.value,
					null,
					undefined,
					{
						column: token.column,
						line: token.line,
						path: checkNotNull(this.sourceFile?.name),
					},
				);
			case "BINARY":
				return new LiteralExpression(
					Literals.binary,
					token.value,
					null,
					undefined,
					{
						column: token.column,
						line: token.line,
						path: checkNotNull(this.sourceFile?.name),
					},
				);
			case "OCTAL":
				return new LiteralExpression(
					Literals.octal,
					token.value,
					null,
					undefined,
					{
						column: token.column,
						line: token.line,
						path: checkNotNull(this.sourceFile?.name),
					},
				);
			case "NUMBER":
				return new LiteralExpression(
					Literals.number,
					token.value,
					null,
					undefined,
					{
						column: token.column,
						line: token.line,
						path: checkNotNull(this.sourceFile?.name),
					},
				);
			default:
				this.failAt(token, `Invalid literal "${token.value}"`);
		}
	}

	// Handles "$name = ..." / "$name: Type = ..." / "@const $name ..."
	private parseDeclaration(isConst = false) {
		const register = checkNotNull(
			this.consume(
				"V_REGISTER",
				`Expected $RegisterName but found "${checkNotNull(this.peek()).value}" instead.`,
			),
		);

		let typeNode: Node | undefined;
		if (this.check("DELIMITER") && checkNotNull(this.peek()).value === ":") {
			this.advance(); // ':'
			typeNode = this.parseType();
		}

		this.consume("ASSIGN_OP", `Expected "=" after "${register.value}"`, "=");
		const value = this.parseStatement();
		const t = checkNotNull(this.peek());

		if (t.type === "DELIMITER" && t.value === Delimiters.SEMICOLON) {
			this.advance();
		}

		return new DeclarationExpression(
			register.value,
			value,
			isConst,
			null,
			typeNode,
			{
				column: register.column,
				line: register.line,
				path: checkNotNull(this.sourceFile?.name),
			},
		);
	}

	/** Parse a type: `[]T`, `[N]T`, nested `[2][3]int`, `Name`, or `T | U`. */
	private parseType(): Node {
		const loc = () => ({
			line: checkNotNull(this.peek()).line,
			column: checkNotNull(this.peek()).column,
			path: checkNotNull(this.sourceFile?.name),
		});

		let left: Node;
		if (
			this.check("DELIMITER") &&
			checkNotNull(this.peek()).value === Delimiters.LEFT_BRACKET
		) {
			const start = checkNotNull(this.peek());
			this.advance(); // '['
			let length: number | null = null;
			if (this.check("NUMBER") || this.check("HEX") || this.check("OCTAL") || this.check("BINARY")) {
				const numTok = checkNotNull(this.advance());
				const raw = numTok.value;
				if (numTok.type === "HEX") length = parseInt(raw.slice(2), 16);
				else if (numTok.type === "BINARY") length = parseInt(raw.slice(2), 2);
				else if (numTok.type === "OCTAL") length = parseInt(raw.slice(2), 8);
				else length = parseInt(raw, 10);
				if (!Number.isFinite(length) || length < 0) {
					this.failAt(numTok, `Invalid array length '${raw}'`);
				}
			}
			this.consume(
				"DELIMITER",
				"Expected ']' in array type",
				Delimiters.RIGHT_BRACKET,
			);
			// Recursive: `[2][3]int` → elem is `[3]int`
			const elem = this.parseType();
			left = new ArrayTypeExpression(elem, length, null, {
				line: start.line,
				column: start.column,
				path: checkNotNull(this.sourceFile?.name),
			});
		} else {
			left = this.parseTypeAtom();
		}

		while (this.check("DELIMITER") && checkNotNull(this.peek()).value === "|") {
			this.advance();
			const right = this.parseTypeAtom();
			left = new UnionTypeExpression(left, right, null, loc());
		}
		return left;
	}

	private parseTypeAtom(): Node {
		const peek = checkNotNull(this.peek());
		if (peek.type === "KEYWORD" && peek.value === "error") {
			this.advance();
			return new PrimaryExpression("Identifier", "error", null, {
				line: peek.line,
				column: peek.column,
				path: checkNotNull(this.sourceFile?.name),
			});
		}
		const typeName = checkNotNull(
			this.consume("IDENTIFIER", "Expected type name"),
		);
		return new PrimaryExpression("Identifier", typeName.value, null, {
			line: typeName.line,
			column: typeName.column,
			path: checkNotNull(this.sourceFile?.name),
		});
	}

	private parseParamsList(): { elements: Node[], isVariadic: boolean } {
		const peek = checkNotNull(this.peek());
		if (peek.type === "DELIMITER" && peek.value === Delimiters.RIGHT_PAREN) {
			this.advance();
			return { elements: [], isVariadic: false };
		}

		const params: Node[] = [];
		let isVariadic = false;

		do {
			if (this.check("DELIMITER") && checkNotNull(this.peek()).value === "...") {
				this.advance();
				isVariadic = true;
			}

			const name = this.consume("IDENTIFIER", "Expected parameter name");
			if (!name) break;

			let typeNode: Node | undefined;
			if (this.check("DELIMITER") && checkNotNull(this.peek()).value === ":") {
				this.advance();
				typeNode = this.parseType();
			}

			// Create a dummy value for the parameter declaration
			const dummyValue = new LiteralExpression(
				Literals.number,
				"0",
				null,
				undefined,
				{
					line: name.line,
					column: name.column,
					path: checkNotNull(this.sourceFile?.name),
				},
			);

			const param = new DeclarationExpression(
				name.value,
				dummyValue,
				false,
				null,
				typeNode,
				{
					line: name.line,
					column: name.column,
					path: checkNotNull(this.sourceFile?.name),
				},
			);

			params.push(param);
			
			if (isVariadic && this.check("DELIMITER") && checkNotNull(this.peek()).value === ",") {
				this.failAt(
					checkNotNull(this.peek()),
					"Rest parameter must be the last parameter",
				);
			}
		} while (
			this.match("DELIMITER") &&
			checkNotNull(this.previous()).value === ","
		);

		return { elements: params, isVariadic };
	}

	private parseCompilerKeyword(): Node {
		const keyword = checkNotNull(this.advance());
		if (!isCompilerKeywordToken(keyword)) {
			this.failAt(
				checkNotNull(this.peek()),
				`Unexpected token: ${checkNotNull(this.peek()).value} at line ${checkNotNull(this.peek()).line}`,
			);
		}

		switch (keyword.value) {
			case CompilerSymbols.import:
				return this.parsecompilerImport();
			case CompilerSymbols.const:
				return this.parseCompilerConst();
			case CompilerSymbols.typeOf:
			case CompilerSymbols.isError:
				// Expression-form builtins (`@typeOf(x)`, `@isError(x)`).
				this.current--;
				return this.parseExpressionStatement();
			case CompilerSymbols.func:
				return this.parseCompilerFunc();
			case CompilerSymbols.for:
				return this.parseForExpression();
			case CompilerSymbols.if:
				return this.parseIfExpression();
			case CompilerSymbols.struct:
				return this.parseCompilerStruct();
			case CompilerSymbols.extern:
				return this.parseCompilerExtern();
		}
		this.failAt(keyword, `Unhandled compiler keyword: ${keyword.value}`);
	}

	private parseCompilerExtern(): Node {
		// @extern name;
		// Declares that 'name' is provided natively at runtime.
		const name = this.consume("IDENTIFIER", "Expected identifier after @extern");
		if (!name) this.failAt(checkNotNull(this.peek()), "Expected identifier after @extern");
		this.consume("DELIMITER", "Expected ';' after @extern declaration", Delimiters.SEMICOLON);
		return new ExternDeclaration(name.value);
	}

	private parseCompilerStruct(): Node {
		const structToken = checkNotNull(this.previous());
		const name = checkNotNull(
			this.consume("IDENTIFIER", "Expected struct name"),
		);

		this.consume(
			"DELIMITER",
			"Expected '{' before struct body",
			Delimiters.LEFT_BRACE,
		);

		const fields: { name: string; type: Node | null }[] = [];
		const methods: FunctionDeclaration[] = [];

		while (
			!this.check("EOF") &&
			!(
				this.check("DELIMITER") &&
				checkNotNull(this.peek()).value === Delimiters.RIGHT_BRACE
			)
		) {
			if (
				this.check("COMPILER_KEYWORD") &&
				checkNotNull(this.peek()).value === "func"
			) {
				this.advance();
				const func = this.parseCompilerFunc() as FunctionDeclaration;
				func.name = `${name.value}::${func.name}`;
				methods.push(func);
				continue;
			}

			const fieldName = checkNotNull(
				this.consume("IDENTIFIER", "Expected field name in struct declaration"),
			);
			this.consume(
				"DELIMITER",
				"Expected ':' after field name",
				Delimiters.COLON,
			);

			const fieldType = this.parseType();

			this.consume(
				"DELIMITER",
				"Expected ';' after field declaration",
				Delimiters.SEMICOLON,
			);

			fields.push({ name: fieldName.value, type: fieldType });
		}

		this.consume(
			"DELIMITER",
			"Expected '}' after struct body",
			Delimiters.RIGHT_BRACE,
		);

		return new StructDeclaration(name.value, fields, methods, {
			line: structToken.line,
			column: structToken.column,
			path: checkNotNull(this.sourceFile?.name),
		});
	}

	private parseIfExpression(): Node {
		const ifToken = checkNotNull(this.previous());
		this.consume(
			"DELIMITER",
			`Expects "${Delimiters.LEFT_PAREN}" but found "${this.peek()?.value}" instead.`,
			Delimiters.LEFT_PAREN,
		);
		const cond = this.parseExpression();
		this.consume(
			"DELIMITER",
			`Expects "${Delimiters.RIGHT_PAREN}" but found "${this.peek()?.value}" instead.`,
			Delimiters.RIGHT_PAREN,
		);

		const pipeToken = checkNotNull(this.peek());
		let pipeValue: Node | null = null;

		if (
			pipeToken &&
			pipeToken.type === "DELIMITER" &&
			pipeToken.value === Delimiters.PIPE
		) {
			this.advance();
			pipeValue = this.parsePrimary();
			this.consume(
				"DELIMITER",
				`Unexpected token "${this.peek()?.value}" expected "${Delimiters.PIPE}" instead.`,
				Delimiters.PIPE,
			);
		}

		const body = this.parseBlock();
		let elseBody: Node | null = null;

		// Check for @else
		if (
			this.check("COMPILER_KEYWORD") &&
			this.peek()?.value === CompilerSymbols.else
		) {
			this.advance(); // consume @else
			// It could be @else @if ... or just @else { ... }
			if (
				this.check("COMPILER_KEYWORD") &&
				this.peek()?.value === CompilerSymbols.if
			) {
				this.advance(); // consume @if
				elseBody = this.parseIfExpression();
			} else {
				elseBody = this.parseBlock();
			}
		}

		return new IfExpression(cond, pipeValue, body, elseBody, {
			line: ifToken.line,
			column: ifToken.column,
			path: checkNotNull(this.sourceFile?.name),
		});
	}

	private parseForExpression(): Node {
		const forToken = checkNotNull(this.previous());
		this.consume(
			"DELIMITER",
			`Expects "${Delimiters.LEFT_PAREN}" but found "${this.peek()?.value}" instead.`,
			Delimiters.LEFT_PAREN,
		);

		const expr1 = this.parseExpression(); // condition, range, or iterable

		// C-style for loops (@for ($i = 0; i < 5; i = i + 1)) are not supported.
		// Use range loops (@for (0..N) |i|) or condition loops (@for (cond)) instead.
		if (this.check("DELIMITER") && this.peek()?.value === Delimiters.SEMICOLON) {
			this.failAt(
				forToken,
				"C-style for loops are not supported. Use '@for (0..N) |i|' for range loops or '@for (condition)' for condition loops.",
			);
		}

		if (this.check("DELIMITER") && this.peek()?.value === ",") {
			this.advance(); // consume ','
			this.consume("NUMBER", "Expected '0' for array index range", "0");
			this.consume("BIN_OP", "Expected '..' for array index range", "..");
		}

		this.consume(
			"DELIMITER",
			`Expects "${Delimiters.RIGHT_PAREN}" but found "${this.peek()?.value}" instead.`,
			Delimiters.RIGHT_PAREN,
		);

		const captures: { name: string; byRef: boolean }[] = [];
		if (this.check("DELIMITER") && this.peek()?.value === "|") {
			this.advance(); // consume '|'
			let hasMoreCaptures = true;
			do {
				const name = checkNotNull(
					this.consume("IDENTIFIER", "Expected capture name"),
				).value;
				captures.push({ name, byRef: false });
				if (this.check("DELIMITER") && this.peek()?.value === ",") {
					this.advance();
				} else {
					hasMoreCaptures = false;
				}
			} while (hasMoreCaptures);
			this.consume("DELIMITER", "Expected '|' to close captures", "|");
		}

		const body = this.parseBlock();

		let kind: "condition" | "range" | "iterable" = "condition";
		let condition: Node | null = null;
		let rangeStart: Node | null = null;
		let rangeEnd: Node | null = null;
		let iterable: Node | null = null;

		if (captures.length > 0) {
			if (expr1 instanceof BinaryExpression && expr1.operator === "..") {
				kind = "range";
				rangeStart = expr1.left;
				rangeEnd = expr1.right;
			} else {
				kind = "iterable";
				iterable = expr1;
			}
		} else {
			kind = "condition";
			condition = expr1;
		}

		return new ForExpression(
			kind,
			condition,
			rangeStart,
			rangeEnd,
			iterable,
			captures,
			null,
			body,
			{
				line: forToken.line,
				column: forToken.column,
				path: checkNotNull(this.sourceFile?.name),
			},
		);
	}

	private parseReturnStatement(): Node {
		const keyword = checkNotNull(
			this.consume("KEYWORD", `Expected "${Keywords.return}"`, Keywords.return),
		);
		let returnValue: Node | null = null;
		if (
			!this.check("DELIMITER") ||
			checkNotNull(this.peek()).value !== Delimiters.SEMICOLON
		) {
			returnValue = this.parseExpression();
		}
		this.consume(
			"DELIMITER",
			`Expected "${Delimiters.SEMICOLON}"`,
			Delimiters.SEMICOLON,
		);
		return new ReturnExpression(returnValue, null, {
			line: keyword.line,
			column: keyword.column,
			path: checkNotNull(this.sourceFile?.name),
		});
	}

	private parseDeferStatement(): Node {
		const keyword = checkNotNull(
			this.consume("KEYWORD", `Expected "${Keywords.defer}"`, Keywords.defer),
		);
		let body: Node;
		if (
			this.check("DELIMITER") &&
			checkNotNull(this.peek()).value === Delimiters.LEFT_BRACE
		) {
			body = this.parseBlock();
		} else {
			const expr = this.parseExpression();
			this.consume(
				"DELIMITER",
				`Expected "${Delimiters.SEMICOLON}" after defer`,
				Delimiters.SEMICOLON,
			);
			body = expr;
		}
		return new DeferStatement(body, null, {
			line: keyword.line,
			column: keyword.column,
			path: checkNotNull(this.sourceFile?.name),
		});
	}

	private parseBreakStatement(): Node {
		const keyword = checkNotNull(
			this.consume("KEYWORD", `Expected "${Keywords.break}"`, Keywords.break),
		);
		let label: string | null = null;
		if (this.check("DELIMITER") && this.peek()?.value === ":") {
			this.advance(); // consume ':'
			label = checkNotNull(
				this.consume(
					"IDENTIFIER",
					"Expected label after ':' in break statement",
				),
			).value;
		}
		this.consume(
			"DELIMITER",
			`Expected "${Delimiters.SEMICOLON}"`,
			Delimiters.SEMICOLON,
		);
		return new BreakExpression(label, null, {
			line: keyword.line,
			column: keyword.column,
			path: checkNotNull(this.sourceFile?.name),
		});
	}

	private parseContinueStatement(): Node {
		const keyword = checkNotNull(
			this.consume(
				"KEYWORD",
				`Expected "${Keywords.continue}"`,
				Keywords.continue,
			),
		);
		let label: string | null = null;
		if (this.check("DELIMITER") && this.peek()?.value === ":") {
			this.advance(); // consume ':'
			label = checkNotNull(
				this.consume(
					"IDENTIFIER",
					"Expected label after ':' in continue statement",
				),
			).value;
		}
		this.consume(
			"DELIMITER",
			`Expected "${Delimiters.SEMICOLON}"`,
			Delimiters.SEMICOLON,
		);
		return new ContinueExpression(label, null, {
			line: keyword.line,
			column: keyword.column,
			path: checkNotNull(this.sourceFile?.name),
		});
	}

	private parseBlock(): BlockExpression {
		this.consume("DELIMITER", "Expected '{'", Delimiters.LEFT_BRACE);
		const statements: Node[] = [];

		while (
			!this.isAtEnd() &&
			!(
				this.peek()?.type === "DELIMITER" &&
				this.peek()?.value === Delimiters.RIGHT_BRACE
			)
		) {
			const stmt = this.parseStatement();
			if (stmt) statements.push(stmt);
		}

		this.consume("DELIMITER", "Expected '}'", Delimiters.RIGHT_BRACE);

		return new BlockExpression(statements, null, {
			line: this.peek()?.line || 0,
			column: 0,
			path: checkNotNull(this.sourceFile?.name),
		});
	}

	parseCompilerFunc(): Node {
		const name = this.advance();

		if (name?.type !== "IDENTIFIER") {
			this.failAt(
				checkNotNull(name),
				`Expected a valid function name but found "${name?.value}" instead.`,
			);
		}

		this.consume(
			"DELIMITER",
			`Expected "${Delimiters.LEFT_PAREN}" after function name but found "${checkNotNull(this.peek()).value}" instead.`,
			Delimiters.LEFT_PAREN,
		);

		const parsedParams = this.parseParamsList();
		const params = new Params(parsedParams.elements);
		params.isVariadic = parsedParams.isVariadic;

		let returnType: Node | null = null;
		// check if return type
		if (this.check("DELIMITER") && this.peek()?.value === ":") {
			this.advance(); // eat ":"
			returnType = this.parseType();
		}

		const body = this.parseBlock();

		const func = new FunctionDeclaration(name.value, params, body, returnType, null, {
			line: name.line,
			column: name.column,
			path: checkNotNull(this.sourceFile?.name),
		});

		// Fix up parents
		body.parent = func;
		params.parent = func;

		return func;
	}


	parseCompilerConst(): Node {
		return this.parseDeclaration(true);
	}

	parsecompilerImport(): Node {
		const leftParen = checkNotNull(this.peek());

		assert(
			checkNotNull(this.sourceFile?.name),
			this.source,
			leftParen.value === Delimiters.LEFT_PAREN,
			'Expected "(" after import',
			leftParen.line,
			leftParen.column,
		);
		this.advance();

		const _import = checkNotNull(this.peek());

		if (_import.type !== "STRING") {
			this.failAt(
				_import,
				`Unexpected import value "${_import.value}". Expected a valid path.`,
			);
		}

		const importPath = checkNotNull(this.advance());

		assert(
			checkNotNull(this.sourceFile?.name),
			this.source,
			checkNotNull(this.peek()).value === Delimiters.RIGHT_PAREN,
			'Expected ")" after import path',
			checkNotNull(this.peek()).line,
			checkNotNull(this.peek()).column,
		);

		this.advance();
		this.consume(
			"DELIMITER",
			`Expected "${Delimiters.SEMICOLON}" after import statement, found "${checkNotNull(this.peek()).value}" instead`,
			Delimiters.SEMICOLON,
		);

		return new ImportNode(importPath.value, {
			line: importPath.line,
			column: importPath.column,
			path: checkNotNull(this.sourceFile?.name),
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
		this.source = source;
		this.sourceFile = Bun.file(path);
		const scannerResult = scan(source, path);
		// Note: You should check scannerResult.errors here before proceeding!

		this.tokens = scannerResult.tokens;
		this.current = 0;

		// console.log(...this.tokens)
		// process.exit(0);

		const doc = this.buildAst();
		doc.path = path;
		doc.source = source;
		return doc;
	}

	public async parseFile(path: string): Promise<{
		stats: fs.Stats;
		code: string;
		parsed: DocumentBody;
	}> {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			throw Error(`File not found: ${path}`);
		}
		const stats = await file.stat();
		const content = await file.text();
		this.sourceFile = file;
		this.source = content;

		return { stats, code: content, parsed: this.parse(content, path) };
	}
}
