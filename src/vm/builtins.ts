// others
import * as fs from "node:fs";
import { NativeFunction, type Value } from "../bytecode";
import type { VMState } from "./state";

// ----------------------------------------------------------------------

export function defineNative(
	state: VMState,
	name: string,
	func: (...args: Value[]) => Value,
) {
	state.globals.set(name, new NativeFunction(name, func, 0));
}

export function registerBuiltins(state: VMState) {
	defineNative(state, "print", (...args: Value[]) => {
		console.log(...args);
		return null;
	});

	// Heap slices/arrays/strings store length at ptr-1; len(ptr) reads it.
	defineNative(state, "len", (...args: Value[]) => {
		if (args.length !== 1) {
			throw new Error("len() expects exactly 1 argument");
		}
		const ptr = args[0] as number;
		if (typeof ptr !== "number") {
			throw new Error("len() expects an array, slice, or string");
		}
		return state.memory[ptr - 1] as number;
	});

	defineNative(state, "__printLn", (...args: Value[]) => {
		const ptr = args[0] as number;
		const len = state.memory[ptr - 1] as number;
		let msg = "";
		for (let i = 0; i < len; i++) {
			msg += String.fromCharCode(state.memory[ptr + i] as number);
		}

		for (let i = 1; i < args.length; i++) {
			if (args[i] !== undefined) {
				if (msg.includes("{s}")) {
					const strPtr = args[i] as number;
					const strLen = state.memory[strPtr - 1] as number;
					let s = "";
					for (let j = 0; j < strLen; j++) {
						s += String.fromCharCode(state.memory[strPtr + j] as number);
					}
					msg = msg.replace("{s}", s);
				} else if (msg.includes("{i}")) {
					msg = msg.replace("{i}", String(args[i]));
				}
			}
		}
		console.log(msg);
		return null;
	});

	defineNative(state, "__alloc", (...args: Value[]) => {
		const size = args[0] as number;
		const ptr = state.heap.ptr;
		state.heap.ptr += size;
		return ptr;
	});

	function readString(ptr: number): string {
		const len = state.memory[ptr - 1] as number;
		let str = "";
		for (let i = 0; i < len; i++) {
			str += String.fromCharCode(state.memory[ptr + i] as number);
		}
		return str;
	}

	function writeString(str: string): number {
		const ptr = state.heap.ptr;
		state.memory[ptr] = str.length;
		for (let i = 0; i < str.length; i++) {
			state.memory[ptr + 1 + i] = str.charCodeAt(i);
		}
		state.heap.ptr += 1 + str.length;
		return ptr + 1;
	}

	function writeArray(arr: number[]): number {
		const ptr = state.heap.ptr;
		state.memory[ptr] = arr.length;
		for (let i = 0; i < arr.length; i++) {
			state.memory[ptr + 1 + i] = arr[i]!;
		}
		state.heap.ptr += 1 + arr.length;
		return ptr + 1;
	}

	defineNative(state, "__strlen", (...args: Value[]) => {
		const ptr = args[0] as number;
		return state.memory[ptr - 1] as number;
	});

	defineNative(state, "__substr", (...args: Value[]) => {
		const str = readString(args[0] as number);
		const start = args[1] as number;
		const len = args[2] as number;
		return writeString(str.substring(start, start + len));
	});

	defineNative(state, "__indexOf", (...args: Value[]) => {
		const str = readString(args[0] as number);
		const search = readString(args[1] as number);
		return str.indexOf(search);
	});

	defineNative(state, "__split", (...args: Value[]) => {
		const str = readString(args[0] as number);
		const sep = readString(args[1] as number);
		const parts = str.split(sep);
		const ptrs = parts.map((p) => writeString(p));
		return writeArray(ptrs);
	});

	defineNative(state, "__readFile", (...args: Value[]) => {
		const path = readString(args[0] as number);
		try {
			const content = fs.readFileSync(path, "utf8");
			return writeString(content);
		} catch (e: any) {
			// Return a magic error struct pointer! But we don't have a way to allocate one natively easily here, 
			// so we just return -1 or similar, and let standard library wrap it in an error?
			// Actually, let's allocate an error struct.
			// struct layout: [0xE2202, msgPtr]
			const msgPtr = writeString(e.message);
			const errPtr = state.heap.ptr;
			state.memory[errPtr] = 0xE2202; // MAGIC TAG
			state.memory[errPtr + 1] = msgPtr;
			state.heap.ptr += 2;
			return errPtr + 1; // pointer to the msgPtr field, offset by 1
		}
	});

	defineNative(state, "__readLine", (...args: Value[]) => {
		try {
			// Read a single line from stdin.
			// Since Node doesn't have a simple synchronous prompt built-in without blocking weirdly, 
			// we can use a small buffer read.
			const buffer = Buffer.alloc(1024);
			const bytesRead = fs.readSync(0, buffer, 0, 1024, null);
			let str = buffer.toString("utf8", 0, bytesRead);
			if (str.endsWith("\n")) str = str.slice(0, -1);
			if (str.endsWith("\r")) str = str.slice(0, -1);
			return writeString(str);
		} catch (e: any) {
			const msgPtr = writeString(e.message);
			const errPtr = state.heap.ptr;
			state.memory[errPtr] = 0xE2202;
			state.memory[errPtr + 1] = msgPtr;
			state.heap.ptr += 2;
			return errPtr + 1;
		}
	});

	defineNative(state, "__floor", (...args: Value[]) => {
		return Math.floor(args[0] as number);
	});

	defineNative(state, "__ceil", (...args: Value[]) => {
		return Math.ceil(args[0] as number);
	});

	defineNative(state, "__round", (...args: Value[]) => {
		return Math.round(args[0] as number);
	});

	defineNative(state, "__sqrt", (...args: Value[]) => {
		const val = args[0] as number;
		if (val < 0) {
			const errPtr = state.heap.ptr;
			const msgPtr = writeString("Cannot take square root of negative number");
			state.memory[errPtr] = 0xE2202;
			state.memory[errPtr + 1] = msgPtr;
			state.heap.ptr += 2;
			return errPtr + 1;
		}
		return Math.sqrt(val);
	});

	defineNative(state, "__toUpper", (...args: Value[]) => {
		return writeString(readString(args[0] as number).toUpperCase());
	});

	defineNative(state, "__toLower", (...args: Value[]) => {
		return writeString(readString(args[0] as number).toLowerCase());
	});

	defineNative(state, "__trim", (...args: Value[]) => {
		return writeString(readString(args[0] as number).trim());
	});

	defineNative(state, "__replace", (...args: Value[]) => {
		return writeString(readString(args[0] as number).replaceAll(readString(args[1] as number), readString(args[2] as number)));
	});

	defineNative(state, "__concat", (...args: Value[]) => {
		const a = readString(args[0] as number);
		const b = readString(args[1] as number);
		return writeString(a + b);
	});

	defineNative(state, "__min", (...args: Value[]) => {
		const ptr = args[0] as number;
		const len = state.memory[ptr - 1] as number;
		const nums: number[] = [];
		for (let i = 0; i < len; i++) {
			nums.push(state.memory[ptr + i] as number);
		}
		return Math.min(...nums);
	});

	defineNative(state, "__max", (...args: Value[]) => {
		const ptr = args[0] as number;
		const len = state.memory[ptr - 1] as number;
		const nums: number[] = [];
		for (let i = 0; i < len; i++) {
			nums.push(state.memory[ptr + i] as number);
		}
		return Math.max(...nums);
	});

	defineNative(state, "__pow", (...args: Value[]) => {
		return Math.pow(args[0] as number, args[1] as number);
	});

	defineNative(state, "__repeat", (...args: Value[]) => {
		return writeString(readString(args[0] as number).repeat(args[1] as number));
	});

	defineNative(state, "__startsWith", (...args: Value[]) => {
		return readString(args[0] as number).startsWith(readString(args[1] as number));
	});

	defineNative(state, "__endsWith", (...args: Value[]) => {
		return readString(args[0] as number).endsWith(readString(args[1] as number));
	});

	defineNative(state, "__writeFile", (...args: Value[]) => {
		fs.writeFileSync(readString(args[0] as number), readString(args[1] as number));
		return null;
	});

	defineNative(state, "__appendFile", (...args: Value[]) => {
		fs.appendFileSync(readString(args[0] as number), readString(args[1] as number));
		return null;
	});

	defineNative(state, "__deleteFile", (...args: Value[]) => {
		fs.unlinkSync(readString(args[0] as number));
		return null;
	});

	defineNative(state, "__exists", (...args: Value[]) => {
		return fs.existsSync(readString(args[0] as number));
	});
}
