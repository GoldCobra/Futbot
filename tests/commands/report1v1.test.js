const CONSTANTS = require('../../src/utils/constants');
const manualReport = require('../../src/services/manualReport');
const startgg = require('../../src/integrations/startgg');

jest.mock('../../src/integrations/startgg', () => ({
    getStandardizeSetUrl: jest.fn(value => `standard:${value}`),
    updateSet: jest.fn(async () => ({ url: 'https://start.gg/report' }))
}));

describe('/report1v1', () => {
    let report1v1;

    beforeEach(() => {
        jest.spyOn(manualReport, 'recordManualReport1v1').mockResolvedValue({
            legacyMatchId: 12345,
            ratedMatchId: 67890
        });
        jest.spyOn(manualReport, 'buildReportReply').mockReturnValue('report reply');
        jest.clearAllMocks();
        report1v1 = require('../../src/commands/general/report1v1');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    function createInteraction({ seturi = null, winorder = null } = {}) {
        const users = {
            p1: { id: 'p1', username: 'PlayerOne' },
            p2: { id: 'p2', username: 'PlayerTwo' }
        };
        const strings = {
            game: 'MSBL',
            seturi,
            winorder,
            tournament: 'Cup',
            tournamentstage: 'Finals'
        };
        return {
            guildId: 'guild-1',
            member: {
                roles: {
                    cache: {
                        some: jest.fn(rolePredicate => rolePredicate({ id: CONSTANTS.ROLES.MSL_STAFF_MSBL }))
                    }
                }
            },
            options: {
                getUser: jest.fn(name => users[name]),
                getInteger: jest.fn(name => name === 'p1wins' ? 2 : 1),
                getString: jest.fn(name => strings[name] ?? null)
            },
            deferReply: jest.fn(async () => {}),
            editReply: jest.fn(async () => {}),
            followUp: jest.fn(async () => {})
        };
    }

    it('records the report without a start.gg set', async () => {
        const interaction = createInteraction();

        await report1v1.execute(interaction);

        expect(manualReport.recordManualReport1v1).toHaveBeenCalledWith({
            interaction,
            p1: { id: 'p1', username: 'PlayerOne' },
            p2: { id: 'p2', username: 'PlayerTwo' },
            p1Wins: 2,
            p2Wins: 1,
            gametype: 'MSBL',
            guildid: 'guild-1',
            tournament: 'Cup',
            stage: 'Finals',
            setUri: ''
        });
        expect(startgg.updateSet).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith('report reply');
    });

    it('updates start.gg and records the report', async () => {
        const interaction = createInteraction({
            seturi: 'https://start.gg/raw',
            winorder: '121'
        });

        await report1v1.execute(interaction);

        expect(startgg.getStandardizeSetUrl).toHaveBeenCalledWith('https://start.gg/raw');
        expect(startgg.updateSet).toHaveBeenCalledWith('standard:https://start.gg/raw', ['p1', 'p2', 'p1'], 'p1', 'p2', true);
        expect(manualReport.recordManualReport1v1).toHaveBeenCalledWith(expect.objectContaining({
            setUri: 'standard:https://start.gg/raw'
        }));
    });

    it('requires winorder when a start.gg set is provided', async () => {
        const interaction = createInteraction({
            seturi: 'https://start.gg/raw'
        });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await report1v1.execute(interaction);

        expect(manualReport.recordManualReport1v1).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('winorder'));
    });
});
