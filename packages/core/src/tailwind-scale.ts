/** Tailwind's default spacing scale (token -> px), used for both directions
 * of height/padding/margin editing. rem values assume the framework default
 * of 16px root font size, same as Tailwind itself. */
export const TAILWIND_SPACING_SCALE: Record<string, number> = {
  "0": 0,
  px: 1,
  "0.5": 2,
  "1": 4,
  "1.5": 6,
  "2": 8,
  "2.5": 10,
  "3": 12,
  "3.5": 14,
  "4": 16,
  "5": 20,
  "6": 24,
  "7": 28,
  "8": 32,
  "9": 36,
  "10": 40,
  "11": 44,
  "12": 48,
  "14": 56,
  "16": 64,
  "20": 80,
  "24": 96,
  "28": 112,
  "32": 128,
  "36": 144,
  "40": 160,
  "44": 176,
  "48": 192,
  "52": 208,
  "56": 224,
  "60": 240,
  "64": 256,
  "72": 288,
  "80": 320,
  "96": 384,
};

const PX_TO_TOKEN = new Map(Object.entries(TAILWIND_SPACING_SCALE).map(([token, px]) => [px, token]));

/** e.g. 80 -> "20" (exact scale match) or 83 -> "[83px]" (arbitrary value,
 * never silently rounds to the nearest scale step). */
export function pxToSpacingToken(px: number): string {
  const exact = PX_TO_TOKEN.get(px);
  return exact ?? `[${px}px]`;
}

/** e.g. "20" -> 80, "[83px]" -> 83, or null if it's not a spacing token at all. */
export function spacingTokenToPx(token: string): number | null {
  if (token in TAILWIND_SPACING_SCALE) return TAILWIND_SPACING_SCALE[token]!;
  const arbitrary = /^\[(\d+(?:\.\d+)?)px\]$/.exec(token);
  return arbitrary ? Number(arbitrary[1]) : null;
}
