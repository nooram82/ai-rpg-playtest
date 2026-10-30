import { spawn } from 'node:child_process';
import type { GameFactory } from './types.js';

/**
 * A game you can drive from the shell. Each turn runs `act` once: the action arrives on stdin
 * and in PLAYTEST_ACTION, the playthrough's id in PLAYTEST_SESSION, and whatever the command
 * prints to stdout is what the player sees. Keep state between calls in your game, keyed by
 * PLAYTEST_SESSION.
 */
export interface CommandGameConfig {
  type: 'command';
  start?: string;
  act: string;
  cwd?: string;
  /** Default 300000 (5 minutes). */
  timeoutMs?: number;
}

export function commandGame(cfg: CommandGameConfig, baseDir: string): GameFactory {
  return async (ctx) => {
    const run = (command: string, action: string) =>
      runShell(command, action, {
        cwd: cfg.cwd ?? baseDir,
        timeoutMs: cfg.timeoutMs ?? 300_000,
        env: { PLAYTEST_ACTION: action, PLAYTEST_SESSION: ctx.sessionId, PLAYTEST_CHARACTER: ctx.character },
      });
    return {
      start: async () => (cfg.start ? run(cfg.start, '') : ''),
      act: (action) => run(cfg.act, action),
    };
  };
}

function runShell(command: string, stdin: string, opts: { cwd: string; timeoutMs: number; env: Record<string, string> }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Game command timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`Game command exited ${code}: ${err.slice(-400)}`));
    });
    child.stdin.end(stdin);
  });
}
