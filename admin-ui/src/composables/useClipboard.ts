import { ref } from "vue";

/*
 * copied stays true until reset() is called explicitly (e.g. on dialog
 * close or re-mint) — no auto-reset timer, matching the 3 call sites this
 * replaces.
 */
export function useClipboard() {
  const copied = ref(false);

  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      copied.value = true;
      return true;
    } catch {
      copied.value = false;
      return false;
    }
  }

  function reset() {
    copied.value = false;
  }

  return { copied, copy, reset };
}
