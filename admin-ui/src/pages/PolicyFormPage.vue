<script setup lang="ts">
// Dual-mode form: renders the create page at /policies/new and the edit page
// at /policies/:id/edit. One component rather than two because the fields and
// their validation are identical — a second file is how the consumers create
// page and the consumers inline edit form ended up as two implementations of
// the same three fields, with two parallel sets of i18n error keys that have
// to be kept in sync by hand.
//
// The backend has no GET /admin-api/policies/:id, so edit mode prefills from
// the collection endpoint and finds its row there. That's deliberate: the list
// is small, and inventing a backend route just to back this page would be a
// bigger change than the feature warrants.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCreateForm } from "@/composables/useCreateForm";
import { numberRangeValidator, parseOptionalNumber } from "@/utils/fieldParsing";
import { POLICY_RATE_LIMIT, POLICY_TIMEOUT_MS } from "@/utils/fieldConstraints";
import { focusFirstInvalid } from "@/utils/focusFirstInvalid";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { GuardPolicy } from "@/types/api";
import PageHeader from "@/components/ui/PageHeader.vue";
import FormField from "@/components/ui/FormField.vue";
import FormPage from "@/components/ui/FormPage.vue";
import FieldError from "@/components/ui/FieldError.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import UnsavedChangesDialog from "@/components/ui/UnsavedChangesDialog.vue";

const props = defineProps<{ id?: string }>();

const { t } = useI18n({ useScope: "global" });

const isEdit = computed(() => props.id !== undefined);

const name = ref("");
const rate = ref("");
const timeout = ref("");
const nameError = ref("");
const rateError = ref("");
const timeoutError = ref("");

// Edit mode only: the prefill round-trip. `loading` gates the form so the user
// never types into fields that are about to be overwritten by the response.
const loading = ref(false);
const loadError = ref("");
// Snapshot of the loaded values, so `isDirty` means "changed from what was
// loaded" in edit mode instead of "non-empty" — otherwise the unsaved-changes
// dialog would fire on leaving an edit page where nothing was touched.
const loaded = ref({ name: "", rate: "", timeout: "" });

// Range-checked to the API's own limits. A bare finite-number check let a negative
// rate and a timeout above the 600000 ms ceiling reach the server, which answers 400.
const validateRate = numberRangeValidator({
  ...POLICY_RATE_LIMIT,
  message: t("pages.policies.new.errors.rate_invalid"),
});
const validateTimeout = numberRangeValidator({
  ...POLICY_TIMEOUT_MS,
  message: t("pages.policies.new.errors.timeout_invalid"),
});

const { creating, error, errorRequestId, run } = useCreateForm({
  submit: () => {
    const payload = {
      name: name.value.trim(),
      rateLimitPerMin: parseOptionalNumber(rate.value).value,
      timeoutMs: parseOptionalNumber(timeout.value).value,
    };
    return isEdit.value
      ? api.patch(`/admin-api/policies/${encodeURIComponent(props.id ?? "")}`, payload)
      : api.post("/admin-api/policies", payload);
  },
  redirectTo: "/policies",
  // Mode-specific: a failed PATCH saying "could not create" is a wrong answer.
  // Safe to read `isEdit` once here — the route param can't change without
  // remounting the component.
  fallbackKey: isEdit.value ? "pages.policies.edit.save_failed" : "pages.policies.new.errors.create_failed",
});

onMounted(async () => {
  if (!isEdit.value) return;
  loading.value = true;
  try {
    const res = await api.get<{ items: GuardPolicy[] }>("/admin-api/policies");
    const policy = res.items.find((x) => String(x.id) === props.id);
    if (!policy) {
      loadError.value = t("pages.policies.edit.not_found");
      return;
    }
    name.value = policy.name;
    rate.value = policy.rateLimitPerMin !== null ? String(policy.rateLimitPerMin) : "";
    timeout.value = policy.timeoutMs !== null ? String(policy.timeoutMs) : "";
    loaded.value = { name: name.value, rate: rate.value, timeout: timeout.value };
  } catch (err) {
    loadError.value = toErrorMessage(err, tk("pages.policies.edit.load_failed"));
  } finally {
    loading.value = false;
  }
});

function submitPolicy() {
  // Per-field rather than one message at the bottom: each of these names the field it
  // is about, so it belongs next to that field and can be linked to it.
  nameError.value = name.value.trim() ? "" : t("pages.policies.new.errors.name_required");
  rateError.value = validateRate(rate.value) ?? "";
  timeoutError.value = validateTimeout(timeout.value) ?? "";
  if (nameError.value || rateError.value || timeoutError.value) {
    void focusFirstInvalid();
    return;
  }
  return run();
}

const isDirty = computed(() => {
  if (isEdit.value) {
    return (
      name.value !== loaded.value.name || rate.value !== loaded.value.rate || timeout.value !== loaded.value.timeout
    );
  }
  return Boolean(name.value.trim()) || Boolean(rate.value.trim()) || Boolean(timeout.value.trim());
});
</script>

<template>
  <section>
    <FormPage max-width="26.25rem">
      <PageHeader
        :title="isEdit ? t('pages.policies.edit.title') : t('pages.policies.new.title')"
        :back-link="{ to: '/policies', label: t('nav.policies.label') }"
      />

      <SignalLoader v-if="loading" />
      <FieldError v-else-if="loadError" :message="loadError" />

      <form v-else novalidate class="form-card" @submit.prevent="submitPolicy">
        <FormField v-slot="field" :label="t('pages.policies.new.fields.name')" for="p-name" :error="nameError">
          <input
            id="p-name"
            v-model="name"
            type="text"
            required
            :placeholder="t('pages.policies.new.placeholders.name')"
            v-bind="field"
          />
        </FormField>
        <FormField v-slot="field" :label="t('pages.policies.new.fields.rate')" for="p-rate" :error="rateError">
          <input id="p-rate" v-model="rate" type="text" inputmode="numeric" v-bind="field" />
        </FormField>
        <FormField v-slot="field" :label="t('pages.policies.new.fields.timeout')" for="p-timeout" :error="timeoutError">
          <input id="p-timeout" v-model="timeout" type="text" inputmode="numeric" v-bind="field" />
        </FormField>
        <FieldError :message="error" :request-id="errorRequestId" />
        <button type="submit" class="btn-primary" :disabled="creating">
          {{
            creating
              ? isEdit
                ? t("common.saving")
                : t("common.creating")
              : isEdit
                ? t("common.save_changes")
                : t("pages.policies.new.create")
          }}
        </button>
      </form>
    </FormPage>

    <UnsavedChangesDialog :dirty="isDirty" :bypass="creating" />
  </section>
</template>
