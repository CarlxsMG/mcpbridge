import { defineConfig } from "vitepress";

// ─────────────────────────────────────────────────────────────────────────────
// Change these two if your GitHub repo differs. Everything else derives from them.
const GH_USER = "aico-dot-team-code";
const GH_REPO = "mcpbridge";
// ─────────────────────────────────────────────────────────────────────────────

const REPO_URL = `https://github.com/${GH_USER}/${GH_REPO}`;
const SITE_ORIGIN = `https://${GH_USER.toLowerCase()}.github.io`;
// On GitHub Actions we derive the base from the actual repo name so links never
// break if the repo is renamed. Locally it defaults to the constant above.
const BASE = process.env.DOCS_BASE ?? `/${GH_REPO}/`;
// The interactive demo is a static SPA published alongside the docs under /demo/.
const DEMO_URL = SITE_ORIGIN + BASE + "demo/";

const DESCRIPTION =
  "The self-hosted MCP gateway with a real admin UI. Turn any REST API or MCP server " +
  "into secure, governed AI tools — OpenAPI-to-MCP auto-discovery, RBAC, guardrails, " +
  "circuit breaking. Single binary, no Kubernetes.";

// Tiny inline ES translation table — every entry here mirrors an English
// string from the sidebar / nav / footer / edit-link. The point is to keep
// these labels localisable without dragging in a full i18n catalog just
// for ~20 strings.
const textEs = {
  Guide: "Guía",
  Features: "Funcionalidades",
  "Live demo": "Demo en vivo",
  "Why MCP REST Bridge": "Por qué MCP REST Bridge",
  Community: "Comunidad",
  Contributing: "Contribuir",
  Changelog: "Registro de cambios",
  "Security policy": "Política de seguridad",
  "Report an issue": "Reportar un problema",
  Introduction: "Introducción",
  Overview: "Resumen",
  "Getting started": "Primeros pasos",
  Architecture: "Arquitectura",
  "Concepts & glossary": "Conceptos y glosario",
  Connect: "Conectar",
  "Connecting MCP clients": "Conectar clientes MCP",
  "Registering backends": "Registrar backends",
  Bundles: "Bundles",
  Operate: "Operar",
  Security: "Seguridad",
  "Threat model": "Modelo de amenazas",
  "Access control & multi-tenancy": "Control de acceso y multi-tenancy",
  "Guardrails & resilience": "Guardrails y resiliencia",
  "Observability & monitoring": "Observabilidad y monitorización",
  "Scaling & high availability": "Escalado y alta disponibilidad",
  Deployment: "Despliegue",
  Reference: "Referencia",
  Configuration: "Configuración",
  "API reference": "Referencia de API",
  CLI: "CLI",
  Support: "Soporte",
  Troubleshooting: "Solución de problemas",
  FAQ: "Preguntas frecuentes",
  "Edit this page on GitHub": "Edita esta página en GitHub",
  "Released under the MIT License · Built with Bun + Vue.":
    "Distribuido bajo la licencia MIT · Construido con Bun + Vue.",
  "Open source · ": "Código abierto · ",
} as const;

// English sidebar — kept here so the root locale's `themeConfig` block can
// stay focused on the structural chrome only (logo, search, footer). Sidebar
// strings get re-derived for each locale below.
const sidebarGuideEn = [
  {
    text: "Introduction",
    items: [
      { text: "Overview", link: "/" },
      { text: "Getting started", link: "/guide/getting-started" },
      { text: "Why MCP REST Bridge", link: "/guide/why-mcp-rest-bridge" },
      { text: "Architecture", link: "/guide/architecture" },
      { text: "Concepts & glossary", link: "/guide/concepts" },
    ],
  },
  {
    text: "Connect",
    items: [
      { text: "Registering backends", link: "/guide/registering-backends" },
      { text: "Bundles", link: "/guide/bundles" },
      { text: "Connecting MCP clients", link: "/guide/connecting-clients" },
    ],
  },
  {
    text: "Operate",
    items: [
      { text: "Security", link: "/guide/security" },
      { text: "Threat model", link: "/guide/threat-model" },
      { text: "Access control & multi-tenancy", link: "/guide/access-control" },
      { text: "Guardrails & resilience", link: "/guide/guardrails-resilience" },
      { text: "Observability & monitoring", link: "/guide/observability" },
      { text: "Scaling & high availability", link: "/guide/scaling" },
      { text: "Deployment", link: "/guide/deployment" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Configuration", link: "/guide/configuration" },
      { text: "API reference", link: "/guide/api-reference" },
      { text: "CLI", link: "/guide/cli" },
      { text: "Features", link: "/guide/features" },
    ],
  },
  {
    text: "Support",
    items: [
      { text: "Troubleshooting", link: "/guide/troubleshooting" },
      { text: "FAQ", link: "/guide/faq" },
    ],
  },
  {
    text: "Community",
    items: [
      { text: "Contributing", link: "/guide/contributing" },
      { text: "Changelog", link: "/guide/changelog" },
      { text: "Security policy", link: "/guide/security-policy" },
    ],
  },
];

// Spanish sidebar — keys point at `/es/guide/...` paths so VitePress routes
// Spanish pages under the `/es/` locale root.
const sidebarGuideEs = sidebarGuideEn.map((group) => ({
  text: textEs[group.text as keyof typeof textEs] ?? group.text,
  items: group.items.map((item) => ({
    text: textEs[item.text as keyof typeof textEs] ?? item.text,
    // Map any /guide/foo path to /es/guide/foo so the ES sidebar lives in
    // its own locale tree. Skip the "/" entry which is the locale's home.
    link: item.link === "/" ? "/es/" : `/es${item.link}`,
  })),
}));

// Architecture sidebar — ADRs + SLOs live outside /guide/ (they're reference
// material, not part of the linear guide), so they get their own sidebar shown
// when you land on an /architecture/ page. The ADRs are English-only; only the
// SLO doc has a Spanish mirror, so the ES architecture sidebar lists just that.
const sidebarArchitecture = [
  {
    text: "Architecture",
    items: [
      { text: "SLOs (public contract)", link: "/architecture/slos" },
      {
        text: "ADR-0001 · Two planes, three endpoints",
        link: "/architecture/decisions/0001-two-planes-three-endpoints",
      },
      {
        text: "ADR-0002 · W3C traceparent propagation",
        link: "/architecture/decisions/0002-w3c-traceparent-propagation",
      },
      { text: "ADR-0003 · SLOs as a public contract", link: "/architecture/decisions/0003-slos-public-contract" },
      { text: "ADR-0004 · E2E as a CI gate", link: "/architecture/decisions/0004-e2e-as-ci-gate" },
    ],
  },
];

export default defineConfig({
  // VitePress's built-in i18n. The root locale keeps the existing
  // /guide/foo URLs; the Spanish locale mounts at /es/guide/foo.
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      themeConfig: {
        // Defaults below — `themeConfig` at the bottom of this file holds the
        // English chrome (nav, sidebar, footer), so per-locale overrides only
        // need to swap in the Spanish strings when `locale === 'es'`.
      },
    },
    es: {
      label: "Español",
      lang: "es-ES",
      link: "/es/",
      themeConfig: {
        nav: [
          {
            text: textEs["Guide"],
            link: "/es/guide/getting-started",
            activeMatch: "/es/guide/(?!features|why-mcp-rest-bridge)",
          },
          { text: textEs["Features"], link: "/es/guide/features", activeMatch: "/es/guide/features" },
          { text: textEs["Live demo"], link: DEMO_URL },
          {
            text: textEs["Why MCP REST Bridge"],
            link: "/es/guide/why-mcp-rest-bridge",
            activeMatch: "/es/guide/why-mcp-rest-bridge",
          },
          {
            text: textEs["Community"],
            items: [
              { text: textEs["Contributing"], link: "/es/guide/contributing" },
              { text: textEs["Changelog"], link: "/es/guide/changelog" },
              { text: textEs["Security policy"], link: "/es/guide/security-policy" },
              { text: textEs["Report an issue"], link: REPO_URL + "/issues/new" },
            ],
          },
        ],
        sidebar: {
          "/es/guide/": sidebarGuideEs,
          "/es/architecture/": [
            { text: textEs["Architecture"], items: [{ text: "SLOs", link: "/es/architecture/slos" }] },
          ],
        },
        editLink: {
          pattern: REPO_URL + "/edit/main/docs/:path",
          text: textEs["Edit this page on GitHub"],
        },
        footer: {
          message: textEs["Released under the MIT License · Built with Bun + Vue."],
          copyright: `${textEs["Open source · "]}${REPO_URL}`,
        },
      },
    },
  },
  title: "MCP REST Bridge",
  titleTemplate: ":title · MCP REST Bridge",
  description: DESCRIPTION,
  base: BASE,
  cleanUrls: true,
  lastUpdated: true,
  metaChunk: true,
  // Only skip localhost URLs (quickstart examples); still validate real internal links.
  ignoreDeadLinks: "localhostLinks",

  sitemap: { hostname: SITE_ORIGIN + BASE },

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: BASE + "favicon.svg" }],
    ["meta", { name: "theme-color", content: "#00a99a" }],
    [
      "meta",
      {
        name: "keywords",
        content:
          "MCP gateway, MCP proxy, MCP aggregator, Model Context Protocol, OpenAPI to MCP, REST to MCP, self-hosted MCP, MCP admin UI, MCP RBAC, AI tool gateway",
      },
    ],
    ["meta", { name: "author", content: "MCP REST Bridge contributors" }],

    // Open Graph / social cards
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "MCP REST Bridge" }],
    ["meta", { property: "og:title", content: "MCP REST Bridge — self-hosted MCP gateway with an admin UI" }],
    ["meta", { property: "og:description", content: DESCRIPTION }],
    ["meta", { property: "og:url", content: SITE_ORIGIN + BASE }],
    ["meta", { property: "og:image", content: SITE_ORIGIN + BASE + "og-cover.png" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "MCP REST Bridge — self-hosted MCP gateway with an admin UI" }],
    ["meta", { name: "twitter:description", content: DESCRIPTION }],
    ["meta", { name: "twitter:image", content: SITE_ORIGIN + BASE + "og-cover.png" }],

    // Fonts — same families the product uses (Space Grotesk + IBM Plex).
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap",
      },
    ],
  ],

  themeConfig: {
    logo: "/favicon.svg",
    siteTitle: "MCP REST Bridge",

    nav: [
      { text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/(?!features|why-mcp-rest-bridge)" },
      { text: "Features", link: "/guide/features", activeMatch: "/guide/features" },
      { text: "Live demo", link: DEMO_URL },
      {
        text: "Why MCP REST Bridge",
        link: "/guide/why-mcp-rest-bridge",
        activeMatch: "/guide/why-mcp-rest-bridge",
      },
      {
        text: "Community",
        items: [
          { text: "Contributing", link: "/guide/contributing" },
          { text: "Changelog", link: "/guide/changelog" },
          { text: "Security policy", link: "/guide/security-policy" },
          { text: "Report an issue", link: REPO_URL + "/issues/new" },
        ],
      },
    ],

    sidebar: {
      "/guide/": sidebarGuideEn,
      "/architecture/": sidebarArchitecture,
    },

    socialLinks: [{ icon: "github", link: REPO_URL }],
    search: { provider: "local" },
    outline: { level: [2, 3] },

    editLink: {
      pattern: REPO_URL + "/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License · Built with Bun + Vue.",
      copyright: `Open source · ${REPO_URL}`,
    },
  },
});
