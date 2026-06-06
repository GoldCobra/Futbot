const manualReport = require('../../src/services/manualReport');

describe('/report2v2', () => {
    let report2v2;

    beforeEach(() => {
        jest.spyOn(manualReport, 'recordManualReport2v2').mockResolvedValue({
            legacyMultiMatchId: 22345,
            ratedMatchId: 67890,
            gameType: 'MSC',
            mode: '2v2',
            matchNumber: 8
        });
        jest.spyOn(manualReport, 'buildReportReply').mockReturnValue('report reply');
        jest.clearAllMocks();
        report2v2 = require('../../src/commands/general/report2v2');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    function createInteraction() {
        const users = {
            team1p1: { id: 'p1', username: 'PlayerOne' },
            team1p2: { id: 'p2', username: 'PlayerTwo' },
            team2p1: { id: 'p3', username: 'PlayerThree' },
            team2p2: { id: 'p4', username: 'PlayerFour' }
        };
        const strings = {
            game: 'MSC',
            tournament: 'Cup',
            tournamentstage: 'Winners Final',
            seturi: 'https://start.gg/set'
        };
        return {
            guildId: 'guild-1',
            options: {
                getUser: jest.fn(name => users[name]),
                getInteger: jest.fn(name => name === 'team1wins' ? 2 : 1),
                getString: jest.fn(name => strings[name] ?? null)
            },
            deferReply: jest.fn(async () => {}),
            editReply: jest.fn(async () => {})
        };
    }

    it('records a 2v2 report through the manual report service', async () => {
        const interaction = createInteraction();

        await report2v2.execute(interaction);

        expect(manualReport.recordManualReport2v2).toHaveBeenCalledWith({
            interaction,
            team1p1: { id: 'p1', username: 'PlayerOne' },
            team1p2: { id: 'p2', username: 'PlayerTwo' },
            team2p1: { id: 'p3', username: 'PlayerThree' },
            team2p2: { id: 'p4', username: 'PlayerFour' },
            team1Wins: 2,
            team2Wins: 1,
            gametype: 'MSC',
            guildid: 'guild-1',
            tournament: 'Cup',
            stage: 'Winners Final',
            setUri: 'https://start.gg/set'
        });
        expect(manualReport.buildReportReply).toHaveBeenCalledWith({
            legacyMatchId: 22345,
            ratedMatchId: 67890,
            gameType: 'MSC',
            mode: '2v2',
            matchNumber: 8
        });
        expect(interaction.editReply).toHaveBeenCalledWith('report reply');
    });
});
