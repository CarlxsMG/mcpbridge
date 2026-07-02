import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import HowItWorks from './components/HowItWorks.vue'
import DemoReel from './components/DemoReel.vue'
import './custom.css'

// The default VitePress theme, re-skinned with the product's own design tokens
// (see custom.css), plus a couple of custom components used on the landing.
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HowItWorks', HowItWorks)
    app.component('DemoReel', DemoReel)
  },
} satisfies Theme
