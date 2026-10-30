import fs from 'node:fs';
import path from 'node:path';
import type { GameConfig } from './adapters/index.js';
import type { ModelConfig } from './llm.js';
import type { Persona } from './personas.js';
import { ALL_PROBES, type ProbeKind } from './probes.js';

export interface PlaytestConfig {
  game: GameConfig;
  /** The model that plays. A mid-size model is enough. */
  player: ModelConfig;
  /** The model that judges. Use a strong one. */
  judge: ModelConfig;
  /** Turns per persona. Default 40. Memory and consequences need 30 or more to mean much. */
  turns?: number;
  /** Built-in or custom persona ids. Default: merchant, seeker, brawler. */
  personas?: string[];
  customPersonas?: Persona[];
  /** Default: all of them. */
  probes?: ProbeKind[];
  /** "every": check every turn for puppeting (one judge call per turn). "probes": only probe turns. Default "every". */
  audit?: 'every' | 'probes';
  /** A few lines telling the player what the game is and how to start, if it isn't obvious. */
  setting?: string;
  /** Personas played at once. Default 3. Manual games always run one at a time. */
  concurrency?: number;
  seed?: number;
  /** Where runs are written. Default ./runs next to the config file. */
  out?: string;
  /** How many recent turns the player sees in full. Default 8; older ones live in its notes. */
  playerContextTurns?: number;
}

export interface LoadedConfig extends Required<Omit<PlaytestConfig, 'customPersonas' | 'setting' | 'personas'>> {
  customPersonas: Persona[];
  setting?: string;
  personas?: string[];
  baseDir: string;
}

export function loadConfig(file: string, overrides: Partial<PlaytestConfig> = {}): LoadedConfig {
  const full = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(full, 'utf8')) as PlaytestConfig;
  const cfg = { ...raw, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } as PlaytestConfig;
  const baseDir = path.dirname(full);
  if (!cfg.game?.type) throw new Error('config.game.type is required (chat, http, command, module or manual)');
  for (const k of ['player', 'judge'] as const) {
    if (!cfg[k]?.model) throw new Error(`config.${k} needs a model`);
    const provider = cfg[k].provider ?? 'openai';
    if (!['openai', 'claude-code', 'codex'].includes(provider)) throw new Error(`config.${k}.provider must be openai, claude-code or codex`);
    if (provider === 'openai' && !cfg[k].baseUrl) throw new Error(`config.${k} needs baseUrl (or "provider": "claude-code" or "codex")`);
  }
  const probes = cfg.probes ?? ALL_PROBES;
  for (const p of probes) if (!ALL_PROBES.includes(p)) throw new Error(`Unknown probe "${p}". Known: ${ALL_PROBES.join(', ')}`);
  return {
    game: cfg.game,
    player: cfg.player,
    judge: cfg.judge,
    turns: cfg.turns ?? 40,
    personas: cfg.personas,
    customPersonas: cfg.customPersonas ?? [],
    probes,
    audit: cfg.audit ?? 'every',
    setting: cfg.setting,
    concurrency: cfg.game.type === 'manual' ? 1 : cfg.concurrency ?? 3,
    seed: cfg.seed ?? Math.floor(Math.random() * 1e9),
    out: path.resolve(baseDir, cfg.out ?? 'runs'),
    playerContextTurns: cfg.playerContextTurns ?? 8,
    baseDir,
  };
}
