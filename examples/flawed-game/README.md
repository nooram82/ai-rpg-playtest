# Flawed game

A tiny text RPG server with two bugs planted on purpose, for trying the playtest plugin:

- it only sends the last 4 messages to the model, so anything older is forgotten;
- its prompt tells the narrator to describe what the hero says and does.

Run it with `node server.mjs` (port 4317). The game master is `claude -p` on Haiku, so Claude Code
must be installed and signed in.

    POST /games             {"player": "..."}        -> {"id": "...", "opening": "..."}
    POST /games/:id/turn    {"text": "..."}          -> {"narration": "..."}
