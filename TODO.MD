# LLTS Project Status & Roadmap

This document tracks the current capabilities of the LLTS (Low Level TypeScript) language and outlines the future roadmap.

## ✅ Current Capabilities

### Lexer (Scanner)

- [x] **Basic Tokens**: Identifiers, Numbers, Strings, Booleans (`true`, `false`).
- [x] **Registers**: Support for register-based variables (e.g., `$a`, `$t0`).
- [x] **Keywords**: `return`, `true`, `false`.
- [x] **Compiler Directives**: `@func`, `@import`, `@const`, `@typeOf`, `@if`, `@while`, `@for`, `@struct`.
- [x] **Operators**: Arithmetic (`+`, `-`, `*`, `/`), Assignment (`=`), Comparison (`<`, `>`, `==`, `!=`).
- [x] **Comments**: Line comments starting with `#`.

### Parser

- [x] **Function Declarations**:
  - Syntax: `@func name(params): type { body }`.
  - Typed and untyped parameters.
- [x] **Variable Declarations**:
  - Register assignment: `$var = value`.
  - Typed declarations: `$var: type = value`.
  - Constant declarations: `@const $var = value`.
- [x] **Expressions**:
  - Binary/Unary expressions.
  - Function calls.
  - Member access (`obj.prop`).
  - Pipe operator (`|>` for function composition).
- [x] **Statements**:
  - Control Flow: `@if`, `@while`, `@for` loop structures.
  - Returns, Blocks, and Expressions.
- [x] **Structs**: `@struct` definitions with fields and methods.

### Compiler & VM

- [x] **Bytecode Generation**: Emits custom bytecode (e.g. `OP_ADD`, `OP_CALL_STATIC`).
- [x] **Compile-time Functions**: Functions compiled entirely ahead of time.
  - Mutual recursion support via call graph detection (DFS).
  - Forward-reference patching.
  - Inlining for simple functions vs. static jumps for loops/recursive calls.
- [x] **VM Execution**: 
  - Execution over an `Int32Array` heap.
  - Call stack frames, locals, and scope management.
  - Dynamic module system execution.

---

## 🚧 Roadmap / Missing Features

### 1. Control Flow (High Priority)
- [x] **Branching**: `break`, `continue` keywords inside loops.

### 2. Type System & Data Structures
- [ ] **Arrays/Lists**: Syntax and support for primitive collection types over the `Int32Array` heap.
- [ ] **Type Checker**: Implement semantic analysis pass to verify types natively.

### 3. Backend / Execution
- [ ] **Standard Library**: Built-in functions beyond `print` (e.g., math, memory allocators).
- [ ] **Memory Management**: Define cleanup logic (manual freeing or basic GC over Int32Array).

### 4. Tooling & DX
- [ ] **CLI Improvements**: Better error reporting, help commands.
- [ ] **LSP**: A basic Language Server for syntax highlighting and errors in editors.
- [ ] **Tests**: Comprehensive test suite for parser, compiler, and VM.
