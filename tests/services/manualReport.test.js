describe('manual report service', () => {
    let manualReport;
    let mockExecuteQuery;
    let mockCreateMatch;
    let mockGetActiveSeason;
    let mockRecordCompetitiveResult;
    let mockLinkExistingLegacyMirror;

    beforeEach(() => {
        jest.resetModules();
        mockExecuteQuery = jest.fn(async query => ({
            recordset: [{ Id: query.includes('reportScore2') ? 22345 : 12345 }]
        }));
        mockCreateMatch = jest.fn(async () => 67890);
        mockGetActiveSeason = jest.fn(async () => ({ Id: 2, DisplayName: 'Burst Season 2026' }));
        mockRecordCompetitiveResult = jest.fn(async () => ({
            seasonId: 2,
            seasonName: 'Burst Season 2026',
            changes: []
        }));
        mockLinkExistingLegacyMirror = jest.fn(async () => ({ id: 55 }));

        jest.doMock('../../src/db/sqlClient', () => ({
            executeQuery: (...args) => mockExecuteQuery(...args)
        }));
        jest.doMock('../../src/db/daos/ratedMatchDao', () => jest.fn().mockImplementation(() => ({
            createMatch: mockCreateMatch
        })));
        jest.doMock('../../src/db/daos/competitiveWhrSyncDao', () => jest.fn().mockImplementation(() => ({
            linkExistingLegacyMirror: mockLinkExistingLegacyMirror
        })));
        jest.doMock('../../src/services/competitiveRating', () => ({
            getActiveSeason: mockGetActiveSeason,
            recordCompetitiveResult: mockRecordCompetitiveResult
        }));

        manualReport = require('../../src/services/manualReport');
    });

    afterEach(() => {
        jest.dontMock('../../src/db/sqlClient');
        jest.dontMock('../../src/db/daos/ratedMatchDao');
        jest.dontMock('../../src/db/daos/competitiveWhrSyncDao');
        jest.dontMock('../../src/services/competitiveRating');
    });

    function createInteraction() {
        return {
            guildId: 'guild-1',
            channelId: 'channel-1',
            channel: { id: 'channel-1', name: 'manual-reports' },
            client: { id: 'client-1' }
        };
    }

    it('records 1v1 legacy history with zero legacy deltas and completes Competitive ELO', async () => {
        const result = await manualReport.recordManualReport1v1({
            interaction: createInteraction(),
            p1: { id: '111', username: 'One' },
            p2: { id: '222', username: 'Two' },
            p1Wins: 2,
            p2Wins: 1,
            gametype: 'SMS',
            guildid: 'guild-1',
            tournament: 'Tournament',
            stage: 'Finals',
            setUri: 'https://start.gg/set'
        });

        expect(mockExecuteQuery).toHaveBeenCalledWith(
            expect.stringContaining('exec reportScore'),
            expect.objectContaining({
                gametype: 2,
                d1: 0,
                d2: 0,
                score: '2-1'
            })
        );
        expect(mockCreateMatch).toHaveBeenCalledWith(expect.objectContaining({
            matchCode: 'manual-report:match:12345',
            gameId: 2,
            mode: '1v1',
            seasonId: 2,
            firstTo: 2,
            participants: [
                { discordId: '111', teamNumber: 1, isRepresentative: true },
                { discordId: '222', teamNumber: 2, isRepresentative: true }
            ]
        }));
        expect(mockRecordCompetitiveResult).toHaveBeenCalledWith(expect.objectContaining({
            ratedMatchId: 67890,
            matchCode: 'manual-report:match:12345',
            seasonId: 2,
            gameType: 2,
            mode: '1v1',
            winnerTeamNumber: 1,
            team1Score: 2,
            team2Score: 1,
            skipWhrSync: true
        }));
        expect(mockLinkExistingLegacyMirror).toHaveBeenCalledWith({
            ratedMatchId: 67890,
            legacyMatchId: 12345,
            legacyMultiMatchId: null
        });
        expect(result).toEqual(expect.objectContaining({
            legacyMatchId: 12345,
            ratedMatchId: 67890
        }));
    });

    it('records 2v2 legacy history with zero legacy deltas and completes Competitive 2v2 ELO', async () => {
        const result = await manualReport.recordManualReport2v2({
            interaction: createInteraction(),
            team1p1: { id: '111', username: 'One' },
            team1p2: { id: '222', username: 'Two' },
            team2p1: { id: '333', username: 'Three' },
            team2p2: { id: '444', username: 'Four' },
            team1Wins: 1,
            team2Wins: 2,
            gametype: 'MSC',
            guildid: 'guild-1'
        });

        expect(mockExecuteQuery).toHaveBeenCalledWith(
            expect.stringContaining('exec reportScore2'),
            expect.objectContaining({
                gametype: 1,
                d1: 0,
                d2: 0,
                d5: 0,
                d6: 0,
                score: '1-2'
            })
        );
        expect(mockCreateMatch).toHaveBeenCalledWith(expect.objectContaining({
            matchCode: 'manual-report:multi:22345',
            gameId: 1,
            mode: '2v2',
            seasonId: 2,
            firstTo: 2,
            participants: [
                { discordId: '111', teamNumber: 1, isRepresentative: true },
                { discordId: '222', teamNumber: 1, isRepresentative: false },
                { discordId: '333', teamNumber: 2, isRepresentative: true },
                { discordId: '444', teamNumber: 2, isRepresentative: false }
            ]
        }));
        expect(mockRecordCompetitiveResult).toHaveBeenCalledWith(expect.objectContaining({
            ratedMatchId: 67890,
            matchCode: 'manual-report:multi:22345',
            seasonId: 2,
            gameType: 1,
            mode: '2v2',
            winnerTeamNumber: 2,
            team1Score: 1,
            team2Score: 2,
            skipWhrSync: true
        }));
        expect(mockLinkExistingLegacyMirror).toHaveBeenCalledWith({
            ratedMatchId: 67890,
            legacyMatchId: null,
            legacyMultiMatchId: 22345
        });
        expect(result).toEqual(expect.objectContaining({
            legacyMultiMatchId: 22345,
            ratedMatchId: 67890
        }));
    });

    it('rejects draw reports before writing legacy or Competitive data', async () => {
        await expect(manualReport.recordManualReport1v1({
            interaction: createInteraction(),
            p1: { id: '111', username: 'One' },
            p2: { id: '222', username: 'Two' },
            p1Wins: 1,
            p2Wins: 1,
            gametype: 'MSBL',
            guildid: 'guild-1'
        })).rejects.toThrow('Draw reports are not supported');

        expect(mockExecuteQuery).not.toHaveBeenCalled();
        expect(mockCreateMatch).not.toHaveBeenCalled();
        expect(mockRecordCompetitiveResult).not.toHaveBeenCalled();
        expect(mockLinkExistingLegacyMirror).not.toHaveBeenCalled();
    });

    it('blocks the full report before legacy write when no active season exists', async () => {
        mockGetActiveSeason.mockResolvedValue(null);

        await expect(manualReport.recordManualReport1v1({
            interaction: createInteraction(),
            p1: { id: '111', username: 'One' },
            p2: { id: '222', username: 'Two' },
            p1Wins: 2,
            p2Wins: 0,
            gametype: 'MSBL',
            guildid: 'guild-1'
        })).rejects.toThrow('No active Competitive season');

        expect(mockExecuteQuery).not.toHaveBeenCalled();
        expect(mockCreateMatch).not.toHaveBeenCalled();
    });

    it('does not link WHR sync or report success when Competitive ELO returns no result', async () => {
        mockRecordCompetitiveResult.mockResolvedValue(null);

        await expect(manualReport.recordManualReport1v1({
            interaction: createInteraction(),
            p1: { id: '111', username: 'One' },
            p2: { id: '222', username: 'Two' },
            p1Wins: 2,
            p2Wins: 0,
            gametype: 'MSBL',
            guildid: 'guild-1'
        })).rejects.toThrow('Competitive rating update failed');

        expect(mockExecuteQuery).toHaveBeenCalled();
        expect(mockCreateMatch).toHaveBeenCalled();
        expect(mockRecordCompetitiveResult).toHaveBeenCalled();
        expect(mockLinkExistingLegacyMirror).not.toHaveBeenCalled();
    });
});
