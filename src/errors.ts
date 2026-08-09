/**
 * LLTS diagnostic printing — always to process.stderr (no JS host stacks by default).
 */

const colors = {
	reset: "\x1b[0m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
	bold: "\x1b[1m",
};

function writeStderr(line: string): void {
	process.stderr.write(`${line}\n`);
}

/** Pretty-print a source location to stderr. */
export function reportSourceError(
	path: string,
	source: string,
	line: number,
	column: number,
	message: string,
) {
	const lines = source.split("\n");
	const lineIndex = line - 1;
	const lineContent = lines[lineIndex];

	if (typeof lineContent === "undefined") {
		writeStderr(
			`${path}: ${colors.red}Error:${colors.reset} ${message} (at line ${line})`,
		);
		return;
	}

	const lineNumberStr = line.toString();
	const gutterPadding = " ".repeat(lineNumberStr.length);
	const pointerPadding = " ".repeat(Math.max(0, column - 1));

	writeStderr(
		`${path}: ${colors.red}${colors.bold}Error:${colors.reset} ${message}`,
	);
	if (lineIndex > 0) {
		writeStderr(
			`${colors.gray}   ${line - 1} |${colors.reset} ${lines[lineIndex - 1] ?? ""}`,
		);
	}
	writeStderr(
		`${colors.cyan}  ${gutterPadding}--> ${path}:${line}:${column}${colors.reset}`,
	);
	writeStderr(
		`${colors.gray}   ${lineNumberStr} |${colors.reset} ${lineContent}`,
	);
	writeStderr(
		`${colors.gray}   ${gutterPadding} |${colors.reset} ${pointerPadding}${colors.red}^${colors.reset}`,
	);
	if (lineIndex + 1 < lines.length) {
		writeStderr(
			`${colors.gray}   ${line + 1} |${colors.reset} ${lines[lineIndex + 1] ?? ""}`,
		);
	}
}

export interface StackFrameInfo {
	funcName: string;
	line: number;
}

/** Format LLTS frames, innermost (current) first. */
export function formatVmStackTrace(
	frames: StackFrameInfo[],
	file: string,
	currentLine: number,
): string {
	const lines: string[] = [];
	for (let i = frames.length - 1; i >= 0; i--) {
		const fr = frames[i]!;
		const name = fr.funcName || "<script>";
		const line = i === frames.length - 1 ? currentLine : fr.line || 0;
		const loc = line > 0 ? `${file}:${line}` : file;
		lines.push(`    at ${name} (${loc})`);
	}
	return lines.join("\n");
}

export function reportCompileMessage(message: string): void {
	writeStderr(`${colors.red}${colors.bold}Error:${colors.reset} ${message}`);
}

export function reportStackTrace(trace: string): void {
	if (trace) writeStderr(trace);
}

/** Single location frame for parse/compile diagnostics (no VM stack). */
export function reportLocationFrame(
	file: string,
	line: number,
	name = "<script>",
): void {
	const loc = line > 0 ? `${file}:${line}` : file;
	writeStderr(`    at ${name} (${loc})`);
}

/** Thrown after LLTS diagnostics were already written to stderr. */
export class ReportedError extends Error {
	readonly lltsReported = true;
	constructor(message: string, name = "RuntimeError") {
		super(message);
		this.name = name;
	}
}
