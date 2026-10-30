---
name: playtest
description: Playtest the AI RPG or AI storyteller in this repo with scripted AI players, then trace each problem they find to the code or prompt that caused it. Use when the user wants to playtest their AI game, check whether it remembers things, puppets the player, lets risky actions auto-succeed, accepts powers the player never had, pushes refused quests, ignores consequences, or repeats phrases; or asks to triage an existing playtest run.
argument-hint: "[turns] [personas] | triage <run folder>"
---

# Playtest an AI RPG

The `rpg-playtest` CLI plays the game with AI players for dozens of turns, runs six probes
(memory, silent turns, confidence, overreach, refusal, consequence), checks every turn for
puppeting, and writes reports with verified quotes. This skill connects it to the game in this
repo, runs it, and sends a triage subagent after each problem to find the cause.

It works in Claude Code and in Codex. Where they differ, both are given below.

**Finding the CLI.** In Claude Code the plugin puts `rpg-playtest` on the shell's PATH; if the
shell can't find it, use `"${CLAUDE_PLUGIN_ROOT}/bin/rpg-playtest"`. Elsewhere (Codex), it is
`bin/rpg-playtest` two folders up from this SKILL.md file: `<this skill's folder>/../../bin/rpg-playtest`.
It builds itself on first use (needs Node 20+ and npm), which takes about a minute. Below,
`rpg-playtest` means whichever of these works.

If the arguments start with `triage`, skip to step 5 with the run folder given.

## 1. Find how the game takes a turn

Read the repo until you can answer: how does a new game start, how is a player's action sent,
and where does the game's reply text come back? Look for an HTTP route for turns, a CLI, or an
engine function (`takeTurn`, `handleMessage`, a chat completion call with a system prompt).

Pick the adapter, in this order of preference:

- **module**: a small `playtest/adapter.mjs` exporting `createGame(options, ctx)` that returns
  `{ start(), act(action), close?() }`. Use it whenever there is sign-in, streaming, websockets,
  several events per turn, or the engine can be called in-process. `ctx.sessionId` is unique
  per playthrough; use it to create a fresh test user or save so runs never touch real data.
- **http**: a plain JSON request/response API. Templates: `{{action}}`, `{{sessionId}}`,
  `{{session}}`, `{{character}}`, `{{env.NAME}}`; `reply` is a path like `events[*].text`.
- **command**: a script that takes the action on stdin and prints the reply.
- **chat**: the game is just a system prompt on a model. Point `systemPromptFile` at it.

The reply must be what a player would read: narration and dialogue only, no JSON, no debug
output, no tool calls. Include every text event of the turn.

The `start()` reply can be empty if the game waits for the player. If the game needs character
creation, say so in `setting` ("Answer the character questions first").

Write `playtest/playtest.config.json` (create the folder; add `playtest/runs/` to .gitignore):

```json
{
  "game": { "type": "module", "path": "./adapter.mjs", "options": { "baseUrl": "http://localhost:3000" } },
  "player": { "provider": "claude-code", "model": "haiku", "effort": "low" },
  "judge": { "provider": "claude-code", "model": "sonnet" },
  "turns": 30,
  "personas": ["merchant", "seeker", "brawler"],
  "setting": "One or two lines: the genre, and how play starts."
}
```

Use the models of the tool you are running in, so no API key is needed:

- **Claude Code:** as above (`claude -p` on the user's sign-in).
- **Codex:** `"player": { "provider": "codex", "model": "default", "effort": "low" }` and
  `"judge": { "provider": "codex", "model": "default", "effort": "medium" }` (`codex exec` on the
  user's sign-in; `default` is the model in their Codex config).

If the user prefers an API: `{ "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY", "model": "..." }`.
Keep the judge strong; small judges misread puppeting.

If the game must be running (a dev server), check whether it is up. If not, ask the user to
start it, or start it yourself in the background if the repo makes that obvious. Never point
the playtest at production.

## 2. Smoke test

```bash
rpg-playtest run --config playtest/playtest.config.json --turns 3 --personas merchant --probes silent
```

Open the run's `merchant/transcript.md` and check that the replies are real scenes, not errors,
JSON or empty strings, and that the opening (if any) is there. Fix the adapter until they are.

## 3. Full run

Start it in the background if you can, since it takes a while (about 20-40 seconds per turn per persona,
personas in parallel; 30 turns x 3 personas is often 15-25 minutes):

```bash
rpg-playtest run --config playtest/playtest.config.json
```

Pass the user's choices through: `--turns n`, `--personas a,b` (built in: merchant, seeker,
brawler, schemer), `--probes ...`, `--seed n` to repeat an earlier run's tests on a new build.
Tell the user it is running and roughly how long. If you can't run long commands in the
background, give the user the command to run in their own terminal and wait for them to say
it finished. If they stop it, the CLI still judges and
reports what was played; a run killed hard can be finished with `rpg-playtest report <run folder>`.

## 4. Read the results

The run folder is printed at the end (`playtest/runs/<timestamp>/`). Read `summary.json`:
per persona, probes (`status`: pass, partial, fail, inconclusive, each with turns, quotes and a
note), puppeting slips (turn, level, quotes), and repeated stock phrases (`tics`).

## 5. Triage in parallel

Collect the findings worth a look: every probe with status `fail` or `partial`, every turn with
`major` puppeting, minor puppeting only when it recurs in the same way three or more times, and
tics that appear in more than a third of the turns. Group duplicates (the same slip across
personas is one finding).

For each finding, start a triage subagent, all at once so they run in parallel (at most 6; the
rest after):

- **Claude Code:** the `playtest-triage` agent from this plugin, all in one message.
- **Codex:** spawn a sub-agent per finding, telling it to read and follow
  `<this skill's folder>/../../agents/playtest-triage.md` (give the absolute path).
- If you can't start subagents, work through the findings yourself one at a time, following
  that same file.

Give each one:

- the finding as JSON from `summary.json`, and which persona it came from
- the path to that persona's `transcript.md` and `turns.jsonl`
- the adapter and config you wrote, and what you learned in step 1 about where turns are
  handled (files and functions), so it does not have to rediscover the engine

## 6. Report

Give the user one table: finding, verdict (confirmed or false alarm, from the triage),
cause (`file:line`), and the suggested fix. Then the short version of the scores from
`summary.md`. Mention which findings the triage could not place.

Do not change the game's code unless the user asks. When they do, fix one finding at a time,
then re-run with the same `--seed` (in `summary.json`) and the same personas to confirm it
moved, and compare the two runs.
