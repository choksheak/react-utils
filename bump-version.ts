import * as fs from "fs";
import * as path from "path";

// Read args
const args = process.argv.slice(2);
const bumpType =
  args
    .find((a) => ["--major", "--minor", "--patch"].includes(a))
    ?.replace("--", "") || "patch";

const pkgPath = path.resolve(process.cwd(), "package.json");

// Read and parse package.json
if (!fs.existsSync(pkgPath)) {
  console.error("❌ package.json not found in current directory.");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const oldVersion: string = pkg.version;

if (!/^\d+\.\d+\.\d+$/.test(oldVersion)) {
  console.error(`❌ Invalid version format in package.json: "${oldVersion}"`);
  process.exit(1);
}

let [major, minor, patch] = oldVersion.split(".").map(Number);

switch (bumpType) {
  case "major":
    major += 1;
    minor = 0;
    patch = 0;
    break;

  case "minor":
    minor += 1;
    patch = 0;
    break;

  case "patch":
  default:
    patch += 1;
    if (patch > 9) {
      patch = 0;
      minor += 1;
    }
    break;
}

const newVersion = `${major}.${minor}.${patch}`;
pkg.version = newVersion;

// Write updated package.json
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

// Pretty log
const label = bumpType.toUpperCase();
console.log(`✅ [${label}] Version bumped: ${oldVersion} → ${newVersion}`);
