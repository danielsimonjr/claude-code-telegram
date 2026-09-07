/**
 * Text handling for outbound Telegram messages.
 *
 * Pure functions, deliberately free of any Telegram or Claude dependency, so the
 * chunking edge cases can be tested without a bot token or a network.
 */

/** Telegram's per-message character limit, with a little headroom. */
export const MAX_MSG = 4000;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// CSI sequences (colour, cursor movement) and OSC sequences (window title).
const CSI = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g");
const OSC = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g");
// Control characters except tab (09), newline (0A) and carriage return (0D).
// Built from char codes, never written literally: literal control bytes make the
// file read as binary to git and grep, and are invisible in review.
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}`
    + `${String.fromCharCode(11)}${String.fromCharCode(12)}`
    + `${String.fromCharCode(14)}-${String.fromCharCode(31)}]`,
  "g",
);

/** Strip terminal escape sequences and stray control characters. */
export function cleanAnsi(text: string): string {
  return text.replace(CSI, "").replace(OSC, "").replace(CONTROL, "").trim();
}

/**
 * Split text into chunks that fit one Telegram message each.
 *
 * Breaks on a newline when one falls in the later half of the chunk, so paragraphs
 * survive; otherwise breaks at the hard limit. Every iteration consumes at least one
 * character, which is what stops pathological input (a string of newlines) from
 * looping forever.
 *
 * Returns an empty array for empty input: Telegram rejects an empty message, so
 * "nothing to say" must produce nothing to send rather than one blank chunk.
 */
export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    if (rest.length <= MAX_MSG) {
      chunks.push(rest);
      break;
    }

    let splitAt = rest.lastIndexOf("\n", MAX_MSG);
    // A break point in the first half wastes most of the message, and a break at 0
    // would consume nothing at all -- an infinite loop.
    if (splitAt < MAX_MSG * 0.5) splitAt = MAX_MSG;

    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt);
  }

  return chunks;
}
