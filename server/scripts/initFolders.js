// scripts/initFolders.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const foldersToCreate = [
  'data',
  'dynamic_tools',
  'evolution_data',
  'personas',
  'logs'
];

console.log('--- Initializing Required Folders ---');

for (const folder of foldersToCreate) {
  const targetPath = path.join(ROOT_DIR, folder);
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
    console.log(`[CREATED] ${folder}/`);
  } else {
    console.log(`[EXISTS]  ${folder}/`);
  }
}

console.log('\n--- Initializing Environment ---');
const envExamplePath = path.join(ROOT_DIR, '.env.example');
const envPath = path.join(ROOT_DIR, '.env');

if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
  let envContent = fs.readFileSync(envExamplePath, 'utf8');
  
  // Auto-generate a random secure 32-byte encryption key
  const newKey = crypto.randomBytes(32).toString('hex');
  envContent = envContent.replace(
    'ENCRYPTION_KEY=your-32-byte-hex-key-here-change-me',
    `ENCRYPTION_KEY=${newKey}`
  );
  
  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log('[CREATED] .env (Auto-generated secure ENCRYPTION_KEY)');
} else if (fs.existsSync(envPath)) {
  console.log('[EXISTS]  .env file already exists. Skipping copy.');
} else {
  console.log('[WARNING] .env.example not found. Cannot create .env.');
}

console.log('\n✅ Initialization complete!');
