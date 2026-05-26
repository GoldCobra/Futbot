const CompetitiveRatingDao = require('../../src/db/daos/competitiveRatingDao');

function createRewardTransactionMock() {
    const calls = [];
    return {
        calls,
        request() {
            const inputs = {};
            return {
                input(name, value) {
                    inputs[name] = value;
                    return this;
                },
                async query(query) {
                    calls.push({ query, inputs: { ...inputs } });
                    if (query.includes('CompetitiveSeasonRewardProgress') && query.includes('SELECT TOP 1')) {
                        return {
                            recordset: [{
                                HighestEarnedTier: null,
                                HighestEarnedTierOrder: 0,
                                CurrentTargetTier: 'Bronze',
                                CurrentTargetTierOrder: 1,
                                CurrentTargetWins: 4,
                                RequiredWins: 5
                            }]
                        };
                    }
                    if (query.includes('CompetitiveSeasonRewardProgress') && query.includes('UPDATE')) {
                        return { recordset: [], rowsAffected: [1] };
                    }
                    if (query.includes('CompetitiveSeasonRewardEarned') && query.includes('INSERT INTO')) {
                        return { recordset: [], rowsAffected: [1] };
                    }
                    throw new Error(`Unexpected query in reward DAO test: ${query}`);
                }
            };
        }
    };
}

const thresholds = [
    { RankNumber: 0, Tier: 'Unranked', IsActive: true },
    { RankNumber: 1, Tier: 'Bronze', IsActive: true }
];

const bronzeUnlockChange = {
    RatedMatchId: 11,
    SeasonId: 2,
    PlayerId: 7,
    GameId: 1,
    ModeCode: '1v1',
    Outcome: 'win',
    RankAfter: 1,
    EloAfter: 650,
    PlacementBefore: 5,
    PlacementAfter: 6
};

describe('CompetitiveRatingDao season reward persistence', () => {
    it('updates live reward progress without writing final earned rows', async () => {
        const dao = new CompetitiveRatingDao();
        const transaction = createRewardTransactionMock();

        const result = await dao._applySeasonRewardProgressForChanges(
            transaction,
            [bronzeUnlockChange],
            thresholds
        );

        expect(result).toEqual({ progressRowsTouched: 1, earnedRowsInserted: 0 });
        expect(transaction.calls.some(call => (
            call.query.includes('CompetitiveSeasonRewardEarned') && call.query.includes('INSERT INTO')
        ))).toBe(false);
    });

    it('writes final earned rows only when season rewards are finalized', async () => {
        const dao = new CompetitiveRatingDao();
        const transaction = createRewardTransactionMock();

        const result = await dao._applySeasonRewardProgressForChanges(
            transaction,
            [bronzeUnlockChange],
            thresholds,
            { writeFinalEarned: true }
        );

        expect(result).toEqual({ progressRowsTouched: 1, earnedRowsInserted: 1 });
        expect(transaction.calls.some(call => (
            call.query.includes('CompetitiveSeasonRewardEarned') && call.query.includes('INSERT INTO')
        ))).toBe(true);
    });
});
