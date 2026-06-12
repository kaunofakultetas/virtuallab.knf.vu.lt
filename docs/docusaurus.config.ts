import path from "path";
import type { Config } from "@docusaurus/types";
import type { PresetOptions } from "@kaunofakultetas/docusaurus-preset";

// Serve the brand assets bundled inside the preset (logos + favicon) as if they
// were local static files — they end up under /img/* in the build output.
const presetStaticDir = path.join(
    path.dirname(require.resolve("@kaunofakultetas/docusaurus-preset")),
    "static",
);

const config: Config = {
    title: "VirtualLab",
    url: "https://virtuallab.knf.vu.lt",
    baseUrl: "/docs/",
    favicon: "img/vuLogo.svg",
    markdown: { mermaid: true },
    staticDirectories: ["static", presetStaticDir],

    presets: [
        [
            "@kaunofakultetas/docusaurus-preset",
            {
                docs: {
                    path: "content", // Markdown lives in docs/content/
                    routeBasePath: "/", // docs served at the site root
                    sidebarPath: require.resolve("./sidebars.ts"),
                },
            } satisfies PresetOptions,
        ],
    ],

    themeConfig: {
        navbar: {
            title: "VirtualLab Docs", // shown to the right of the logo
            logo: { alt: "Kauno fakultetas", src: "img/knfLogoText.svg" },
            items: [],
        },
    },
};

export default config;
