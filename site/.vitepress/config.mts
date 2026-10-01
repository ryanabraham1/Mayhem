import { defineConfig } from "vitepress";

const repo = "https://github.com/ryanabraham1/Mayhem";

export default defineConfig({
  title: "Mayhem",
  description:
    "Time-optimal swerve trajectory planning for FRC, with on-robot bump recovery.",
  // Served from https://ryanabraham1.github.io/Mayhem/ (the gh-pages branch also hosts the
  // MayhemLib maven repo and MayhemLib.json at the same root).
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
        href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Outfit:wght@400;500;600;700&display=swap",
      },
    ],
    ["meta", { name: "theme-color", content: "#6b3fe6" }],
  ],
  themeConfig: {
    logo: "/icon.svg",
    siteTitle: "Mayhem",
    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Desktop app", link: "/app/projects", activeMatch: "/app/" },
      { text: "MayhemLib", link: "/lib/installation", activeMatch: "/lib/" },
      { text: "Reference", link: "/reference/solver", activeMatch: "/reference/" },
      { text: "Download", link: `${repo}/releases/latest` },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Your first auto", link: "/guide/quick-start" },
          ],
        },
      ],
      "/app/": [
        {
          text: "Desktop app",
          items: [
            { text: "Projects and deploying", link: "/app/projects" },
            { text: "Robot configuration", link: "/app/robot" },
            { text: "Field and obstacles", link: "/app/field" },
            { text: "Building paths", link: "/app/paths" },
            { text: "Constraints", link: "/app/constraints" },
            { text: "Markers and pose variables", link: "/app/markers" },
            { text: "Checking a path", link: "/app/checking" },
            { text: "Fuel sim", link: "/app/fuel-sim" },
            { text: "Troubleshooting", link: "/app/troubleshooting" },
          ],
        },
      ],
      "/lib/": [
        {
          text: "MayhemLib (robot code)",
          items: [
            { text: "Installation", link: "/lib/installation" },
            { text: "Quick start", link: "/lib/quick-start" },
            { text: "Coming from Choreo", link: "/lib/from-choreo" },
          ],
        },
        {
          text: "API",
          items: [
            { text: "AutoFactory, routines and triggers", link: "/lib/api" },
            { text: "Event markers", link: "/lib/markers" },
            { text: "Splits and alliance flipping", link: "/lib/splits-and-alliance" },
          ],
        },
        {
          text: "On the robot",
          items: [
            { text: "Bump recovery", link: "/lib/recovery" },
            { text: "Tuning the follower", link: "/lib/tuning" },
            { text: "Telemetry", link: "/lib/telemetry" },
            { text: "Testing without a robot", link: "/lib/testing" },
            { text: "Troubleshooting", link: "/lib/troubleshooting" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "How the solver works", link: "/reference/solver" },
            { text: "Conventions", link: "/reference/conventions" },
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
      copyright: "Not affiliated with FIRST, WPILib or Choreo.",
    },
  },
});
