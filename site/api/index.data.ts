// Package and type summaries for the API overview page (the full JSON stays server-side).
import { defineLoader } from "vitepress";
import { INTERNAL_PACKAGES, apiPath, loadApi } from "../.vitepress/api";

export interface ApiIndexData {
  version: string;
  packages: {
    name: string;
    slug: string;
    summary: string;
    internal: boolean;
    types: { name: string; kind: string; link: string; summary: string }[];
  }[];
}

declare const data: ApiIndexData;
export { data };

export default defineLoader({
  watch: ["./mayhemlib.json"],
  load(): ApiIndexData {
    const api = loadApi();
    return {
      version: api.version,
      packages: api.packages.map((p) => ({
        name: p.name,
        slug: p.slug,
        summary: p.summary ?? "",
        internal: INTERNAL_PACKAGES.has(p.slug),
        types: p.types.map((t) => ({
          name: t.name,
          kind: t.kind,
          link: apiPath(t.url),
          summary: (t.summary ?? "").replace(/<[^>]+>/g, ""),
        })),
      })),
    };
  },
});
