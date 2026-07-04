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

export default defineConfig({
  lang: "en-US",
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
      // `activeMatch` is a regex string. "Features" and "Why" are also under
      // /guide/, so match every guide page EXCEPT those two (they own their own
      // nav item) — otherwise "Guide" stays highlighted on Features/Why too.
      { text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/(?!features|why-mcp-rest-bridge)" },
      { text: "Features", link: "/guide/features", activeMatch: "/guide/features" },
      { text: "Live demo", link: DEMO_URL },
      {
        text: "Why MCP REST Bridge",
        link: "/guide/why-mcp-rest-bridge",
        activeMatch: "/guide/why-mcp-rest-bridge",
      },
      {
        // Was "v1" — read as a doc-version switcher (a pattern most doc sites
        // train users to expect), not "meta project links". Renamed so the
        // label matches its actual contents.
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
      "/guide/": [
        {
          text: "Introduction",
          items: [
            // Explicit way back to the landing pitch — previously only the
            // small header logo did this from inside /guide/.
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
            { text: "Connecting MCP clients", link: "/guide/connecting-clients" },
            { text: "Registering backends", link: "/guide/registering-backends" },
          ],
        },
        {
          text: "Operate",
          items: [
            { text: "Security", link: "/guide/security" },
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
          // Troubleshooting is diagnose-a-problem content, not lookup content
          // like the Reference group above it — a different mental mode, so
          // it gets its own group instead of being the odd one out in Reference.
          text: "Support",
          items: [
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
            { text: "FAQ", link: "/guide/faq" },
          ],
        },
        {
          // Mirrors the nav's "Community" dropdown so these pages are reachable
          // (and get a proper sidebar "you are here" highlight) without opening it.
          text: "Community",
          items: [
            { text: "Contributing", link: "/guide/contributing" },
            { text: "Changelog", link: "/guide/changelog" },
            { text: "Security policy", link: "/guide/security-policy" },
          ],
        },
      ],
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
