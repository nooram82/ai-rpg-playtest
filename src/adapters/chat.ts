import fs from 'node:fs';
import path from 'node:path';
import { makeModel, type ChatMessage, type ModelConfig } from '../llm.js';
import type { GameFactory } from './types.js';

/**
 * The game is a system prompt on a chat model. For prompt-only games and character cards, and
 * as a baseline: run your engine and a bare prompt through the same probes and compare.
 */
export interface ChatGameConfig {
  type: 'chat';
  model: ModelConfig;
  systemPrompt?: string;
  systemPromptFile?: string;
  /** Sent as the first user message to get an opening scene. Default: no opening, the player starts. */
  opening?: string;
  /** Keep only this many recent messages (plus the system prompt). Default: everything. */
  maxHistoryMessages?: number;
}

export function chatGame(cfg: ChatGameConfig, baseDir: string): GameFactory {
  const system = cfg.systemPrompt ?? (cfg.systemPromptFile ? fs.readFileSync(path.resolve(baseDir, cfg.systemPromptFile), 'utf8') : undefined);
  if (!system) throw new Error('chat game needs systemPrompt or systemPromptFile');
  return async (ctx) => {
    const model = makeModel(cfg.model);
    const history: ChatMessage[] = [];
    const send = async (text: string) => {
      history.push({ role: 'user', content: text });
      const recent = cfg.maxHistoryMessages ? history.slice(-cfg.maxHistoryMessages) : history;
      const reply = await model.chat([{ role: 'system', content: system.replaceAll('{{character}}', ctx.character) }, ...recent]);
      history.push({ role: 'assistant', content: reply });
      return reply;
    };
    return {
      start: async () => (cfg.opening ? send(cfg.opening) : ''),
      act: send,
    };
  };
}

