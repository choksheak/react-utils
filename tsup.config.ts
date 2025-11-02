import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Non-minified development build
    entry: ["src/index.ts"],
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
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: false, // No need for duplicate declarations
    sourcemap: true,
    minify: true,
    splitting: false,
    external: ["react", "react-dom"],
    outExtension: ({ format }) => ({
      js: format === "cjs" ? ".min.cjs" : ".min.mjs",
    }),
  },
]);
