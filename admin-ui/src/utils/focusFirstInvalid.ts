import { nextTick } from "vue";

/**
 * Moves keyboard focus to the first control the form just marked invalid.
 *
 * Without this, failing validation left focus wherever it was — measured on
 * /consumers/new, still on `#main-content` — so after hearing two error alerts a
 * keyboard or screen-reader user had to tab the whole form to find which fields
 * were broken. WCAG 3.3.1 asks that the item in error be identifiable; landing on
 * it is the cheapest way to make that true in practice.
 *
 * Awaits `nextTick` first: the caller sets its error refs and calls straight
 * through, so `aria-invalid` is not in the DOM yet at call time.
 *
 * Scoped by `aria-invalid="true"`, which `FormField` sets whenever it renders an
 * error — so a field wired through FormField is found automatically, and one that
 * hand-rolls its error markup is deliberately not.
 */
export async function focusFirstInvalid(root?: ParentNode | null): Promise<boolean> {
  await nextTick();
  const scope = root ?? document;
  const target = scope.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!target) return false;
  target.focus();
  // Long forms can put the offending field off-screen; `focus()` alone scrolls it
  // into view in most browsers, but not when the page is mid-scroll-anchor.
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}
