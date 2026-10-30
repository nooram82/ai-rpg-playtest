import { chatJson, type ChatModel } from './llm.js';
import type { Exchange } from './player.js';

/**
 * Judgments. Every verdict comes with quotes from the game's own text, and the harness checks
 * each quote really appears there (`verified`), so a reader can trust or overrule the judge in
 * seconds. Use a strong model for judging: small models make confident, wrong calls here.
 */

export interface Quote {
  turn: number;
  text: string;
  verified: boolean;
}

const JUDGE_SYSTEM = `You judge how an AI-run text RPG handled a player's turn. Be strict but fair, and literal: judge only what the text says. Quote the game's text exactly (copy-paste, short) as evidence. Reply with JSON only.`;

const PUPPETING_RULES = `PUPPETING is when the game takes control of the PLAYER'S character beyond what the player wrote:
- dialogue: words in quotes, or reported speech, said by the player's character that the player did not write
- action: the player's character doing something the player did not say (walking somewhere new, drawing a weapon, paying, agreeing, sleeping)
- emotion/thought: telling the player what their character feels, thinks, decides, wants or realises ("you feel a surge of anger", "you decide to trust her")
- pre-resolution: playing out several steps or a long stretch of time the player didn't choose, so the player had no chance to act in between
NOT puppeting: restating or describing the action the player did write; the immediate physical result of it; sensations from the world ("the cold bites", "you hear footsteps"); other characters acting and speaking; asking the player what they do.
Levels: "none"; "minor" (one small slip: a brief invented gesture, a mild assigned feeling or thought); "major" (invented dialogue, a decision or meaningful action made for the player, or a skipped stretch of play).
Decide the level last, from your quotes: only quote text that IS puppeting. If all you found restates or follows from what the player wrote, the level is "none" and quotes is empty.`;

export interface TurnAudit {
  puppeting: 'none' | 'minor' | 'major';
  puppetQuotes: Quote[];
  puppetNote: string;
  /** Set only while watching a refusal. */
  repushed?: boolean;
  repushQuotes?: Quote[];
}

export async function auditTurn(
  judge: ChatModel,
  args: { turn: number; previous: Exchange[]; action: string; reply: string; declined?: string },
): Promise<TurnAudit> {
  const prompt = `${PUPPETING_RULES}
${args.declined ? `\nREFUSAL WATCH: earlier the player clearly turned down this: "${args.declined}". Does THIS reply push it on them again (someone re-offers or presses it, or the story steers them back into it)? Merely mentioning it in passing, or a fair consequence of refusing, is not pushing.\n` : ''}
${args.previous.length ? `EARLIER (for context only):\n${args.previous.map((e) => `You: ${e.action}\nGame: ${clip(e.reply, 800)}`).join('\n\n')}\n` : ''}
THE PLAYER WROTE:
${args.action}

THE GAME REPLIED:
${args.reply}

Return {"puppeting": "none|minor|major", "quotes": ["exact puppeting text from the reply"], "note": "one sentence"${args.declined ? ', "repushed": true|false, "repush_quotes": ["exact text"]' : ''}}`;
  const out = await chatJson<{ puppeting?: string; quotes?: string[]; note?: string; repushed?: boolean; repush_quotes?: string[] }>(
    judge,
    [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: prompt },
    ],
    { temperature: 0 },
  );
  const level = out.puppeting === 'major' || out.puppeting === 'minor' ? out.puppeting : 'none';
  return {
    puppeting: level,
    puppetQuotes: level === 'none' ? [] : quotes(out.quotes, args.turn, args.reply),
    puppetNote: out.note ?? '',
    ...(args.declined ? { repushed: !!out.repushed, repushQuotes: out.repushed ? quotes(out.repush_quotes, args.turn, args.reply) : [] } : {}),
  };
}

export interface ProbeJudgment {
  verdict: string;
  quotes: Quote[];
  note: string;
}

async function judgeWith(judge: ChatModel, prompt: string, verdicts: string[], sources: Array<{ turn: number; text: string }>): Promise<ProbeJudgment> {
  const out = await chatJson<{ verdict?: string; quotes?: Array<{ turn?: number; text?: string } | string>; note?: string }>(
    judge,
    [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content: `${prompt}\n\nReturn {"verdict": "${verdicts.join('|')}", "quotes": [{"turn": <turn>, "text": "exact short quote from the game"}], "note": "one or two sentences"}`,
      },
    ],
    { temperature: 0 },
  );
  const verdict = verdicts.includes(String(out.verdict)) ? String(out.verdict) : 'unclear';
  const qs: Quote[] = [];
  for (const q of out.quotes ?? []) {
    const text = typeof q === 'string' ? q : q.text ?? '';
    if (!text.trim()) continue;
    const turn = typeof q === 'string' ? sources[sources.length - 1]?.turn ?? 0 : Number(q.turn ?? 0);
    const src = sources.find((s) => s.turn === turn) ?? sources.find((s) => contains(s.text, text));
    qs.push({ turn: src?.turn ?? turn, text, verified: !!src && contains(src.text, text) });
  }
  return { verdict, quotes: qs, note: out.note ?? '' };
}

/** Who heard the player say the fact, so the recall goes to someone who could know it. */
export async function extractListeners(judge: ChatModel, plant: Exchange): Promise<string> {
  const out = await chatJson<{ listeners?: string }>(
    judge,
    [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content: `On this turn the player told someone a fact about their past.

Player: ${plant.action}
Game: ${plant.reply}

Who heard it? Name the person they said it to first, then anyone else clearly present to hear it, as the player would refer to them ("Wick the apple seller, with Sal nearby"). If you can't tell, say "unclear".
Return {"listeners": "..."}`,
      },
    ],
    { temperature: 0 },
  );
  const l = out.listeners?.trim();
  return l && l.toLowerCase() !== 'unclear' ? l : '';
}

export function judgeMemory(
  judge: ChatModel,
  a: { fact: string; listeners: string; plant: Exchange; recall: Exchange; follow?: Exchange; keysFound: boolean[] },
): Promise<ProbeJudgment> {
  const turns = [a.recall, ...(a.follow ? [a.follow] : [])];
  return judgeWith(
    judge,
    `MEMORY PROBE. On turn ${a.plant.turn} the player told someone a fact. ${a.recall.turn - a.plant.turn} turns later they asked for it back.
The fact: ${a.fact}
Who heard it on turn ${a.plant.turn}: ${a.listeners || 'not recorded'}

TURN ${a.plant.turn} (planting)
Player: ${a.plant.action}
Game: ${clip(a.plant.reply, 1500)}

${turns.map((e) => `TURN ${e.turn}\nPlayer: ${e.action}\nGame: ${e.reply}`).join('\n\n')}

A word search of the recall reply found: ${a.keysFound.map((f, i) => `detail ${i + 1} ${f ? 'present' : 'absent'}`).join(', ')}.
Verdicts:
- "recalled": the game gave back the fact's specific details correctly (both the creature and the number)
- "partial": some details right, some missing or vague, nothing contradicted
- "wrong": the game stated different details (invented a different creature or number)
- "not_recalled": the game dodged, said it didn't know, or answered generally without the details
- "not_asked": the player never actually asked for the fact back
- "asked_wrong_person": the player asked someone who could not have heard it, and the game fairly said they didn't know (that is consistency, not forgetting)`,
    ['recalled', 'partial', 'wrong', 'not_recalled', 'not_asked', 'asked_wrong_person'],
    turns.map((e) => ({ turn: e.turn, text: e.reply })),
  );
}

export function judgeConfidence(judge: ChatModel, a: { act: Exchange; next?: Exchange }): Promise<ProbeJudgment> {
  const turns = [a.act, ...(a.next ? [a.next] : [])];
  return judgeWith(
    judge,
    `FAIRNESS PROBE. The player attempted something risky and phrased it as if success were certain. A fair game does not let confident wording decide the outcome: the result should depend on the situation, the character, or a roll, and could go badly.

${turns.map((e) => `TURN ${e.turn}\nPlayer: ${e.action}\nGame: ${e.reply}`).join('\n\n')}

Verdicts:
- "auto_success": it simply worked as the player declared, with no real risk, cost, check or roll shown
- "uncertain": the game treated it as uncertain (a roll, a check, a partial success, a cost, or the outcome left open)
- "failed": it failed or went badly
- "unclear": the player didn't actually attempt something risky, or the reply doesn't resolve it`,
    ['auto_success', 'uncertain', 'failed', 'unclear'],
    turns.map((e) => ({ turn: e.turn, text: e.reply })),
  );
}

export function judgeOverreach(judge: ChatModel, a: { act: Exchange; next?: Exchange; earlier: string }): Promise<ProbeJudgment> {
  const turns = [a.act, ...(a.next ? [a.next] : [])];
  return judgeWith(
    judge,
    `RULES PROBE. The player tried to use a power, skill, item or resource their character may not have. A game with real rules stops or questions abilities that were never established.

WHAT THE GAME HAD ESTABLISHED ABOUT THE CHARACTER BEFORE THIS (opening and early turns, may be incomplete):
${clip(a.earlier, 4000)}

${turns.map((e) => `TURN ${e.turn}\nPlayer: ${e.action}\nGame: ${e.reply}`).join('\n\n')}

Verdicts:
- "allowed": the game let it work as if the character had it, though nothing above established it
- "questioned": the game made it uncertain, costly or partial, or had someone doubt it, without simply granting it
- "refused": the game made clear the character can't do this or doesn't have it
- "already_had": the character really did have this, from the established text
- "unclear": can't tell`,
    ['allowed', 'questioned', 'refused', 'already_had', 'unclear'],
    turns.map((e) => ({ turn: e.turn, text: e.reply })),
  );
}

export async function extractDeclined(judge: ChatModel, a: { ask: Exchange; decline: Exchange }): Promise<{ declined: string; respected: boolean }> {
  const out = await chatJson<{ declined?: string; respected?: boolean }>(
    judge,
    [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content: `The player asked about work and then turned an offer down.

TURN ${a.ask.turn}
Player: ${a.ask.action}
Game: ${a.ask.reply}

TURN ${a.decline.turn}
Player: ${a.decline.action}
Game: ${a.decline.reply}

What did the player turn down, in a short phrase? Did the game accept the refusal on this turn (it may react, but doesn't force the job on them)?
Return {"declined": "short phrase", "respected": true|false}`,
      },
    ],
    { temperature: 0 },
  );
  return { declined: out.declined?.trim() || 'the job they were offered', respected: out.respected !== false };
}

export function judgeConsequence(judge: ChatModel, a: { act: Exchange; revisit: Exchange; follow?: Exchange }): Promise<ProbeJudgment> {
  const turns = [a.revisit, ...(a.follow ? [a.follow] : [])];
  return judgeWith(
    judge,
    `CONSEQUENCE PROBE. On turn ${a.act.turn} the player wronged someone (cheated, stole, broke a promise or lied). On turn ${a.revisit.turn} they went back to deal with that person as if nothing happened. A living world remembers.

TURN ${a.act.turn} (the wrong)
Player: ${a.act.action}
Game: ${clip(a.act.reply, 1500)}

${turns.map((e) => `TURN ${e.turn}\nPlayer: ${e.action}\nGame: ${e.reply}`).join('\n\n')}

Verdicts:
- "remembered": the wronged person (or people around them) reacted in a way that shows the wrong is known or suspected, or it had a visible consequence
- "no_reaction": they met and dealt with each other as if it never happened
- "not_caught": the wrong plausibly went unnoticed in the story so far, and the game kept that consistent
- "not_met": the player never got back to that person`,
    ['remembered', 'no_reaction', 'not_caught', 'not_met'],
    turns.map((e) => ({ turn: e.turn, text: e.reply })),
  );
}

/**
 * Sort repeated phrases into stock phrasing (a tic: the same description, gesture or line again)
 * and story references (a place, object or plan that keeps coming up because it matters).
 */
export async function classifyRepeats(
  judge: ChatModel,
  items: Array<{ phrase: string; count: number; example: string }>,
): Promise<Map<string, 'tic' | 'story'>> {
  const out = new Map<string, 'tic' | 'story'>();
  if (!items.length) return out;
  const res = await chatJson<{ tics?: string[] }>(
    judge,
    [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content: `These phrases each appeared in several separate replies from an AI storyteller. Which are STOCK PHRASING: the same description, gesture, image, transition or line of dialogue reused (e.g. "the air hangs heavy", "he jerks his chin at", "only time will tell")? The rest are STORY REFERENCES: a place, object, person, deal or deadline that keeps coming up because it is part of the story (e.g. "the toll post", "the eight baskets").

${items.map((i, n) => `${n + 1}. "${i.phrase}" (${i.count} replies), e.g.: ${i.example}`).join('\n')}

Return {"tics": ["exact phrase", ...]} listing only the stock phrasing.`,
      },
    ],
    { temperature: 0 },
  );
  const tics = new Set((res.tics ?? []).map((t) => String(t).toLowerCase().trim()));
  for (const i of items) out.set(i.phrase, tics.has(i.phrase) ? 'tic' : 'story');
  return out;
}

function quotes(list: unknown, turn: number, source: string): Quote[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    .slice(0, 4)
    .map((text) => ({ turn, text, verified: contains(source, text) }));
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_]/g, '')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
}

/** The quote appears in the source, ignoring case, punctuation and markdown. Long quotes may be trimmed with "...". */
export function contains(source: string, quote: string): boolean {
  const src = normalize(source);
  const pieces = quote.split(/\.\.\.|…/).map(normalize).filter((p) => p.length > 0);
  return pieces.length > 0 && pieces.every((p) => src.includes(p));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
