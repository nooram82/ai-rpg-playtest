/**
 * How the harness talks to a game. One session = one character's playthrough.
 * A game only has to take the player's words and give back what the player sees.
 */
export interface GameSession {
  /** Start a new playthrough. Returns the opening text, or '' if the game waits for the player. */
  start(): Promise<string>;
  /** Send one player action; return everything the player sees in response, as text. */
  act(action: string): Promise<string>;
  close?(): Promise<void>;
}

export interface SessionContext {
  /** Unique per playthrough, safe to use as a user or session id in your game. */
  sessionId: string;
  personaId: string;
  /** The persona's one-line character description, if your game wants it for character creation. */
  character: string;
}

export type GameFactory = (ctx: SessionContext) => Promise<GameSession>;
