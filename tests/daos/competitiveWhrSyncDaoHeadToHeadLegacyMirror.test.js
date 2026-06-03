jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: jest.fn(),
    getPool: jest.fn(),
    sql: {
        Int: 'Int',
        TinyInt: 'TinyInt',
        VarChar: length => ({ type: 'VarChar', length }),
        NVarChar: length => ({ type: 'NVarChar', length })
    }
}));

const CompetitiveWhrSyncDao = require('../../src/db/daos/competitiveWhrSyncDao');

function createTransactionMock(recordsets) {
    const calls = [];
    return {
        calls,
        request: jest.fn(() => {
            const inputs = {};
            const request = {
                input: jest.fn(function input(key, typeOrValue, maybeValue) {
                    inputs[key] = arguments.length >= 3 ? maybeValue : typeOrValue;
                    return request;
                }),
                query: jest.fn(async query => {
                    calls.push({ query, inputs: { ...inputs } });
                    return {
                        recordset: recordsets.shift() ?? [],
                        rowsAffected: [0]
                    };
                })
            };
            return request;
        })
    };
}

describe('CompetitiveWhrSyncDao legacy mirror for head-to-head tracking', () => {
    it('mirrors completed singles matches into dbo.Match with H2H-visible score fields', async () => {
        const transaction = createTransactionMock([
            [],
            [{ LegacyMatchId: 9101 }]
        ]);
        const dao = new CompetitiveWhrSyncDao();

        const result = await dao._mirrorSinglesMatch(transaction, {
            Id: 77,
            GameId: 1,
            GameCode: 'MSC',
            ModeCode: '1v1',
            MatchNumber: 12,
            Team1Score: 3,
            Team2Score: 1,
            CompletedAtUtc: new Date('2026-06-03T09:00:00Z'),
            GuildId: 'guild-1',
            ThreadUrl: 'https://discord.test/thread'
        }, [
            { PlayerId: 101, TeamNumber: 1 },
            { PlayerId: 202, TeamNumber: 2 }
        ]);

        const insert = transaction.calls.find(call => call.query.includes('INSERT INTO dbo.Match'));
        expect(result).toEqual({ legacyMatchId: 9101 });
        expect(insert.query).toContain('P1Wins, P1Losses');
        expect(insert.query).toContain('P1MatchScore, P2MatchScore');
        expect(insert.query).toContain('Tournament, Stage');
        expect(insert.inputs).toEqual(expect.objectContaining({
            gameId: 1,
            player1: 101,
            player2: 202,
            score: '3-1',
            team1Score: 3,
            team2Score: 1,
            p1MatchScore: 1,
            p2MatchScore: 0,
            tournament: 'Competitive Rated',
            stage: 'MSC 1v1 #12',
            channel: 'Competitive Rated MSC 1v1 #12',
            notes: 'CompetitiveRatedMatch:77'
        }));
    });

    it('mirrors completed doubles matches into dbo.MultiMatch with H2H-visible score fields', async () => {
        const transaction = createTransactionMock([
            [],
            [{ LegacyMultiMatchId: 9202 }]
        ]);
        const dao = new CompetitiveWhrSyncDao();

        const result = await dao._mirrorDoublesMatch(transaction, {
            Id: 88,
            GameId: 3,
            GameCode: 'MSBL',
            ModeCode: '2v2',
            MatchNumber: 4,
            Team1Score: 0,
            Team2Score: 2,
            CompletedAtUtc: new Date('2026-06-03T10:00:00Z'),
            GuildId: 'guild-1'
        }, [
            { PlayerId: 301, TeamNumber: 1 },
            { PlayerId: 302, TeamNumber: 1 },
            { PlayerId: 401, TeamNumber: 2 },
            { PlayerId: 402, TeamNumber: 2 }
        ]);

        const insert = transaction.calls.find(call => call.query.includes('INSERT INTO dbo.MultiMatch'));
        expect(result).toEqual({ legacyMultiMatchId: 9202 });
        expect(insert.query).toContain('Team1Wins, Team1Losses');
        expect(insert.query).toContain('Team1MatchScore, Team2MatchScore');
        expect(insert.query).toContain('Tournament, Stage');
        expect(insert.inputs).toEqual(expect.objectContaining({
            gameId: 3,
            player1: 301,
            player2: 302,
            player5: 401,
            player6: 402,
            score: '0-2',
            team1Score: 0,
            team2Score: 2,
            team1MatchScore: 0,
            team2MatchScore: 1,
            tournament: 'Competitive Rated',
            stage: 'MSBL 2v2 #4',
            channel: 'Competitive Rated MSBL 2v2 #4'
        }));
    });
});
