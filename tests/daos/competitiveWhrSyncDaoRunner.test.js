const mockExecuteQuery = jest.fn();
let mockTransaction;

jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: (...args) => mockExecuteQuery(...args),
    getPool: jest.fn(async () => ({})),
    sql: {
        Int: 'Int',
        TinyInt: 'TinyInt',
        VarChar: length => ({ type: 'VarChar', length }),
        NVarChar: length => ({ type: 'NVarChar', length }),
        ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
        Transaction: jest.fn(() => mockTransaction)
    }
}));

const CompetitiveWhrSyncDao = require('../../src/db/daos/competitiveWhrSyncDao');
const { buildStatsDeltaUpdate } = require('../../src/db/daos/competitiveWhrSyncDao');

function createTransactionMock(respond = () => ({ recordset: [], rowsAffected: [0] })) {
    const calls = [];
    return {
        calls,
        begin: jest.fn(async () => {}),
        commit: jest.fn(async () => {}),
        rollback: jest.fn(async () => {}),
        request: jest.fn(() => {
            const inputs = {};
            const request = {
                input: jest.fn(function input(key, typeOrValue, maybeValue) {
                    inputs[key] = arguments.length >= 3 ? maybeValue : typeOrValue;
                    return request;
                }),
                query: jest.fn(async query => {
                    calls.push({ query, inputs: { ...inputs } });
                    return respond(query, inputs);
                })
            };
            return request;
        })
    };
}

describe('CompetitiveWhrSyncDao runner status per game', () => {
    beforeEach(() => {
        mockExecuteQuery.mockReset();
    });

    it('counts the open WHR backlog per game, including abandoned running rows', async () => {
        mockExecuteQuery.mockResolvedValue({ recordset: [{ GameId: 1, BacklogCount: 73 }, { GameId: 3, BacklogCount: 288 }] });
        const dao = new CompetitiveWhrSyncDao();

        const backlog = await dao.getRunnerBacklogByGame({ mode: '1v1' });

        const [query, inputs] = mockExecuteQuery.mock.calls[0];
        expect(query).toContain("WhrRunnerStatus IN ('pending_external_runner','failed','not_configured')");
        expect(query).toContain("WhrRunnerStatus = 'running' AND LastAttemptAtUtc < DATEADD(minute, -30, SYSUTCDATETIME())");
        expect(query).toContain("SyncStatus IN ('synced','rolled_back')");
        expect(query).toContain('GROUP BY GameId');
        expect(inputs).toEqual({ modeCode: [{ type: 'VarChar', length: 10 }, '1v1'] });
        expect([...backlog]).toEqual([[1, 73], [3, 288]]);
    });

    it('moves the whole backlog of a game to running in one statement', async () => {
        mockExecuteQuery.mockResolvedValue({ rowsAffected: [288], recordset: [] });
        const dao = new CompetitiveWhrSyncDao();

        const result = await dao.markGameRunnerRunning({ gameId: 3, mode: '1v1' });

        const [query, inputs] = mockExecuteQuery.mock.calls[0];
        expect(query).toContain("SET WhrRunnerStatus = 'running'");
        expect(query).toContain('AttemptCount = AttemptCount + 1');
        expect(query).toContain("WhrRunnerStatus IN ('pending_external_runner','failed','not_configured')");
        expect(query).not.toContain('TOP');
        expect(inputs).toEqual({
            gameId: ['TinyInt', 3],
            modeCode: [{ type: 'VarChar', length: 10 }, '1v1']
        });
        expect(result).toEqual({ updatedRows: 288 });
    });

    it('completes and fails only rows that are running', async () => {
        mockExecuteQuery.mockResolvedValue({ rowsAffected: [2], recordset: [] });
        const dao = new CompetitiveWhrSyncDao();

        await dao.markGameRunnerComplete({ gameId: 1 });
        await dao.markGameRunnerFailed({ gameId: 1, error: new Error('boom') });

        const [completeQuery] = mockExecuteQuery.mock.calls[0];
        expect(completeQuery).toContain("SET WhrRunnerStatus = 'complete'");
        expect(completeQuery).toContain("WhrRunnerStatus = 'running'");
        const [failQuery, failInputs] = mockExecuteQuery.mock.calls[1];
        expect(failQuery).toContain("SET WhrRunnerStatus = 'failed'");
        expect(failQuery).toContain('LastError = @lastError');
        expect(failInputs.lastError).toEqual([{ type: 'NVarChar', length: 1000 }, 'boom']);
    });

    it('marks open 2v2 rows as not computed, and refreshes an outdated reason', async () => {
        mockExecuteQuery.mockResolvedValue({ rowsAffected: [9], recordset: [] });
        const dao = new CompetitiveWhrSyncDao();

        const result = await dao.markModeRunnerNotComputed({ mode: '2v2', reason: 'TST is not recalculated.' });

        const [query, inputs] = mockExecuteQuery.mock.calls[0];
        expect(query).toContain("SET WhrRunnerStatus = 'not_configured'");
        expect(query).toContain("WhrRunnerStatus IN ('pending_external_runner','failed','running')");
        expect(query).toContain("WhrRunnerStatus = 'not_configured' AND ISNULL(LastError, N'') <> @lastError");
        expect(inputs).toEqual({
            modeCode: [{ type: 'VarChar', length: 10 }, '2v2'],
            lastError: [{ type: 'NVarChar', length: 1000 }, 'TST is not recalculated.']
        });
        expect(result).toEqual({ updatedRows: 9 });
    });
});

describe('CompetitiveWhrSyncDao legacy stats', () => {
    it('counts only futbot mirrors, aggregated per player, and stamps every pending row once', async () => {
        mockTransaction = createTransactionMock(() => ({
            recordset: [{ StampedRows: 12, CountedSingles: 9, CountedDoubles: 1 }],
            rowsAffected: [0]
        }));
        const dao = new CompetitiveWhrSyncDao();

        const result = await dao.applyPendingLegacyStats();

        expect(mockTransaction.begin).toHaveBeenCalled();
        expect(mockTransaction.commit).toHaveBeenCalled();
        const { query } = mockTransaction.calls[0];
        expect(query).toContain('WITH (UPDLOCK, HOLDLOCK)');
        expect(query).toContain("sync.SyncStatus = 'synced'");
        expect(query).toContain('sync.LegacyStatsAppliedAtUtc IS NULL');
        expect(query).toContain("legacy.Notes = CONCAT('CompetitiveRatedMatch:', sync.RatedMatchId)");
        expect(query).toContain("legacyMulti.Channel = CONCAT('Competitive Rated ', game.Code, ' ', sync.ModeCode, ' #', sync.MatchNumber)");
        expect(query).toContain('MatchWins = ps.MatchWins + delta.MatchWins');
        expect(query).toContain('Wins2v2 = ps.Wins2v2 + delta.Wins2v2');
        expect(query).toContain('GROUP BY GameType, Player');
        expect(query).toContain('SET LegacyStatsAppliedAtUtc = @appliedAtUtc');
        expect(result).toEqual({ stampedRows: 12, countedSingles: 9, countedDoubles: 1 });
    });

    it('rolls back when counting fails', async () => {
        mockTransaction = createTransactionMock(() => {
            throw new Error('deadlock');
        });
        const dao = new CompetitiveWhrSyncDao();

        await expect(dao.applyPendingLegacyStats()).rejects.toThrow('deadlock');

        expect(mockTransaction.rollback).toHaveBeenCalled();
        expect(mockTransaction.commit).not.toHaveBeenCalled();
    });

    it('builds a delta update that never takes a counter below 0', () => {
        const query = buildStatsDeltaUpdate('SELECT 1 AS GameType, 2 AS Player, 3 AS GamesWon, 1 AS GamesLost', { doubles: true, sign: -1 });

        expect(query).toContain('MatchWins2v2 = CASE WHEN ps.MatchWins2v2 < delta.MatchWins2v2 THEN 0 ELSE ps.MatchWins2v2 - delta.MatchWins2v2 END');
        expect(query).toContain('SUM(CASE WHEN GamesWon = GamesLost THEN 1 ELSE 0 END) AS MatchDraws2v2');
        expect(query).toContain('WHERE Player IS NOT NULL');
    });
});

describe('CompetitiveWhrSyncDao rollback of legacy rows', () => {
    function rollbackTransaction(syncRow) {
        return createTransactionMock(query => {
            if (query.includes('SELECT TOP 1 *')) return { recordset: [syncRow], rowsAffected: [1] };
            if (query.includes('OUTPUT INSERTED.*')) return { recordset: [{ ...syncRow, SyncStatus: 'rolled_back' }], rowsAffected: [1] };
            return { recordset: [], rowsAffected: [1] };
        });
    }

    it('takes a counted mirror back out of PlayerStats before deleting it', async () => {
        mockTransaction = rollbackTransaction({
            Id: 5, RatedMatchId: 77, GameId: 3, ModeCode: '1v1', MatchNumber: 12,
            SyncStatus: 'synced', LegacyMatchId: 9101, LegacyMultiMatchId: null,
            LegacyStatsAppliedAtUtc: new Date('2026-09-25T10:00:00Z')
        });
        const dao = new CompetitiveWhrSyncDao();

        await dao.markRolledBack({ ratedMatchId: 77 });

        const queries = mockTransaction.calls.map(call => call.query);
        const reverseIndex = queries.findIndex(query => query.includes('MatchWins = CASE WHEN ps.MatchWins < delta.MatchWins'));
        const deleteIndex = queries.findIndex(query => query.includes('DELETE FROM dbo.Match'));
        expect(reverseIndex).toBeGreaterThan(-1);
        expect(reverseIndex).toBeLessThan(deleteIndex);
        expect(mockTransaction.calls[reverseIndex].inputs).toEqual({
            legacyMatchId: 9101,
            statsApplied: 1,
            mirrorNotes: 'CompetitiveRatedMatch:77'
        });
        expect(queries[reverseIndex]).toContain("(@statsApplied = 1 OR ISNULL(m.Notes, N'') <> @mirrorNotes)");
        expect(mockTransaction.commit).toHaveBeenCalled();
    });

    it('leaves a mirror untouched in PlayerStats when its stats were never applied', async () => {
        mockTransaction = rollbackTransaction({
            Id: 6, RatedMatchId: 78, GameId: 2, ModeCode: '2v2', MatchNumber: 4,
            SyncStatus: 'synced', LegacyMatchId: null, LegacyMultiMatchId: 9202,
            LegacyStatsAppliedAtUtc: null
        });
        const dao = new CompetitiveWhrSyncDao();

        await dao.markRolledBack({ ratedMatchId: 78 });

        const reverse = mockTransaction.calls.find(call => call.query.includes('MatchWins2v2 = CASE'));
        expect(reverse.inputs).toEqual(expect.objectContaining({
            legacyMultiMatchId: 9202,
            statsApplied: 0,
            gameId: 2,
            modeCode: '2v2',
            matchNumber: 4
        }));
        expect(reverse.query).toContain("ISNULL(mm.Tournament, N'') = 'Competitive Rated'");
    });

    it('does not reverse anything twice for a row that is already rolled back', async () => {
        mockTransaction = rollbackTransaction({
            Id: 7, RatedMatchId: 79, GameId: 1, ModeCode: '1v1', MatchNumber: 3,
            SyncStatus: 'rolled_back', LegacyMatchId: 9303, LegacyMultiMatchId: null,
            LegacyStatsAppliedAtUtc: new Date()
        });
        const dao = new CompetitiveWhrSyncDao();

        await dao.markRolledBack({ ratedMatchId: 79 });

        expect(mockTransaction.calls.some(call => call.query.includes('UPDATE ps'))).toBe(false);
    });
});
