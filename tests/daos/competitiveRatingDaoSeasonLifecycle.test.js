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
const { executeQuery } = require('../../src/db/sqlClient');

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

describe('CompetitiveRatingDao season queue availability', () => {
    beforeEach(() => {
        executeQuery.mockReset();
        jest.useFakeTimers({ doNotFake: ['performance'] });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('blocks queueing when an active season has not reached StartDateUtc yet', async () => {
        jest.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
        executeQuery.mockResolvedValueOnce({
            recordset: [{
                Id: 2,
                SeasonNumber: 1,
                DisplayName: 'Burst Season 2026',
                StartDateUtc: '2026-06-04T08:00:00.000Z',
                EndDateUtc: '2026-09-02T08:00:00.000Z',
                IsActive: true,
                IsCompleted: false,
                LifecycleStatus: 'active'
            }]
        });

        const dao = new CompetitiveRatingDao();

        await expect(dao.getSeasonQueueAvailability()).resolves.toEqual(expect.objectContaining({
            canQueue: false,
            status: 'scheduled',
            message: 'Season has not started yet. Rated matches open soon.'
        }));
        expect(executeQuery).toHaveBeenCalledTimes(1);
    });

    it('allows queueing when an active season is within its scheduled window', async () => {
        jest.setSystemTime(new Date('2026-06-04T08:00:01.000Z'));
        const season = {
            Id: 2,
            SeasonNumber: 1,
            DisplayName: 'Burst Season 2026',
            StartDateUtc: '2026-06-04T08:00:00.000Z',
            EndDateUtc: '2026-09-02T08:00:00.000Z',
            IsActive: true,
            IsCompleted: false,
            LifecycleStatus: 'active'
        };
        executeQuery.mockResolvedValueOnce({ recordset: [season] });

        const dao = new CompetitiveRatingDao();

        await expect(dao.getSeasonQueueAvailability()).resolves.toEqual({
            canQueue: true,
            status: 'active',
            season,
            message: null
        });
        expect(executeQuery).toHaveBeenCalledTimes(1);
    });
});
