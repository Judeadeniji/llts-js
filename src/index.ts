import { Parser } from "./parser";

const args = process.argv.slice(2);

const commands = [
    {
        short: "i",
        long: "input",
        expectsValue: true,
        required: true
    },
    {
        short: "o",
        long: "output",
        expectsValue: true
    }
];

let arg: string | undefined;
let cmds: {
    c: string;
    v: string | undefined;
}[] = []

while (arg = args.shift()) {
    if (!arg) {
        break;
    }

    if (arg.startsWith("-")) {
        let c = arg.slice(1);
        let v: string | undefined;
        if (c.startsWith("-")) c = arg.slice(2);

        const command = commands.find((cmd) => [cmd.long, cmd.short].includes(c));

        if (!command) {
            throw Error(`Invalid command: "${c}"`)
        }

        const { expectsValue, required } = command;

        if (expectsValue) {
            v = args.shift();
        }

        if (required && v === undefined) throw Error(`Missing value for "${c}"`);

        cmds.push({
            c, v
        })
    }
}

executeCommands(cmds)

function executeCommands(cmds: { c: string; v: string | undefined }[]) {
    for (const { c, v } of cmds) {
        switch (c) {
            case "input":
                return parseInput(v!);

            default:
                throw Error(`Invalid command: "${c}"`)
        }
    }
}

async function parseInput(path: string) {
    const parser = new Parser();

    const result = await parser.parseFile(path);
    console.dir(result.parsed, {
        depth: Number.POSITIVE_INFINITY
    })
}

