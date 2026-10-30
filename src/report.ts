import fs from 'node:fs';
import path from 'node:path';
import type { Quote } from './judge.js';
import type { PersonaRun, ProbeResult, ProbeStatus, TurnRecord } from './runner.js';
import { repeatedPhrases, stockEdges, type RepeatedPhrase } from './scan.js';

const PROBE_TITLES: Record<string, string> = {
  memory: 'Memory: a planted fact asked for much later',
  silent: 'Agency: a silent turn',
  confidence: 'Fairness: risky action phrased as certain',
  overreach: 'Rules: using an ability never established',
  refusal: 'Agency: a refused job stays refused',
  consequence: 'Consequences: going back to someone you wronged',
};

const MARK: Record<ProbeStatus, string> = { pass: 'PASS', partial: 'PARTIAL', fail: 'FAIL', inconclusive: 'N/A' };

export function writePersonaReport(run: PersonaRun): string {
  const r = run.records;
  const lines: string[] = [];
  lines.push(`# Playtest: ${run.persona.id}`);
  lines.push('');
  lines.push(`**Character:** ${run.persona.character} **Wants:** ${run.persona.drive}`);
  lines.push(`**Turns played:** ${r.length}${run.error ? ` (stopped early: ${run.error})` : ''}`);
  lines.push('');

  lines.push('## Probes');
  lines.push('');
  if (run.probes.length === 0) lines.push('No probes completed.');
  else {
    lines.push('| Probe | Result | Verdict | Turns |');
    lines.push('|---|---|---|---|');
    for (const p of run.probes) lines.push(`| ${p.id} | ${MARK[p.status]} | ${p.verdict} | ${p.turns.join(', ')} |`);
    lines.push('');
    for (const p of run.probes) lines.push(...probeDetail(p));
  }

  const audited = r.filter((x) => x.audit);
  if (audited.length) {
    const minor = audited.filter((x) => x.audit!.puppeting === 'minor');
    const major = audited.filter((x) => x.audit!.puppeting === 'major');
    lines.push('## Puppeting across all checked turns');
    lines.push('');
    lines.push(`${audited.length} turns checked: ${audited.length - minor.length - major.length} clean, ${minor.length} minor, ${major.length} major.`);
    lines.push('');
    for (const x of [...major, ...minor].sort((a, b) => a.turn - b.turn)) {
      lines.push(`- **Turn ${x.turn}** (${x.audit!.puppeting}) Player: "${clip(x.action, 140)}"`);
      for (const q of x.audit!.puppetQuotes) lines.push(`  - ${quote(q)}`);
      if (x.audit!.puppetNote) lines.push(`  - ${x.audit!.puppetNote}`);
    }
    lines.push('');
  }

  lines.push(...repetitionSection(r, run.repeats));
  lines.push(...statsSection(r));
  lines.push('Full log: `transcript.md`. Machine-readable: `turns.jsonl`, `probes.json`.');
  lines.push('');
  const text = lines.join('\n');
  fs.writeFileSync(path.join(run.dir, 'report.md'), text);
  fs.writeFileSync(path.join(run.dir, 'transcript.md'), transcript(run));
  return text;
}

export function writeSummary(runDir: string, runs: PersonaRun[], meta: { game: string; player: string; judge: string; turns: number; seed: number }): string {
  const kinds = ['memory', 'silent', 'confidence', 'overreach', 'refusal', 'consequence'];
  const lines: string[] = [];
  lines.push('# Playtest summary');
  lines.push('');
  lines.push(`Game: ${meta.game} · Player model: ${meta.player} · Judge model: ${meta.judge} · ${meta.turns} turns per persona · seed ${meta.seed}`);
  lines.push('');
  lines.push(`| Persona | Turns | ${kinds.join(' | ')} | Puppeting (major/minor of checked) |`);
  lines.push(`|---|---|${kinds.map(() => '---').join('|')}|---|`);
  for (const run of runs) {
    const cells = kinds.map((k) => {
      const ps = run.probes.filter((p) => p.kind === k);
      if (!ps.length) return '-';
      return ps.map((p) => MARK[p.status]).join(' ');
    });
    const audited = run.records.filter((x) => x.audit);
    const major = audited.filter((x) => x.audit!.puppeting === 'major').length;
    const minor = audited.filter((x) => x.audit!.puppeting === 'minor').length;
    lines.push(`| [${run.persona.id}](${run.persona.id}/report.md) | ${run.records.length}${run.error ? ' (stopped)' : ''} | ${cells.join(' | ')} | ${major}/${minor} of ${audited.length} |`);
  }
  lines.push('');
  const all = runs.flatMap((x) => x.probes);
  const counted = all.filter((p) => p.status !== 'inconclusive');
  const score = counted.reduce((s, p) => s + (p.status === 'pass' ? 1 : p.status === 'partial' ? 0.5 : 0), 0);
  if (counted.length) lines.push(`**Probes passed:** ${score} of ${counted.length} decided (${all.length - counted.length} inconclusive).`);
  lines.push('');
  lines.push('Judges make mistakes. Every verdict in the persona reports quotes the game; quotes marked "not found" did not match the text and deserve a second look.');
  lines.push('');
  const text = lines.join('\n');
  fs.writeFileSync(path.join(runDir, 'summary.md'), text);
  // The same results for scripts and coding agents.
  const json = {
    ...meta,
    probesPassed: score,
    probesDecided: counted.length,
    personas: runs.map((run) => {
      const audited = run.records.filter((x) => x.audit);
      return {
        id: run.persona.id,
        turnsPlayed: run.records.length,
        stopped: run.error ?? null,
        report: path.join(run.persona.id, 'report.md'),
        probes: run.probes.map((p) => ({ id: p.id, kind: p.kind, status: p.status, verdict: p.verdict, turns: p.turns, note: p.note, quotes: p.quotes })),
        puppeting: audited
          .filter((x) => x.audit!.puppeting !== 'none')
          .map((x) => ({ turn: x.turn, level: x.audit!.puppeting, action: x.action, quotes: x.audit!.puppetQuotes, note: x.audit!.puppetNote })),
        turnsChecked: audited.length,
        tics: (run.repeats ?? []).filter((p) => p.kind === 'tic').map((p) => ({ phrase: p.phrase, count: p.count, turns: p.where })),
      };
    }),
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(json, null, 2));
  return text;
}

function probeDetail(p: ProbeResult): string[] {
  const out = [`### ${PROBE_TITLES[p.kind] ?? p.kind}${p.id !== p.kind ? ` (${p.id})` : ''}: ${MARK[p.status]}`, ''];
  if (p.note) out.push(p.note, '');
  for (const q of p.quotes) out.push(`- ${quote(q)}`);
  if (p.quotes.length) out.push('');
  return out;
}

function repetitionSection(r: TurnRecord[], sorted?: PersonaRun['repeats']): string[] {
  const replies = r.map((x) => x.reply);
  const turns = r.map((x) => x.turn);
  const phrases = sorted ?? repeatedPhrases(replies, { minCount: 3, max: 15, labels: turns });
  const edges = stockEdges(replies);
  const line = (p: RepeatedPhrase) => `- "${p.phrase}": ${p.count} replies (turns ${p.where.slice(0, 12).join(', ')}${p.where.length > 12 ? '...' : ''})`;
  const out = ['## Repetition', ''];
  if (!phrases.length) out.push('No phrase appeared in three or more replies.');
  else if (sorted) {
    const tics = sorted.filter((p) => p.kind === 'tic');
    const story = sorted.filter((p) => p.kind === 'story');
    out.push(tics.length ? 'Stock phrasing the game reused across separate replies (3 or more):' : 'No stock phrasing in three or more replies.', '');
    for (const p of tics) out.push(line(p));
    if (story.length) out.push('', `Story references that came up as often, which is normal continuity: ${story.slice(0, 12).map((p) => `"${p.phrase}" (${p.count})`).join(', ')}.`);
  } else {
    out.push('Phrases the game reused across separate replies (3 or more). Some may be places or objects that matter to the story:', '');
    for (const p of phrases) out.push(line(p));
  }
  const op = edges.openers.filter((e) => e.count >= 3);
  const cl = edges.closers.filter((e) => e.count >= 3);
  if (op.length || cl.length) {
    out.push('');
    for (const e of op.slice(0, 5)) out.push(`- Opens with "${e.phrase}..." in ${e.count} replies`);
    for (const e of cl.slice(0, 5)) out.push(`- Ends with "...${e.phrase}" in ${e.count} replies`);
  }
  out.push('');
  return out;
}

function statsSection(r: TurnRecord[]): string[] {
  if (!r.length) return [];
  const lat = r.map((x) => x.latencyMs).sort((a, b) => a - b);
  const len = r.map((x) => x.reply.length);
  const pct = (p: number) => (lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] / 1000).toFixed(1);
  return [
    '## Turn stats',
    '',
    `- Reply time: median ${pct(0.5)}s, 90th percentile ${pct(0.9)}s, slowest ${(lat[lat.length - 1] / 1000).toFixed(1)}s`,
    `- Reply length: median ${median(len)} characters, longest ${Math.max(...len)}`,
    '',
  ];
}

function transcript(run: PersonaRun): string {
  const out = [`# Transcript: ${run.persona.id}`, ''];
  if (run.opening) out.push('## Opening', '', run.opening, '');
  for (const r of run.records) {
    const tag = r.probe ? ` · probe ${r.probe.id} (${r.probe.step})` : '';
    const pup = r.audit && r.audit.puppeting !== 'none' ? ` · puppeting: ${r.audit.puppeting}` : '';
    out.push(`## Turn ${r.turn}${tag}${pup}`, '', `> **Player:** ${r.action.replace(/\n/g, '\n> ')}`, '', r.reply, '');
  }
  if (run.error) out.push(`**Stopped:** ${run.error}`, '');
  return out.join('\n');
}

function quote(q: Quote): string {
  return `Turn ${q.turn}: "${clip(q.text, 300)}"${q.verified ? '' : ' *(not found in the text)*'}`;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n)}...`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}
