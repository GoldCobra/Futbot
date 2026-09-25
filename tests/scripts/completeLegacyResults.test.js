jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: jest.fn(),
    getPool: jest.fn(),
    closePool: jest.fn(),
    sql: {}
}));

const {
    classifyQueueCandidates,
    buildApplySql,
    MAX_QUEUE_BACKFILL,
    MAX_SURE_DUPLICATES
} = require('../../scripts/completeLegacyResults');

function candidateRow(overrides = {}) {
    return {
        ID: 100,
        Player1: 1,
        Player2: 2,
        P1Wins: 2,
        P2Wins: 0,
        FirstTo: 2,
        LobbyDate: new Date('2023-05-03T08:44:00Z'),
        PairReportedNearby: 0,
        Player1Name: 'A',
        Player2Name: 'B',
        GameType: 3,
        ...overrides
    };
}

describe('completeLegacyResults', () => {
    it('adds a decided queue match whose game is clear', () => {
        const { insert, review } = classifyQueueCandidates([candidateRow()]);

        expect(review).toEqual([]);
        expect(insert).toEqual([expect.objectContaining({ rankedMatchId: 100, gameType: 3, p1Wins: 2, p2Wins: 0 })]);
    });

    it('sends every unclear case to the review list instead of guessing', () => {
        const { insert, review } = classifyQueueCandidates([
            candidateRow({ ID: 1, GameType: 2 }),
            candidateRow({ ID: 1, GameType: 3 }),
            candidateRow({ ID: 2, GameType: null }),
            candidateRow({ ID: 3, P1Wins: 1, P2Wins: 1 }),
            candidateRow({ ID: 4, PairReportedNearby: 1 })
        ]);

        expect(insert).toEqual([]);
        expect(review.map(row => [row.rankedMatchId, row.reason])).toEqual([
            [1, 'game ambiguous (2/3)'],
            [2, 'game unknown (no activity of both players within 60 days)'],
            [3, 'not decided (1-1, first to 2)'],
            [4, 'pair already reported within 2 days with a different result']
        ]);
    });

    it('writes with hard caps, idempotently and without reactivating players', () => {
        const query = buildApplySql();

        expect(MAX_QUEUE_BACKFILL).toBe(70);
        expect(MAX_SURE_DUPLICATES).toBe(3);
        expect(query).toContain('SET XACT_ABORT ON');
        expect(query).toContain(`> ${MAX_QUEUE_BACKFILL}`);
        expect(query).toContain(`> ${MAX_SURE_DUPLICATES}`);
        expect(query).toContain("NOT EXISTS (SELECT 1 FROM dbo.Match m WHERE m.Notes = CONCAT('RankedMatch:', b.RankedMatchId))");
        expect(query).toContain("CONCAT(N'Rated Match ', r.ID, N' - backfill')");
        expect(query).toContain('A duplicate is linked to a competitive rated match');
        expect(query).toContain('INTO #ActiveBefore');
        expect(query).toContain('SET IsActive = a.IsActive');
        expect(query).toContain('MatchWins = ps.MatchWins + delta.MatchWins');
        expect(query).toContain('MatchWins = CASE WHEN ps.MatchWins < delta.MatchWins THEN 0 ELSE ps.MatchWins - delta.MatchWins END');
        expect(query.indexOf('CASE WHEN ps.MatchWins < delta.MatchWins')).toBeLessThan(query.indexOf('DELETE m FROM dbo.Match m'));
    });
});
