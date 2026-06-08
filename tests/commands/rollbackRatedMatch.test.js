const mockRollbackCompetitiveMatch = jest.fn();
const mockUpdateRollbackThreadStatus = jest.fn();

jest.mock('../../src/services/competitiveRating', () => ({
    rollbackCompetitiveMatch: (...args) => mockRollbackCompetitiveMatch(...args)
}));

jest.mock('../../src/db/daos/competitiveRatingDao', () => jest.fn().mockImplementation(() => ({
    updateRollbackThreadStatus: (...args) => mockUpdateRollbackThreadStatus(...args)
})));

const command = require('../../src/commands/mslstaff/rollbackratedmatch');

function buildInteraction(overrides = {}) {
    const values = {
        game: 'msc',
        mode: '1v1',
        matchnumber: 12,
        reason: 'wrong report',
        confirm: true,
        ...overrides.values
    };

    return {
        deferReply: jest.fn(async () => {}),
        editReply: jest.fn(async () => {}),
        user: { id: 'staff-1' },
        client: {
            channels: {
                fetch: jest.fn()
            }
        },
        options: {
            getString: jest.fn(name => values[name]),
            getInteger: jest.fn(name => values[name]),
            getBoolean: jest.fn(name => values[name])
        },
        ...overrides
    };
}

describe('rollbackratedmatch command', () => {
    beforeEach(() => {
        mockRollbackCompetitiveMatch.mockReset();
        mockUpdateRollbackThreadStatus.mockReset();
        mockUpdateRollbackThreadStatus.mockResolvedValue(undefined);
    });

    it('requires explicit confirm true before rolling back', async () => {
        const interaction = buildInteraction({ values: { confirm: false } });

        await command.execute(interaction);

        expect(mockRollbackCompetitiveMatch).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('confirm:true'));
    });

    it('rolls back by game mode and match number, then marks the thread rolled back', async () => {
        const thread = {
            id: 'thread-1',
            name: '✅ 1v1 #12 | PlayerHome VS PlayerAway',
            archived: true,
            locked: true,
            send: jest.fn(async () => ({ id: 'notice-1' })),
            setName: jest.fn(async () => {}),
            setLocked: jest.fn(async () => {}),
            setArchived: jest.fn(async () => {})
        };
        const interaction = buildInteraction();
        interaction.client.channels.fetch.mockResolvedValue(thread);
        mockRollbackCompetitiveMatch.mockResolvedValue({
            status: 'rolled_back',
            alreadyRolledBack: false,
            rollbackId: 44,
            seasonId: 2,
            gameId: 1,
            gameCode: 'MSC',
            mode: '1v1',
            matchId: 100,
            matchCode: 'abc',
            matchNumber: 12,
            threadId: 'thread-1',
            reason: 'wrong report',
            rolledBackByDiscordId: 'staff-1',
            snapshotCount: 4,
            replayedMatchCount: 3,
            recalculatedChangeCount: 6,
            dbVerification: {
                verified: true,
                rollbackId: 44,
                matchStatus: 'rolled_back',
                rollbackSnapshotCount: 4,
                currentChangeCount: 2,
                whrSyncStatus: 'rolled_back'
            },
            changes: [
                { discordId: 'winner-1', eloBefore: 1000, eloAfter: 1050, eloDelta: 50 },
                { discordId: 'loser-1', eloBefore: 1000, eloAfter: 1000, eloDelta: 0 }
            ],
            currentRatings: [
                { discordId: 'winner-1', currentElo: 1000 },
                { discordId: 'loser-1', currentElo: 1000 }
            ]
        });

        await command.execute(interaction);

        expect(mockRollbackCompetitiveMatch).toHaveBeenCalledWith(expect.objectContaining({
            gameId: 1,
            mode: '1v1',
            matchNumber: 12,
            reason: 'wrong report',
            rolledBackByDiscordId: 'staff-1'
        }));
        expect(thread.setName).toHaveBeenCalledWith('↩️ 1v1 #12 | PlayerHome VS PlayerAway', expect.any(String));
        expect(thread.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('MATCH ROLLED BACK')
        }));
        expect(mockUpdateRollbackThreadStatus).toHaveBeenCalledWith({
            rollbackId: 44,
            threadNoticeMessageId: 'notice-1',
            threadFinalizeStatus: 'posted'
        });
        expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Match rolled back: MSC 1v1 #12'));
        expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('DB verification: RatedMatch #100 is rolled_back; rollback audit #44 confirmed.'));
    });

    it('does not report success when rollback DB verification fails in the service', async () => {
        const interaction = buildInteraction();
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockRollbackCompetitiveMatch.mockRejectedValue(new Error("Rollback DB verification failed for MSC 1v1 #12: RatedMatch status is 'completed', expected 'rolled_back'"));

        try {
            await command.execute(interaction);
        } finally {
            consoleError.mockRestore();
        }

        expect(mockUpdateRollbackThreadStatus).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Rollback DB verification failed'));
    });
});
