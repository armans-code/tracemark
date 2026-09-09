/**
 * Normalizes a caught value into a printable message.
 *
 * @remarks
 * Anything can be thrown in JavaScript, not just `Error`, so `catch` bindings
 * arrive as `unknown` and can't be read directly.
 *
 * @param error - The caught value.
 * @returns `error.message` for `Error`s, otherwise the value stringified.
 */
export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
