# Futbot

Standalone Discord bot for Mario Strikers Competitive Rated matches and Futbot gear/role utilities.

This project is intentionally independent from the main bot: it has its own npm package, command registration, tests, start script and Git history. The SQL database remains the shared external contract.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill `FUTBOT_TOKEN`, `FUTBOT_ID`, database credentials and `COMPETITIVE_DB_SCHEMA`.
3. Install dependencies:

```powershell
npm install
```

## Run

```powershell
npm start
```

or use `teststart-futbot.bat`.

The bot stops cleanly on SIGTERM/SIGINT (for example `docker compose stop`): it stops the rated queue's timers, saves the runtime state, leaves the gateway and closes the DB pool. Run it as `node index.js` in a container, not through `npm start`, so the signal reaches the process.

## Register Commands

```powershell
npm run commands:register
```

## Tests and lint

```powershell
npm test
npm run lint
```

Tests never reach the production database or Discord: `tests/setup/isolate.js` clears the credentials and refuses every non-local network connection. `tests/contracts` compares the slash command definitions and other public formats with fixtures; regenerate them only for an intended change with `UPDATE_CONTRACTS=1 npm test`.

GitHub Actions runs the same checks (`npm ci`, lint, tests on Node 24) on every push to master and every pull request (`.github/workflows/ci.yml`); Dependabot proposes dependency updates as pull requests (`.github/dependabot.yml`).

## Structure

| Path | Responsibility |
| --- | --- |
| `index.js` | Client, event wiring, login with retry, shutdown |
| `src/commands` | Slash commands (`general`, `mslstaff`) and the loader that registers and dispatches them |
| `src/services/competitiveRatedQueue` | The rated queue (see below); `service.js` is its public API |
| `src/services/competitiveRating.js` | Match results (ELO), rollback, rank roles, season lookups |
| `src/services/competitiveWhrRunner.js`, `wholeHistoryRating.js` | Whole History Rating of the legacy 1v1 history |
| `src/services/manualReport.js` | `/report1v1` and `/report2v2` |
| `src/db/sqlClient.js` | Connection pool, retries of transient errors, circuit breaker |
| `src/db/requests.js`, `src/db/errors.js` | Shared request helpers; `RatedMatchStateError` for writes that can never succeed |
| `src/db/daos` | SQL of the competitive tables, rated matches and WHR |
| `src/utils` | Constants, permissions (staff roles), Discord helpers |

### Rated queue modules

Dependencies point one way: `service → interactionRouter → finishedMatch → matchmaking → matchFlow → helper modules`; `season` and `watchdog` also only use `matchmaking`/`matchFlow`. A test (`competitiveRatedQueueModuleGraph.test.js`) fails on any import cycle.

| Module | Responsibility |
| --- | --- |
| `service.js` | Public API: startup recovery, tick, panel reconcile, stop, reset |
| `interactionRouter.js` | Routes every button and select to its handler under the match lock |
| `finishedMatch.js` | Rematch and Report Issue buttons of a finished match |
| `season.js` | Automatic season ending, finalization and activation on the tick |
| `watchdog.js` | Restores missing controls and re-arms lost timers; never moves a match forward |
| `matchmaking.js` | Search pools, matchmaking, creation of a match |
| `matchFlow.js` | The match itself: setup, games, completion, cancellation, match timers |
| `matchTransitions.js` | Allowed stage transitions |
| `dbOps.js` | Queue of pending DB writes (game results, completion, cancellation) |
| `state.js`, `core.js` | In-memory state, per-key operation queues, per-match output queue, runtime persistence |
| `runtimeState.js` | Reading and writing the runtime file |
| `threadLifecycle.js`, `threadMessages.js`, `terminalFlow.js` | Match threads: messages, closing, archiving, issue reports |
| `panel.js`, `messages.js`, `formatting.js`, `customIds.js`, `privatePrompts.js`, `interactions.js` | Panels, message building, custom ID format, ephemeral prompts, interaction acknowledgement |
| `matchLogic.js`, `matchState.js` | Pure team building and match state helpers |
| `runtimeLogger.js`, `constants.js` | Log routing to the log channels, configuration |

### Rated match lifecycle

```
awaiting_start ──(both picks made)──────────────► awaiting_winner
awaiting_winner ──(GAME WIN)────────────────────► awaiting_loser_confirmation
awaiting_loser_confirmation ──(match decided)───► complete
                            ──(MSC/SMS advantage chosen)──► awaiting_start
                            ──(MSBL confirmed / timeouts)─► awaiting_winner
every non-terminal stage ──(timeout, player vote, season end)──► cancelled
```

MSBL has no setup and starts in `awaiting_winner`. The DB row (`RatedMatch.Status`) follows `creating → active → completed → rolled_back`, and `creating/active → cancelled`. Every stage change goes through `transitionMatchStage`, which rejects transitions outside this table (in tests it throws).

**One-time effects.** A game result and a match result are written at most once:
- Unique constraints on `RatedMatchGame (RatedMatchId, GameNumber)` and `CompetitiveRatingChange (RatedMatchId, PlayerId)`.
- `recordMatchCompletion` locks the match row; existing rating changes are returned instead of written twice.
- A match cancelled in the DB never gets ELO (`RatedMatchStateError`).
- Cancelling only touches `creating`/`active` rows.

**Concurrency.** Everything that changes a match runs in that match's operation queue, and Discord output runs in its per-match output queue. The tick does not overlap itself. Matchmaking reserves the players before it closes their searches.

**Failures and restarts.**
- A DB write that fails transiently is kept in the pending-write queue and retried in order. A completion waits for the game results of its match.
- Writes that can never succeed are dropped and logged (`competitive_db.op_dropped`).
- The in-memory state (searches, matches, pending writes) is saved to `competitive-rated-runtime.json` in `FUTBOT_RUNTIME_DIR`. It is restored on start:
  - a match that had already reached `complete` or `cancelled` is finished;
  - clicks that arrive during this recovery wait for it.

## Competitive DB Operations

Competitive migration/reset/rebuild scripts live in `scripts/` and are exposed through `package.json` scripts. They operate only on the configured competitive schema and the shared `dbo.Player` identity table.
