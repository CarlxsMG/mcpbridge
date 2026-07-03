import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import HowItWorks from "./components/HowItWorks.vue";
import RequestPath from "./components/RequestPath.vue";
import ScaleOut from "./components/ScaleOut.vue";
import DemoReel from "./components/DemoReel.vue";
import "./custom.css";

// The default VitePress theme, re-skinned with the product's own design tokens
// (see custom.css), plus a couple of custom components used on the landing.
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("HowItWorks", HowItWorks);
    app.component("RequestPath", RequestPath);
    app.component("ScaleOut", ScaleOut);
    app.component("DemoReel", DemoReel);
  },
} satisfies Theme;
