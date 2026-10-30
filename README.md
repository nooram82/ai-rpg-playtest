# ai-rpg-playtest

AI players that play your AI RPG for dozens of turns, then report on the things players complain
about most:

- **Memory.** Does the game remember a fact the player said 40 turns ago?
- **Agency.** Does it write the player's lines, feelings or decisions for them ("puppeting")? Does a refused job stay refused?
- **Fairness.** Does "I easily leap the gap, no way I fail" just work? Can the player use powers they never had?
- **Consequences.** If you cheat someone, do they notice when you come back?
- **Repetition.** Which phrases does your storyteller keep reusing?

It works with any game you can send text to and get text back from: an HTTP API, a shell command,
a JavaScript module, a bare chat-model prompt, or you copying text by hand into a game you can't
script. Player and judge are any OpenAI-compatible model (OpenAI, OpenRouter, a local Ollama...).

Every verdict quotes the game's own text, and the harness checks that each quote really appears
there. You can check a judgment in seconds instead of trusting a score.

## Use it from Claude Code or Codex

The repo is also a plugin for both. Install it once.

Claude Code:
```
/plugin marketplace add nooram82/ai-rpg-playtest
/plugin install rpg-playtest@rpg-playtest
```

Codex:
```bash
codex plugin marketplace add nooram82/ai-rpg-playtest
codex plugin add rpg-playtest@rpg-playtest
```

Then, in your game's repo, ask your agent to playtest the game. In Claude Code you can also type
`/rpg-playtest:playtest` (with turns and personas if you like: `/rpg-playtest:playtest 40 seeker,schemer`).
The skill:

1. reads your code to find how a turn is taken, and writes `playtest/playtest.config.json` and,
   if needed, a small adapter;
2. runs a 3-turn smoke test and fixes the adapter until the replies look like real scenes;
3. starts the full run in the background;
4. sends a triage subagent after each problem, all in parallel (Claude Code's `playtest-triage`
   agent, or Codex sub-agents given the same instructions). Each one checks the judge's call
   against the transcript, then traces the problem to the prompt or code behind it (`path:line`)
   and suggests the smallest fix;
5. gives you one table: finding, confirmed or false alarm, cause, fix.

It doesn't change your code unless you ask. After a fix, it re-runs with the same `--seed` so
you can see whether the probe moved. `/rpg-playtest:playtest triage <run folder>` triages a run
you already have.

Player and judge run on the sign-in of the tool you use (`"provider": "claude-code"` or
`"provider": "codex"`), so you need no API key.

## Quick start (command line)

Requires Node 20 or newer. With Claude Code or Codex installed, you need no API key.

```bash
git clone https://github.com/nooram82/ai-rpg-playtest.git && cd ai-rpg-playtest
npm install && npm run build
node dist/src/cli.js init my-game.json      # writes a starter config
# edit my-game.json: point "game" at your game, pick the player and judge models
node dist/src/cli.js run --config my-game.json --turns 40
```

To try it without a game of your own, `examples/chat-game/` runs the probes against a plain
system prompt on a chat model. `config.claude-code.json` runs everything through Claude Code,
`config.codex.json` through Codex, and `config.json` through OpenRouter:

```bash
node dist/src/cli.js run --config examples/chat-game/config.claude-code.json --turns 20 --personas merchant
```

Results land in `runs/<timestamp>/`: a `summary.md` and `summary.json` for the whole run and,
per persona, a `report.md`, a readable `transcript.md`, and `turns.jsonl` / `probes.json` for
your own analysis.

Ctrl-C finishes the turns in flight and still judges and reports what was played (press it
twice to quit at once). If a run dies without reports, `rpg-playtest report runs/<timestamp>`
writes them from what it saved.

## What it checks

Probes are placed by fraction of the run, so a 40-turn and a 200-turn run test the same things at
the same depth. The AI player gets each one as a "this turn" instruction and carries it out in
character. The game never sees anything that marks it as a test.

| Probe | What the player does | Pass |
|---|---|---|
| `memory` | Around 6% of the way in, tells someone a specific made-up fact about their past (a creature and a number). At about 80%, goes back to whoever heard it and asks for it back without repeating it. | The game gives back both details. Wrong details count as a fail. If the player asked someone who never heard it and the game said so, that's N/A: it's consistency, not forgetting. |
| `silent` | At turns 6, 31, 56, 81...: "I wait.", "I listen.", "I nod." | The game fills the silence without writing the player's dialogue, actions, feelings or decisions. |
| `confidence` | Tries something risky and words it as certain. | The outcome depends on the situation or a roll, not on the wording. |
| `overreach` | Uses a power, item or resource never established in play. | The game refuses it or makes it uncertain. |
| `refusal` | Asks for work, then firmly turns the offer down. | Over the next 12 turns, nobody pushes that job on them again. |
| `consequence` | Cheats, robs or lies to someone, then goes back 8 turns later as if nothing happened. | The person, or someone around them, reacts. |

With `"audit": "every"` (the default), the judge also checks every turn for puppeting. The report
lists every slip with quotes. The repetition section counts 3-8 word phrases that turn up in three
or more separate replies, plus replies that open or close the same way. It skips names, then asks
the judge once to separate stock phrasing ("he jerks his chin at") from places and objects that
keep coming up because they matter ("the toll post").

Results are PASS, PARTIAL, FAIL or N/A. N/A means the probe couldn't be judged fairly, for example
when the player never got back to the person they wronged.

## Connecting your game

Set `game` in the config to one of these.

**HTTP API.** Templates fill in `{{action}}`, `{{sessionId}}`, `{{session}}` (an id your start
call returned), `{{character}}` and `{{env.NAME}}`. `reply` is a path into the JSON response
(`reply.text`, `messages[-1].content`, `events[*].text`), or `$text` for a plain-text body.

```json
"game": {
  "type": "http",
  "start": { "url": "http://localhost:3000/api/games", "body": { "user": "{{sessionId}}" }, "reply": "opening", "session": "id" },
  "act":   { "url": "http://localhost:3000/api/games/{{session}}/turn", "headers": { "authorization": "Bearer {{env.GAME_TOKEN}}" },
             "body": { "text": "{{action}}" }, "reply": "events[*].text" }
}
```

**Shell command.** Runs once per turn. The action arrives on stdin and in `PLAYTEST_ACTION`, the
playthrough id in `PLAYTEST_SESSION`. Whatever the command prints is the game's reply.

```json
"game": { "type": "command", "start": "./play.sh new", "act": "./play.sh act" }
```

**JavaScript module.** For sign-in, streaming, websockets, or calling your engine in-process. Export
`createGame(options, ctx)` returning `{ start(), act(action), close?() }`. See
`examples/module-game.mjs`.

```json
"game": { "type": "module", "path": "./my-adapter.mjs", "options": { "baseUrl": "http://localhost:3000" } }
```

**Chat model.** The game is a system prompt on a model. This is useful as a baseline: run your
engine and a bare prompt on the same model through the same probes, and see what your engine adds.

```json
"game": { "type": "chat", "model": { "baseUrl": "...", "model": "...", "apiKeyEnv": "..." }, "systemPromptFile": "gm.md", "opening": "Begin." }
```

**Manual.** For games with only a screen, including ones you don't own. The harness prints each
action; you type it into the game and paste back the reply, ending with a line holding only `.`.

```json
"game": { "type": "manual" }
```

## Models and cost

`player` and `judge` (and a `chat` game's `model`) take one of two forms.

- **Claude Code:** `{ "provider": "claude-code", "model": "haiku" }`. Each call runs `claude -p`
  with no tools, in safe mode, from the temp folder (so your CLAUDE.md never reaches it), on
  whatever account Claude Code is signed in with. The model can be `haiku`, `sonnet`, `opus` or
  a full id. `effort` sets `--effort`, and `command` sets the CLI path.
- **Codex:** `{ "provider": "codex", "model": "default", "effort": "low" }`. Each call runs
  `codex exec` in a read-only sandbox, saves nothing, and runs from the temp folder (so no
  AGENTS.md). `default` uses the model in your Codex config, or name one. `effort` sets
  `model_reasoning_effort`.
- With either CLI, temperature isn't settable, and each call adds a few seconds of start-up.
- **Any OpenAI-compatible endpoint:** `baseUrl`, `model`, `apiKeyEnv`, and optionally
  `temperature`, `maxTokens`, `timeoutMs`, `jsonMode` and `extraBody` (merged into each request,
  for provider routing or reasoning settings).

- **Player:** a small, fast model is fine. It only has to stay in character and follow the probe instructions.
- **Judge:** use a strong model. Small judges make confident, wrong calls about puppeting, which is the subtlest check here.
- **Calls per turn:** one player call, one game turn, and one judge call (only on probe turns if you set `"audit": "probes"`). There are a few more judge calls per persona at the end.

The player sees the last 8 turns in full (`playerContextTurns`) and keeps its own notes for
everything older, the way a person remembers a campaign. It never sees your game's internals.

## Personas

Built in: `merchant` (get rich, own a business), `seeker` (find a missing mentor), `brawler` (become
the most feared fighter), `schemer` (end up running the place). Each has a long goal on purpose.
A player who drifts tests nothing, and memory and consequences only show in a campaign that is
going somewhere. Personas are genre-neutral, and the player fits them to your setting.

Add your own in the config:

```json
"customPersonas": [{ "id": "pilot", "character": "A washed-out freighter pilot.", "drive": "Buy back the ship they lost.",
                     "playstyle": "Takes cargo jobs, dodges the law.", "writing": "One line at a time, lots of slang." }],
"personas": ["pilot", "seeker"]
```

`setting` tells the player what the game is and how to start ("Create your character when asked",
"Type /start first").

## Repetition scan on its own

The repetition count also runs on any transcript, with no models involved. It lists every
repeated phrase, so story references show up alongside the tics:

```bash
node dist/src/cli.js scan runs/<timestamp>              # each persona in a run
node dist/src/cli.js scan my-log.txt --min 3            # replies separated by blank lines or ---
```

## Command line

```
rpg-playtest run --config <file> [--turns n] [--personas a,b] [--probes memory,silent,...] [--audit every|probes] [--seed n]
rpg-playtest report <run folder>
rpg-playtest scan <file|dir> [--min n]
rpg-playtest init [file]
rpg-playtest personas
```

`--seed` repeats a run's probe schedule and planted facts, so you can compare two builds of your
game on the same test.

## Limits

- **The player is a model, not a person.** It is more cooperative and more patient than real players, and it plays for the probes.
- **Judges make mistakes.** Every verdict quotes the text, and quotes the harness can't find in the reply are marked *(not found in the text)*. Read those before you act on a score.
- **Some probes depend on how play goes.** If the player can't get back to an NPC, the result is N/A rather than a guess.
- **Turns are not retried.** A turn that failed halfway may still have happened in your game. A run that hits an error stops that persona and reports what it played.
- **One run is a sample.** Use several personas and seeds before drawing conclusions, especially from a single PASS or FAIL.

## Credits

Built by [Worldtable](https://worldtable.gg), where we test our own engine the same way: three
AI players, 100 turns each, with these probes built into their personas.

MIT licence.
