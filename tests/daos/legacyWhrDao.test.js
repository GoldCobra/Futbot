const mockExecuteQuery = jest.fn();
let mockTransaction;

jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: (...args) => mockExecuteQuery(...args),
    getPool: jest.fn(async () => ({})),
    sql: {
        Int: 'Int',
        MAX: 'MAX',
        NVarChar: length => ({ type: 'NVarChar', length }),
        Transaction: jest.fn(() => mockTransaction)
    }
}));

const LegacyWhrDao = require('../../src/db/daos/legacyWhrDao');

function createTransactionMock(respond) {
    const calls = [];
    return {
        calls,
        begin: jest.fn(async () => {}),
        commit: jest.fn(async () => {}),
        rollback: jest.fn(async () => {}),
        request: jest.fn(() => {
            const inputs = {};
            const request = {
                input: jest.fn((key, type, value) => {
                    inputs[key] = value;
                    return request;
                }),
                query: jest.fn(async query => {
                    calls.push({ query, inputs: { ...inputs } });
                    return respond(query);
                })
            };
            return request;
        })
    };
}

describe('LegacyWhrDao', () => {
    beforeEach(() => {
        mockExecuteQuery.mockReset();
    });

    it('builds a fingerprint of the reported results of one game', async () => {
        mockExecuteQuery.mockResolvedValue({ recordset: [{ MatchCount: 10325, MaxMatchId: 23179, MatchChecksum: -1234 }] });
        const dao = new LegacyWhrDao();

        const fingerprint = await dao.getMatchFingerprint(3);

        const [query, inputs] = mockExecuteQuery.mock.calls[0];
        expect(query).toContain('CHECKSUM_AGG(BINARY_CHECKSUM([Match], Player1, Player2, P1Wins, P1Losses, MatchDate, FutureMatch))');
        expect(query).toContain('WHERE GameType = @gameType');
        expect(inputs).toEqual({ gameType: ['Int', 3] });
        expect(fingerprint).toBe('10325:23179:-1234');
    });

    it('loads every reported result of the game in a stable order, plus the stored WHR', async () => {
        mockExecuteQuery.mockResolvedValue({
            recordsets: [
                [{ MatchCount: 2, MaxMatchId: 8, MatchChecksum: 5 }],
                [
                    { MatchId: 7, Player1: 1, Player2: 2, P1Wins: 2, P1Losses: 1, DayNumber: 9700 },
                    { MatchId: 8, Player1: 2, Player2: 3, P1Wins: 0, P1Losses: 2, DayNumber: 9701 }
                ],
                [{ Player: 1, DayNumber: 9700, RatingWHR: 12.5 }],
                [{ Player: 1, RatingWHR: 12.5 }, { Player: 4, RatingWHR: 0 }]
            ]
        });
        const dao = new LegacyWhrDao();

        const state = await dao.loadGameState(2);

        const [query] = mockExecuteQuery.mock.calls[0];
        expect(query).toContain('FutureMatch = 0');
        expect(query).toContain('P1Wins + P1Losses > 0');
        expect(query).toContain("DATEDIFF(day, '2000-01-01', CAST(MatchDate AS date)) AS DayNumber");
        expect(query).toContain('ORDER BY MatchDate ASC, [Match] ASC');
        expect(query).not.toMatch(/Tournament|Channel/);
        expect(state).toEqual({
            gameType: 2,
            fingerprint: '2:8:5',
            matches: [
                { matchId: 7, player1: 1, player2: 2, p1Wins: 2, p1Losses: 1, day: 9700 },
                { matchId: 8, player1: 2, player2: 3, p1Wins: 0, p1Losses: 2, day: 9701 }
            ],
            history: [{ playerId: 1, day: 9700, ratingElo: 12.5 }],
            ratings: [{ playerId: 1, ratingElo: 12.5 }, { playerId: 4, ratingElo: 0 }]
        });
    });

    it('writes the differences of a recalculation in one transaction', async () => {
        mockTransaction = createTransactionMock(() => ({
            recordset: [{ HistoryDeleted: 1, HistoryUpdated: 2, HistoryInserted: 3, StatsInserted: 0, RatingsUpdated: 4 }]
        }));
        const dao = new LegacyWhrDao();

        const result = await dao.applyDiff(3, {
            upserts: [{ playerId: 1, day: 9700, ratingElo: 10.25 }],
            deletes: [{ playerId: 2, day: 9600 }],
            ratingUpdates: [{ playerId: 1, ratingElo: 10.25 }]
        });

        const { query, inputs } = mockTransaction.calls[0];
        expect(mockTransaction.commit).toHaveBeenCalled();
        expect(query).toContain('SET XACT_ABORT ON');
        expect(query).toContain("OPENJSON(@history) WITH (Player INT '$[0]', DayNumber INT '$[1]', RatingWHR NUMERIC(19,9) '$[2]')");
        expect(query).toContain('DELETE h');
        expect(query).toContain('INSERT INTO dbo.WhrRatingHistory');
        expect(query).toContain('INSERT INTO dbo.PlayerStats (Player, GameType)');
        expect(query).toContain('SET RatingWHR = r.RatingWHR');
        expect(inputs).toEqual({
            gameType: 3,
            history: '[[1,9700,10.25]]',
            deletes: '[[2,9600]]',
            ratings: '[[1,10.25]]'
        });
        expect(result).toEqual({ historyDeleted: 1, historyUpdated: 2, historyInserted: 3, statsInserted: 0, ratingsUpdated: 4 });
    });

    it('replaces the whole history of a game on a rebuild', async () => {
        mockTransaction = createTransactionMock(() => ({ recordset: [{ HistoryDeleted: 8794, HistoryInserted: 8847, RatingsUpdated: 651 }] }));
        const dao = new LegacyWhrDao();

        const result = await dao.rebuildGame(3, {
            history: [{ playerId: 1, day: 9700, ratingElo: 1 }],
            ratings: [{ playerId: 1, ratingElo: 1 }, { playerId: 2, ratingElo: 0 }]
        });

        const { query, inputs } = mockTransaction.calls[0];
        expect(query).toContain('DELETE FROM dbo.WhrRatingHistory WHERE GameType = @gameType');
        expect(inputs.ratings).toBe('[[1,1],[2,0]]');
        expect(result).toEqual(expect.objectContaining({ historyDeleted: 8794, historyInserted: 8847, ratingsUpdated: 651 }));
    });

    it('rolls back and rethrows when a write fails', async () => {
        mockTransaction = createTransactionMock(() => {
            throw new Error('timeout');
        });
        const dao = new LegacyWhrDao();

        await expect(dao.applyDiff(1, { upserts: [], deletes: [], ratingUpdates: [] })).rejects.toThrow('timeout');

        expect(mockTransaction.rollback).toHaveBeenCalled();
        expect(mockTransaction.commit).not.toHaveBeenCalled();
    });
});
