import module from '../../generated/decision_core.wasm';
import { HttpError } from './types.js';
interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  allocate(length: number): number;
  evaluate(pointer: number, length: number): bigint;
  release(pointer: number, length: number): void;
}
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
let instance: Exports | undefined;
/** Calls are synchronous: no await may occur between allocating and releasing. */
export function decision<T>(input: unknown): T {
  const bytes = encoder.encode(JSON.stringify(input));
  if (bytes.length > 16 * 1024 * 1024) throw new HttpError(422, 'decision_input_too_large');
  const core = instance ??= new WebAssembly.Instance(module, {}).exports as Exports;
  let outputPointer = 0, outputLength = 0;
  try {
    const pointer = core.allocate(bytes.length);
    if (!pointer) throw new Error('Allocation failed');
    new Uint8Array(core.memory.buffer, pointer, bytes.length).set(bytes);
    const result = core.evaluate(pointer, bytes.length); // Rust consumes the input.
    outputPointer = Number(result & 0xffffffffn); outputLength = Number(result >> 32n);
    const output = JSON.parse(decoder.decode(new Uint8Array(core.memory.buffer, outputPointer, outputLength)));
    if (output.error) throw new HttpError(422, output.error);
    return output as T;
  } catch (error) {
    // Discard a trapped instance, including allocations whose ownership is unknown.
    instance = undefined;
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'local_decision_failed');
  } finally {
    if (outputPointer) core.release(outputPointer, outputLength);
  }
}
