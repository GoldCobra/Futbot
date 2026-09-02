let mockTransaction;

jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: jest.fn(),
    getPool: jest.fn(async () => ({})),
    sql: {
        ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
        Transaction: jest.fn(() => mockTransaction)
    }
}));

const CompetitiveRatingDao = require('../../src/db/daos/competitiveRatingDao');

function createTransactionMock() {
    const calls = [];
    return {
        calls,
        request() {
            const inputs = {};
            return {
                input(name, value) { inputs[name] = value; return this; },
                async query(query) {
                    calls.push({ query, inputs: { ...inputs } });
                    // No candidates anywhere, so nothing is inserted and every award query still runs.
                    return { recordset: [], rowsAffected: [0] };
                }
            };
        }
    };
}

// The queries that pick award winners, keyed by something unique to each one.
const AWARD_QUERY_MARKERS = {
    'Most Wins / Most Active / Iron Player': 'WITH candidates AS',
    'Biggest Upset': 'AverageEloBefore',
    'Clutch / Sweep / Comeback King': 'GROUP BY crc.PlayerId',
    'Duo of the Season': 'winningPairs'
};

describe('season awards require a finished placement', () => {
    beforeEach(() => {
        mockTransaction = createTransactionMock();
    });

    it('applies the placement bar to every award, not just Top 10', async () => {
        const dao = new CompetitiveRatingDao();

        await dao._rebuildAwardPartition(mockTransaction, { seasonId: 2, gameId: 2, mode: '2v2' });

        const selects = mockTransaction.calls
            .map(call => call.query)
            .filter(query => !query.includes('DELETE'));

        expect(selects.length).toBeGreaterThan(0);

        // Every winner-selecting query must gate on PlacementComplete, either directly on the
        // rating row or through the EXISTS filter for the match-derived awards.
        for (const query of selects) {
            expect(query).toMatch(/PlacementComplete = 1/);
        }

        // And each award family is actually represented in this partition.
        for (const [name, marker] of Object.entries(AWARD_QUERY_MARKERS)) {
            expect(selects.some(query => query.includes(marker))).toBe(true);
            expect(name).toBeTruthy();
        }
    });

    it('checks both partners for Duo of the Season', async () => {
        const dao = new CompetitiveRatingDao();

        await dao._rebuildAwardPartition(mockTransaction, { seasonId: 2, gameId: 2, mode: '2v2' });

        const duo = mockTransaction.calls.map(c => c.query).find(q => q.includes('winningPairs'));

        expect(duo).toBeDefined();
        expect(duo).toContain('placed.PlayerId = p1.PlayerId');
        expect(duo).toContain('placed.PlayerId = p2.PlayerId');
    });

    it('scopes the placement lookup to the same season, game and mode', async () => {
        const dao = new CompetitiveRatingDao();

        await dao._rebuildAwardPartition(mockTransaction, { seasonId: 2, gameId: 3, mode: '1v1' });

        const upset = mockTransaction.calls.map(c => c.query).find(q => q.includes('AverageEloBefore'));

        // A placement finished in another game or mode must not qualify a player here.
        expect(upset).toContain('placed.SeasonId = @seasonId');
        expect(upset).toContain('placed.GameId = @gameId');
        expect(upset).toContain('placed.ModeCode = @mode');
    });
});
