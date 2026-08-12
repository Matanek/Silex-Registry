import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sourceRoot = resolve("registry/v1");
const outputRoot = resolve(process.argv[2] ?? "dist/v1");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const checksumPattern = /^[0-9a-f]{64}$/;

if (sourceRoot === outputRoot) {
  throw new Error("the generated registry must use a distinct output directory");
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function parseVersion(value) {
  const match = versionPattern.exec(value);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined || right[index] === undefined) {
      return left[index] === right[index] ? 0 : left[index] === undefined ? -1 : 1;
    }

    const leftNumber = /^\d+$/.test(left[index]) ? Number(left[index]) : null;
    const rightNumber = /^\d+$/.test(right[index]) ? Number(right[index]) : null;
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== null && rightNumber === null) return -1;
    if (leftNumber === null && rightNumber !== null) return 1;
    if (left[index] !== right[index]) {
      return left[index].localeCompare(right[index], "en");
    }
  }

  return 0;
}

function compareVersions(left, right) {
  for (const part of ["major", "minor", "patch"]) {
    if (left.parsed[part] !== right.parsed[part]) {
      return left.parsed[part] - right.parsed[part];
    }
  }
  return comparePrerelease(left.parsed.prerelease, right.parsed.prerelease);
}

const rootIndex = await readJson(join(sourceRoot, "index.json"), "registry index");
if (rootIndex.schema !== 1) throw new Error("registry index uses an unsupported schema");
if (rootIndex.endpoints?.releases !== "packages/{package}/index.json") {
  throw new Error("registry index has an unsupported releases endpoint");
}
if (rootIndex.endpoints?.manifest !== "packages/{package}/{version}.json") {
  throw new Error("registry index has an unsupported manifest endpoint");
}

const sourcePackagesRoot = join(sourceRoot, "packages");
const packageDirectories = (await readdir(sourcePackagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name, "en"));

if (packageDirectories.length === 0) throw new Error("registry has no packages");

for (const packageDirectory of packageDirectories) {
  const packageRoot = join(sourcePackagesRoot, packageDirectory.name);
  const entries = await readdir(packageRoot, { withFileTypes: true });
  if (entries.some((entry) => entry.name === "index.json")) {
    throw new Error(`${packageDirectory.name}/index.json is generated and must not be committed`);
  }

  const versionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ file: entry.name, version: entry.name.slice(0, -5) }))
    .map((entry) => ({ ...entry, parsed: parseVersion(entry.version) }));

  const invalidFile = versionFiles.find((entry) => entry.parsed === null);
  if (invalidFile) {
    throw new Error(`${packageDirectory.name}/${invalidFile.file} is not a semantic version manifest`);
  }
  if (versionFiles.length === 0) {
    throw new Error(`${packageDirectory.name} has no version manifest`);
  }

  for (const entry of versionFiles) {
    const label = `${packageDirectory.name}/${entry.file}`;
    const manifest = await readJson(join(packageRoot, entry.file), label);
    if (manifest.schema !== 1) throw new Error(`${label} uses an unsupported schema`);
    if (manifest.name !== packageDirectory.name) throw new Error(`${label} has a mismatched package name`);
    if (manifest.version !== entry.version) throw new Error(`${label} has a mismatched version`);
    if (typeof manifest.requires?.silex !== "string" || manifest.requires.silex.trim() === "") {
      throw new Error(`${label} has no Silex compatibility range`);
    }
    if (typeof manifest.archive?.url !== "string") throw new Error(`${label} has no archive URL`);

    let archiveUrl;
    try {
      archiveUrl = new URL(manifest.archive.url);
    } catch {
      throw new Error(`${label} has an invalid archive URL`);
    }
    if (archiveUrl.protocol !== "https:") throw new Error(`${label} archive URL must use HTTPS`);
    if (!checksumPattern.test(manifest.archive?.sha256 ?? "")) {
      throw new Error(`${label} has an invalid SHA-256 checksum`);
    }
  }
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(dirname(outputRoot), { recursive: true });
await cp(sourceRoot, outputRoot, { recursive: true });
await copyFile(resolve("index.html"), join(dirname(outputRoot), "index.html"));
await copyFile(resolve("styles.css"), join(dirname(outputRoot), "styles.css"));

for (const packageDirectory of packageDirectories) {
  const sourcePackageRoot = join(sourcePackagesRoot, packageDirectory.name);
  const outputPackageRoot = join(outputRoot, "packages", packageDirectory.name);
  const versionFiles = (await readdir(sourcePackageRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({
      file: entry.name,
      version: entry.name.slice(0, -5),
      parsed: parseVersion(entry.name.slice(0, -5)),
    }))
    .sort((left, right) => compareVersions(right, left));

  const releases = [];
  for (const entry of versionFiles) {
    const manifest = await readJson(join(sourcePackageRoot, entry.file), `${packageDirectory.name}/${entry.file}`);
    releases.push({
      version: manifest.version,
      requires: manifest.requires,
      manifest: entry.file,
    });
  }

  await writeFile(
    join(outputPackageRoot, "index.json"),
    `${JSON.stringify({ schema: 1, name: packageDirectory.name, releases }, null, 2)}\n`,
  );
}

console.log(`Built ${packageDirectories.length} packages in ${outputRoot}`);
