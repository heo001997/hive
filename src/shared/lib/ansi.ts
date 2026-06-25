/**
 * Main/server-safe ANSI helpers. A renderer-layer copy lives at
 * `src/renderer/src/lib/ansi-utils.ts`; this module exists so the server can
 * strip terminal escapes (e.g. when fingerprinting PTY output) WITHOUT importing
 * renderer code into the main/server process.
 */

/** Regex matching SGR, OSC, and CSI ANSI escape sequences. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)/g

/** Remove all ANSI escape sequences from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}
