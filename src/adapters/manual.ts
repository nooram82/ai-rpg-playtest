import readline from 'node:readline';
import type { GameFactory } from './types.js';

/**
 * You are the wire. The harness prints the AI player's action; you type it into the game,
 * then paste what the game showed and end with a line holding only a period. Works for any
 * game with a screen, including ones you don't own. Run one persona at a time.
 */
export interface ManualGameConfig {
  type: 'manual';
}

export function manualGame(): GameFactory {
  return async (ctx) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    const readReply = async (): Promise<string> => {
      const out: string[] = [];
      for (;;) {
        const next = await lines.next();
        if (next.done || next.value.trim() === '.') break;
        out.push(next.value);
      }
      return out.join('\n').trim();
    };
    return {
      start: async () => {
        process.stderr.write(`\n[${ctx.personaId}] Start a new game for: ${ctx.character}\nPaste the opening (or nothing), then a line with only "." :\n`);
        return readReply();
      },
      act: async (action) => {
        process.stderr.write(`\n[${ctx.personaId}] TYPE THIS INTO THE GAME:\n\n${action}\n\nPaste the game's reply, then a line with only "." :\n`);
        return readReply();
      },
      close: async () => rl.close(),
    };
  };
}
