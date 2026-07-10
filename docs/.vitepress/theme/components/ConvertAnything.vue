<script setup lang="ts">
// "Convert anything to MCP" — a six-card grid that makes the core pitch legible
// at a glance: every kind of backend the bridge can turn into governed MCP tools,
// with the exact `POST /register` field that does it. Localised EN/ES from the
// active VitePress locale (the diagram components stay English-only, but this one
// carries prose, so it follows the page language). Theme-aware via VitePress CSS
// vars so it reads in both light and dark.
import { useData } from "vitepress";
import { computed } from "vue";

const { lang } = useData();
const isEs = computed(() => lang.value.toLowerCase().startsWith("es"));

interface Source {
  field: string;
  title: string;
  blurb: string;
}

const copy = computed(() => {
  if (isEs.value) {
    return {
      heading: "Convierte cualquier cosa a MCP",
      sub: "Seis formas de convertir un backend en tools MCP gobernadas — todas por la misma guard pipeline.",
      cta: "Ver todos los caminos de registro →",
      href: "/es/guide/registering-backends",
      sources: [
        {
          field: "openapi_url",
          title: "OpenAPI / Swagger",
          blurb: "Auto-descubre una tool MCP por operación desde el spec.",
        },
        { field: "graphql_url", title: "GraphQL", blurb: "Introspecciona el schema — una tool por query y mutation." },
        {
          field: "curl_input",
          title: "Comando cURL",
          blurb: "Pega una invocación curl que funcione y obtén una tool.",
        },
        { field: "postman_collection", title: "Postman", blurb: "Una tool por request en una colección v2.1." },
        { field: "tools[]", title: "Manual", blurb: "¿Sin spec? Escribe a mano exactamente las tools que necesitas." },
        {
          field: 'kind: "mcp"',
          title: "Servidor MCP",
          blurb: "Re-expón las tools de un servidor MCP existente, ya gobernadas.",
        },
      ] as Source[],
    };
  }
  return {
    heading: "Convert anything to MCP",
    sub: "Six ways to turn a backend into governed MCP tools — all through the same guard pipeline.",
    cta: "See every registration path →",
    href: "/guide/registering-backends",
    sources: [
      {
        field: "openapi_url",
        title: "OpenAPI / Swagger",
        blurb: "Auto-discover one MCP tool per operation from the spec.",
      },
      { field: "graphql_url", title: "GraphQL", blurb: "Introspect the schema — one tool per query & mutation." },
      { field: "curl_input", title: "cURL command", blurb: "Paste a working curl invocation and get one tool." },
      { field: "postman_collection", title: "Postman", blurb: "One tool per request in a v2.1 collection export." },
      { field: "tools[]", title: "Manual", blurb: "No spec? Hand-write exactly the tools you need." },
      { field: 'kind: "mcp"', title: "MCP server", blurb: "Re-expose an existing MCP server's tools, governed." },
    ] as Source[],
  };
});
</script>

<template>
  <section class="ca">
    <h2 class="ca-h">{{ copy.heading }}</h2>
    <p class="ca-sub">{{ copy.sub }}</p>

    <div class="ca-grid">
      <a v-for="s in copy.sources" :key="s.field" class="ca-card" :href="copy.href">
        <code class="ca-field">{{ s.field }}</code>
        <span class="ca-arrow" aria-hidden="true">→ MCP</span>
        <h3 class="ca-title">{{ s.title }}</h3>
        <p class="ca-blurb">{{ s.blurb }}</p>
      </a>
    </div>

    <p class="ca-foot">
      <a :href="copy.href">{{ copy.cta }}</a>
    </p>
  </section>
</template>

<style scoped>
.ca {
  margin: 2.5rem 0 1rem;
}
.ca-h {
  font-size: 1.6rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  border: 0;
  padding: 0;
}
.ca-sub {
  margin: 0.4rem 0 1.4rem;
  color: var(--vp-c-text-2);
  max-width: 44rem;
}

.ca-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(232px, 1fr));
  gap: 0.9rem;
}

.ca-card {
  display: block;
  padding: 1rem 1.1rem 1.05rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  text-decoration: none;
  transition:
    border-color 0.15s ease,
    transform 0.15s ease,
    box-shadow 0.15s ease;
}
.ca-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
  box-shadow: 0 8px 22px rgba(14, 17, 22, 0.1);
}

.ca-field {
  display: inline-block;
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  border-radius: 6px;
  padding: 0.12rem 0.42rem;
}
.ca-arrow {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
  margin-left: 0.45rem;
  letter-spacing: 0.04em;
}
.ca-title {
  font-size: 1.05rem;
  font-weight: 600;
  margin: 0.7rem 0 0.25rem;
  border: 0;
  padding: 0;
  color: var(--vp-c-text-1);
  letter-spacing: -0.01em;
}
.ca-blurb {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.ca-foot {
  margin: 1.3rem 0 0;
}
.ca-foot a {
  font-weight: 600;
}
</style>
