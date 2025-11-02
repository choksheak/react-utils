import { fileURLToPath } from "node:url";

import {
  FixupPluginDefinition,
  fixupPluginRules,
  includeIgnoreFile,
} from "@eslint/compat";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import pluginImport from "eslint-plugin-import";
import pluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginSortImports from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

const gitignorePath = fileURLToPath(new URL(".gitignore", import.meta.url));

export default defineConfig([
  includeIgnoreFile(gitignorePath, "Imported .gitignore patterns"),
  // "docs/" is not in .gitignore, but should be ignored by eslint.
  globalIgnores(["docs/*"]),
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.browser },
  },
  tseslint.configs.recommended,
  {
    plugins: {
      "simple-import-sort": pluginSortImports,
      import: pluginImport,
    },
    rules: {
      "simple-import-sort/imports": "error",
      "import/newline-after-import": "error",
      "import/no-duplicates": "error",
    },
  },
  // We could have used a 1-liner "pluginReact.configs.flat.recommended,", but
  // we need to auto-detect the react version, hence we need to expand out the
  // config block.
  {
    plugins: {
      react: pluginReact,
      "react-hooks": fixupPluginRules(
        // Something is off with the typing here, but not sure what.
        pluginReactHooks as FixupPluginDefinition,
      ),
    },
    rules: {
      ...pluginReact.configs.recommended.rules,
      ...pluginReactHooks.configs.recommended.rules,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  pluginPrettierRecommended,
]);
