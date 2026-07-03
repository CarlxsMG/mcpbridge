import { ref, toValue, type MaybeRefOrGetter } from "vue";
import { onBeforeRouteLeave } from "vue-router";

// bypass exists because "deleted" records are intentionally dirty (form no longer matches server) but must leave without a prompt.
export function useUnsavedChangesGuard(isDirty: MaybeRefOrGetter<boolean>, bypass: MaybeRefOrGetter<boolean> = false) {
  const pendingLeave = ref(false);
  let leaveNext: ((valid?: boolean) => void) | null = null;

  onBeforeRouteLeave((_to, _from, next) => {
    if (!toValue(bypass) && toValue(isDirty)) {
      leaveNext = next;
      pendingLeave.value = true;
    } else {
      next();
    }
  });

  function confirmLeave() {
    pendingLeave.value = false;
    leaveNext?.(true);
    leaveNext = null;
  }

  function cancelLeave() {
    pendingLeave.value = false;
    leaveNext?.(false);
    leaveNext = null;
  }

  return { pendingLeave, confirmLeave, cancelLeave };
}
