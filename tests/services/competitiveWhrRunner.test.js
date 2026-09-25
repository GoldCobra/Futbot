const {
    CompetitiveWhrRunner,
    TST_NOT_COMPUTED_REASON
} = require('../../src/services/competitiveWhrRunner');

const MATCHES = [
    { matchId: 1, player1: 10, player2: 20, p1Wins: 2, p1Losses: 1, day: 9000 },
    { matchId: 2, player1: 20, player2: 30, p1Wins: 2, p1Losses: 0, day: 9003 }
];

function createSyncDao({ backlog = new Map() } = {}) {
    return {
        markModeRunnerNotComputed: jest.fn(async () => ({ updatedRows: 0 })),
        applyPendingLegacyStats: jest.fn(async () => ({ stampedRows: 0, countedSingles: 0, countedDoubles: 0 })),
        getRunnerBacklogByGame: jest.fn(async () => backlog),
        markGameRunnerRunning: jest.fn(async () => ({ updatedRows: 1 })),
        markGameRunnerComplete: jest.fn(async () => ({ updatedRows: 1 })),
        markGameRunnerFailed: jest.fn(async () => ({ updatedRows: 1 }))
    };
}

function createWhrDao({ fingerprint = 'fp-1', history = [], ratings = [] } = {}) {
    return {
        fingerprint,
        getMatchFingerprint: jest.fn(async function getMatchFingerprint() { return this.fingerprint; }),
        loadGameState: jest.fn(async function loadGameState(gameType) {
            return { gameType, fingerprint: this.fingerprint, matches: MATCHES, history, ratings };
        }),
        applyDiff: jest.fn(async () => ({
            historyDeleted: 0,
            historyUpdated: 0,
            historyInserted: 4,
            statsInserted: 0,
            ratingsUpdated: 3
        }))
    };
}

function createRunner(overrides = {}) {
    let now = 1_000_000;
    const clock = {
        now: () => now,
        advance: ms => { now += ms; }
    };
    const syncDao = overrides.syncDao ?? createSyncDao();
    const whrDao = overrides.whrDao ?? createWhrDao();
    const runner = new CompetitiveWhrRunner({
        syncDao,
        whrDao,
        gameTypes: overrides.gameTypes ?? [3],
        fingerprintCheckIntervalMs: 60_000,
        whrOptions: overrides.whrOptions,
        now: clock.now
    });
    return { runner, syncDao, whrDao, clock };
}

describe('CompetitiveWhrRunner', () => {
    it('recalculates every game on the first run and writes the differences', async () => {
        const { runner, syncDao, whrDao } = createRunner({ gameTypes: [1, 2, 3] });

        const result = await runner.runPending();

        expect(whrDao.loadGameState.mock.calls.map(([gameType]) => gameType)).toEqual([1, 2, 3]);
        expect(whrDao.applyDiff).toHaveBeenCalledTimes(3);
        const [gameType, diff] = whrDao.applyDiff.mock.calls[0];
        expect(gameType).toBe(1);
        expect(diff.upserts).toHaveLength(4);
        expect(diff.ratingUpdates.map(update => update.playerId).sort()).toEqual([10, 20, 30]);
        expect(syncDao.markGameRunnerRunning).toHaveBeenCalledWith({ gameId: 1, mode: '1v1' });
        expect(syncDao.markGameRunnerComplete).toHaveBeenCalledWith({ gameId: 1, mode: '1v1' });
        expect(result.status).toBe('complete');
        expect(result.games[0]).toEqual(expect.objectContaining({
            gameType: 1,
            status: 'complete',
            reason: 'startup',
            matches: 2,
            players: 3,
            historyInserted: 4,
            ratingsUpdated: 3,
            syncRows: 1
        }));
    });

    it('marks 2v2 rows as not computed and applies pending legacy stats on every run', async () => {
        const { runner, syncDao } = createRunner();

        await runner.runPending();

        expect(syncDao.markModeRunnerNotComputed).toHaveBeenCalledWith({ mode: '2v2', reason: TST_NOT_COMPUTED_REASON });
        expect(syncDao.applyPendingLegacyStats).toHaveBeenCalledTimes(1);
        expect(syncDao.getRunnerBacklogByGame).toHaveBeenCalledWith({ mode: '1v1' });
    });

    it('stays idle when nothing changed since the last full recalculation', async () => {
        const { runner, whrDao } = createRunner();
        await runner.runPending();
        whrDao.loadGameState.mockClear();

        const result = await runner.runPending();

        expect(result.status).toBe('idle');
        expect(result.games).toEqual([]);
        expect(whrDao.loadGameState).not.toHaveBeenCalled();
        expect(whrDao.getMatchFingerprint).not.toHaveBeenCalled();
    });

    it('recalculates immediately when rated matches are waiting', async () => {
        const syncDao = createSyncDao();
        const { runner, whrDao } = createRunner({ syncDao });
        await runner.runPending();
        whrDao.loadGameState.mockClear();
        syncDao.getRunnerBacklogByGame.mockResolvedValue(new Map([[3, 2]]));

        const result = await runner.runPending();

        expect(whrDao.loadGameState).toHaveBeenCalledWith(3);
        expect(result.games[0].reason).toBe('backlog');
    });

    it('checks the match fingerprint only after the interval and recalculates when it changed', async () => {
        const { runner, whrDao, clock } = createRunner();
        await runner.runPending();
        whrDao.loadGameState.mockClear();

        clock.advance(30_000);
        await runner.runPending();
        expect(whrDao.getMatchFingerprint).not.toHaveBeenCalled();

        clock.advance(31_000);
        await runner.runPending();
        expect(whrDao.getMatchFingerprint).toHaveBeenCalledTimes(1);
        expect(whrDao.loadGameState).not.toHaveBeenCalled();

        whrDao.fingerprint = 'fp-2';
        clock.advance(61_000);
        const result = await runner.runPending();
        expect(whrDao.loadGameState).toHaveBeenCalledTimes(1);
        expect(result.games[0].reason).toBe('matches_changed');
    });

    it('does not write when the stored state already matches', async () => {
        const whrDao = createWhrDao();
        const { runner } = createRunner({ whrDao });
        await runner.runPending();
        const [, diff] = whrDao.applyDiff.mock.calls[0];
        const history = diff.upserts;
        const ratings = diff.ratingUpdates;
        whrDao.loadGameState.mockImplementation(async gameType => ({
            gameType, fingerprint: 'fp-2', matches: MATCHES, history, ratings
        }));
        whrDao.applyDiff.mockClear();
        whrDao.fingerprint = 'fp-2';
        runner.lastFingerprintCheckAt.clear();

        const result = await runner.runPending();

        expect(whrDao.applyDiff).not.toHaveBeenCalled();
        expect(result.games[0]).toEqual(expect.objectContaining({ historyInserted: 0, ratingsUpdated: 0 }));
    });

    it('marks a failed game, keeps going with the others and reports the failure', async () => {
        const whrDao = createWhrDao();
        whrDao.loadGameState.mockImplementation(async gameType => {
            if (gameType === 2) throw new Error('database unavailable');
            return { gameType, fingerprint: 'fp', matches: MATCHES, history: [], ratings: [] };
        });
        const { runner, syncDao } = createRunner({ whrDao, gameTypes: [1, 2, 3] });

        await expect(runner.runPending()).rejects.toMatchObject({
            message: expect.stringContaining('WHR recalculation failed for game type 2 (2: database unavailable)')
        });

        expect(syncDao.markGameRunnerFailed).toHaveBeenCalledWith({
            gameId: 2,
            mode: '1v1',
            error: expect.objectContaining({ message: 'database unavailable' })
        });
        expect(whrDao.applyDiff.mock.calls.map(([gameType]) => gameType)).toEqual([1, 3]);
    });

    it('never writes a result that did not converge', async () => {
        const { runner, whrDao, syncDao } = createRunner({ whrOptions: { maxIterations: 1 } });

        await expect(runner.runPending()).rejects.toThrow('did not converge');

        expect(whrDao.applyDiff).not.toHaveBeenCalled();
        expect(syncDao.markGameRunnerComplete).not.toHaveBeenCalled();
        expect(syncDao.markGameRunnerFailed).toHaveBeenCalled();
    });

    it('runs at most one recalculation at a time', async () => {
        const { runner, syncDao } = createRunner();

        const [first, second] = [runner.runPending(), runner.runPending()];

        expect(second).toBe(first);
        await first;
        expect(syncDao.applyPendingLegacyStats).toHaveBeenCalledTimes(1);
        await runner.runPending();
        expect(syncDao.applyPendingLegacyStats).toHaveBeenCalledTimes(2);
    });
});
