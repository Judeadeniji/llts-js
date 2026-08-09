/**
 * Gradual typechecker: annotations enforced when present.
 */
import { test } from "bun:test";
import { expectError, expectOutput, runSource } from "./helpers";

test("$x: int = 1 parses and runs", () => {
	expectOutput(
		runSource(`
$x: int = 1;
print(x);
`),
		["1"],
	);
});

test("$x: i32 accepts int literal via alias normalize", () => {
	expectOutput(
		runSource(`
$x: i32 = 42;
print(x);
`),
		["42"],
	);
});

test("$x: int = string is a type error", () => {
	expectError(
		runSource(`
$x: int = "hi";
print(x);
`),
		"not assignable",
	);
});

test("annotated param mismatch is a type error", () => {
	expectError(
		runSource(`
@func add(a: int, b: int): int {
    return a + b;
}
print(add(1, "x"));
`),
		"not assignable",
	);
});

test("annotated return mismatch is a type error", () => {
	expectError(
		runSource(`
@func bad(): int {
    return "nope";
}
print(bad());
`),
		"not assignable",
	);
});

test("unannotated wrong call still compiles (gradual)", () => {
	expectOutput(
		runSource(`
@func id(a) {
    return a;
}
print(id(1));
print(id("hi"));
`),
		["1", "hi"],
	);
});

test("struct field type mismatch", () => {
	expectError(
		runSource(`
@struct Point {
    x: int;
    y: int;
}
$p = Point { x: 1, y: "bad" };
print(p.x);
`),
		"not assignable",
	);
});

test("[]int array type annotation", () => {
	expectOutput(
		runSource(`
$a: []int = [1, 2, 3];
print(a[0]);
print(len(a));
`),
		["1", "3"],
	);
});

test("T | error and ? unwrap", () => {
	expectOutput(
		runSource(`
@func ok(): string | error {
    return "yes";
}
@func main(): string | error {
    $s = ok()?;
    print(s);
    return s;
}
`),
		["yes"],
	);
});

test("boolean alias normalizes to bool", () => {
	expectOutput(
		runSource(`
$b: boolean = true;
print(b);
`),
		["true"],
	);
});

test("@typeOf prints annotated and inferred types", () => {
	expectOutput(
		runSource(`
$x: int = 1;
$y = "hi";
$z: []int = [1, 2];
print(@typeOf(x));
print(@typeOf(y));
print(@typeOf(z));
print(@typeOf(true));
`),
		["int", "string", "[]int", "bool"],
	);
});

test("@typeOf on T | error and after ?", () => {
	expectOutput(
		runSource(`
@func f(): string | error {
    return "ok";
}
print(@typeOf(f()));
$s = f()?;
print(@typeOf(s));
`),
		["string | error", "string"],
	);
});

test("@typeOf arity must be 1", () => {
	expectError(
		runSource(`
print(@typeOf(1, 2));
`),
		"@typeOf expects exactly 1 argument",
	);
});
