describe('competitiveRating rank role assignment', () => {
    function loadServiceWithThresholds(thresholds) {
        jest.resetModules();

        jest.doMock('../../src/db/daos/competitiveRatingDao', () => jest.fn().mockImplementation(() => ({
            getAllRankThresholds: jest.fn(async () => thresholds)
        })));
        jest.doMock('../../src/db/daos/competitiveWhrSyncDao', () => jest.fn().mockImplementation(() => ({})));

        return require('../../src/services/competitiveRating');
    }

    function createClientWithMember(existingRoleIds = []) {
        const removed = [];
        const added = [];
        const member = {
            roles: {
                cache: {
                    filter: jest.fn(predicate => new Map(
                        existingRoleIds
                            .map(id => ({ id }))
                            .filter(predicate)
                            .map(role => [role.id, role])
                    ))
                },
                remove: jest.fn(async role => {
                    removed.push(role.id);
                }),
                add: jest.fn(async roleId => {
                    added.push(roleId);
                })
            }
        };
        const guild = {
            members: {
                fetch: jest.fn(async () => member)
            }
        };
        const client = {
            guilds: {
                fetch: jest.fn(async () => guild)
            }
        };

        return { client, guild, member, removed, added };
    }

    afterEach(() => {
        jest.dontMock('../../src/db/daos/competitiveRatingDao');
        jest.dontMock('../../src/db/daos/competitiveWhrSyncDao');
    });

    it('does not add retired legacy rank role ids even if a threshold points at one', async () => {
        const CONSTANTS = require('../../src/utils/constants');
        const { assignCompRankRoles } = loadServiceWithThresholds([
            { RankNumber: 0, DiscordRoleId: '1504569388056186901' },
            { RankNumber: 1, DiscordRoleId: CONSTANTS.ROLES.LEGEND }
        ]);
        const { client, member, added } = createClientWithMember([]);

        await assignCompRankRoles(client, 'guild-1', 'discord-1', 1);

        expect(member.roles.add).not.toHaveBeenCalled();
        expect(added).toEqual([]);
    });

    it('ignores existing retired legacy rank roles while managing new competitive rank roles', async () => {
        const CONSTANTS = require('../../src/utils/constants');
        const bronzeRoleId = '1504566977182699620';
        const silverRoleId = '1504567155092357211';
        const { assignCompRankRoles } = loadServiceWithThresholds([
            { RankNumber: 1, DiscordRoleId: bronzeRoleId },
            { RankNumber: 2, DiscordRoleId: silverRoleId },
            { RankNumber: 3, DiscordRoleId: CONSTANTS.ROLES.SUPERSTAR }
        ]);
        const { client, member, removed, added } = createClientWithMember([
            CONSTANTS.ROLES.SUPERSTAR,
            bronzeRoleId
        ]);

        await assignCompRankRoles(client, 'guild-1', 'discord-1', 2);

        expect(removed).toEqual([bronzeRoleId]);
        expect(added).toEqual([silverRoleId]);
        expect(member.roles.remove).not.toHaveBeenCalledWith(expect.objectContaining({
            id: CONSTANTS.ROLES.SUPERSTAR
        }));
    });

    it('assigns the active Unranked role for placement players at rank 0', async () => {
        const unrankedRoleId = '1504569388056186901';
        const bronzeRoleId = '1504566977182699620';
        const { assignCompRankRoles } = loadServiceWithThresholds([
            { RankNumber: 0, DiscordRoleId: unrankedRoleId },
            { RankNumber: 1, DiscordRoleId: bronzeRoleId }
        ]);
        const { client, member, removed, added } = createClientWithMember([bronzeRoleId]);

        await assignCompRankRoles(client, 'guild-1', 'discord-1', 0);

        expect(removed).toEqual([bronzeRoleId]);
        expect(added).toEqual([unrankedRoleId]);
        expect(member.roles.add).toHaveBeenCalledWith(unrankedRoleId);
    });
});
