const RatedMatchDao = require('../../src/db/daos/ratedMatchDao');

describe('RatedMatchDao.createMatch', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    function createMatchInput() {
        return {
            matchCode: 'manual:1:123',
            gameId: 3,
            mode: '1v1',
            firstTo: 2,
            seasonId: 2,
            homeTeamNumber: 1,
            awayTeamNumber: 2,
            participants: [
                { discordId: '111', teamNumber: 1, isRepresentative: true },
                { discordId: '222', teamNumber: 2, isRepresentative: true }
            ],
            guildId: 'guild-1',
            panelChannelId: 'channel-1',
            threadId: null,
            threadUrl: null
        };
    }

    it('does not re-activate an existing active match code', async () => {
        const dao = new RatedMatchDao();
        jest.spyOn(dao, 'createMatchHeader').mockResolvedValue({
            id: 99,
            matchNumber: 7,
            seasonMatchNumber: 3,
            seasonId: 2,
            status: 'active',
            existing: true
        });
        const activateMatch = jest.spyOn(dao, 'activateMatch').mockResolvedValue([]);

        const result = await dao.createMatch(createMatchInput());

        expect(result).toBe(99);
        expect(activateMatch).not.toHaveBeenCalled();
    });

    it('returns match numbering details from createMatchWithDetails', async () => {
        const dao = new RatedMatchDao();
        jest.spyOn(dao, 'createMatchHeader').mockResolvedValue({
            id: 99,
            matchNumber: 7,
            seasonMatchNumber: 3,
            seasonId: 2,
            status: 'creating',
            existing: false
        });
        const activateMatch = jest.spyOn(dao, 'activateMatch').mockResolvedValue([]);

        const input = createMatchInput();
        const result = await dao.createMatchWithDetails(input);

        expect(result).toEqual({
            id: 99,
            matchNumber: 7,
            seasonMatchNumber: 3,
            seasonId: 2,
            status: 'creating',
            existing: false
        });
        expect(activateMatch).toHaveBeenCalledWith(expect.objectContaining({
            matchId: 99,
            participants: input.participants
        }));
    });

    it('still activates an existing creating match code so interrupted creates can recover', async () => {
        const dao = new RatedMatchDao();
        jest.spyOn(dao, 'createMatchHeader').mockResolvedValue({
            id: 100,
            matchNumber: 8,
            seasonMatchNumber: 4,
            seasonId: 2,
            status: 'creating',
            existing: true
        });
        const activateMatch = jest.spyOn(dao, 'activateMatch').mockResolvedValue([]);

        const input = createMatchInput();
        const result = await dao.createMatch(input);

        expect(result).toBe(100);
        expect(activateMatch).toHaveBeenCalledWith(expect.objectContaining({
            matchId: 100,
            participants: input.participants
        }));
    });
});
