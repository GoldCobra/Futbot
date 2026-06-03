const mockExecuteQuery = jest.fn();

jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: (...args) => mockExecuteQuery(...args),
    getPool: jest.fn(),
    sql: {
        Int: 'Int',
        TinyInt: 'TinyInt',
        VarChar: length => ({ type: 'VarChar', length }),
        NVarChar: length => ({ type: 'NVarChar', length })
    }
}));

const CompetitiveWhrSyncDao = require('../../src/db/daos/competitiveWhrSyncDao');

describe('CompetitiveWhrSyncDao runner status methods', () => {
    beforeEach(() => {
        mockExecuteQuery.mockReset();
    });

    it('groups pending external runner rows by game and mode', async () => {
        mockExecuteQuery.mockResolvedValue({
            recordset: [
                { Id: 10, GameId: 1, ModeCode: '1v1' },
                { Id: 11, GameId: 1, ModeCode: '1v1' },
                { Id: 20, GameId: 2, ModeCode: '2v2' }
            ]
        });
        const dao = new CompetitiveWhrSyncDao();

        const result = await dao.getPendingRunnerPartitions({ limit: 25 });

        expect(mockExecuteQuery).toHaveBeenCalledWith(
            expect.stringContaining("WhrRunnerStatus IN (@runnerStatus0)"),
            expect.objectContaining({
                limit: ['Int', 25],
                runnerStatus0: [{ type: 'VarChar', length: 30 }, 'pending_external_runner']
            })
        );
        const [query] = mockExecuteQuery.mock.calls[0];
        expect(query).toContain('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        expect(query).toContain('WITH (READPAST)');
        expect(result).toEqual([
            { gameId: 1, mode: '1v1', syncIds: [10, 11], count: 2 },
            { gameId: 2, mode: '2v2', syncIds: [20], count: 1 }
        ]);
    });

    it('marks only pending runner rows as not configured', async () => {
        mockExecuteQuery.mockResolvedValue({ rowsAffected: [2], recordset: [] });
        const dao = new CompetitiveWhrSyncDao();

        const result = await dao.markRunnerNotConfigured({
            gameId: 1,
            mode: '1v1',
            syncIds: [10, 11],
            reason: 'missing algorithm'
        });

        const [query, inputs] = mockExecuteQuery.mock.calls[0];
        expect(query).toContain("SET WhrRunnerStatus = @whrRunnerStatus");
        expect(query).toContain("SyncStatus IN ('synced','rolled_back')");
        expect(query).toContain("WhrRunnerStatus IN (@expectedRunnerStatus0)");
        expect(query).toContain("Id IN (@syncId0, @syncId1)");
        expect(inputs).toEqual(expect.objectContaining({
            gameId: ['TinyInt', 1],
            modeCode: [{ type: 'VarChar', length: 10 }, '1v1'],
            whrRunnerStatus: [{ type: 'VarChar', length: 30 }, 'not_configured'],
            lastError: [{ type: 'NVarChar', length: 1000 }, 'missing algorithm'],
            expectedRunnerStatus0: [{ type: 'VarChar', length: 30 }, 'pending_external_runner'],
            syncId0: ['Int', 10],
            syncId1: ['Int', 11]
        }));
        expect(result).toEqual({
            updatedRows: 2,
            whrRunnerStatus: 'not_configured'
        });
    });

    it('uses running as the expected source state before marking complete', async () => {
        mockExecuteQuery.mockResolvedValue({ rowsAffected: [1], recordset: [] });
        const dao = new CompetitiveWhrSyncDao();

        await dao.markRunnerComplete({ gameId: 1, mode: '2v2', syncIds: [99] });

        const [query, inputs] = mockExecuteQuery.mock.calls[0];
        expect(query).toContain("LastError = NULL");
        expect(inputs).toEqual(expect.objectContaining({
            whrRunnerStatus: [{ type: 'VarChar', length: 30 }, 'complete'],
            expectedRunnerStatus0: [{ type: 'VarChar', length: 30 }, 'running'],
            syncId0: ['Int', 99]
        }));
    });
});
