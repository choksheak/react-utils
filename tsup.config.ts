import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Non-minified development build
    clean: true,
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    external: ["react", "react-dom"],
    outExtension: ({ format }) => ({
      js: format === "cjs" ? ".cjs" : ".mjs",
    }),
  },
  // Minified production build
  {
    format: ["cjs", "esm"],
    dts: false, // No need for duplicate declarations
    sourcemap: true,
    minify: true,
    // Don't use chunk-* files - that encourages bundlers to treat them as
    // separate entry points.
    splitting: false,
    external: ["react", "react-dom"],
    outExtension: ({ format }) => ({
      js: format === "cjs" ? ".min.cjs" : ".min.mjs",
    }),
  },
]);
