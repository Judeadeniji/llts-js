/**
 * LLTS test helpers — thin wrappers around the compiler+VM so tests
 * can be written as plain Bun test() calls.
 */
import { spawnSync } from "bun";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const ROOT = path.resolve(import.meta.dir, "..");
const ENTRY = path.join(ROOT, "src/index.ts");

export interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	lines: string[];
}

/** Compile and run an inline .lls source string. */
export function runSource(source: string): RunResult {
	const tmp = path.join(os.tmpdir(), `llts_test_${Date.now()}_${Math.random().toString(36).slice(2)}.lls`);
	fs.writeFileSync(tmp, source, "utf-8");
	try {
		return runFile(tmp);
	} finally {
		fs.unlinkSync(tmp);
	}
}

/** Compile and run a file from the examples/ directory. */
export function runFile(filePath: string): RunResult {
	const result = spawnSync(["bun", "run", ENTRY, "-i", filePath], {
		cwd: ROOT,
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	const allLines = stdout.split(/\r?\n/);
	// Remove trailing empty lines (from final newline) but keep internal empty lines
	while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
		allLines.pop();
	}
	return {
		stdout,
		stderr,
		exitCode: result.exitCode ?? 1,
		lines: allLines,
	};
}

/** Assert the run succeeded (exit 0) and produced exactly the expected output lines. */
export function expectOutput(result: RunResult, expected: string[]) {
	if (result.exitCode !== 0) {
		throw new Error(
			`Expected exit 0, got ${result.exitCode}.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
		);
	}
	for (let i = 0; i < expected.length; i++) {
		const line = result.lines[i];
		const want = expected[i];
		if (line !== want) {
			throw new Error(
				`Output line ${i + 1} mismatch:\n  expected: ${JSON.stringify(want)}\n  got:      ${JSON.stringify(line)}\nFull output:\n${result.stdout}`,
			);
		}
	}
}

/** Assert the run failed (non-zero exit) and stderr/stdout contains the given message. */
export function expectError(result: RunResult, containing: string) {
	if (result.exitCode === 0) {
		throw new Error(
			`Expected a non-zero exit but process succeeded.\nstdout: ${result.stdout}`,
		);
	}
	const combined = result.stderr + result.stdout;
	if (!combined.includes(containing)) {
		throw new Error(
			`Expected error containing ${JSON.stringify(containing)}\nbut got:\n${combined}`,
		);
	}
}
