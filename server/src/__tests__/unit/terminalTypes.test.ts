import { describe, it, expect } from 'vitest';
import {
  GEMINI_CLI_SUBCOMMANDS,
  CLAUDE_CLI_SUBCOMMANDS,
} from '../../terminal/terminalTypes.js';

describe('Terminal Types & Constants', () => {
  // ── CLI Subcommands ──

  it('GEMINI_CLI_SUBCOMMANDS contains expected commands', () => {
    expect(GEMINI_CLI_SUBCOMMANDS.has('mcp')).toBe(true);
    expect(GEMINI_CLI_SUBCOMMANDS.has('extensions')).toBe(true);
    expect(GEMINI_CLI_SUBCOMMANDS.has('skills')).toBe(true);
  });

  it('GEMINI_CLI_SUBCOMMANDS does not contain random strings', () => {
    expect(GEMINI_CLI_SUBCOMMANDS.has('random')).toBe(false);
    expect(GEMINI_CLI_SUBCOMMANDS.has('')).toBe(false);
  });

  it('CLAUDE_CLI_SUBCOMMANDS contains expected commands', () => {
    expect(CLAUDE_CLI_SUBCOMMANDS.has('mcp')).toBe(true);
    expect(CLAUDE_CLI_SUBCOMMANDS.has('config')).toBe(true);
    expect(CLAUDE_CLI_SUBCOMMANDS.has('doctor')).toBe(true);
    expect(CLAUDE_CLI_SUBCOMMANDS.has('login')).toBe(true);
  });

  it('CLAUDE_CLI_SUBCOMMANDS does not contain gemini-specific commands', () => {
    expect(CLAUDE_CLI_SUBCOMMANDS.has('extensions')).toBe(false);
    expect(CLAUDE_CLI_SUBCOMMANDS.has('skills')).toBe(false);
  });

  // ── Set sizes are reasonable ──

  it('CLI subcommand sets have reasonable size', () => {
    expect(GEMINI_CLI_SUBCOMMANDS.size).toBeGreaterThan(3);
    expect(GEMINI_CLI_SUBCOMMANDS.size).toBeLessThan(30);
    expect(CLAUDE_CLI_SUBCOMMANDS.size).toBeGreaterThan(3);
    expect(CLAUDE_CLI_SUBCOMMANDS.size).toBeLessThan(30);
  });
});
