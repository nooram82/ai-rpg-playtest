import fs from 'node:fs';
import path from 'node:path';
import type { GameFactory } from './adapters/index.js';
import type { LoadedConfig } from './config.js';
import {
  auditTurn,
  classifyRepeats,
  extractDeclined,
  extractListeners,
  judgeConfidence,
  judgeConsequence,
  judgeMemory,
  judgeOverreach,
  type ProbeJudgment,
  type Quote,
  type TurnAudit,
} from './judge.js';
import { type ChatModel } from './llm.js';
import type { Persona } from './personas.js';
import { playerSystemPrompt, playerTurn, type Exchange } from './player.js';
import { repeatedPhrases, type RepeatedPhrase } from './scan.js';
import { hasKeys, planProbes, type MemoryFact, type ProbeKind, type ProbePlan, type ProbeStep } from './probes.js';

export interface TurnRecord extends Exchange {
  latencyMs: number;
  probe?: { id: string; kind: ProbeKind; step: ProbeStep['step'] };
  audit?: TurnAudit;
  notes: string;
}

export type ProbeStatus = 'pass' | 'partial' | 'fail' | 'inconclusive';

export interface ProbeResult {
  id: string;
  kind: ProbeKind;
  status: ProbeStatus;
  verdict: string;
  turns: number[];
  quotes: Quote[];
  note: string;
}

export interface PersonaRun {
  persona: Persona;
  sessionId: string;
  dir: string;
  opening: string;
  records: TurnRecord[];
  plan: ProbePlan;
  probes: ProbeResult[];
  declined?: string;
  /** Who heard the memory probe's fact. */
  listeners?: string;
  /** Phrases reused across replies, sorted by the judge into tics and story references. */
  repeats?: Array<RepeatedPhrase & { kind: 'tic' | 'story' }>;
  error?: string;
}

export interface Models {
  player: ChatModel;
  judge: ChatModel;
}

type Log = (msg: string) => void;

/** Set `stopped` to finish the turn in flight, then judge and report what was played. */
export interface StopSignal {
  stopped: boolean;
}

/** What the run learned along the way, saved so `report` can judge a stopped run later. */
interface PersonaState {
  opening: string;
  listeners?: string;
  declined?: string;
  error?: string;
}

function saveState(run: PersonaRun) {
  const state: PersonaState = { opening: run.opening, listeners: run.listeners, declined: run.declined, error: run.error };
  fs.writeFileSync(path.join(run.dir, 'state.json'), JSON.stringify(state, null, 2));
}

export async function runPersona(
  cfg: LoadedConfig,
  persona: Persona,
  factory: GameFactory,
  models: Models,
  runDir: string,
  log: Log,
  stop: StopSignal = { stopped: false },
): Promise<PersonaRun> {
  const sessionId = `${path.basename(runDir)}-${persona.id}`;
  const dir = path.join(runDir, persona.id);
  fs.mkdirSync(dir, { recursive: true });
  const plan = planProbes(cfg.turns, cfg.probes, cfg.seed + hash(persona.id));
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  const run: PersonaRun = { persona, sessionId, dir, opening: '', records: [], plan, probes: [] };
  const jsonl = path.join(dir, 'turns.jsonl');
  fs.writeFileSync(jsonl, '');

  const game = await factory({ sessionId, personaId: persona.id, character: `${persona.character} ${persona.drive}` });
  const system = playerSystemPrompt(persona, cfg.setting);
  let notes = '';
  try {
    run.opening = await game.start();
    saveState(run);
    const wrong = plan.steps.find((s) => s.probeId === 'consequence' && s.step === 'act');
    const revisit = plan.steps.find((s) => s.probeId === 'consequence' && s.step === 'revisit');
    for (let turn = 1; turn <= cfg.turns; turn++) {
      if (stop.stopped) {
        run.error = 'stopped by you';
        break;
      }
      const step = plan.steps.find((s) => s.turn === turn);
      const watching = run.declined && plan.refusalWatch && turn >= plan.refusalWatch.from && turn <= plan.refusalWatch.to;
      const constraints = watching ? [`On turn ${plan.refusalWatch!.from - 1} you turned down ${run.declined}. Stick to that refusal.`] : [];
      // The consequence probe only works if the wrong is still standing when the player goes back.
      if (wrong && revisit && turn > wrong.turn && turn <= revisit.turn + 1) {
        constraints.push(`On turn ${wrong.turn} you wronged someone (it's in your notes). Let it stand: don't confess, apologise or put it right unless they find out on their own.`);
      }

      let action: string;
      if (step?.fixedAction) {
        action = step.fixedAction;
      } else {
        const input = {
          turn,
          totalTurns: cfg.turns,
          opening: run.opening,
          recent: run.records.slice(-cfg.playerContextTurns),
          notes,
          instruction: step?.instruction?.replaceAll('{{listener}}', run.listeners || 'the person you told'),
          constraints,
        };
        let out = await playerTurn(models.player, system, input);
        // The memory plant only counts if both details were actually said.
        if (step?.step === 'plant' && plan.fact && hasKeys(out.action, plan.fact.keys).includes(false)) {
          out = await playerTurn(models.player, system, {
            ...input,
            instruction: `${step.instruction}\nYour line MUST contain both exact details: ${plan.fact.text}.`,
          });
        }
        action = out.action;
        notes = out.notes;
      }

      // No retry: a turn that failed halfway may still have happened in the game.
      const started = Date.now();
      const reply = await game.act(action);
      const record: TurnRecord = {
        turn,
        action,
        reply,
        latencyMs: Date.now() - started,
        notes,
        ...(step ? { probe: { id: step.probeId, kind: step.kind, step: step.step } } : {}),
      };

      if (cfg.audit === 'every' || step || watching) {
        record.audit = await auditTurn(models.judge, {
          turn,
          previous: run.records.slice(-2),
          action,
          reply,
          declined: watching ? run.declined : undefined,
        });
      }
      run.records.push(record);
      fs.appendFileSync(jsonl, JSON.stringify(record) + '\n');

      if (step?.step === 'plant') run.listeners = await extractListeners(models.judge, record);
      if (step?.step === 'decline') {
        const ask = run.records.find((r) => r.probe?.id === 'refusal' && r.probe.step === 'ask');
        if (ask) run.declined = (await extractDeclined(models.judge, { ask, decline: record })).declined;
      }
      if (step?.step === 'plant' || step?.step === 'decline') saveState(run);
      const flag = record.audit && record.audit.puppeting !== 'none' ? ` puppeting:${record.audit.puppeting}` : '';
      log(`[${persona.id}] turn ${turn}/${cfg.turns}${step ? ` (${step.probeId} ${step.step})` : ''} ${(record.latencyMs / 1000).toFixed(1)}s${flag}`);
    }
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
    log(`[${persona.id}] stopped at turn ${run.records.length + 1}: ${run.error}`);
  } finally {
    await game.close?.().catch(() => {});
  }
  saveState(run);
  return judgeRun(run, models.judge);
}

/** The end-of-run judging: probe verdicts and the repetition sort. */
export async function judgeRun(run: PersonaRun, judge: ChatModel): Promise<PersonaRun> {
  run.probes = await evaluateProbes(run, judge, run.plan.fact);
  run.repeats = await sortRepeats(run.records, judge).catch(() => undefined);
  fs.writeFileSync(path.join(run.dir, 'probes.json'), JSON.stringify(run.probes, null, 2));
  return run;
}

/** Rebuild a persona's run from its folder, for `report` on a run that was stopped or crashed. */
export function loadPersonaRun(dir: string, persona: Persona, runDir: string, turns: number): PersonaRun {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')) as ProbePlan;
  const records = fs
    .readFileSync(path.join(dir, 'turns.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TurnRecord);
  const statePath = path.join(dir, 'state.json');
  const state: PersonaState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { opening: '' };
  const played = records.length;
  return {
    persona,
    sessionId: `${path.basename(runDir)}-${persona.id}`,
    dir,
    opening: state.opening,
    records,
    plan,
    probes: [],
    listeners: state.listeners,
    declined: state.declined,
    error: state.error ?? (played < turns ? `stopped after ${played} turns` : undefined),
  };
}

export async function evaluateProbes(run: PersonaRun, judge: ChatModel, fact?: MemoryFact): Promise<ProbeResult[]> {
  const at = (turn: number) => run.records.find((r) => r.turn === turn);
  const stepOf = (id: string, step: string) => run.records.find((r) => r.probe?.id === id && r.probe.step === step);
  const results: ProbeResult[] = [];
  const done = (id: string, kind: ProbeKind, j: ProbeJudgment, turns: number[], status: ProbeStatus) =>
    results.push({ id, kind, status, verdict: j.verdict, turns, quotes: j.quotes, note: j.note });

  for (const r of run.records.filter((x) => x.probe?.kind === 'silent')) {
    const a = r.audit;
    if (!a) continue;
    const status: ProbeStatus = a.puppeting === 'none' ? 'pass' : a.puppeting === 'minor' ? 'partial' : 'fail';
    results.push({ id: r.probe!.id, kind: 'silent', status, verdict: a.puppeting, turns: [r.turn], quotes: a.puppetQuotes, note: `Player: "${r.action}". ${a.puppetNote}` });
  }

  const plant = stepOf('memory', 'plant');
  const recall = stepOf('memory', 'recall');
  if (fact && plant && recall) {
    const follow = at(recall.turn + 1);
    const keysFound = hasKeys(recall.reply + (follow ? ` ${follow.reply}` : ''), fact.keys);
    const j = await judgeMemory(judge, { fact: fact.text, listeners: run.listeners ?? '', plant, recall, follow, keysFound });
    const status: ProbeStatus =
      j.verdict === 'recalled' ? 'pass' : j.verdict === 'partial' ? 'partial' : j.verdict === 'wrong' || j.verdict === 'not_recalled' ? 'fail' : 'inconclusive';
    const heard = run.listeners ? ` Told to: ${run.listeners.replace(/[.\s]+$/, '')}.` : '';
    done('memory', 'memory', { ...j, note: `${recall.turn - plant.turn} turns later. Fact: ${fact.text}.${heard} ${j.note}` }, [plant.turn, recall.turn], status);
  }

  const conf = stepOf('confidence', 'act');
  if (conf) {
    const j = await judgeConfidence(judge, { act: conf, next: at(conf.turn + 1) });
    const status: ProbeStatus = j.verdict === 'auto_success' ? 'fail' : j.verdict === 'unclear' ? 'inconclusive' : 'pass';
    done('confidence', 'confidence', j, [conf.turn], status);
  }

  const over = stepOf('overreach', 'act');
  if (over) {
    const before = run.records.filter((r) => r.turn < over.turn);
    const earlier = [run.opening, ...before.slice(0, 3).map((r) => r.reply), ...before.slice(-3).map((r) => r.reply)].filter(Boolean).join('\n---\n');
    const j = await judgeOverreach(judge, { act: over, next: at(over.turn + 1), earlier });
    const status: ProbeStatus = j.verdict === 'allowed' ? 'fail' : j.verdict === 'questioned' || j.verdict === 'refused' ? 'pass' : 'inconclusive';
    done('overreach', 'overreach', j, [over.turn], status);
  }

  const decline = stepOf('refusal', 'decline');
  if (decline && run.declined) {
    const watched = run.records.filter((r) => r.audit?.repushed !== undefined);
    const pushes = watched.filter((r) => r.audit!.repushed);
    const status: ProbeStatus = watched.length === 0 ? 'inconclusive' : pushes.length === 0 ? 'pass' : pushes.length === 1 ? 'partial' : 'fail';
    results.push({
      id: 'refusal',
      kind: 'refusal',
      status,
      verdict: `${pushes.length} of ${watched.length} later turns pushed it again`,
      turns: [decline.turn, ...pushes.map((p) => p.turn)],
      quotes: pushes.flatMap((p) => p.audit!.repushQuotes ?? []),
      note: `Declined on turn ${decline.turn}: ${run.declined}.`,
    });
  }

  const wrong = stepOf('consequence', 'act');
  const revisit = stepOf('consequence', 'revisit');
  if (wrong && revisit) {
    const j = await judgeConsequence(judge, { act: wrong, revisit, follow: at(revisit.turn + 1) });
    const status: ProbeStatus = j.verdict === 'remembered' ? 'pass' : j.verdict === 'no_reaction' ? 'fail' : 'inconclusive';
    done('consequence', 'consequence', j, [wrong.turn, revisit.turn], status);
  }

  return results;
}

async function sortRepeats(records: TurnRecord[], judge: ChatModel) {
  const found = repeatedPhrases(records.map((r) => r.reply), { minCount: 3, max: 25, labels: records.map((r) => r.turn) });
  const example = (p: RepeatedPhrase) => {
    const reply = records.find((r) => r.turn === p.where[0])?.reply ?? '';
    const norm = (x: string) => ` ${x.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ')} `;
    const sentence = reply.split(/(?<=[.!?])\s+/).find((x) => norm(x).includes(` ${p.phrase} `));
    return (sentence ?? reply).replace(/\s+/g, ' ').slice(0, 200);
  };
  const kinds = await classifyRepeats(judge, found.map((p) => ({ phrase: p.phrase, count: p.count, example: example(p) })));
  return found.map((p) => ({ ...p, kind: kinds.get(p.phrase) ?? 'story' }));
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}
