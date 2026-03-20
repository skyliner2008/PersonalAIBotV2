import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CliProfileManager');

export interface CliProfileConfig {
  argsTemplate: string[];
  usesStdin: boolean;
  extraEnv?: Record<string, string>;
}

const CONFIG_DIR = path.join(process.cwd(), 'config');
const PROFILES_PATH = path.join(CONFIG_DIR, 'cli_profiles.json');

const DEFAULT_PROFILES: Record<string, CliProfileConfig> = {
  'claude-cli': {
    argsTemplate: ['--print', '{prompt_content}'],
    usesStdin: false,
    extraEnv: { 'CLAUDE_CODE_DISABLE_NONINTERACTIVE_CHECK': '1' }
  },
  'gemini-cli': {
    argsTemplate: ['-p', '{prompt_content}'],
    usesStdin: false,
  },
  'codex-cli': {
    argsTemplate: ['exec', '{prompt_content}'],
    usesStdin: false,
    extraEnv: {
      'CODEX_HOME': path.join(process.cwd(), '.codex-swarm'),
    }
  },
  'aider-cli': { argsTemplate: ['--message-file', '{tempFile}'], usesStdin: false },
  'ollama-cli': { argsTemplate: ['run', 'llama3.1'], usesStdin: true },
  'llm-cli': { argsTemplate: ['prompt'], usesStdin: true },
  'kilo-cli': {
    argsTemplate: ['run', '--model', 'kilo/kilo-auto/free', '{prompt_content}'],
    usesStdin: false,
  },
  'qwen-cli': { argsTemplate: ['chat', '{prompt_content}'], usesStdin: false },
  'openai-cli': {
    argsTemplate: ['api', 'chat.completions.create', '-m', 'gpt-4o', '-g', 'user', '{prompt_content}'],
    usesStdin: false,
  },
  'opencode-cli': {
    argsTemplate: ['run', '{prompt_content}'],
    usesStdin: false,
  },
};

export function loadCliProfiles(): Record<string, CliProfileConfig> {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (!fs.existsSync(PROFILES_PATH)) {
      fs.writeFileSync(PROFILES_PATH, JSON.stringify(DEFAULT_PROFILES, null, 2), 'utf-8');
      return DEFAULT_PROFILES;
    }
    const data = fs.readFileSync(PROFILES_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    log.error('Failed to load CLI profiles, using defaults', err);
    return DEFAULT_PROFILES;
  }
}

export function saveCliProfiles(profiles: Record<string, CliProfileConfig>): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2), 'utf-8');
  } catch (err) {
    log.error('Failed to save CLI profiles', err);
    throw err;
  }
}
