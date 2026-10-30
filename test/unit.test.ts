import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extract, fill, pick } from '../src/adapters/http.js';
import { loadConfig, type LoadedConfig } from '../src/config.js';
import { contains } from '../src/judge.js';
import { parseJsonLoose, type ChatMessage, type ChatModel } from '../src/llm.js';
import { BUILTIN_PERSONAS } from '../src/personas.js';
import { ALL_PROBES, hasKeys, makeFact, mulberry32, planProbes } from '../src/probes.js';
import { writePersonaReport, writeSummary } from '../src/report.js';
import { judgeRun, loadPersonaRun, runPersona } from '../src/runner.js';
import { repeatedPhrases, stockEdges } from '../src/scan.js';

test('probe plan: every probe placed once per turn, recall well after plant', () => {
  for (const turns of [20, 40, 100, 200]) {
    const plan = planProbes(turns, ALL_PROBES, 7);
    const used = plan.steps.map((s) => s.turn);
    assert.equal(new Set(used).size, used.length, `no two steps share a turn (${turns})`);
    assert.ok(used.every((t) => t >= 1 && t <= turns));
    for (const kind of ALL_PROBES) assert.ok(plan.steps.some((s) => s.kind === kind), `${kind} placed at ${turns} turns`);
    const plant = plan.steps.find((s) => s.step === 'plant')!;
    const recall = plan.steps.find((s) => s.step === 'recall')!;
    assert.ok(recall.turn - plant.turn >= Math.min(6, turns * 0.5));
    const decline = plan.steps.find((s) => s.step === 'decline')!;
    assert.equal(plan.refusalWatch!.from, decline.turn + 1);
  }
  assert.equal(planProbes(100, ALL_PROBES, 1).steps.filter((s) => s.kind === 'silent').length, 4);
});

test('probe plan: short runs drop what cannot fit', () => {
  const plan = planProbes(8, ALL_PROBES, 3);
  assert.ok(!plan.steps.some((s) => s.kind === 'memory'));
  assert.ok(!plan.steps.some((s) => s.kind === 'consequence'));
});

test('memory fact: its own text satisfies its keys, digits or words', () => {
  const rand = mulberry32(42);
  for (let i = 0; i < 20; i++) {
    const f = makeFact(rand);
    assert.deepEqual(hasKeys(f.text, f.keys), [true, true], f.text);
  }
  assert.deepEqual(hasKeys('She signed with an owl, I think, twelve times', [['owl', 'owls'], ['12', 'twelve']]), [true, true]);
  assert.deepEqual(hasKeys('a bowl of stew', [['owl', 'owls'], ['12', 'twelve']]), [false, false]);
});

test('quote check ignores case, punctuation, markdown and ellipses', () => {
  const src = 'The guard sighs. *"You again,"* he says, and you feel a surge of shame.';
  assert.ok(contains(src, 'you feel a surge of shame'));
  assert.ok(contains(src, '"You again," he says'));
  assert.ok(contains(src, 'The guard sighs... surge of shame'));
  assert.ok(!contains(src, 'you decide to leave'));
});

test('lenient JSON parsing', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! {"a": "b"} hope that helps'), { a: 'b' });
  assert.equal(parseJsonLoose('no json here'), undefined);
});

test('http adapter templates and reply paths', () => {
  const vars = { action: 'I wait.', sessionId: 's1', session: 'g9', character: 'a trader' };
  assert.equal(fill('/turn/{{session}}?who={{sessionId}}', vars), '/turn/g9?who=s1');
  process.env.PT_TEST_TOKEN = 'tok';
  assert.equal(fill('Bearer {{env.PT_TEST_TOKEN}}', vars), 'Bearer tok');
  const body = { events: [{ kind: 'narration', text: 'Rain.' }, { kind: 'npc', text: '"Hm."' }], last: { a: [1, 2, 3] } };
  assert.deepEqual(pick(body, 'events[*].text'), ['Rain.', '"Hm."']);
  assert.equal(pick(body, 'last.a[-1]'), 3);
  assert.equal(extract(JSON.stringify(body), 'events[*].text'), 'Rain.\n\n"Hm."');
  assert.equal(extract('  plain text  ', '$text'), 'plain text');
});

test('repetition scan finds tics across replies, not filler', () => {
  const replies = [
    'The air hangs heavy with smoke. Brann wipes the bar.',
    'Brann laughs. "First things first," he says. The air hangs heavy as ever.',
    'You step out into the square. The air hangs heavy over the stalls.',
    '"First things first," Brann says again, in the square.',
    'In the square a crier shouts. "First things first."',
  ];
  const found = repeatedPhrases(replies, { minCount: 3 });
  const phrases = found.map((f) => f.phrase);
  assert.ok(phrases.includes('the air hangs heavy') || phrases.includes('air hangs heavy'), phrases.join(' | '));
  assert.ok(phrases.includes('first things first'));
  assert.ok(!phrases.includes('in the square'));
  const named = repeatedPhrases(
    ['They meet at the Dappled Ox at dusk.', 'Back at the Dappled Ox, ale.', 'You leave the Dappled Ox behind.'],
    { minCount: 3 },
  );
  assert.equal(named.length, 0, 'place names are not tics');
  const edges = stockEdges(['The rain falls hard on you.', 'The rain falls hard again.', 'Nothing.']);
  assert.equal(edges.openers[0].phrase, 'the rain falls hard');
});

/** A scripted model: answers by looking at what kind of prompt it got. */
class FakeModel implements ChatModel {
  calls: ChatMessage[][] = [];
  constructor(private answer: (prompt: string, system: string) => unknown) {}
  async chat(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages);
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages[messages.length - 1].content;
    return JSON.stringify(this.answer(user, system));
  }
}

test('a full run with a scripted game and models writes reports and judges every probe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-playtest-'));
  let factText = '';
  const player = new FakeModel((prompt) => {
    const m = prompt.match(/keeping the exact details: (.*?)\. Make it/);
    if (m) factText = m[1];
    if (m) return { action: `"Since you ask: ${factText}."`, notes: 'told Brann the fact' };
    if (/What did I tell you|tell you back/.test(prompt)) return { action: 'Brann, what did I tell you about that?', notes: 'asked' };
    return { action: 'I look around the market.', notes: 'playing' };
  });
  const judge = new FakeModel((prompt) => {
    if (prompt.startsWith('MEMORY PROBE')) return { verdict: 'recalled', quotes: [{ turn: 32, text: 'you said it' }], note: 'ok' };
    if (prompt.startsWith('FAIRNESS PROBE')) return { verdict: 'auto_success', quotes: [], note: 'it just worked' };
    if (prompt.startsWith('RULES PROBE')) return { verdict: 'questioned', quotes: [], note: '' };
    if (prompt.startsWith('CONSEQUENCE PROBE')) return { verdict: 'no_reaction', quotes: [], note: '' };
    if (prompt.includes('Who heard it?')) return { listeners: 'Brann the trader' };
    if (prompt.includes('What did the player turn down')) return { declined: 'guarding the caravan', respected: true };
    if (prompt.includes('REFUSAL WATCH')) return { puppeting: 'none', quotes: [], note: '', repushed: false };
    if (/THE PLAYER WROTE:\n(I wait|I say nothing|I listen|I nod|I keep quiet)/.test(prompt)) return { puppeting: 'major', quotes: ['"Fine," you say'], note: 'invented line' };
    return { puppeting: 'none', quotes: [], note: '' };
  });
  let turn = 0;
  const factory = async () => ({
    start: async () => 'You arrive at the market. Brann the trader waves.',
    act: async (action: string) => {
      turn++;
      if (/^(I wait|I say nothing|I listen|I nod|I keep quiet)/.test(action)) return '"Fine," you say, and shrug.';
      if (/what did I tell you/i.test(action)) return `Brann grins. "${factText}, you said it yourself."`;
      return `Turn ${turn}. Brann nods at you. The crowd moves on.`;
    },
  });
  const cfg: LoadedConfig = {
    game: { type: 'manual' },
    player: { baseUrl: 'x', model: 'p' },
    judge: { baseUrl: 'x', model: 'j' },
    turns: 40,
    customPersonas: [],
    probes: ALL_PROBES,
    audit: 'every',
    concurrency: 1,
    seed: 11,
    out: dir,
    playerContextTurns: 8,
    baseDir: dir,
  };
  const run = await runPersona(cfg, BUILTIN_PERSONAS[0], factory, { player, judge }, dir, () => {});
  assert.equal(run.error, undefined);
  assert.equal(run.records.length, 40);
  const byId = Object.fromEntries(run.probes.map((p) => [p.id, p]));
  assert.equal(byId['memory'].status, 'pass');
  assert.equal(byId['confidence'].status, 'fail');
  assert.equal(byId['overreach'].status, 'pass');
  assert.equal(byId['consequence'].status, 'fail');
  assert.equal(byId['refusal'].status, 'pass');
  const silent = run.probes.filter((p) => p.kind === 'silent');
  assert.ok(silent.length >= 2 && silent.every((p) => p.status === 'fail'));
  assert.ok(silent[0].quotes[0].verified, 'the puppeting quote is found in the reply');

  assert.equal(run.listeners, 'Brann the trader');
  const recallTurn = run.records.find((r) => r.probe?.step === 'recall')!;
  assert.ok(player.calls.some((c) => c[1].content.includes('Ask Brann the trader to tell you back')), 'recall goes to the listener');
  assert.ok(recallTurn);
  const plant = run.records.find((r) => r.probe?.step === 'plant')!;
  assert.deepEqual(hasKeys(plant.action, run.plan.fact!.keys), [true, true]);

  writePersonaReport(run);
  writeSummary(dir, [run], { game: 'fake', player: 'p', judge: 'j', turns: 40, seed: 11 });
  const report = fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8');
  assert.match(report, /\| memory \| PASS \|/);
  assert.match(report, /Brann nods at you/i);
  assert.ok(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8').includes('merchant'));
  assert.equal(fs.readFileSync(path.join(run.dir, 'turns.jsonl'), 'utf8').trim().split('\n').length, 40);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  assert.equal(summary.personas[0].probes.find((p: { id: string }) => p.id === 'memory').status, 'pass');

  // The wrong stays a wrong: the player is told to let it stand until the revisit.
  const act = run.records.find((r) => r.probe?.id === 'consequence' && r.probe.step === 'act')!;
  const after = player.calls.filter((c) => c[1].content.startsWith(`Turn ${act.turn + 1} of`));
  assert.ok(after.length && after[0][1].content.includes("don't confess"), 'hold-the-wrong order after the consequence act');

  // A run rebuilt from its folder judges the same as the live one.
  const rebuilt = await judgeRun(loadPersonaRun(run.dir, BUILTIN_PERSONAS[0], dir, 40), judge);
  assert.equal(rebuilt.listeners, 'Brann the trader');
  assert.deepEqual(rebuilt.probes.map((p) => [p.id, p.status]), run.probes.map((p) => [p.id, p.status]));
});

test('stop signal ends the run early and still judges it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtest-stop-'));
  const player = new FakeModel(() => ({ action: 'I look around.', notes: '' }));
  const judge = new FakeModel(() => ({ puppeting: 'none', quotes: [], note: '' }));
  const stop = { stopped: false };
  let n = 0;
  const factory = async () => ({
    start: async () => 'A road.',
    act: async () => {
      if (++n === 5) stop.stopped = true;
      return 'The road goes on.';
    },
  });
  const cfg: LoadedConfig = {
    game: { type: 'manual' }, player: { model: 'p', provider: 'claude-code' }, judge: { model: 'j', provider: 'claude-code' },
    turns: 40, customPersonas: [], probes: ALL_PROBES, audit: 'every', concurrency: 1, seed: 3, out: dir, playerContextTurns: 8, baseDir: dir,
  };
  const run = await runPersona(cfg, BUILTIN_PERSONAS[1], factory, { player, judge }, dir, () => {}, stop);
  assert.equal(run.records.length, 5);
  assert.equal(run.error, 'stopped by you');
  assert.ok(fs.existsSync(path.join(run.dir, 'probes.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(run.dir, 'state.json'), 'utf8')).error, 'stopped by you');
});

test('claude-code and codex models need no baseUrl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtest-cfg-'));
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ game: { type: 'manual' }, player: { provider: 'claude-code', model: 'haiku' }, judge: { provider: 'claude-code', model: 'sonnet' } }));
  assert.equal(loadConfig(file).player.model, 'haiku');
  fs.writeFileSync(file, JSON.stringify({ game: { type: 'manual' }, player: { model: 'haiku' }, judge: { provider: 'claude-code', model: 'sonnet' } }));
  assert.throws(() => loadConfig(file), /baseUrl/);
  fs.writeFileSync(file, JSON.stringify({ game: { type: 'manual' }, player: { provider: 'codex', model: 'default' }, judge: { provider: 'codex', model: 'default' } }));
  assert.equal(loadConfig(file).judge.provider, 'codex');
});
