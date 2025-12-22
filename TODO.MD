# LLTS Project Status & Roadmap

This document tracks the current capabilities of the LLTS (Low Level TypeScript) language and outlines the future roadmap.

## ✅ Current Capabilities

### Lexer (Scanner)
- [x] **Basic Tokens**: Identifiers, Numbers, Strings, Booleans (`true`, `false`).
- [x] **Registers**: Support for register-based variables (e.g., `$a`, `$t0`).
- [x] **Keywords**: `return`, `true`, `false`.
- [x] **Compiler Directives**: `@func`, `@import`, `@const`, `@typeOf`.
- [x] **Operators**: Arithmetic (`+`, `-`, `*`, `/`), Assignment (`=`), Comparison (lexed but maybe not fully parsed).
- [x] **Comments**: Line comments starting with `#`.

### Parser
- [x] **Function Declarations**:
  - Syntax: `@func name(params): type { body }`.
  - Typed and untyped parameters.
  - Return type annotations.
- [x] **Variable Declarations**:
  - Register assignment: `$var = value`.
  - Typed declarations: `$var: type = value`.
  - Constant declarations: `@const $var = value`.
- [x] **Expressions**:
  - Binary expressions (precedence handling implemented).
  - Unary expressions.
  - Function calls.
  - Member access (`obj.prop`).
- [x] **Statements**:
  - `return` statements.
  - Expression statements.
  - Block statements `{ ... }`.
- [x] **Imports**: Basic parsing of `@import("path")`.

### AST
- [x] Structured Node classes for all implemented parser features (`DocumentBody`, `FunctionDeclaration`, `BinaryExpression`, etc.).

---

## 🚧 Roadmap / Missing Features

### 1. Control Flow (High Priority)
The language currently lacks basic control flow structures.
- [ ] **If/Else Statements**: Parse `if (cond) { ... } else { ... }`.
- [ ] **Loops**:
  - `while (cond) { ... }`
  - `for` loops.
- [ ] **Branching**: `break`, `continue`.

### 2. Type System
Currently, types are parsed as annotations but not validated.
- [ ] **Type Checker**: Implement a semantic analysis pass to verify types.
- [ ] **Custom Types**: Support for `struct` or `interface` definitions.
- [ ] **Arrays/Lists**: Syntax and support for collection types.

### 3. Backend / Execution
The project currently only produces an AST.
- [ ] **Interpreter**: A tree-walk interpreter to execute the AST directly (for testing/prototyping).
- [ ] **Code Generation**:
  - Target LLVM IR?
  - Target C?
  - Target JavaScript?
- [ ] **Standard Library**: Built-in functions beyond `print` (e.g., math, IO).

### 4. Tooling & DX
- [ ] **CLI Improvements**: Better error reporting, help commands.
- [ ] **LSP**: A basic Language Server for syntax highlighting and errors in editors.
- [ ] **Tests**: Comprehensive test suite for parser and scanner edge cases.

### 5. Advanced Features
- [ ] **Module Resolution**: Actual linking of `@import`ed files.
- [ ] **Memory Management**: Define how memory is handled (manual vs GC vs ownership).
- [ ] **Scopes**: Proper lexical scoping rules (currently basic).
