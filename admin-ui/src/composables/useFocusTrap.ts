import type { Ref } from "vue";

// Selector matches the broadest of the three hand-rolled trapFocus copies
// this composable replaces (ConnectClientDialog's) — includes select/textarea
// so it stays correct for dialogs that have them.
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// Cycles Tab/Shift+Tab within `container.value` only — never the whole
// document — so multiple traps can be nested (e.g. ShareInstallLinkDialog
// renders a ConfirmDialog for its "revoke" confirmation inside the same
// outer overlay) without interfering with each other.
export function useFocusTrap(container: Ref<HTMLElement | null>) {
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "Tab" || !container.value) return;
    const focusable = container.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return { onKeydown };
}
