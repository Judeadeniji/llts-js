/**
 * Arrays/slices use global len(); negative indices are rejected.
 * `$name` is declaration-only; uses omit the sigil.
 */
import { test } from "bun:test";
import { runSource, expectOutput, expectError } from "./helpers";

test("len(arr) returns element count", () => {
	expectOutput(
		runSource(`
$a = [10, 20, 30];
print(len(a));
print(a[0]);
print(a[2]);
`),
		["3", "10", "30"],
	);
});

test("len of empty array is 0", () => {
	expectOutput(
		runSource(`
$a = [];
print(len(a));
`),
		["0"],
	);
});

test("len works on strings", () => {
	expectOutput(
		runSource(`
print(len("hi"));
`),
		["2"],
	);
});

test("negative array index is a runtime error", () => {
	expectError(
		runSource(`
$a = [1, 2, 3];
print(a[-1]);
`),
		"Array index must be >= 0",
	);
});

test("for-in over array uses len", () => {
	expectOutput(
		runSource(`
$sum = 0;
@for ([10, 20, 30]) |x| {
    sum = sum + x;
}
print(sum);
`),
		["60"],
	);
});

test("sigil is rejected in expression uses", () => {
	expectError(
		runSource(`
$a = 1;
print($a);
`),
		"only used in declarations",
	);
});

test("sigil is rejected on compound assignment", () => {
	expectError(
		runSource(`
$a = 1;
$a += 2;
`),
		"only used in declarations",
	);
});

test("redeclaration with $ in the same scope is an error", () => {
	expectError(
		runSource(`
$a = 1;
$a = 2;
`),
		"already declared",
	);
});

test("bare name reassignment works after $ declaration", () => {
	expectOutput(
		runSource(`
$a = 1;
a = 2;
print(a);
`),
		["2"],
	);
});
