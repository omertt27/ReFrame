# ReFrame brand assets (v1)

Direction: **Option B — Diagonal Frame** (two opposing corner brackets), chosen from the concept
canvas at https://claude.ai/code/artifact/88f00a66-ec05-489c-89a3-e7bfe9da7b98.

- `logo-mark.svg` — the mark alone, transparent background, 100×100 viewBox
- `logo-lockup-dark.svg` / `logo-lockup-light.svg` — mark + wordmark, for dark/light backgrounds respectively
- `favicon.svg` — mark on a fixed dark rounded-square chip, for browser tabs / GitHub org avatar

**Colors:** accent `#f4a340` (warm amber, evokes crop/selection marks — used identically on both
themes). Dark-theme text `#f5f5f5`, light-theme text `#111113`.

**Known limitation:** the wordmark in the lockup SVGs is a live `<text>` element referencing
"Space Grotesk" with a system-sans fallback, not outlined paths — it will render correctly
wherever that font is installed or loaded (works as-is in this repo's own docs/site if Space
Grotesk is linked via Google Fonts, same as the concept canvas), but falls back to the system
sans elsewhere. Convert to outlines in a design tool before using these as final print-ready or
strictly-portable assets.
