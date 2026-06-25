import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Non-minified development build.
    // Recommended for use in bundlers to improve debuggability.
    clean: true,
    format: ["cjs", "esm"],
    dts: true,
    minify: false,
    splitting: true,
    external: ["react", "react-dom"],
    outExtension: ({ format }) => ({
      js: format === "cjs" ? ".cjs" : ".js",
    }),
  },
  // Minified production build.
  // Need to opt in explicit use by importing the '.min.js' files directly.
  {
    format: ["cjs", "esm"],
    dts: false, // No need for duplicate declarations
    sourcemap: true,
    minify: true,
    splitting: true,
    external: ["react", "react-dom"],
    outExtension: ({ format }) => ({
      js: format === "cjs" ? ".min.cjs" : ".min.js",
    }),
  },
]);
