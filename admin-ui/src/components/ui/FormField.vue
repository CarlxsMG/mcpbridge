<script setup lang="ts">
/**
 * Label + control + (optionally) that control's validation message.
 *
 * Passing `error` here rather than rendering a bare `<FieldError>` sibling is what
 * ties the message to the field. `FieldError` already carries `role="alert"`, so a
 * validation failure was announced — but the input itself said nothing: no
 * `aria-invalid`, and no `aria-describedby` pointing at the message. Submitting
 * /consumers/new with two bad fields fired two alerts in a burst, neither attached
 * to a control, and a screen-reader user tabbing back through the form had no way to
 * tell which fields were the broken ones (WCAG 3.3.1).
 *
 * The wiring is handed to the slot rather than applied here, because the control is
 * the caller's markup — spread it onto the input:
 *
 *   <FormField :label="…" for="c-name" :error="nameError" v-slot="field">
 *     <input id="c-name" v-model="name" v-bind="field" />
 *   </FormField>
 *
 * The wiring is handed over as ONE object bound with `v-bind`, not as individual
 * `:aria-describedby` / `:aria-invalid` attributes on `<slot>`. The template compiler
 * camelizes slot-prop names, so those would arrive as `ariaDescribedby` and spread
 * onto the input as the invalid attribute `ariadescribedby` — measured. (Confusingly
 * `ariaInvalid` DOES survive, because it is a reflected DOM property and
 * `aria-describedby` is not, so the bug looks half-working.) Keys in a v-bind object
 * are passed through verbatim.
 *
 * Form-level errors (a failed POST, with no single control to point at) stay as a
 * standalone `<FieldError>` — there `role="alert"` alone is the right treatment.
 */
import { computed } from "vue";
import FieldError from "./FieldError.vue";

const props = defineProps<{
  label: string;
  for: string;
  /** Validation message for THIS control. Omit for fields that cannot fail on their own. */
  error?: string;
}>();

// Derived from the control's own id, so it is stable across re-renders and needs no
// injection: the caller already guarantees `for` is unique on the page.
const errorId = computed(() => `${props.for}-error`);
const invalid = computed(() => Boolean(props.error));

// `"true" as const` matters: widened to `string` it no longer satisfies Vue's
// `aria-invalid` type (Booleanish | "grammar" | "spelling"), and every call site
// spreading this onto an <input> fails to compile.
const fieldAttrs = computed(() =>
  invalid.value ? ({ "aria-invalid": "true", "aria-describedby": errorId.value } as const) : {},
);
</script>

<template>
  <div class="field">
    <label :for="props.for">{{ label }}</label>
    <slot v-bind="fieldAttrs" />
    <FieldError v-if="error" :id="errorId" :message="error" />
  </div>
</template>

<style scoped>
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
</style>
