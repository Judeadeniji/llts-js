# LLTS-JS

A custom language parser and compiler written in TypeScript.

**LLTS** stands for **Low Level TypeScript**. Note that this is **not** a "TypeScript to LLVM" compiler; it simply means the language implementation itself is written in JavaScript/TypeScript.

> **Note**: This project is a personal learning experiment to understand how compilers, parsers, and ASTs work. It is not intended for production use.

## Features

- **Custom Syntax**: Supports function declarations (`@func`), variable registers (`$var`), and basic arithmetic.
- **Hand-written Parser**: Implements a recursive descent parser.
- **AST Generation**: Produces a structured Abstract Syntax Tree.
- **Built with Bun**: Fast runtime and development.

## Installation

```bash
bun install
```

## Usage

To parse a file:

```bash
bun run src/index.ts -i examples/functions.lls
```

## Example

```typescript
@func add(a: i32, b: i32): i32 {
    return a + b;
}

@func main() {
    $a = 1;
    $b = 2;
    $c = add($a, $b);
    print($c);
}
```
