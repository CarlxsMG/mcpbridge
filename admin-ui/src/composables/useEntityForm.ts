import { ref, type Ref } from "vue";
import { useErrorState } from "./useErrorState";

/**
 * Generalizes the "create/edit inline form" quartet (open/editing/busy/error
 * refs + openCreate/openEdit/close functions + a submit try-catch-close
 * block) hand-rolled across ~13 pages — see ConsumersPage for the canonical
 * worked example (`showCreate`/`editingConsumer`/`creating`/`createError` +
 * `openCreate`/`openEdit`/`closeForm`/`submitConsumer`).
 *
 * Deliberately does NOT own per-field validation (ConsumersPage's
 * `nameError`/`quotaError`/`endUserLimitError`) — that varies too much per
 * page to abstract cleanly. Callers validate their own fields before calling
 * `submit`, and return early (without calling `submit`) if validation fails.
 */
export function useEntityForm<E>(options: { reset: () => void; fill?: (entity: E) => void }) {
  const open = ref(false);
  const editing = ref<E | null>(null) as Ref<E | null>;
  const busy = ref(false);
  const { message: error, requestId: errorRequestId, capture, clear } = useErrorState();

  function openCreate(): void {
    editing.value = null;
    options.reset();
    clear();
    open.value = true;
  }

  function openEdit(entity: E): void {
    editing.value = entity;
    options.reset();
    options.fill?.(entity);
    clear();
    open.value = true;
  }

  function close(): void {
    open.value = false;
    editing.value = null;
    options.reset();
    clear();
  }

  async function submit(action: (editing: E | null) => Promise<void>, fallbackMessage: string): Promise<boolean> {
    busy.value = true;
    clear();
    try {
      await action(editing.value);
      close();
      return true;
    } catch (err) {
      capture(err, fallbackMessage);
      return false;
    } finally {
      busy.value = false;
    }
  }

  return { open, editing, busy, error, errorRequestId, openCreate, openEdit, close, submit };
}
