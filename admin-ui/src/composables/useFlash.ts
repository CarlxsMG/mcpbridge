import type { Ref } from "vue";

/**
 * Extracted from the `flashSaved()` free function hand-rolled in
 * GuardEditor.vue (11 call sites, one per form section). No cleanup on
 * unmount: every caller flashes a per-section `saved*` ref straight after
 * a successful save, so the component is guaranteed to still be around
 * when the timeout fires.
 */
export function useFlash(durationMs = 2000) {
  function flash(flag: Ref<boolean>) {
    flag.value = true;
    setTimeout(() => {
      flag.value = false;
    }, durationMs);
  }

  return { flash };
}
