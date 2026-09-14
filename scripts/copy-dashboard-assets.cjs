const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const srcDir = path.join(projectRoot, 'src', 'dashboard', 'public');
const destDir = path.join(projectRoot, 'dist', 'dashboard', 'public');

// Validate source directory exists
if (!fs.existsSync(srcDir)) {
    console.error(`[ASSET-COPY] Error: Source directory does not exist: ${srcDir}`);
    process.exit(1);
}

// Scoped removal of old destination assets without touching the rest of dist
if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
}

// Ensure parent directories exist
fs.mkdirSync(destDir, { recursive: true });

// Copy files safely, rejecting symlinks and path traversals
const files = fs.readdirSync(srcDir);

for (const file of files) {
    const srcFile = path.join(srcDir, file);
    const destFile = path.join(destDir, file);

    const lstat = fs.lstatSync(srcFile);
    if (lstat.isSymbolicLink()) {
        console.warn(`[ASSET-COPY] Skipping symbolic link: ${srcFile}`);
        continue;
    }

    if (lstat.isFile()) {
        fs.copyFileSync(srcFile, destFile);
    }
}

console.log(`[ASSET-COPY] Successfully copied dashboard assets from ${srcDir} to ${destDir}`);
