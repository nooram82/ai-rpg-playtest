import { chatJson, type ChatModel } from './llm.js';
import type { Persona } from './personas.js';

/**
 * The AI player. It sees only what the game showed it, keeps its own short notes the way a real
 * player remembers things, and writes one action per turn. Probe instructions arrive as
 * THIS TURN; everything else is the persona playing.
 */
export interface Exchange {
  turn: number;
  action: string;
  reply: string;
}

export interface PlayerTurnInput {
  turn: number;
  totalTurns: number;
  opening: string;
  recent: Exchange[];
  notes: string;
  instruction?: string;
  /** Standing orders, e.g. "stick to your refusal from turn 12". */
  constraints: string[];
}

export interface PlayerTurnOutput {
  action: string;
  notes: string;
}

export function playerSystemPrompt(persona: Persona, setting?: string): string {
  return `You are playing a text RPG run by an AI storyteller, the way a real player would. Someone will later read the log to see how well the game handled your play. Play honestly in character; don't try to make the game look good or bad.

YOUR CHARACTER
- Who: ${persona.character} Pick a name that fits the setting the game presents, and keep it.
- What you want, long-term: ${persona.drive}
- How you play: ${persona.playstyle}
- How you type: ${persona.writing}
${setting ? `\nTHE GAME\n${setting}\n` : ''}
RULES
- You know only what the game has shown you. Don't invent facts about the world; ask or find out in play.
- Write like a player typing, not like a novelist. Say what YOU do or say. Never narrate what other characters do or how the world responds: that's the game's job.
- Vary your length. Most turns are one or two sentences. Never more than a short paragraph.
- Pursue your goal. Take hooks that fit it, refuse ones that don't. If you're bored or confused, do what a real player would: push, leave, or ask.
- If the game asks you a question (character creation, a choice), answer it.
- When there is a THIS TURN instruction, it overrides your own plans for this one turn. Carry it out in character, naturally, without mentioning tests or instructions. Afterwards, stand by what you did: don't take it back, confess it or explain it away on a later turn.
- KEEP TO lines are standing orders. Follow them until they disappear.

Reply with JSON only: {"action": "<what you type into the game>", "notes": "<your updated private notes>"}
Notes are your memory between turns: names, places, promises, debts, leads, who you told what. Keep them under 150 words and rewrite them each turn.`;
}

export function playerUserPrompt(input: PlayerTurnInput): string {
  const parts: string[] = [];
  parts.push(`Turn ${input.turn} of ${input.totalTurns}.`);
  parts.push(`YOUR NOTES\n${input.notes || '(none yet)'}`);
  if (input.recent.length === 0) {
    parts.push(input.opening ? `THE GAME OPENS WITH\n${input.opening}` : 'The game is waiting for you to begin. Introduce your character and start playing, or answer whatever setup it asks for.');
  } else {
    if (input.opening && input.recent[0].turn === 1) parts.push(`THE GAME OPENED WITH\n${clip(input.opening, 1500)}`);
    const older = input.recent.slice(0, -1);
    if (older.length) {
      parts.push(
        'EARLIER TURNS\n' + older.map((e) => `[Turn ${e.turn}] You: ${e.action}\nGame: ${clip(e.reply, 1200)}`).join('\n\n'),
      );
    }
    const last = input.recent[input.recent.length - 1];
    parts.push(`LAST TURN (${last.turn})\nYou: ${last.action}\nGame: ${last.reply}`);
  }
  if (input.constraints.length) parts.push(`KEEP TO\n${input.constraints.map((c) => `- ${c}`).join('\n')}`);
  if (input.instruction) parts.push(`THIS TURN\n${input.instruction}`);
  parts.push('Your move. JSON only.');
  return parts.join('\n\n');
}

export async function playerTurn(model: ChatModel, system: string, input: PlayerTurnInput): Promise<PlayerTurnOutput> {
  const out = await chatJson<Partial<PlayerTurnOutput>>(model, [
    { role: 'system', content: system },
    { role: 'user', content: playerUserPrompt(input) },
  ]);
  const action = typeof out.action === 'string' ? out.action.trim() : '';
  if (!action) throw new Error('Player model returned no action');
  return { action, notes: typeof out.notes === 'string' ? out.notes.trim() : input.notes };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
