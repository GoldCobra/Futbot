const mockRecordMatchCompletion = jest.fn();
const mockRollbackMatchByNumber = jest.fn();
const mockGetRollbackCommitState = jest.fn();
const mockGetActiveSeason = jest.fn();
const mockGetSeasonQueueAvailability = jest.fn();
const mockSyncCompletedMatch = jest.fn();
const mockMarkRolledBack = jest.fn();
const mockSyncPendingCompletedMatches = jest.fn();

jest.mock('../../src/db/daos/competitiveRatingDao', () => jest.fn().mockImplementation(() => ({
    getActiveSeason: (...args) => mockGetActiveSeason(...args),
    getSeasonQueueAvailability: (...args) => mockGetSeasonQueueAvailability(...args),
    recordMatchCompletion: (...args) => mockRecordMatchCompletion(...args),
    rollbackMatchByNumber: (...args) => mockRollbackMatchByNumber(...args),
    getRollbackCommitState: (...args) => mockGetRollbackCommitState(...args)
})));

jest.mock('../../src/db/daos/competitiveWhrSyncDao', () => jest.fn().mockImplementation(() => ({
    syncCompletedMatch: (...args) => mockSyncCompletedMatch(...args),
    markRolledBack: (...args) => mockMarkRolledBack(...args),
    syncPendingCompletedMatches: (...args) => mockSyncPendingCompletedMatches(...args)
})));

const {
    getSeasonQueueAvailability,
    recordCompetitiveResult,
    rollbackCompetitiveMatch,
    recoverPendingCompetitiveWhrSync
} = require('../../src/services/competitiveRating');

describe('competitiveRating WHR/TST sync hooks', () => {
    beforeEach(() => {
        mockRecordMatchCompletion.mockReset();
        mockRollbackMatchByNumber.mockReset();
        mockGetRollbackCommitState.mockReset();
        mockGetActiveSeason.mockReset();
        mockGetSeasonQueueAvailability.mockReset();
        mockSyncCompletedMatch.mockReset();
        mockMarkRolledBack.mockReset();
        mockSyncPendingCompletedMatches.mockReset();

        mockGetActiveSeason.mockResolvedValue({ Id: 2, DisplayName: 'Burst Season 2026' });
        mockGetSeasonQueueAvailability.mockResolvedValue({
            canQueue: true,
            status: 'active',
            season: { Id: 2, DisplayName: 'Burst Season 2026' },
            message: null
        });
        mockRecordMatchCompletion.mockResolvedValue([
            { playerId: 1, discordId: 'p1', teamNumber: 1, outcome: 'win', eloDelta: 50 },
            { playerId: 2, discordId: 'p2', teamNumber: 2, outcome: 'loss', eloDelta: 0 }
        ]);
        mockSyncCompletedMatch.mockResolvedValue({ syncStatus: 'synced' });
        mockMarkRolledBack.mockResolvedValue({ syncStatus: 'rolled_back' });
        mockGetRollbackCommitState.mockResolvedValue({
            matchId: 88,
            matchStatus: 'rolled_back',
            rollbackId: 9,
            rollbackRatedMatchId: 88,
            rollbackSnapshotCount: 2,
            currentChangeCount: 2,
            whrSyncId: 14,
            whrSyncStatus: 'rolled_back'
        });
        mockSyncPendingCompletedMatches.mockResolvedValue([{ ratedMatchId: 77, syncStatus: 'synced' }]);
    });

    it('schedules WHR/TST sync after a stored competitive completion without blocking the result', async () => {
        const result = await recordCompetitiveResult({
            ratedMatchId: 77,
            matchCode: 'match-77',
            gameType: 1,
            mode: '1v1',
            winnerTeamNumber: 1,
            team1Score: 2,
            team2Score: 0,
            homeTeamNumber: 1,
            awayTeamNumber: 2
        });

        expect(result.changes).toHaveLength(2);
        expect(mockSyncCompletedMatch).not.toHaveBeenCalled();

        await new Promise(resolve => setTimeout(resolve, 0));

        expect(mockSyncCompletedMatch).toHaveBeenCalledWith({ ratedMatchId: 77 });
    });

    it('can skip automatic WHR/TST mirroring for manually linked reports', async () => {
        const result = await recordCompetitiveResult({
            ratedMatchId: 77,
            matchCode: 'manual-report:match:12345',
            gameType: 1,
            mode: '1v1',
            winnerTeamNumber: 1,
            team1Score: 2,
            team2Score: 0,
            homeTeamNumber: 1,
            awayTeamNumber: 2,
            skipWhrSync: true
        });

        expect(result.changes).toHaveLength(2);

        await new Promise(resolve => setTimeout(resolve, 0));

        expect(mockSyncCompletedMatch).not.toHaveBeenCalled();
    });

    it('passes historical completion timestamps through for report backfills', async () => {
        const completedAtUtc = new Date('2026-06-04T18:22:52.000Z');

        await recordCompetitiveResult({
            ratedMatchId: 77,
            matchCode: 'manual:1:22685',
            gameType: 1,
            mode: '1v1',
            winnerTeamNumber: 1,
            team1Score: 3,
            team2Score: 0,
            homeTeamNumber: 1,
            awayTeamNumber: 2,
            skipWhrSync: true,
            completedAtUtc
        });

        expect(mockRecordMatchCompletion).toHaveBeenCalledWith(expect.objectContaining({
            ratedMatchId: 77,
            matchCode: 'manual:1:22685',
            completedAtUtc
        }), expect.any(Function));
    });

    it('marks the WHR/TST sync row rolled back after a competitive rollback', async () => {
        mockRollbackMatchByNumber.mockResolvedValue({
            status: 'rolled_back',
            matchId: 88,
            rollbackId: 9,
            gameId: 1,
            gameCode: 'MSBL',
            mode: '2v2',
            matchNumber: 12,
            snapshotCount: 2
        });

        const result = await rollbackCompetitiveMatch({
            gameId: 1,
            mode: '2v2',
            matchNumber: 12,
            reason: 'wrong report',
            rolledBackByDiscordId: 'staff-1'
        });

        expect(mockMarkRolledBack).toHaveBeenCalledWith({ ratedMatchId: 88 });
        expect(mockGetRollbackCommitState).toHaveBeenCalledWith({
            gameId: 1,
            mode: '2v2',
            matchNumber: 12
        });
        expect(result.whrSync).toEqual({ syncStatus: 'rolled_back' });
        expect(result.dbVerification).toEqual(expect.objectContaining({
            verified: true,
            matchStatus: 'rolled_back',
            rollbackId: 9,
            whrSyncStatus: 'rolled_back'
        }));
    });

    it('rejects a rollback success response when the DB readback does not show the match rolled back', async () => {
        mockRollbackMatchByNumber.mockResolvedValue({
            status: 'rolled_back',
            matchId: 88,
            rollbackId: 9,
            gameId: 1,
            gameCode: 'MSBL',
            mode: '1v1',
            matchNumber: 12,
            snapshotCount: 2
        });
        mockGetRollbackCommitState.mockResolvedValue({
            matchId: 88,
            matchStatus: 'completed',
            rollbackId: 9,
            rollbackRatedMatchId: 88,
            rollbackSnapshotCount: 2,
            currentChangeCount: 2,
            whrSyncId: 14,
            whrSyncStatus: 'rolled_back'
        });

        await expect(rollbackCompetitiveMatch({
            gameId: 1,
            mode: '1v1',
            matchNumber: 12,
            reason: 'wrong report',
            rolledBackByDiscordId: 'staff-1'
        })).rejects.toThrow("RatedMatch status is 'completed', expected 'rolled_back'");
    });

    it('exposes DB-backed WHR/TST sync recovery for startup and tick retries', async () => {
        const result = await recoverPendingCompetitiveWhrSync();

        expect(mockSyncPendingCompletedMatches).toHaveBeenCalledTimes(1);
        expect(result).toEqual([{ ratedMatchId: 77, syncStatus: 'synced' }]);
    });

    it('keeps active queue availability open even when WHR/TST backfill is not configured yet', async () => {
        const result = await getSeasonQueueAvailability();

        expect(result).toEqual({
            canQueue: true,
            status: 'active',
            season: { Id: 2, DisplayName: 'Burst Season 2026' },
            message: null
        });
    });

    it('keeps existing season availability blocks unchanged', async () => {
        mockGetSeasonQueueAvailability.mockResolvedValue({
            canQueue: false,
            status: 'scheduled',
            season: { Id: 2, DisplayName: 'Burst Season 2026' },
            message: 'Season has not started yet. Rated matches open soon.'
        });

        await expect(getSeasonQueueAvailability()).resolves.toEqual({
            canQueue: false,
            status: 'scheduled',
            season: { Id: 2, DisplayName: 'Burst Season 2026' },
            message: 'Season has not started yet. Rated matches open soon.'
        });
    });
});
