import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..'); 
const OUTPUT_FILE = path.join(ROOT_DIR, 'PersonalAIBotV2-Release.zip');

// Files/folders to explicitly ignore (relative to ROOT_DIR)
const IGNORE_LIST = [
  'node_modules',
  'server/node_modules',
  'dashboard/node_modules',
  '.env',
  'server/.env',
  '.git',
  '.vscode',
  'server/data',
  'server/evolution_data',
  'server/dynamic_tools',
  'server/logs',
  'PersonalAIBotV2-Release.zip'
];

// For personas, we want to keep the folder structure and system persona,
// but ignore user-generated personas.
const PERSONA_IGNORE_REGEX = /^server[\\/]personas[\\/](?!system).*$/i;

console.log(`📦 Packaging PersonalAIBotV2 to ${OUTPUT_FILE}...`);

const output = fs.createWriteStream(OUTPUT_FILE);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`✅ Success! Packaged ${archive.pointer()} total bytes.`);
  console.log(`📂 Saved to: ${OUTPUT_FILE}`);
});

archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);

// Helper function to recursively add files, respecting ignores
function addDirectoryToArchive(currentPath, basePathInZip) {
  if (!fs.existsSync(currentPath)) return;

  const items = fs.readdirSync(currentPath);

  for (const item of items) {
    const fullPath = path.join(currentPath, item);
    const relPath = path.relative(ROOT_DIR, fullPath).replace(/\\/g, '/');

    // Check ignore list
    if (IGNORE_LIST.some(ignored => relPath === ignored || relPath.startsWith(ignored + '/'))) {
      continue;
    }

    // Special rule for personas (keep 'system' folder, ignore others)
    if (PERSONA_IGNORE_REGEX.test(relPath)) {
        continue;
    }

    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      addDirectoryToArchive(fullPath, path.posix.join(basePathInZip, item));
    } else {
      archive.file(fullPath, { name: path.posix.join(basePathInZip, item) });
    }
  }
}

// Start adding from the root directory
addDirectoryToArchive(ROOT_DIR, '');

archive.finalize();
