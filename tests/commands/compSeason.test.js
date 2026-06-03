const mockExecuteQuery = jest.fn();

jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: (...args) => mockExecuteQuery(...args)
}));

const command = require('../../src/commands/mslstaff/compSeason');

function buildInteraction(action = 'status') {
    return {
        deferReply: jest.fn(async () => {}),
        editReply: jest.fn(async () => {}),
        options: {
            getString: jest.fn(() => action)
        }
    };
}

describe('comp-season command', () => {
    beforeEach(() => {
        mockExecuteQuery.mockReset();
    });

    it('shows automatic season lifecycle status', async () => {
        mockExecuteQuery
            .mockResolvedValueOnce({
                recordset: [{
                    Id: 2,
                    SeasonNumber: 1,
                    DisplayName: 'Burst Season 2026',
                    StartDateUtc: '2026-06-04T08:00:00.000Z',
                    EndDateUtc: '2026-09-02T08:00:00.000Z',
                    LifecycleStatus: 'active'
                }]
            })
            .mockResolvedValueOnce({ recordset: [] })
            .mockResolvedValueOnce({
                recordset: [{
                    Id: 3,
                    SeasonNumber: 2,
                    DisplayName: 'Next Season',
                    StartDateUtc: '2026-09-03T08:00:00.000Z',
                    EndDateUtc: '2026-12-02T08:00:00.000Z',
                    LifecycleStatus: 'scheduled'
                }]
            });

        const interaction = buildInteraction('status');

        await command.execute(interaction);

        expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('**Active:** **Burst Season 2026**'));
        expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('**Upcoming seasons:**'));
    });

    it('rejects manual season actions', async () => {
        const interaction = buildInteraction('end');

        await command.execute(interaction);

        expect(mockExecuteQuery).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Manual season start/end is disabled'));
    });
});
