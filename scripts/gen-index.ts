import * as fs from "fs/promises";
import * as path from "path";

const SRC_DIR = path.join(process.cwd(), "src");

async function generateIndex() {
  const files = await fs.readdir(SRC_DIR);

  // Identify unique module base names (e.g., 'fetcher' from 'fetcher.ts'.
  const moduleBaseNames = new Set<string>();

  for (const file of files) {
    if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
      const baseName = path.parse(file).name;

      // Skip the main entry point if it's named index (which is usually
      // handled by 'main'/'types')
      if (baseName !== "index") {
        moduleBaseNames.add(baseName);
      }
    }
  }

  // Generate index.ts.
  const fh = await fs.open(SRC_DIR + "/index.ts", "w");

  for (const module of moduleBaseNames) {
    fh.write(`export * from "./${module}";\n`);
  }

  await fh.close();

  console.log(`Successfully wrote index.ts`);
}

generateIndex();
