import { readFileSync } from "node:fs";
import { defineConfig } from "vitepress";

const repo = "https://github.com/ryanabraham1/Mayhem";
const appVersion: string = JSON.parse(
  readFileSync(new URL("../../app/package.json", import.meta.url), "utf-8"),
).version;

export default defineConfig({
  title: "Mayhem",
  description:
    "One app for an FRC robot's software: autos, state machines, logs, and reviewing what a code change does.",
  // Served from https://ryanabraham1.github.io/Mayhem/ (the gh-pages branch also hosts the
  // vendordep maven repo and MayhemCpp.json at the same root).
  base: "/Mayhem/",
  cleanUrls: true,
  lastUpdated: false,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/Mayhem/icon.svg" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
      },
    ],
    ["meta", { name: "theme-color", content: "#ffffff" }],
  ],
  markdown: {
    // Code blocks are dark in both color schemes.
    theme: { light: "github-dark", dark: "github-dark" },
  },
  themeConfig: {
    logo: "/icon.svg",
    siteTitle: "Mayhem",
    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Using Mayhem", link: "/suite/overview", activeMatch: "/suite/" },
      { text: "Robot code", link: "/robot-code/setup", activeMatch: "/robot-code/" },
      { text: "Agents", link: "/agents/", activeMatch: "/agents/" },
      { text: "Reference", link: "/reference/conventions", activeMatch: "/reference/" },
      {
        text: `v${appVersion}`,
        items: [
          { text: "Download the app", link: `${repo}/releases/latest` },
          { text: "All releases", link: `${repo}/releases` },
          { text: "C++ library (MayhemCpp)", link: "/robot-code/setup" },
        ],
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Your first auto", link: "/guide/quick-start" },
            { text: "A week with Mayhem", link: "/guide/workflow" },
          ],
        },
        {
          text: "Next",
          items: [
            { text: "The app at a glance", link: "/suite/overview" },
            { text: "Set up robot code", link: "/robot-code/setup" },
            { text: "Connect an agent", link: "/agents/" },
          ],
        },
      ],
      "/suite/": [
        {
          text: "Using Mayhem",
          items: [
            { text: "The app at a glance", link: "/suite/overview" },
            { text: "Projects, files and settings", link: "/suite/projects" },
          ],
        },
        {
          text: "Build",
          items: [
            { text: "Autonomous", link: "/suite/autonomous" },
            { text: "State machines", link: "/suite/state-machines" },
          ],
        },
        {
          text: "Robot and logs",
          items: [
            { text: "Robot", link: "/suite/robot" },
            { text: "Logs", link: "/suite/logs" },
          ],
        },
        {
          text: "Review",
          items: [{ text: "Changes", link: "/suite/changes" }],
        },
      ],
      "/robot-code/": [
        {
          text: "Robot code",
          items: [
            { text: "Set up a robot repo", link: "/robot-code/setup" },
            { text: "Running autos", link: "/robot-code/autos" },
            { text: "State machines", link: "/robot-code/state-machines" },
            { text: "Logging and what's deployed", link: "/robot-code/logging" },
            { text: "Sim proof scenarios", link: "/robot-code/scenarios" },
          ],
        },
      ],
      "/agents/": [
        {
          text: "Agents",
          items: [
            { text: "Connect an agent", link: "/agents/" },
            { text: "How changes get reviewed", link: "/agents/review" },
            { text: "Command line and MCP tools", link: "/agents/tools" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Conventions", link: "/reference/conventions" },
            { text: "The tools/mayhem folder", link: "/reference/repo-files" },
            { text: "Building and contributing", link: "/reference/building" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: repo }],
    search: { provider: "local" },
    editLink: {
      pattern: `${repo}/edit/main/site/:path`,
      text: "Edit this page on GitHub",
    },
    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: "Previous", next: "Next" },
    footer: {
      message: "Mayhem is an open-source FRC project.",
      copyright: "Not affiliated with FIRST or WPILib.",
    },
  },
});
