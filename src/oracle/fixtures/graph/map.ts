/**
 * A factory whose name is also a method on every array in the language.
 *
 * It exists to be exported through the barrel next door. While the store read
 * every imported file's whole export table, `rows.map(...)` in any file that
 * imported the barrel was drawn as a call into this — eight times in zod
 * alone. `typed.ts` writes that call.
 */
export function map(keys: readonly string[]): Map<string, number> {
  return new Map(keys.map((key, index) => [key, index]));
}
