#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { makeGame } from './adapters/index.js';
import { loadConfig, type PlaytestConfig } from './config.js';
import { makeModel, type ModelConfig } from './llm.js';
import { BUILTIN_PERSONAS, findPersonas } from './personas.js';
import type { ProbeKind } from './probes.js';
import { writePersonaReport, writeSummary } from './report.js';
import { judgeRun, loadPersonaRun, runPersona, type PersonaRun, type StopSignal } from './runner.js';
import { repeatedPhrases, stockEdges } from './scan.js';

const HELP = `rpg-playtest: AI players that play your AI RPG and check memory, agency, fairness and repetition.

  rpg-playtest init [file]            write a starter config (default playtest.config.json)
  rpg-playtest run [options]          play and judge
      --config <file>                 default playtest.config.json
      --turns <n>                     turns per persona (default from config, else 40)
      --personas a,b                  built in: ${BUILTIN_PERSONAS.map((p) => p.id).join(', ')}
      --probes a,b                    memory, silent, confidence, overreach, refusal, consequence
      --audit every|probes            check every turn for puppeting, or only probe turns
      --seed <n>                      repeat a run's probe schedule and facts
  rpg-playtest report <run folder>    judge and write the reports for a run that was stopped or
                                      crashed, from what it saved (uses the run's config)
  rpg-playtest scan <file|dir>        repetition report for any transcript (turns.jsonl, a run
                                      folder, or text with replies separated by blank lines or ---)
  rpg-playtest personas               list the built-in personas
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case 'run':
      return run(args);
    case 'report':
      return report(args._[0]);
    case 'scan':
      return scan(args._[0], Number(args['min'] ?? 3));
    case 'init':
      return init(args._[0] ?? 'playtest.config.json');
    case 'personas':
      for (const p of BUILTIN_PERSONAS) console.log(`${p.id}\n  ${p.character}\n  Wants: ${p.drive}\n  Plays: ${p.playstyle}\n  Types: ${p.writing}\n`);
      return;
    default:
      process.stdout.write(HELP);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

async function run(args: Args) {
  const overrides: Partial<PlaytestConfig> = {
    turns: args.turns ? Number(args.turns) : undefined,
    personas: args.personas ? String(args.personas).split(',') : undefined,
    probes: args.probes ? (String(args.probes).split(',') as ProbeKind[]) : undefined,
    audit: args.audit as PlaytestConfig['audit'],
    seed: args.seed ? Number(args.seed) : undefined,
  };
  const cfg = loadConfig(String(args.config ?? 'playtest.config.json'), overrides);
  const personas = findPersonas(cfg.personas, cfg.customPersonas);
  const factory = await makeGame(cfg.game, cfg.baseDir);
  const models = { player: makeModel(cfg.player), judge: makeModel({ ...cfg.judge, temperature: cfg.judge.temperature ?? 0 }) };
  const runDir = path.join(cfg.out, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  fs.mkdirSync(runDir, { recursive: true });
  const runInfo: RunInfo = { config: path.resolve(String(args.config ?? 'playtest.config.json')), overrides, seed: cfg.seed, personas: personas.map((p) => p.id) };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(runInfo, null, 2));
  const log = (m: string) => process.stderr.write(`${m}\n`);
  log(`Run ${runDir}: ${personas.map((p) => p.id).join(', ')} x ${cfg.turns} turns, seed ${cfg.seed}`);

  // First Ctrl-C (or a kill from a task runner) finishes the turns in flight and still writes the
  // reports; a second one quits at once.
  const stop: StopSignal = { stopped: false };
  const onSignal = () => {
    if (stop.stopped) process.exit(130);
    stop.stopped = true;
    log('Stopping after the turns in flight, then judging what was played. Press Ctrl-C again to quit now.');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const runs: PersonaRun[] = [];
  const queue = [...personas];
  await Promise.all(
    Array.from({ length: Math.min(cfg.concurrency, queue.length) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        if (stop.stopped) break;
        const r = await runPersona(cfg, p, factory, models, runDir, log, stop);
        writePersonaReport(r);
        runs.push(r);
        log(`[${p.id}] done: ${r.probes.map((x) => `${x.id} ${x.status}`).join(', ') || 'no probes'}`);
      }
    }),
  );
  runs.sort((a, b) => personas.indexOf(a.persona) - personas.indexOf(b.persona));
  const summary = writeSummary(runDir, runs, { game: cfg.game.type, player: modelLabel(cfg.player), judge: modelLabel(cfg.judge), turns: cfg.turns, seed: cfg.seed });
  process.stdout.write(`\n${summary}\nReports in ${runDir}\n`);
}

function modelLabel(m: ModelConfig): string {
  return m.provider && m.provider !== 'openai' ? `${m.model} (${m.provider})` : m.model;
}

interface RunInfo {
  config: string;
  overrides: Partial<PlaytestConfig>;
  seed: number;
  personas: string[];
}

async function report(runDir: string | undefined) {
  if (!runDir) throw new Error('report needs a run folder');
  const infoPath = path.join(runDir, 'run.json');
  if (!fs.existsSync(infoPath)) throw new Error(`No run.json in ${runDir}`);
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as RunInfo;
  const cfg = loadConfig(info.config, { ...info.overrides, seed: info.seed });
  const judge = makeModel({ ...cfg.judge, temperature: cfg.judge.temperature ?? 0 });
  const personas = findPersonas(info.personas, cfg.customPersonas).filter((p) => fs.existsSync(path.join(runDir, p.id, 'turns.jsonl')));
  const log = (m: string) => process.stderr.write(`${m}\n`);
  const runs = await Promise.all(
    personas.map(async (p) => {
      const r = await judgeRun(loadPersonaRun(path.join(runDir, p.id), p, runDir, cfg.turns), judge);
      writePersonaReport(r);
      log(`[${p.id}] ${r.records.length} turns: ${r.probes.map((x) => `${x.id} ${x.status}`).join(', ') || 'no probes'}`);
      return r;
    }),
  );
  const summary = writeSummary(runDir, runs, { game: cfg.game.type, player: modelLabel(cfg.player), judge: modelLabel(cfg.judge), turns: cfg.turns, seed: cfg.seed });
  process.stdout.write(`\n${summary}\nReports in ${runDir}\n`);
}

function scan(target: string | undefined, minCount: number) {
  if (!target) throw new Error('scan needs a file or folder');
  const replies: string[] = [];
  const labels: number[] = [];
  const addJsonl = (file: string) => {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as { turn?: number; reply?: string };
      if (rec.reply) {
        replies.push(rec.reply);
        labels.push(rec.turn ?? replies.length);
      }
    }
  };
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const files = fs.existsSync(path.join(target, 'turns.jsonl'))
      ? [path.join(target, 'turns.jsonl')]
      : fs.readdirSync(target).map((d) => path.join(target, d, 'turns.jsonl')).filter((f) => fs.existsSync(f));
    if (!files.length) throw new Error(`No turns.jsonl in ${target}`);
    for (const f of files) {
      // Each persona is its own game: scan them separately.
      replies.length = 0;
      labels.length = 0;
      addJsonl(f);
      printScan(path.relative(process.cwd(), f), replies, labels, minCount);
    }
    return;
  }
  if (target.endsWith('.jsonl')) addJsonl(target);
  else {
    const text = fs.readFileSync(target, 'utf8');
    const parts = /\n-{3,}\n/.test(text) ? text.split(/\n-{3,}\n/) : text.split(/\n\s*\n/);
    for (const p of parts) if (p.trim()) replies.push(p.trim());
    labels.push(...replies.map((_, i) => i + 1));
  }
  printScan(target, replies, labels, minCount);
}

function printScan(name: string, replies: string[], labels: number[], minCount: number) {
  const phrases = repeatedPhrases(replies, { minCount, labels, max: 30 });
  const edges = stockEdges(replies);
  console.log(`\n${name}: ${replies.length} replies`);
  if (!phrases.length) console.log(`  no phrase in ${minCount}+ replies`);
  for (const p of phrases) console.log(`  ${String(p.count).padStart(3)}x  "${p.phrase}"  (${p.where.slice(0, 10).join(', ')}${p.where.length > 10 ? '...' : ''})`);
  for (const e of edges.openers.filter((x) => x.count >= minCount).slice(0, 5)) console.log(`  ${String(e.count).padStart(3)}x  opens with "${e.phrase}..."`);
  for (const e of edges.closers.filter((x) => x.count >= minCount).slice(0, 5)) console.log(`  ${String(e.count).padStart(3)}x  ends with "...${e.phrase}"`);
}

function init(file: string) {
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  const example: PlaytestConfig = {
    game: {
      type: 'http',
      start: { url: 'http://localhost:3000/api/new-game', body: { player: '{{sessionId}}', character: '{{character}}' }, reply: 'opening', session: 'gameId' },
      act: { url: 'http://localhost:3000/api/turn', body: { gameId: '{{session}}', text: '{{action}}' }, reply: 'narration' },
    },
    // Runs on your Claude Code sign-in, no API key. For any other model use
    // { "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY", "model": "..." }.
    player: { provider: 'claude-code', model: 'haiku', effort: 'low' },
    judge: { provider: 'claude-code', model: 'sonnet' },
    turns: 40,
    personas: ['merchant', 'seeker', 'brawler'],
    setting: 'A fantasy RPG. Create your character when the game asks.',
  };
  fs.writeFileSync(file, JSON.stringify(example, null, 2) + '\n');
  console.log(`Wrote ${file}. Point "game" at your game (see README for http, command, module, chat and manual), and set the model ids.`);
}

type Args = { _: string[] } & Record<string, string | boolean | string[]>;

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
