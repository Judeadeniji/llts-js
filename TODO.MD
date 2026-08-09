# LLTS Project Status & Roadmap

## ✅ Current Capabilities

### Lexer (Scanner)
- [x] Basic Tokens: Identifiers, Numbers (int, float, hex, binary, octal), Strings, Booleans.
- [x] Registers: `$a`, `$t0`, etc.
- [x] Keywords: `return`, `true`, `false`, `break`, `continue`, `pub`.
- [x] Compiler Directives: `@func`, `@import`, `@const`, `@if`, `@for`, `@struct`.
- [x] Operators: Arithmetic, Assignment (including compound `+=` etc.), Comparison, Logical, Pipe (`|>`), Power (`**`).
- [x] Comments: Line comments starting with `#`.

### Parser
- [x] Function Declarations: `@func name(params): type { body }`.
- [x] Variable Declarations: `$var = value`, `@const $var = value`.
- [x] Expressions: Binary, Unary, Call, Member access, Pipe (`|>`), Index (`[]`).
- [x] Control Flow: `@if`/`@else`, `@for` (range `0..N` and condition forms).
- [x] Loops: `break`, `continue`, labeled loops.
- [x] Structs: `@struct` with fields and methods.
- [x] Arrays: Array literals `[a, b, c]` and index access `arr[i]`.
- [x] Imports: `@import("path")` with module namespacing.
- [x] Explicit errors for unsupported syntax (`@typeOf`, C-style for loops).

### Compiler & VM
- [x] Bytecode generation and execution.
- [x] Static call inlining + `OP_CALL_STATIC` for recursive/looping functions.
- [x] Dynamic first-class function calls (`OP_CALL` on `LLTSFunction`).
- [x] Return-type tracking for fluent method chaining (e.g. `factory().build().run()`).
- [x] Struct heap allocation, field offsets, method dispatch.
- [x] Module import system.
- [x] `OP_SET_PROPERTY` — dynamic property assignment on objects.
- [x] Mutual recursion + call graph cycle detection.

### Standard Library (`std/`) — optional library, not language core
- Imports use explicit paths (e.g. `@import("std/math")`); the compiler has no stdlib short-name aliases.
- [x] `std/math`: `add`, `sub`, `mul`, `div`, `mod`, `pow`, `sqr`, `min`, `max`, …
- [x] `std/debug`: `printLn`, `log`, `assert`.
- [x] `std/mem`: `alloc`.
- [x] `std/io`: file/stdin helpers via host `__*` bindings.

### Tooling
- [x] Basic test suite (`bun test tests/`).

---

## 🚧 Roadmap — Ordered by Priority

### P0 — Silent Wrong Behaviour (no error, wrong result)

- [x] **Hex / binary / octal literals** — scanned and parsed correctly but compiler emits no bytecode.
  - File: `src/compiler/expressions.ts` `LiteralNode` case.
- [x] **`^` exponent operator** — defined as `BinOps.pow` but only `**` is compiled; `^` emits nothing.
  - File: `src/compiler/expressions.ts` `BinaryExpression` case.
- [x] **Unary `+`** — parsed but no opcode emitted. (Working by design as an identity operator).

### P1 — Missing Language Features

- [x] **Explicit error handling** — language-level error types, `error(msg)` and `?` operator.
- [x] **`@const` enforcement** — `@const` declarations must be immutable; re-assignment should be a compile error.
  - File: `src/compiler/statements.ts` `DeclarationNode` + scope tracker.

### P2 — Standard Library

- [ ] **String operations** — `strlen`, `concat`, `substr`, `indexOf`, `split` in `std/string.lls`.
- [ ] **Real `std.io`** — `readLine()` reads from stdin, `readFile(path)` reads disk via native binding.
- [ ] **Math extras** — `min`, `max`, `abs`, `floor`, `ceil`.

### P3 — Safety & Correctness

- [x] **Array bounds checking** — `arr[i]` should throw a runtime error when `i >= length`, not silently corrupt heap.
- [x] **`@const` at VM level** — constants frozen after initial write; mutation = runtime error.
- [x] **LLTS source locations in runtime errors** — VM errors should report the LLTS file/line, not the TypeScript source line.

### P4 — Type System

- [x] **Type checker pass** — gradual semantic analysis before bytecode emission (`src/compiler/typecheck.ts`).
- [x] **Return / param / field annotations enforced** when present; unannotated = `Unknown`.
- [x] **`$name: T`**, `[]T` / `[N]T` (incl. nested), structured `T | error`; aliases `i32`/`number`→`int`, `boolean`→`bool`.
- [x] **`string` ≡ `[]byte`**; string literals infer as `[N]byte`.
- [x] **Structs as types** — named struct annotations validated against declared structs.
- [x] **Debug `OP_ASSERT_TYPE`** at typed boundaries; strip with `--release`.
- [x] **`@typeOf(expr)`** — compile-time type reflection as a `string` (print with `print(@typeOf(x))`).
- [x] **`pub` for user files** — cross-file visibility; private decls compile for the module but are not exported; `./` / `../` imports resolve relative to the importer.

### P5 — Memory

- [ ] **Memory management** — `free(ptr)` or a simple mark-and-sweep GC over the `Int32Array` heap.

### P6 — Tooling

- [ ] **Comprehensive test suite** — tests for parser, compiler, and VM covering all language features.
- [ ] **CLI improvements** — better error reporting with LLTS source context, `--help`, `--version`.
- [ ] **LSP** — syntax highlighting and basic diagnostics for editors.

---

## ⏸ Deferred

- [ ] **VM string encoding / byte heap type** — today strings are JS strings + heap `[len][charCode…]`; a real tagged byte buffer / unified encoding is later.
- [ ] **Runtime-enforced fixed buffers** — `[N]T` is compile-time only; capacity traps / non-growing buffers later.
- [ ] **UTF-8 vs code-unit length** — `len` / `[N]byte` inference currently use JS UTF-16 code units; revisit UTF-8 byte vs code-point policy later.

---

## ❌ Removed / Not Planned

- `@while` loops: removed completely (use `@for` with a condition instead).
- C-style `@for ($i=0; i<N; i=i+1)`: not planned; use `@for (0..N) |i|`.
- **Generics / symbolic `[N]T` type params** — not planned; array lengths stay numeric literals only.
