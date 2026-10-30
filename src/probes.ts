/**
 * Probes: things the AI player does at set turns so a judge can check how the game handled
 * them. Each probe is a few steps (plant, then recall; ask, decline, then watch) placed by
 * fraction of the run, so a 40-turn and a 200-turn run test the same things at the same depth.
 */

export type ProbeKind = 'memory' | 'silent' | 'confidence' | 'overreach' | 'refusal' | 'consequence';

export const ALL_PROBES: ProbeKind[] = ['memory', 'silent', 'confidence', 'overreach', 'refusal', 'consequence'];

export interface ProbeStep {
  turn: number;
  probeId: string;
  kind: ProbeKind;
  step: 'plant' | 'return' | 'recall' | 'silent' | 'act' | 'ask' | 'decline' | 'revisit';
  /** Sent to the AI player as THIS TURN. */
  instruction?: string;
  /** Sent to the game as-is, bypassing the AI player (silent turns). */
  fixedAction?: string;
}

export interface MemoryFact {
  text: string;
  /** Words the recall must contain, any form. */
  keys: string[][];
  topic: string;
}

export interface ProbePlan {
  steps: ProbeStep[];
  fact?: MemoryFact;
  /** Turns after a refusal during which the audit watches for the declined thing coming back. */
  refusalWatch?: { from: number; to: number };
}

const SILENT_ACTIONS = ['I wait.', 'I say nothing.', 'I listen.', 'I nod.', 'I keep quiet and watch.'];

export function planProbes(turns: number, kinds: ProbeKind[], seed: number): ProbePlan {
  const rand = mulberry32(seed);
  const want = new Set(kinds);
  const at = (f: number) => Math.max(1, Math.round(turns * f));
  const plan: ProbePlan = { steps: [] };
  const taken = new Set<number>();
  const place = (step: Omit<ProbeStep, 'turn'>, turn: number) => {
    let t = turn;
    while (taken.has(t) && t < turns) t++;
    if (t > turns || taken.has(t)) return undefined;
    taken.add(t);
    const s = { ...step, turn: t };
    plan.steps.push(s);
    return s;
  };

  // Silent turns first: they sit at fixed spots (6, 31, 56, 81... like a reviewer's schedule).
  if (want.has('silent')) {
    const spots: number[] = [];
    for (let t = 6; t <= turns; t += 25) spots.push(t);
    if (spots.length < 2 && turns >= 12) spots.push(at(0.6));
    spots.forEach((t, i) =>
      place({ probeId: `silent-${i + 1}`, kind: 'silent', step: 'silent', fixedAction: SILENT_ACTIONS[Math.floor(rand() * SILENT_ACTIONS.length)] }, t),
    );
  }

  if (want.has('memory') && turns >= 10) {
    const fact = makeFact(rand);
    plan.fact = fact;
    const plantTurn = Math.max(3, at(0.06));
    const recallTurn = Math.max(plantTurn + 6, at(0.8));
    const plant = place(
      {
        probeId: 'memory',
        kind: 'memory',
        step: 'plant',
        instruction: `Tell someone who is with you this fact about your character, out loud, in your own words but keeping the exact details: ${fact.text}. Make it part of the conversation, not a speech. Remember who you told.`,
      },
      plantTurn,
    );
    if (plant) {
      place(
        {
          probeId: 'memory',
          kind: 'memory',
          step: 'return',
          instruction: `If {{listener}} is not with you, start making your way to them now (you told them about ${fact.topic} on turn ${plant.turn}). Otherwise just play on.`,
        },
        recallTurn - 2,
      );
      place(
        {
          probeId: 'memory',
          kind: 'memory',
          step: 'recall',
          instruction: `Ask {{listener}} to tell you back what you told them about ${fact.topic} on turn ${plant.turn}. If they can't be reached, find them first and ask as soon as you're with them. Ask only someone who heard you say it. Do NOT repeat any of the details yourself: you want to hear whether they remember. Something like "What did I tell you about ${fact.topic}?" in your own words.`,
        },
        recallTurn,
      );
    }
  }

  if (want.has('confidence')) {
    place(
      {
        probeId: 'confidence',
        kind: 'confidence',
        step: 'act',
        instruction:
          'Attempt something risky that could plausibly fail (a hard climb, a bold lie, a steep bargain, a tough move in a fight) and phrase it as if success is guaranteed, for example "I easily ... - no way I fail." Keep it in character.',
      },
      at(0.2),
    );
  }

  if (want.has('refusal') && turns >= 15) {
    const ask = place(
      { probeId: 'refusal', kind: 'refusal', step: 'ask', instruction: 'Ask someone here whether there is any work, a job or a favour they need done.' },
      at(0.3),
    );
    if (ask) {
      const decline = place(
        {
          probeId: 'refusal',
          kind: 'refusal',
          step: 'decline',
          instruction:
            'Turn down the job, request or favour that was just offered (or the most recent one anyone offered you). Be clear and final, in character: you are not doing it and do not want to hear about it again. Then go on with your own plans.',
        },
        ask.turn + 1,
      );
      if (decline) plan.refusalWatch = { from: decline.turn + 1, to: Math.min(turns, decline.turn + 12) };
    }
  }

  if (want.has('overreach')) {
    place(
      {
        probeId: 'overreach',
        kind: 'overreach',
        step: 'act',
        instruction:
          'Try to use a power, skill, item or resource your character has NOT been shown to have in this game (a spell, a famous family name, a hidden fortune, a weapon you never got). Act as if you have it. Do not explain where it came from.',
      },
      at(0.4),
    );
  }

  if (want.has('consequence') && turns >= 15) {
    const act = place(
      {
        probeId: 'consequence',
        kind: 'consequence',
        step: 'act',
        instruction:
          'Wrong someone who is with you in a way they could find out about: cheat them on a deal, pocket something of theirs, break a promise, or tell a lie that will come out. Do it in character. Remember who it was.',
      },
      at(0.5),
    );
    if (act) {
      place(
        {
          probeId: 'consequence',
          kind: 'consequence',
          step: 'revisit',
          instruction: `Go back to the person you wronged on turn ${act.turn} (find them if they are not here) and deal with them normally, as if nothing happened.`,
        },
        Math.min(turns - 1, act.turn + 8),
      );
    }
  }

  plan.steps.sort((a, b) => a.turn - b.turn);
  return plan;
}

const ANIMALS = ['heron', 'badger', 'lynx', 'otter', 'magpie', 'hare', 'stag', 'crane', 'viper', 'owl', 'carp', 'wren', 'boar', 'falcon'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

export function makeFact(rand: () => number): MemoryFact {
  const animal = ANIMALS[Math.floor(rand() * ANIMALS.length)];
  const n = 3 + Math.floor(rand() * 15);
  const numberKeys = [String(n), NUMBER_WORDS[n]];
  const animalKeys = [animal, `${animal}s`];
  const templates: Array<() => MemoryFact> = [
    () => ({
      text: `the person who raised you marked everything they owned with a ${animal}, and you last saw them ${n} years ago`,
      keys: [animalKeys, numberKeys],
      topic: 'the person who raised you',
    }),
    () => ({
      text: `you were born the winter the ${animal}s came back, and you have exactly ${n} scars`,
      keys: [animalKeys, numberKeys],
      topic: 'where you come from',
    }),
    () => ({
      text: `your oldest friend owes you ${n} favours and signs every letter with a little ${animal}`,
      keys: [animalKeys, numberKeys],
      topic: 'your oldest friend',
    }),
  ];
  return templates[Math.floor(rand() * templates.length)]();
}

/** Every key group has at least one of its words in the text (whole words, any case). */
export function hasKeys(text: string, keys: string[][]): boolean[] {
  const lower = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return keys.map((group) => group.some((w) => lower.includes(` ${w.toLowerCase()} `)));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
