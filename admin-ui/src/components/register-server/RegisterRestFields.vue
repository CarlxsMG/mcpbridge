<script setup lang="ts">
import { useI18n } from "vue-i18n";
import FormField from "@/components/ui/FormField.vue";

const { t } = useI18n({ useScope: "global" });

// The parent (RegisterServerPage) owns these refs — it reads them in
// buildRestDiscoveryPayload / register / the stale-preview watcher — so they are
// exposed as models rather than local state; this component only renders the
// REST discovery inputs.
const healthUrl = defineModel<string>("healthUrl", { required: true });
const baseUrl = defineModel<string>("baseUrl", { required: true });
const mode = defineModel<"openapi" | "manual" | "curl" | "postman">("mode", { required: true });
const openapiUrl = defineModel<string>("openapiUrl", { required: true });
const includeTags = defineModel<string>("includeTags", { required: true });
const excludeOps = defineModel<string>("excludeOps", { required: true });
const manualTools = defineModel<string>("manualTools", { required: true });
const curlInput = defineModel<string>("curlInput", { required: true });
const postmanText = defineModel<string>("postmanText", { required: true });
const postmanFileName = defineModel<string>("postmanFileName", { required: true });

const curlPlaceholder =
  "curl -X POST https://api.example.com/users \\\n" +
  '  -H "Content-Type: application/json" \\\n' +
  '  -d \'{"name":"Jane"}\'\n\n' +
  "# a second command works too — separate with a blank line\n" +
  "curl https://api.example.com/users";

function onPostmanFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  postmanFileName.value = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    postmanText.value = typeof reader.result === "string" ? reader.result : "";
  };
  reader.readAsText(file);
}
</script>

<template>
  <FormField :label="t('pages.register_server.health_url_label')" for="r-health">
    <input
      id="r-health"
      v-model="healthUrl"
      type="url"
      :placeholder="t('pages.register_server.health_url_placeholder')"
    />
  </FormField>
  <FormField :label="t('pages.register_server.base_url_label')" for="r-base">
    <input id="r-base" v-model="baseUrl" type="url" :placeholder="t('pages.register_server.base_url_placeholder')" />
  </FormField>

  <div class="segmented" role="radiogroup" :aria-label="t('pages.register_server.mode_aria')">
    <label
      ><input v-model="mode" type="radio" name="mode" value="openapi" />
      {{ t("pages.register_server.mode_openapi") }}</label
    >
    <label
      ><input v-model="mode" type="radio" name="mode" value="manual" />
      {{ t("pages.register_server.mode_manual") }}</label
    >
    <label
      ><input v-model="mode" type="radio" name="mode" value="curl" /> {{ t("pages.register_server.mode_curl") }}</label
    >
    <label
      ><input v-model="mode" type="radio" name="mode" value="postman" />
      {{ t("pages.register_server.mode_postman") }}</label
    >
  </div>

  <template v-if="mode === 'openapi'">
    <FormField :label="t('pages.register_server.openapi_url_label')" for="r-openapi">
      <input
        id="r-openapi"
        v-model="openapiUrl"
        type="url"
        :placeholder="t('pages.register_server.openapi_url_placeholder')"
      />
    </FormField>
    <FormField :label="t('pages.register_server.include_tags_label')" for="r-tags">
      <input
        id="r-tags"
        v-model="includeTags"
        type="text"
        :placeholder="t('pages.register_server.include_tags_placeholder')"
      />
    </FormField>
    <FormField :label="t('pages.register_server.exclude_ops_label')" for="r-exclude">
      <input
        id="r-exclude"
        v-model="excludeOps"
        type="text"
        :placeholder="t('pages.register_server.exclude_ops_placeholder')"
      />
    </FormField>
  </template>

  <FormField v-else-if="mode === 'manual'" :label="t('pages.register_server.manual_tools_label')" for="r-manual">
    <textarea
      id="r-manual"
      v-model="manualTools"
      rows="10"
      spellcheck="false"
      placeholder='[{"name":"get_user","method":"GET","endpoint":"/users/:id","description":"Fetch a user by id","inputSchema":{"type":"object","properties":{"id":{"type":"string"}}}}]'
    ></textarea>
  </FormField>

  <FormField v-else-if="mode === 'curl'" :label="t('pages.register_server.curl_label')" for="r-curl">
    <textarea id="r-curl" v-model="curlInput" rows="10" spellcheck="false" :placeholder="curlPlaceholder"></textarea>
    <p class="hint">
      {{ t("pages.register_server.curl_hint") }}
    </p>
  </FormField>

  <FormField v-else :label="t('pages.register_server.postman_label')" for="r-postman-file">
    <input id="r-postman-file" type="file" accept="application/json,.json" @change="onPostmanFileChange" />
    <p v-if="postmanFileName" class="hint">
      {{ t("pages.register_server.postman_loaded", { name: postmanFileName }) }}
    </p>
    <label for="r-postman-text" class="postman-paste-label">{{ t("pages.register_server.postman_paste_label") }}</label>
    <textarea id="r-postman-text" v-model="postmanText" rows="8" spellcheck="false"></textarea>
  </FormField>
</template>

<style scoped>
:deep(.field textarea) {
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
:deep(.field input[type="file"]) {
  padding: 0.4rem 0;
  border: none;
}
.hint {
  font-size: 0.82rem;
  color: var(--text-secondary);
  margin: 0;
}
.postman-paste-label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0.6rem 0 0.3rem;
}
</style>
