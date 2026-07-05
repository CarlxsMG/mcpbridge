import { readonly, ref } from "vue";

/**
 * Shared skeleton behind useTheme/useDensity: read a persisted value from
 * localStorage (falling back when absent/invalid), apply it once eagerly,
 * and expose a readonly ref plus a setter that persists + re-applies.
 */
export function useStoredToggle<T extends string>(
  key: string,
  isValid: (value: string | null) => value is T,
  fallback: T,
  apply: (value: T) => void,
) {
  function readStored(): T {
    const stored = localStorage.getItem(key);
    return isValid(stored) ? stored : fallback;
  }

  const value = ref<T>(readStored());

  apply(value.value);

  function setValue(v: T): void {
    value.value = v;
    localStorage.setItem(key, v);
    apply(v);
  }

  return { value: readonly(value), setValue };
}
