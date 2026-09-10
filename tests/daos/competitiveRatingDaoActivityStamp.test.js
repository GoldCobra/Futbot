jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: jest.fn(),
    getPool: jest.fn(async () => ({})),
    sql: {
        ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
        Transaction: jest.fn()
    }
}));

const CompetitiveRatingDao = require('../../src/db/daos/competitiveRatingDao');

function createTransactionMock() {
    const queries = [];
    return {
        queries,
        request() {
            return {
                input() {
                    return this;
                },
                async query(query) {
                    queries.push(query);
                    return { recordset: [] };
                }
            };
        }
    };
}

function sessionContextCalls(queries) {
    return queries.filter(query => query.includes('sp_set_session_context'));
}

describe('competitiveRatingDao player activity stamp', () => {
    it('suppresses the activity stamp around the wrapped work and clears it afterwards', async () => {
        const dao = new CompetitiveRatingDao();
        const transaction = createTransactionMock();

        const result = await dao._withoutPlayerActivityStamp(transaction, async () => {
            transaction.request().query('SELECT 1 AS Work');
            return 'done';
        });

        expect(result).toBe('done');
        const contextCalls = sessionContextCalls(transaction.queries);
        expect(contextCalls).toHaveLength(2);
        expect(contextCalls[0]).toContain("@value = 1");
        expect(contextCalls[1]).toContain('@value = NULL');
        // Order is the whole point: set, then the work, then clear.
        expect(transaction.queries).toEqual([
            expect.stringContaining("@value = 1"),
            'SELECT 1 AS Work',
            expect.stringContaining('@value = NULL')
        ]);
    });

    it('still clears the flag when the wrapped work throws', async () => {
        // sp_set_session_context survives a rollback and the connection returns to the pool, so a
        // leaked flag would silently disable activity stamping for every later query on it.
        const dao = new CompetitiveRatingDao();
        const transaction = createTransactionMock();

        await expect(dao._withoutPlayerActivityStamp(transaction, async () => {
            throw new Error('rebuild blew up');
        })).rejects.toThrow('rebuild blew up');

        const contextCalls = sessionContextCalls(transaction.queries);
        expect(contextCalls).toHaveLength(2);
        expect(contextCalls.at(-1)).toContain('@value = NULL');
    });

    it('routes the partition rebuild through the suppression wrapper', async () => {
        // Both rollbackMatchByNumber and rebuildRatingPartition go through _rebuildRatingPartition,
        // so wrapping it there covers both callers.
        const dao = new CompetitiveRatingDao();
        const transaction = createTransactionMock();
        const options = { seasonId: 1, gameId: 3, mode: '1v1' };
        const core = jest.spyOn(dao, '_rebuildRatingPartitionCore').mockResolvedValue('rebuilt');

        const result = await dao._rebuildRatingPartition(transaction, options);

        expect(result).toBe('rebuilt');
        expect(core).toHaveBeenCalledWith(transaction, options);
        expect(sessionContextCalls(transaction.queries)).toHaveLength(2);
    });
});
