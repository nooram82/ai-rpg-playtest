import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GameFactory } from './types.js';

/**
 * Your own JavaScript module, for games you can call in-process or need custom glue for
 * (sign-in, streaming, websockets). It exports `createGame(options, ctx)` (or a default export
 * of the same shape) that returns a GameSession. See examples/module-game.mjs.
 */
export interface ModuleGameConfig {
  type: 'module';
  path: string;
  /** Passed to createGame as its first argument. */
  options?: Record<string, unknown>;
}

export async function moduleGame(cfg: ModuleGameConfig, baseDir: string): Promise<GameFactory> {
  const full = path.isAbsolute(cfg.path) ? cfg.path : path.join(baseDir, cfg.path);
  const mod = await import(pathToFileURL(full).href);
  const create = mod.createGame ?? mod.default;
  if (typeof create !== 'function') throw new Error(`${cfg.path} must export createGame(options, ctx)`);
  return (ctx) => Promise.resolve(create(cfg.options ?? {}, ctx));
}
