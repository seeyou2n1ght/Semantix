import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
    console.error("No version found in environment. Please run via 'npm version'.");
    process.exit(1);
}

// 1. 更新 manifest.json
const manifestPath = "manifest.json";
if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const { minAppVersion } = manifest;
    manifest.version = targetVersion;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
    console.log(`- Updated ${manifestPath} to ${targetVersion}`);

    // 2. 更新 versions.json
    const versionsPath = "versions.json";
    if (existsSync(versionsPath)) {
        const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
        if (!Object.values(versions).includes(minAppVersion)) {
            versions[targetVersion] = minAppVersion;
            writeFileSync(versionsPath, JSON.stringify(versions, null, "\t") + "\n");
            console.log(`- Updated ${versionsPath} with ${targetVersion}: ${minAppVersion}`);
        }
    }
}

// 3. 更新根目录 README.md (项目当前版本：`v0.5.0`)
const readmePath = join("..", "README.md");
if (existsSync(readmePath)) {
    let readme = readFileSync(readmePath, "utf8");
    const versionRegex = /(项目当前版本：`v)(\d+\.\d+\.\d+)(`)/;
    if (versionRegex.test(readme)) {
        readme = readme.replace(versionRegex, `$1${targetVersion}$3`);
        writeFileSync(readmePath, readme);
        console.log(`- Updated ${readmePath} to ${targetVersion}`);
    } else {
        console.warn(`! Could not find version string in ${readmePath}. Check the regex.`);
    }
}
