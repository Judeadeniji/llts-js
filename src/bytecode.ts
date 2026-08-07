export enum OpCode {
    OP_CONSTANT,      // [OP, const_index]
    OP_NULL,
    OP_TRUE,
    OP_FALSE,
    
    // Arithmetic
    OP_ADD,
    OP_SUB,
    OP_MUL,
    OP_DIV,
    OP_MOD,
    OP_POW,
    
    // Comparison
    OP_EQUAL,
    OP_NOT_EQUAL,
    OP_STRING_EQUAL,
    OP_STRING_NOT_EQUAL,
    OP_LESS,
    OP_LESS_EQUAL,
    OP_GREATER,
    OP_GREATER_EQUAL,
    
    // Unary
    OP_NEGATE,
    OP_NOT,
    OP_DUP,
    
    // Strings
    OP_MAKE_STRING,
    
    // Variables
    OP_SET_GLOBAL,    // [OP, const_index_of_name]
    OP_GET_GLOBAL,    // [OP, const_index_of_name]
    OP_SET_LOCAL,     // [OP, stack_index]
    OP_GET_LOCAL,     // [OP, stack_index]
    
    // Arrays and Memory
    OP_GET_INDEX,
    OP_SET_INDEX,
    
    // Control Flow
    OP_JUMP,          // [OP, offset1, offset2]
    OP_JUMP_IF_FALSE, // [OP, offset1, offset2]
    OP_LOOP,          // [OP, offset1, offset2]
    
    // Functions & Calls
    OP_RETURN,
    
    // Objects/Modules
    OP_IMPORT,        // [OP, const_index_of_path]
    OP_GET_PROPERTY,  // [OP, const_index_of_name]
    OP_SET_PROPERTY,  // [OP, const_index_of_name]

    // Builtins
    OP_PRINT,         // [OP, arg_count] (for simplicity)
    
    OP_POP,           // Pops value off the stack
    OP_CALL,          // [OP, arg_count] (Calls a dynamic/native function off stack)
    OP_CALL_STATIC,   // [OP, address_high, address_low, arg_count]
}

export type Value = number | string | boolean | null | Record<string, any> | NativeFunction;

export class NativeFunction {
    constructor(
        public name: string,
        public func: (...args: Value[]) => Value,
        public arity: number
    ) {}
}

export class Chunk {
    code: number[] = [];
    constants: Value[] = [];
    
    write(byte: number) {
        this.code.push(byte);
    }
    
    addConstant(value: Value): number {
        this.constants.push(value);
        return this.constants.length - 1;
    }
}
