// Preserve upstream BLine's bundler-style imports while running the same source
// with Node's built-in TypeScript stripping. No transpiler or npm install needed.
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { extname } from "node:path";
import { readFileSync } from "node:fs";

registerHooks({
  load(url, context, nextLoad) {
    if (url.includes("/suite/core/vendor/bline/") && url.endsWith(".ts")) {
      let source = readFileSync(new URL(url), "utf8");
      // Node 26 removed transform mode. Lower the pinned upstream class's one
      // parameter property into an ordinary field and constructor assignment,
      // then use strip-only mode on every supported Node version. Upstream
      // source files remain byte-for-byte unchanged; algorithms are untouched.
      if (url.endsWith("/sim/rotationProgress.ts")) {
        for (const [before, after] of [
          [
            "export class RotationProgress {",
            "export class RotationProgress {\n  private readonly initialHeading: number;",
          ],
          [
            "    private readonly initialHeading: number,",
            "    initialHeading: number,",
          ],
          [
            "  ) {\n    let distance = 0;",
            "  ) {\n    this.initialHeading = initialHeading;\n    let distance = 0;",
          ],
        ]) {
          if (source.split(before).length !== 2)
            throw new Error(
              "BLine source changed; update the Node parameter-property adapter.",
            );
          source = source.replace(before, after);
        }
      }
      return {
        format: "module",
        shortCircuit: true,
        source: stripTypeScriptTypes(source),
      };
    }
    return nextLoad(url, context);
  },
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? "";
    const blineSource =
      parent.includes("/suite/core/vendor/bline/") ||
      parent.endsWith("/suite/core/blinePreview.ts") ||
      parent.endsWith("/suite/core/constraintGeneration.ts");
    if (blineSource && specifier.startsWith(".") && !extname(specifier))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
