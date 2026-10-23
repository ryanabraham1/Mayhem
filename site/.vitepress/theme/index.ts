import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import DocCrumb from "./components/DocCrumb.vue";
import Home from "./components/Home.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "doc-before": () => h(DocCrumb) }),
  enhanceApp({ app }) {
    app.component("Home", Home);
  },
} satisfies Theme;
