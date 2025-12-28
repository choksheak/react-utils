import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Non-minified development build
    clean: true,
    format: ["cjs", "esm"],
    dts: true,
    splitting: true,
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
    splitting: true,
    external: ["react", "react-dom"],
    outExtension: ({ format }) => ({
      js: format === "cjs" ? ".min.cjs" : ".min.mjs",
    }),
  },
]);
