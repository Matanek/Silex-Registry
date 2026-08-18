import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sourceRoot = resolve("registry/v1/packages");
const outputRoot = resolve(process.argv[2] ?? "dist/v1");
const packagePattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const repositoryPattern = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

const entries = await readdir(sourceRoot, { withFileTypes: true });
const unexpected = entries.find((entry) => !entry.isFile() || !entry.name.endsWith(".json"));
if (unexpected) throw new Error(`registry package entry '${unexpected.name}' must be one JSON file`);

const registrations = [];
for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
  const name = entry.name.slice(0, -5);
  const registration = await readJson(join(sourceRoot, entry.name), entry.name);
  if (registration.schema !== 1) throw new Error(`${entry.name} uses an unsupported schema`);
  if (!packagePattern.test(name) || registration.name !== name) {
    throw new Error(`${entry.name} has a mismatched or invalid package name`);
  }
  if (!repositoryPattern.test(registration.repository)) {
    throw new Error(`${entry.name} must identify one canonical HTTPS GitHub repository ending in .git`);
  }
  if (Object.keys(registration).sort().join(",") !== "name,repository,schema") {
    throw new Error(`${entry.name} contains unsupported registry policy`);
  }
  registrations.push({ name, repository: registration.repository });
}
if (registrations.length === 0) throw new Error("registry has no packages");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await writeFile(
  join(outputRoot, "index.json"),
  `${JSON.stringify({ schema: 2, packages: registrations }, null, 2)}\n`,
);
await mkdir(dirname(outputRoot), { recursive: true });
await copyFile(resolve("index.html"), join(dirname(outputRoot), "index.html"));
await copyFile(resolve("styles.css"), join(dirname(outputRoot), "styles.css"));

console.log(`Built ${registrations.length} package registrations in ${outputRoot}`);
