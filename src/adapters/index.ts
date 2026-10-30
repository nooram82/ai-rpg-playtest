import { chatGame, type ChatGameConfig } from './chat.js';
import { commandGame, type CommandGameConfig } from './command.js';
import { httpGame, type HttpGameConfig } from './http.js';
import { manualGame, type ManualGameConfig } from './manual.js';
import { moduleGame, type ModuleGameConfig } from './module.js';
import type { GameFactory } from './types.js';

export type GameConfig = ChatGameConfig | HttpGameConfig | CommandGameConfig | ModuleGameConfig | ManualGameConfig;
export type { GameFactory, GameSession, SessionContext } from './types.js';

export async function makeGame(cfg: GameConfig, baseDir: string): Promise<GameFactory> {
  switch (cfg.type) {
    case 'chat':
      return chatGame(cfg, baseDir);
    case 'http':
      return httpGame(cfg);
    case 'command':
      return commandGame(cfg, baseDir);
    case 'module':
      return moduleGame(cfg, baseDir);
    case 'manual':
      return manualGame();
    default:
      throw new Error(`Unknown game type: ${(cfg as { type: string }).type}`);
  }
}
