import * as fs from "fs/promises";
import * as path from "path";

const DIST_DIR = path.join(process.cwd(), "dist");
const PACKAGE_JSON_PATH = path.join(DIST_DIR, "package.json");

// Type definitions for package.json structure
type EnvToFile = {
  production: string;
  development: string;
  default: string;
};

type ExportEntry =
  | string
  | {
      types: string;
      import: EnvToFile;
      require: EnvToFile;
    };

type PackageJson = {
  exports?: Record<string, ExportEntry>;
  typesVersions?: Record<"*", Record<string, string[]>>;
  [key: string]: unknown;
};

/**
 * Reads the 'dist' directory, processes file names, and generates the
 * 'exports' and 'typesVersions' configuration objects.
 */
async function generateExportsConfig() {
  console.log(`Scanning directory: ${DIST_DIR}`);

  try {
    const files = await fs.readdir(DIST_DIR);

    // Identify unique module base names (e.g., 'fetcher' from 'fetcher.js' or
    // 'fetcher.d.ts')
    const moduleBaseNames = new Set<string>();

    for (const file of files) {
      // We only care about .js and .d.ts files (the entry points)
      if (file.endsWith(".cjs") && !file.endsWith(".min.cjs")) {
        const baseName = path.parse(file).name;

        // Skip the main entry point if it's named index (which is usually
        // handled by 'main'/'types')
        if (baseName !== "index") {
          moduleBaseNames.add(baseName);
        }
      }
    }

    if (moduleBaseNames.size === 0) {
      console.log("No external module entry points found in dist/. Exiting.");
      return;
    }

    // 2. Build the 'exports' object
    const exports: Record<string, ExportEntry> = {
      // Must include the package.json itself
      "./package.json": "./package.json",
    };

    // 3. Build the 'typesVersions' object
    const typesVersions: PackageJson["typesVersions"] = {
      "*": {},
    };

    console.log(`Found modules: ${Array.from(moduleBaseNames).join(", ")}`);

    for (const name of Array.from(moduleBaseNames).sort()) {
      // Exports entry
      exports[`./${name}`] = {
        types: `./${name}.d.ts`,
        import: {
          production: `./${name}.min.mjs`,
          development: `./${name}.mjs`,
          default: `./${name}.mjs`,
        },
        require: {
          production: `./${name}.min.cjs`,
          development: `./${name}.cjs`,
          default: `./${name}.cjs`,
        },
      };

      // TypesVersions entry
      typesVersions["*"][name] = [`./${name}.d.ts`];
    }

    // 4. Read, update, and write package.json
    const packageJsonContent = await fs.readFile(PACKAGE_JSON_PATH, "utf-8");
    const packageJson: PackageJson = JSON.parse(packageJsonContent);

    // Merge new exports (overwriting existing ones, except for standard fields)
    packageJson.exports = exports;
    packageJson.typesVersions = typesVersions;

    // Use two spaces for indentation for standard package.json format
    await fs.writeFile(
      PACKAGE_JSON_PATH,
      JSON.stringify(packageJson, null, 2) + "\n",
    );

    console.log(`Successfully updated ${PACKAGE_JSON_PATH}:`);
    console.log(
      `- Added ${moduleBaseNames.size} entries to "exports" and "typesVersions".`,
    );
  } catch (error) {
    console.error("An error occurred during export generation:", error);
    process.exit(1);
  }
}

// Execute the function
generateExportsConfig();
