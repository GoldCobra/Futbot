// A partition rebuild replays every match of a season, game and mode. Like live rating, it counts placement only
// until the placement matches are played; the matches themselves keep counting, with no limit.
jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: jest.fn(),
    getPool: jest.fn(async () => ({})),
    sql: {
        ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
        Transaction: jest.fn()
    }
}));

const CompetitiveRatingDao = require('../../src/db/daos/competitiveRatingDao');
const { calculateCompetitiveEloDelta } = require('../../src/services/competitiveRating');

const LADDER = [
    { RankNumber: 0, MinElo: 500, IsActive: true },
    { RankNumber: 1, MinElo: 500, IsActive: true },
    { RankNumber: 7, MinElo: 945, IsActive: true }
];

// Player 11 was placed long ago with 254 counted matches (one more overflowed the TINYINT column before);
// player 22 plays the last placement match in match 900.
const FIRST_CHANGES = [
    { RatedMatchId: 900, PlayerId: 11, EloBefore: 950, RankBefore: 7, PlacementBefore: 254 },
    { RatedMatchId: 900, PlayerId: 22, EloBefore: 600, RankBefore: 0, PlacementBefore: 4 }
];

const MATCHES = [
    { Id: 900, SeasonId: 3, GameType: 1, Mode: '1v1', WinnerTeamNumber: 1 },
    { Id: 901, SeasonId: 3, GameType: 1, Mode: '1v1', WinnerTeamNumber: 2 }
];

const PARTICIPANTS = [
    { RatedMatchParticipantId: 71, RatedMatchId: 900, PlayerId: 11, DiscordId: 'placed', TeamNumber: 1 },
    { RatedMatchParticipantId: 72, RatedMatchId: 900, PlayerId: 22, DiscordId: 'placing', TeamNumber: 2 },
    { RatedMatchParticipantId: 73, RatedMatchId: 901, PlayerId: 11, DiscordId: 'placed', TeamNumber: 1 },
    { RatedMatchParticipantId: 74, RatedMatchId: 901, PlayerId: 22, DiscordId: 'placing', TeamNumber: 2 }
];

function createTransaction() {
    const queries = [];
    return {
        queries,
        request() {
            const inputs = {};
            return {
                input(key, value) {
                    inputs[key] = value;
                    return this;
                },
                async query(query) {
                    queries.push({ query, inputs });
                    if (query.includes('SELECT RankNumber, MinElo, IsActive')) return { recordset: LADDER };
                    if (query.includes('SELECT crc.*')) return { recordset: FIRST_CHANGES };
                    if (query.includes('WinnerTeamNumber, Team1Score, Team2Score')) return { recordset: MATCHES };
                    if (query.includes('rmp.Id AS RatedMatchParticipantId')) return { recordset: PARTICIPANTS };
                    // Every change row and rating row the rebuild writes exists exactly once.
                    return { recordset: [], rowsAffected: [1] };
                }
            };
        }
    };
}

describe('competitiveRatingDao partition rebuild', () => {
    it('counts placement only until the placement matches are played; every match still counts', async () => {
        const dao = new CompetitiveRatingDao();
        jest.spyOn(dao, 'getDefaultRating').mockResolvedValue(500);
        jest.spyOn(dao, '_rebuildRewardPartition').mockResolvedValue({ progressRowsTouched: 0, earnedRowsInserted: 0 });
        const transaction = createTransaction();

        const result = await dao._rebuildRatingPartitionCore(transaction, {
            seasonId: 3,
            gameId: 1,
            mode: '1v1',
            calculateDelta: calculateCompetitiveEloDelta
        });

        expect(result.replayedMatchCount).toBe(2);
        expect(result.recalculatedChangeCount).toBe(4);
        const changeWrites = transaction.queries
            .filter(entry => /^\s*UPDATE/.test(entry.query) && entry.query.includes('CompetitiveRatingChange'))
            .map(({ inputs }) => [inputs.ratedMatchId, inputs.playerId, inputs.placementBefore, inputs.placementAfter]);
        expect(changeWrites).toEqual([
            [900, 11, 254, 254],
            [900, 22, 4, 5],
            [901, 11, 254, 254],
            [901, 22, 5, 5]
        ]);
        const ratingWrites = transaction.queries
            .filter(entry => entry.query.includes('IF EXISTS') && entry.query.includes('CompetitivePlayerRating'))
            .map(({ inputs }) => [inputs.playerId, inputs.placementPlayed, inputs.placementComplete, inputs.wins + inputs.losses]);
        expect(ratingWrites).toEqual([
            [11, 254, 1, 2],
            [22, 5, 1, 2]
        ]);
    });
});
