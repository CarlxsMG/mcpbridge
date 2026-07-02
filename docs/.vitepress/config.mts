import { defineConfig } from 'vitepress'

// ─────────────────────────────────────────────────────────────────────────────
// Change these two if your GitHub repo differs. Everything else derives from them.
const GH_USER = 'aico-dot-team-code'
const GH_REPO = 'mcpbridge'
// ─────────────────────────────────────────────────────────────────────────────

const REPO_URL = `https://github.com/${GH_USER}/${GH_REPO}`
const SITE_ORIGIN = `https://${GH_USER.toLowerCase()}.github.io`
// On GitHub Actions we derive the base from the actual repo name so links never
// break if the repo is renamed. Locally it defaults to the constant above.
const BASE = process.env.DOCS_BASE ?? `/${GH_REPO}/`
// The interactive demo is a static SPA published alongside the docs under /demo/.
const DEMO_URL = SITE_ORIGIN + BASE + 'demo/'

const DESCRIPTION =
  'The self-hosted MCP gateway with a real admin UI. Turn any REST API or MCP server ' +
  'into secure, governed AI tools — OpenAPI-to-MCP auto-discovery, RBAC, guardrails, ' +
  'circuit breaking. Single binary, no Kubernetes.'

export default defineConfig({
  lang: 'en-US',
  title: 'MCP REST Bridge',
  titleTemplate: ':title · MCP REST Bridge',
  description: DESCRIPTION,
  base: BASE,
  cleanUrls: true,
  lastUpdated: true,
  metaChunk: true,
  // Only skip localhost URLs (quickstart examples); still validate real internal links.
  ignoreDeadLinks: 'localhostLinks',

  sitemap: { hostname: SITE_ORIGIN + BASE },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: BASE + 'favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#00a99a' }],
    ['meta', { name: 'keywords', content: 'MCP gateway, MCP proxy, MCP aggregator, Model Context Protocol, OpenAPI to MCP, REST to MCP, self-hosted MCP, MCP admin UI, MCP RBAC, AI tool gateway' }],
    ['meta', { name: 'author', content: 'MCP REST Bridge contributors' }],

    // Open Graph / social cards
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'MCP REST Bridge' }],
    ['meta', { property: 'og:title', content: 'MCP REST Bridge — self-hosted MCP gateway with an admin UI' }],
    ['meta', { property: 'og:description', content: DESCRIPTION }],
    ['meta', { property: 'og:url', content: SITE_ORIGIN + BASE }],
    ['meta', { property: 'og:image', content: SITE_ORIGIN + BASE + 'og-cover.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'MCP REST Bridge — self-hosted MCP gateway with an admin UI' }],
    ['meta', { name: 'twitter:description', content: DESCRIPTION }],
    ['meta', { name: 'twitter:image', content: SITE_ORIGIN + BASE + 'og-cover.png' }],

    // Fonts — same families the product uses (Space Grotesk + IBM Plex).
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap' }],
  ],

  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'MCP REST Bridge',

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Features', link: '/guide/features' },
      { text: 'Live demo ↗', link: DEMO_URL },
      { text: 'Why', link: '/guide/why-mcp-rest-bridge' },
      {
        text: 'v1',
        items: [
          { text: 'Changelog', link: REPO_URL + '/releases' },
          { text: 'Report an issue', link: REPO_URL + '/issues/new' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Why MCP REST Bridge', link: '/guide/why-mcp-rest-bridge' },
            { text: 'Architecture', link: '/guide/architecture' },
          ],
        },
        {
          text: 'Guides',
          items: [
            { text: 'Security', link: '/guide/security' },
            { text: 'Deployment', link: '/guide/deployment' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Reference',
          items: [{ text: 'Features', link: '/guide/features' }],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: REPO_URL }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },

    editLink: {
      pattern: REPO_URL + '/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License · Built with Bun + Vue.',
      copyright: `Open source · ${REPO_URL}`,
    },
  },
})
