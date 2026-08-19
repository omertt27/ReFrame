import type { TextIR } from "../text-ir.js";

export type TextWriteResult = { ok: true } | { ok: false; reason: string };

/**
 * Sets a text node's content to a new plain string. Refuses (never guesses)
 * any value containing "<" or "{" — both are reserved JSX syntax characters,
 * and correct escaping of them through recast's JSXText printer is
 * unverified; a plain, unambiguous string is all this writes.
 *
 * Deliberately writes the TRIMMED value only, with no attempt to preserve
 * the original leading/trailing whitespace/indentation — verified via a
 * throwaway recast spike that trying to preserve it produces a worse-looking
 * diff (stray trailing whitespace before the closing tag) than just letting
 * recast's own default single-line reprint happen. `extra` (recast/babel's
 * cached raw-source hint) is cleared so the stale original text can't leak
 * back into the reprint. See mutate/style.ts's own reformatting caveat for a
 * similar recast limitation on the styles side.
 */
export function writeTextContent(ir: TextIR, value: string): TextWriteResult {
  if (ir.kind === "unsupported") {
    return { ok: false, reason: `text is unsupported, refusing to guess: ${ir.reason}` };
  }
  if (/[<{]/.test(value)) {
    return { ok: false, reason: 'text containing "<" or "{" isn\'t supported yet' };
  }
  ir.node.value = value;
  delete ir.node.extra;
  return { ok: true };
}
