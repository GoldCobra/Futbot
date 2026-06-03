let mockTransaction;
const mockGetPool = jest.fn(async () => ({}));

jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: jest.fn(),
    getPool: (...args) => mockGetPool(...args),
    sql: {
        ISOLATION_LEVEL: {
            SERIALIZABLE: 'SERIALIZABLE'
        },
        Transaction: jest.fn(() => mockTransaction)
    }
}));

const CompetitiveRatingDao = require('../../src/db/daos/competitiveRatingDao');

function createActivationTransactionMock() {
    const calls = [];
    const activeSeason = {
        Id: 3,
        SeasonNumber: 2,
        DisplayName: 'Next Season',
        StartDateUtc: '2026-09-03T08:00:00.000Z',
        EndDateUtc: '2026-12-02T08:00:00.000Z',
        LifecycleStatus: 'active',
        IsActive: true,
        IsCompleted: false,
        SoftResetFactor: 0.70
    };

    return {
        calls,
        begin: jest.fn(async () => {}),
        commit: jest.fn(async () => {}),
        rollback: jest.fn(async () => {}),
        request() {
            const inputs = {};
            return {
                input(name, value) {
                    inputs[name] = value;
                    return this;
                },
                async query(query) {
                    calls.push({ query, inputs: { ...inputs } });

                    if (query.includes('sys.sp_getapplock')) {
                        return { recordset: [{ LockResult: 0 }] };
                    }
                    if (query.includes("LifecycleStatus IN ('active','ending')")) {
                        return { recordset: [] };
                    }
                    if (query.includes("LifecycleStatus = 'scheduled'")) {
                        return { recordset: [{ ...activeSeason, LifecycleStatus: 'scheduled', IsActive: false }] };
                    }
                    if (query.includes("LifecycleStatus = 'completed'")) {
                        return { recordset: [{ Id: 2 }] };
                    }
                    if (query.includes('SELECT TOP 1 MinElo')) {
                        return { recordset: [{ MinElo: 500 }] };
                    }
                    if (query.includes('INSERT INTO')) {
                        return { recordset: [], rowsAffected: [1] };
                    }
                    if (query.includes('UPDATE') && query.includes('OUTPUT INSERTED.*')) {
                        return { recordset: [activeSeason], rowsAffected: [1] };
                    }

                    throw new Error(`Unexpected activateDueSeason query: ${query}`);
                }
            };
        }
    };
}

describe('CompetitiveRatingDao season activation', () => {
    beforeEach(() => {
        mockGetPool.mockClear();
        mockTransaction = createActivationTransactionMock();
    });

    it('initializes season match sequences when activating a scheduled season', async () => {
        const dao = new CompetitiveRatingDao();

        const result = await dao.activateDueSeason();

        const queries = mockTransaction.calls.map(call => call.query);
        expect(result).toEqual(expect.objectContaining({ Id: 3, LifecycleStatus: 'active' }));
        expect(mockTransaction.begin).toHaveBeenCalledWith('SERIALIZABLE');
        expect(mockTransaction.commit).toHaveBeenCalled();
        expect(queries.join('\n')).not.toContain('undefined');
        expect(queries.some(query => (
            query.includes('INSERT INTO') && query.includes('CompetitiveSeasonMatchSequence')
        ))).toBe(true);
    });
});
