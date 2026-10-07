// recordMatchCompletion is the one place a rated result turns into ELO. It must be safe to run
// again (retry queue, recovered runtime state, a retried batch after an unseen commit) and it
// must never rate a match that was cancelled meanwhile.
let mockTransaction;

jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: jest.fn(),
    getPool: jest.fn(async () => ({})),
    sql: {
        ISOLATION_LEVEL: { READ_COMMITTED: 'READ_COMMITTED', SERIALIZABLE: 'SERIALIZABLE' },
        Transaction: jest.fn(() => mockTransaction)
    }
}));

const CompetitiveRatingDao = require('../../src/db/daos/competitiveRatingDao');
const { RatedMatchStateError } = require('../../src/db/errors');
const { calculateCompetitiveEloDelta } = require('../../src/services/competitiveRating');

const PARTICIPANTS = [
    { RatedMatchParticipantId: 71, RatedMatchId: 500, PlayerId: 11, DiscordId: 'home-user', TeamNumber: 1, IsRepresentative: true },
    { RatedMatchParticipantId: 72, RatedMatchId: 500, PlayerId: 22, DiscordId: 'away-user', TeamNumber: 2, IsRepresentative: true }
];

function existingChange(participant, outcome) {
    return {
        RatedMatchId: 500,
        PlayerId: participant.PlayerId,
        DiscordId: participant.DiscordId,
        TeamNumber: participant.TeamNumber,
        Outcome: outcome,
        EloBefore: 500,
        EloAfter: outcome === 'win' ? 550 : 500,
        EloDelta: outcome === 'win' ? 50 : 0,
        RankBefore: 0,
        RankAfter: 0,
        PlacementBefore: 0,
        PlacementAfter: 1
    };
}

function createTransaction({ status = 'active', existingChanges = [] } = {}) {
    const queries = [];
    const transaction = {
        queries,
        begin: jest.fn(async () => {}),
        commit: jest.fn(async () => {}),
        rollback: jest.fn(async () => {}),
        request() {
            const inputs = {};
            return {
                input(key, value) {
                    inputs[key] = value;
                    return this;
                },
                async query(query) {
                    queries.push({ query, inputs });
                    if (query.includes('SELECT TOP 1 Id, SeasonId, GameId, ModeCode, Status')) {
                        return { recordset: [{ Id: 500, SeasonId: 3, GameId: 1, ModeCode: '1v1', Status: status }] };
                    }
                    if (query.includes('rmp.Id AS RatedMatchParticipantId')) {
                        return { recordset: PARTICIPANTS };
                    }
                    if (query.includes('crc.GameId AS GameType')) {
                        return { recordset: existingChanges };
                    }
                    return { recordset: [] };
                }
            };
        }
    };
    return transaction;
}

function writeQueries(transaction) {
    return transaction.queries
        .map(entry => entry.query)
        .filter(query => /^\s*(UPDATE|INSERT)/.test(query));
}

function completion(overrides = {}) {
    return {
        ratedMatchId: 500,
        matchCode: 'm-500',
        seasonId: 3,
        gameType: 1,
        mode: '1v1',
        winnerTeamNumber: 1,
        team1Score: 2,
        team2Score: 0,
        homeTeamNumber: 1,
        awayTeamNumber: 2,
        ...overrides
    };
}

function stubRatingHelpers(dao) {
    jest.spyOn(dao, 'getDefaultRating').mockResolvedValue(500);
    jest.spyOn(dao, 'getRankNumberForElo').mockResolvedValue(1);
    jest.spyOn(dao, '_applySeasonRewardProgressForChanges').mockResolvedValue(undefined);
    jest.spyOn(dao, '_getOrCreateRatingForUpdate').mockImplementation(async (transaction, { playerId }) => ({
        Id: playerId * 10,
        Elo: 500,
        RankNumber: 0,
        PlacementPlayed: 0,
        PlacementComplete: false,
        PeakElo: 500,
        PeakRankNumber: 0
    }));
}

describe('competitiveRatingDao.recordMatchCompletion', () => {
    test('rates an active match once: ratings, audit rows and the completed status in one transaction', async () => {
        const dao = new CompetitiveRatingDao();
        stubRatingHelpers(dao);
        mockTransaction = createTransaction();

        const changes = await dao.recordMatchCompletion(completion(), calculateCompetitiveEloDelta);

        expect(changes.map(change => [change.discordId, change.outcome])).toEqual([
            ['home-user', 'win'],
            ['away-user', 'loss']
        ]);
        // Placement K = 100 against an equal opponent: +50 for the winner, the loser stays on the 500 floor.
        expect(changes[0].eloDelta).toBe(50);
        expect(changes[1].eloAfter).toBe(500);
        const writes = writeQueries(mockTransaction);
        expect(writes.filter(query => query.includes('CompetitivePlayerRating'))).toHaveLength(2);
        expect(writes.filter(query => query.includes('INSERT INTO') && query.includes('CompetitiveRatingChange'))).toHaveLength(2);
        expect(writes.at(-1)).toContain("SET Status = 'completed'");
        expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
        expect(mockTransaction.rollback).not.toHaveBeenCalled();
    });

    test('returns the stored changes without writing again when the match is already rated', async () => {
        const dao = new CompetitiveRatingDao();
        stubRatingHelpers(dao);
        mockTransaction = createTransaction({
            status: 'completed',
            existingChanges: [existingChange(PARTICIPANTS[0], 'win'), existingChange(PARTICIPANTS[1], 'loss')]
        });

        const changes = await dao.recordMatchCompletion(completion(), calculateCompetitiveEloDelta);

        expect(changes.map(change => change.eloDelta)).toEqual([50, 0]);
        expect(writeQueries(mockTransaction)).toEqual([]);
        expect(dao._getOrCreateRatingForUpdate).not.toHaveBeenCalled();
        expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
    });

    test('keeps returning the stored changes after a rollback instead of rating the match again', async () => {
        const dao = new CompetitiveRatingDao();
        stubRatingHelpers(dao);
        mockTransaction = createTransaction({
            status: 'rolled_back',
            existingChanges: [existingChange(PARTICIPANTS[0], 'win'), existingChange(PARTICIPANTS[1], 'loss')]
        });

        await dao.recordMatchCompletion(completion(), calculateCompetitiveEloDelta);

        expect(writeQueries(mockTransaction)).toEqual([]);
    });

    test('refuses to rate a cancelled match and writes nothing', async () => {
        const dao = new CompetitiveRatingDao();
        stubRatingHelpers(dao);
        mockTransaction = createTransaction({ status: 'cancelled' });

        const result = dao.recordMatchCompletion(completion(), calculateCompetitiveEloDelta);

        await expect(result).rejects.toBeInstanceOf(RatedMatchStateError);
        await expect(result).rejects.toThrow('RatedMatch 500 is cancelled');
        expect(writeQueries(mockTransaction)).toEqual([]);
        expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
        expect(mockTransaction.commit).not.toHaveBeenCalled();
    });

    test('rejects partial audit rows instead of completing them', async () => {
        const dao = new CompetitiveRatingDao();
        stubRatingHelpers(dao);
        mockTransaction = createTransaction({
            status: 'completed',
            existingChanges: [existingChange(PARTICIPANTS[0], 'win')]
        });

        await expect(dao.recordMatchCompletion(completion(), calculateCompetitiveEloDelta))
            .rejects.toThrow('Partial CompetitiveRatingChange rows');
        expect(writeQueries(mockTransaction)).toEqual([]);
        expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
    });

    test('rolls back everything when a write fails in the middle', async () => {
        const dao = new CompetitiveRatingDao();
        stubRatingHelpers(dao);
        mockTransaction = createTransaction();
        dao._applySeasonRewardProgressForChanges.mockRejectedValue(new Error('connection lost'));

        await expect(dao.recordMatchCompletion(completion(), calculateCompetitiveEloDelta))
            .rejects.toThrow('connection lost');
        expect(mockTransaction.commit).not.toHaveBeenCalled();
        expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
        // The completed status is only written after the ratings, so it was never reached.
        expect(writeQueries(mockTransaction).some(query => query.includes("SET Status = 'completed'"))).toBe(false);
    });
});
