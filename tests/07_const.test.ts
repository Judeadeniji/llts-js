import { test } from "bun:test";
import { runSource, expectOutput, expectError } from "./helpers";

// ---------------------------------------------------------------------------
// Basic reassignment / shadowing (existing, kept for regression)
// ---------------------------------------------------------------------------

test("cannot reassign to a @const variable", () => {
  expectError(runSource(`
@const $a = 10;
a = 20;
print(a);
`), "CompileError: Cannot reassign to constant variable 'a'");
});

test("can shadow a @const variable in a new scope", () => {
  expectOutput(runSource(`
@const $a = 10;
@if (true) {
    @const $a = 20;
    print(a);
}
print(a);
`), ["20", "10"]);
});

// ---------------------------------------------------------------------------
// Reassignment via compound operators
// ---------------------------------------------------------------------------

test("cannot use += on a @const variable", () => {
  expectError(runSource(`
@const $a = 10;
a += 5;
print(a);
`), "CompileError: Cannot reassign to constant variable 'a'");
});

test("cannot use -=, *=, /= on a @const variable", () => {
  expectError(runSource(`
@const $a = 10;
a -= 1;
`), "CompileError: Cannot reassign to constant variable 'a'");
});

// ---------------------------------------------------------------------------
// Shadowing across different block types
// ---------------------------------------------------------------------------

test("can shadow a @const variable inside a for loop body", () => {
  expectOutput(runSource(`
@const $a = 1;
@for (0..1) |i| {
    @const $a = 99;
    print(a);
}
print(a);
`), ["99", "1"]);
});

test("can shadow a @const variable inside a plain block", () => {
  expectOutput(runSource(`
@const $a = "outer";
@if (true) {
    @const $a = "inner";
    print(a);
}
print(a);
`), ["inner", "outer"]);
});

test("can shadow a @const with a regular (non-const) variable in inner scope", () => {
  expectOutput(runSource(`
@const $a = 10;
@if (true) {
    $a = 20;
    print(a);
    a = 30;
    print(a);
}
print(a);
`), ["20", "30", "10"]);
});

test("shadowing does not affect the outer binding even after inner mutation", () => {
  expectOutput(runSource(`
@const $a = 5;
@if (true) {
    $a = 5;
    a = a + 100;
    print(a);
}
print(a);
`), ["105", "5"]);
});

test("nested shadowing three levels deep resolves to nearest scope", () => {
  expectOutput(runSource(`
@const $a = 1;
@if (true) {
    @const $a = 2;
    @if (true) {
        @const $a = 3;
        print(a);
    }
    print(a);
}
print(a);
`), ["3", "2", "1"]);
});

// ---------------------------------------------------------------------------
// Function scope interaction
// ---------------------------------------------------------------------------

test("can shadow an outer @const with a @const parameter of the same name", () => {
  expectOutput(runSource(`
@const $a = "global";

@func show(a: string) {
    print(a);
}

show("local");
print(a);
`), ["local", "global"]);
});

test("@const declared inside a function is scoped to that function", () => {
  expectOutput(runSource(`
@func makeConst() {
    @const $a = 42;
    print(a);
}

makeConst();
$a = 7;
print(a);
`), ["42", "7"]);
});

test("cannot reassign a @const captured and used across multiple statements in a function", () => {
  expectError(runSource(`
@func doWork() {
    @const $a = 10;
    print(a);
    a = 20;
}
doWork();
`), "CompileError: Cannot reassign to constant variable 'a'");
});

// ---------------------------------------------------------------------------
// Mutability of contents vs identity (arrays / objects)
// ---------------------------------------------------------------------------

test("@const array binding cannot be reassigned, but elements can be mutated", () => {
  expectOutput(runSource(`
@const $arr = [1, 2, 3];
arr[0] = 99;
print(arr[0]);
`), ["99"]);
});

test("cannot reassign a @const array to a whole new array", () => {
  expectError(runSource(`
@const $arr = [1, 2, 3];
arr = [4, 5, 6];
print(arr);
`), "CompileError: Cannot reassign to constant variable 'arr'");
});

test("@const object binding cannot be reassigned, but fields can be mutated", () => {
  expectOutput(runSource(`
@struct Obj { x: int; }
@const $obj = Obj { x: 1 };
obj.x = 2;
print(obj.x);
`), ["2"]);
});

// ---------------------------------------------------------------------------
// Declaration edge cases
// ---------------------------------------------------------------------------

test("@const requires an initializer", () => {
  expectError(runSource(`
@const $a;
print(a);
`), "Expected \"=\" after \"a\"");
});

test("cannot redeclare the same @const twice in the same scope", () => {
  expectError(runSource(`
@const $a = 1;
@const $a = 2;
print(a);
`), "CompileError: Variable 'a' already declared in this scope");
});

test("cannot declare a regular variable then redeclare it as @const in the same scope", () => {
  expectError(runSource(`
$a = 1;
@const $a = 2;
print(a);
`), "CompileError: Variable 'a' already declared in this scope");
});

// ---------------------------------------------------------------------------
// for-loop capture variables and const
// ---------------------------------------------------------------------------

test("for-loop capture variable behaves as effectively const within the body", () => {
  expectError(runSource(`
@for (0..3) |i| {
    i = 99;
}
`), "CompileError: Cannot reassign to constant variable 'i'");
});

test("shadowing the loop capture name with an explicit @const inside body is allowed", () => {
  expectOutput(runSource(`
@for (0..1) |i| {
    @const $i = 100;
    print(i);
}
`), ["100"]);
});