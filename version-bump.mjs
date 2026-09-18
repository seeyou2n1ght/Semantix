import { existsSync, readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const paths = {
	package: join(rootDir, "package.json"),
	lock: join(rootDir, "package-lock.json"),
	manifest: join(rootDir, "manifest.json"),
	versions: join(rootDir, "versions.json"),
	readme: join(rootDir, "README.md"),
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);

function checkRelease() {
	const pkg = readJson(paths.package);
	const lock = readJson(paths.lock);
	const manifest = readJson(paths.manifest);
	const versions = readJson(paths.versions);
	const readme = readFileSync(paths.readme, "utf8");
	const errors = [];

	for (const field of ["id", "name", "version", "minAppVersion", "description", "author"]) {
		if (typeof manifest[field] !== "string" || !manifest[field]) errors.push(`manifest.json has invalid ${field}`);
	}
	if (typeof manifest.isDesktopOnly !== "boolean") errors.push("manifest.json has invalid isDesktopOnly");
	if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) errors.push("manifest.json version must be numeric x.y.z");
	if (manifest.version !== pkg.version) errors.push("manifest.json and package.json versions differ");
	if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) errors.push("package-lock.json version differs");
	if (versions[pkg.version] !== manifest.minAppVersion) errors.push("versions.json is missing the current compatibility entry");
	if (!readme.includes(`当前版本：\`v${pkg.version}\``)) errors.push("README.md current version differs");
	for (const asset of ["main.js", "styles.css"]) {
		if (!existsSync(join(rootDir, asset))) errors.push(`missing ${asset}`);
	}
	if (errors.length) throw new Error(errors.join("\n"));
	console.log(`Release contract valid for ${pkg.version}.`);
}

function nextVersion(current, action) {
	if (/^\d+\.\d+\.\d+$/.test(action)) return action;
	const parts = current.split(".").map(Number);
	if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`Invalid current version: ${current}`);
	if (action === "major") return `${parts[0] + 1}.0.0`;
	if (action === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
	return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

const action = process.argv[2];
if (action === "--check") {
	checkRelease();
	process.exit(0);
}
if (action === "--self-test") {
	assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
	assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
	assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
	assert.equal(nextVersion("1.2.3", "4.5.6"), "4.5.6");
	console.log("Version bump self-test passed.");
	process.exit(0);
}

const pkg = readJson(paths.package);
if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(action ?? "")) {
	throw new Error("Usage: npm run version -- patch|minor|major|x.y.z");
}

const targetVersion = nextVersion(pkg.version, action);

const lock = readJson(paths.lock);
const manifest = readJson(paths.manifest);
const versions = readJson(paths.versions);
const readme = readFileSync(paths.readme, "utf8");
const versionPattern = /(当前版本：`v)(\d+\.\d+\.\d+)(`)/;
if (!versionPattern.test(readme)) throw new Error("README.md current version marker not found");

pkg.version = targetVersion;
lock.version = targetVersion;
lock.packages[""].version = targetVersion;
manifest.version = targetVersion;
versions[targetVersion] = manifest.minAppVersion;

writeJson(paths.package, pkg);
writeJson(paths.lock, lock);
writeJson(paths.manifest, manifest);
writeJson(paths.versions, versions);
writeFileSync(paths.readme, readme.replace(versionPattern, `$1${targetVersion}$3`));
console.log(`Updated release version to ${targetVersion}.`);
