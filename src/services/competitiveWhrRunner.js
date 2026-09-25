const CompetitiveWhrSyncDao = require('../db/daos/competitiveWhrSyncDao');
const LegacyWhrDao = require('../db/daos/legacyWhrDao');
const { computeWholeHistoryRatings, diffWhrState, hasWhrChanges } = require('./wholeHistoryRating');

// dbo.Match.GameType and CompetitiveGame.Id share the same ids: 1 MSC, 2 SMS, 3 MSBL.
const WHR_GAME_TYPES = Object.freeze([1, 2, 3]);
// Reported results outside the rated queue (tournaments, manual reports) are found by fingerprint.
const DEFAULT_FINGERPRINT_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const TST_NOT_COMPUTED_REASON = 'TST (2v2) is not recalculated. The match was mirrored to dbo.MultiMatch only.';

const EMPTY_WRITE = Object.freeze({
    historyDeleted: 0,
    historyUpdated: 0,
    historyInserted: 0,
    statsInserted: 0,
    ratingsUpdated: 0
});

/**
 * Keeps dbo.WhrRatingHistory and dbo.PlayerStats.RatingWHR current. Every recalculation is a complete one:
 * all reported 1v1 results of the game, all players, from scratch. Only the resulting differences are written.
 */
class CompetitiveWhrRunner {
    constructor({
        syncDao = new CompetitiveWhrSyncDao(),
        whrDao = new LegacyWhrDao(),
        gameTypes = WHR_GAME_TYPES,
        fingerprintCheckIntervalMs = DEFAULT_FINGERPRINT_CHECK_INTERVAL_MS,
        whrOptions = {},
        now = () => Date.now()
    } = {}) {
        this.syncDao = syncDao;
        this.whrDao = whrDao;
        this.gameTypes = gameTypes;
        this.fingerprintCheckIntervalMs = fingerprintCheckIntervalMs;
        this.whrOptions = whrOptions;
        this.now = now;
        this.fingerprints = new Map();
        this.lastFingerprintCheckAt = new Map();
        this.inFlight = null;
    }

    runPending() {
        if (!this.inFlight) {
            this.inFlight = this._run().finally(() => {
                this.inFlight = null;
            });
        }
        return this.inFlight;
    }

    async _run() {
        const tst = await this.syncDao.markModeRunnerNotComputed({ mode: '2v2', reason: TST_NOT_COMPUTED_REASON });
        const legacyStats = await this.syncDao.applyPendingLegacyStats();
        const backlogByGame = await this.syncDao.getRunnerBacklogByGame({ mode: '1v1' });

        const games = [];
        const failures = [];
        for (const gameType of this.gameTypes) {
            try {
                const result = await this._runGame(gameType, backlogByGame.get(gameType) ?? 0);
                if (result) games.push(result);
            } catch (error) {
                failures.push(gameType);
                games.push({ gameType, status: 'failed', error: error.message });
            }
        }

        if (failures.length) {
            const detail = games.filter(game => game.status === 'failed')
                .map(game => `${game.gameType}: ${game.error}`)
                .join('; ');
            const error = new Error(`WHR recalculation failed for game type ${failures.join(', ')} (${detail})`);
            error.games = games;
            throw error;
        }

        return {
            status: games.length ? 'complete' : 'idle',
            games,
            tstRows: tst.updatedRows ?? 0,
            legacyStats
        };
    }

    async _dueReason(gameType, backlog) {
        if (backlog > 0) return 'backlog';
        if (!this.fingerprints.has(gameType)) return 'startup';

        const now = this.now();
        if (now - (this.lastFingerprintCheckAt.get(gameType) ?? 0) < this.fingerprintCheckIntervalMs) {
            return null;
        }
        this.lastFingerprintCheckAt.set(gameType, now);
        const fingerprint = await this.whrDao.getMatchFingerprint(gameType);
        return fingerprint === this.fingerprints.get(gameType) ? null : 'matches_changed';
    }

    async _runGame(gameType, backlog) {
        const reason = await this._dueReason(gameType, backlog);
        if (!reason) return null;

        const startedAt = this.now();
        await this.syncDao.markGameRunnerRunning({ gameId: gameType, mode: '1v1' });
        try {
            const state = await this.whrDao.loadGameState(gameType);
            const computed = computeWholeHistoryRatings(state.matches, this.whrOptions);
            if (!computed.converged) {
                throw new Error(`WHR did not converge after ${computed.iterations} iterations (last step ${computed.maxStepElo.toFixed(6)} Elo)`);
            }

            const diff = diffWhrState({
                computed: computed.players,
                existingHistory: state.history,
                existingRatings: state.ratings
            });
            const written = hasWhrChanges(diff) ? await this.whrDao.applyDiff(gameType, diff) : { ...EMPTY_WRITE };
            const complete = await this.syncDao.markGameRunnerComplete({ gameId: gameType, mode: '1v1' });

            this.fingerprints.set(gameType, state.fingerprint);
            this.lastFingerprintCheckAt.set(gameType, this.now());

            return {
                gameType,
                status: 'complete',
                reason,
                matches: computed.matchCount,
                games: computed.gameCount,
                players: computed.players.size,
                iterations: computed.iterations,
                ...written,
                syncRows: complete.updatedRows ?? 0,
                durationMs: this.now() - startedAt
            };
        } catch (error) {
            await this.syncDao.markGameRunnerFailed({ gameId: gameType, mode: '1v1', error }).catch(() => {});
            throw error;
        }
    }
}

const runner = new CompetitiveWhrRunner();

async function runPendingCompetitiveWhrRunner() {
    return runner.runPending();
}

module.exports = {
    CompetitiveWhrRunner,
    WHR_GAME_TYPES,
    DEFAULT_FINGERPRINT_CHECK_INTERVAL_MS,
    TST_NOT_COMPUTED_REASON,
    runPendingCompetitiveWhrRunner
};
