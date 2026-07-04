<script setup lang="ts">
import { ref, computed, watch } from "vue";

/**
 * Renders a lightweight form from a JSON Schema's top-level properties so an
 * admin can fill tool arguments without hand-writing JSON. Supported field
 * kinds: boolean (checkbox), enum (select), number/integer (number input),
 * string (text). Anything else falls back to a JSON textarea. Emits the
 * assembled args object; empty string/number fields are omitted.
 */
const props = defineProps<{
  schema: Record<string, unknown>;
}>();
const model = defineModel<Record<string, unknown>>({ required: true });

interface Field {
  name: string;
  kind: "boolean" | "enum" | "number" | "string" | "json";
  enum?: string[];
  required: boolean;
  description?: string;
}

const fields = computed<Field[]>(() => {
  const schema = props.schema ?? {};
  const props_ = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
  const required = new Set((schema.required as string[]) ?? []);
  return Object.entries(props_).map(([name, def]) => {
    let kind: Field["kind"] = "string";
    if (Array.isArray(def.enum)) kind = "enum";
    else if (def.type === "boolean") kind = "boolean";
    else if (def.type === "number" || def.type === "integer") kind = "number";
    else if (def.type === "object" || def.type === "array") kind = "json";
    return {
      name,
      kind,
      enum: Array.isArray(def.enum) ? (def.enum as unknown[]).map(String) : undefined,
      required: required.has(name),
      description: typeof def.description === "string" ? def.description : undefined,
    };
  });
});

// Per-field string/boolean values; coerced to the schema type on emit.
const values = ref<Record<string, string | boolean>>({});
const jsonInvalid = ref<Record<string, boolean>>({});
let suppress = false;

function hydrate(source: Record<string, unknown>) {
  const next: Record<string, string | boolean> = {};
  for (const f of fields.value) {
    const v = source?.[f.name];
    if (v === undefined) {
      next[f.name] = f.kind === "boolean" ? false : "";
      continue;
    }
    next[f.name] = f.kind === "boolean" ? Boolean(v) : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  values.value = next;
  jsonInvalid.value = {};
}
hydrate(model.value ?? {});

watch(
  () => model.value,
  (mv) => {
    if (!suppress) hydrate(mv ?? {});
  },
  { deep: true },
);

function emitArgs() {
  const out: Record<string, unknown> = {};
  for (const f of fields.value) {
    const raw = values.value[f.name];
    if (f.kind === "boolean") {
      out[f.name] = Boolean(raw);
      continue;
    }
    const str = String(raw ?? "");
    if (str === "") {
      if (f.kind === "json") jsonInvalid.value[f.name] = false;
      continue;
    }
    if (f.kind === "number") {
      const n = Number(str);
      if (Number.isFinite(n)) out[f.name] = n;
    } else if (f.kind === "json") {
      try {
        out[f.name] = JSON.parse(str);
        jsonInvalid.value[f.name] = false;
      } catch {
        out[f.name] = str;
        jsonInvalid.value[f.name] = true;
      }
    } else out[f.name] = str;
  }
  suppress = true;
  model.value = out;
  // release the suppression on the next microtask so external loads still sync
  Promise.resolve().then(() => {
    suppress = false;
  });
}
</script>

<template>
  <div class="schema-form">
    <p v-if="fields.length === 0" class="hint">This tool takes no arguments.</p>
    <div v-for="f in fields" :key="f.name" class="sf-field">
      <label :for="`sf-${f.name}`"> {{ f.name }}<span v-if="f.required" class="req">*</span> </label>
      <p v-if="f.description" class="hint">{{ f.description }}</p>
      <input
        v-if="f.kind === 'boolean'"
        :id="`sf-${f.name}`"
        v-model="values[f.name]"
        type="checkbox"
        @change="emitArgs"
      />
      <select v-else-if="f.kind === 'enum'" :id="`sf-${f.name}`" v-model="values[f.name]" @change="emitArgs">
        <option value="">—</option>
        <option v-for="opt in f.enum" :key="opt" :value="opt">{{ opt }}</option>
      </select>
      <textarea
        v-else-if="f.kind === 'json'"
        :id="`sf-${f.name}`"
        v-model="values[f.name] as string"
        rows="2"
        spellcheck="false"
        placeholder='{"key": "value"}'
        @input="emitArgs"
      ></textarea>
      <input
        v-else-if="f.kind === 'number'"
        :id="`sf-${f.name}`"
        v-model="values[f.name] as string"
        type="number"
        @input="emitArgs"
      />
      <input v-else :id="`sf-${f.name}`" v-model="values[f.name] as string" type="text" @input="emitArgs" />
      <p v-if="f.kind === 'json' && jsonInvalid[f.name]" class="field-error">
        Invalid JSON — sent as a raw string instead.
      </p>
    </div>
  </div>
</template>

<style scoped>
.schema-form {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.sf-field label {
  display: block;
  font-weight: 600;
  font-size: 0.85rem;
  margin-bottom: 0.2rem;
}
.req {
  color: var(--breach);
  margin-left: 0.15rem;
}
.sf-field input[type="text"],
.sf-field input[type="number"],
.sf-field select,
.sf-field textarea {
  width: 100%;
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-sizing: border-box;
  font-size: 0.9rem;
  font-family: var(--font-body);
}
.sf-field textarea {
  font-family: var(--font-mono);
}
.hint {
  font-size: 0.78rem;
  color: var(--text-secondary);
  margin: 0 0 0.3rem;
}
.field-error {
  color: var(--breach);
  font-size: 0.8rem;
  margin: 0.25rem 0 0;
}
</style>
