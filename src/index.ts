// others
import { Parser } from "./parser";
import { ReportedError, reportCompileMessage } from "./errors";
import { VM } from "./vm";

// ----------------------------------------------------------------------

const args = process.argv.slice(2);

const commands = [
	{
		short: "i",
		long: "input",
		expectsValue: true,
		required: true,
	},
	{
		short: "o",
		long: "output",
		expectsValue: true,
	},
	{
		short: "r",
		long: "release",
		expectsValue: false,
	},
];

let arg: string | undefined;
const cmds: {
	c: string;
	v: string | undefined;
}[] = [];

while ((arg = args.shift())) {
	if (!arg) {
		break;
	}

	if (arg.startsWith("-")) {
		let c = arg.slice(1);
		let v: string | undefined;
		if (c.startsWith("-")) c = arg.slice(2);

		const command = commands.find((cmd) => [cmd.long, cmd.short].includes(c));

		if (!command) {
			throw Error(`Invalid command: "${c}"`);
		}

		const { expectsValue, required } = command;

		if (expectsValue) {
			v = args.shift();
		}

		if (required && v === undefined) throw Error(`Missing value for "${c}"`);

		cmds.push({
			c: command.long,
			v,
		});
	}
}

const release = cmds.some((c) => c.c === "release");
executeCommands(cmds, release);

function executeCommands(
	cmds: { c: string; v: string | undefined }[],
	release: boolean,
) {
	for (const { c, v } of cmds) {
		switch (c) {
			case "input":
				return parseInput(v!, release);
			case "release":
				break;
			default:
				throw Error(`Invalid command: "${c}"`);
		}
	}
}

async function parseInput(path: string, release: boolean) {
	try {
		const parser = new Parser();

		const result = await parser.parseFile(path);

		const vm = new VM();
		vm.run(result.parsed, { debug: !release });
	} catch (e) {
		if (e instanceof ReportedError || (e as { lltsReported?: boolean })?.lltsReported) {
			process.exit(1);
		}
		if (e instanceof Error) {
			const msg = e.message;
			if (
				msg.startsWith("CompileError:") ||
				msg.startsWith("TypeCheckError:") ||
				e.name === "TypeCheckError"
			) {
				reportCompileMessage(msg.replace(/^TypeCheckError:\s*/, ""));
				process.exit(1);
			}
			process.stderr.write(`${msg}\n`);
			process.exit(1);
		}
		process.stderr.write(`${String(e)}\n`);
		process.exit(1);
	}
}
