/**
 * Replaces one exact utility-class token within a space-separated class
 * list, leaving every other token untouched — including ones that contain
 * `find` as a substring (e.g. replacing "p-4" must never touch "sm:p-4").
 * Tailwind's responsive/state prefixes (`md:`, `hover:`, ...) are just part
 * of the token, so exact matching handles them correctly with no special
 * casing: replacing "lg:p-8" only ever matches the literal token "lg:p-8".
 */
export function replaceUtilityClass(classList: string, find: string, replace: string): string {
  return classList
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => (token === find ? replace : token))
    .join(" ");
}
