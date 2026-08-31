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

describe('competitiveRating season-start rank role reset', () => {
    const UNRANKED = '1504569388056186901';
    const BRONZE_I = '1504566977182699620';
    const SILVER_I = '1504567155092357211';

    function loadServiceWithThresholds(thresholds) {
        jest.resetModules();

        jest.doMock('../../src/db/daos/competitiveRatingDao', () => jest.fn().mockImplementation(() => ({
            getAllRankThresholds: jest.fn(async () => thresholds)
        })));
        jest.doMock('../../src/db/daos/competitiveWhrSyncDao', () => jest.fn().mockImplementation(() => ({})));

        return require('../../src/services/competitiveRating');
    }

    function createMember(id, roleIds, { failRemoval = false } = {}) {
        const removeCalls = [];
        return {
            id,
            removeCalls,
            roles: {
                cache: {
                    filter: predicate => new Map(
                        roleIds
                            .map(roleId => ({ id: roleId }))
                            .filter(predicate)
                            .map(role => [role.id, role])
                    )
                },
                remove: jest.fn(async roles => {
                    if (failRemoval) throw new Error('missing permissions');
                    removeCalls.push(roles.map(role => role.id));
                })
            }
        };
    }

    function createClient(members) {
        const guild = {
            members: {
                fetch: jest.fn(async () => new Map(members.map(member => [member.id, member])))
            }
        };
        return {
            client: { guilds: { fetch: jest.fn(async () => guild) } },
            guild
        };
    }

    afterEach(() => {
        jest.dontMock('../../src/db/daos/competitiveRatingDao');
        jest.dontMock('../../src/db/daos/competitiveWhrSyncDao');
    });

    it('strips every competitive rank role, Unranked included, in one call per member', async () => {
        const { clearAllCompetitiveRankRoles } = loadServiceWithThresholds([
            { RankNumber: 0, DiscordRoleId: UNRANKED },
            { RankNumber: 1, DiscordRoleId: BRONZE_I },
            { RankNumber: 4, DiscordRoleId: SILVER_I }
        ]);
        const ranked = createMember('m1', [SILVER_I]);
        const unranked = createMember('m2', [UNRANKED]);
        const { client } = createClient([ranked, unranked]);

        const summary = await clearAllCompetitiveRankRoles(client, 'guild-1');

        expect(summary).toEqual({ members: 2, rolesRemoved: 2, failed: 0 });
        expect(ranked.roles.remove).toHaveBeenCalledTimes(1);
        expect(ranked.removeCalls).toEqual([[SILVER_I]]);
        expect(unranked.removeCalls).toEqual([[UNRANKED]]);
    });

    it('leaves members without a competitive rank role untouched', async () => {
        const CONSTANTS = require('../../src/utils/constants');
        const { clearAllCompetitiveRankRoles } = loadServiceWithThresholds([
            { RankNumber: 0, DiscordRoleId: UNRANKED },
            { RankNumber: 1, DiscordRoleId: BRONZE_I }
        ]);
        const bystander = createMember('m1', [CONSTANTS.ROLES.LEGEND, 'some-other-role']);
        const { client } = createClient([bystander]);

        const summary = await clearAllCompetitiveRankRoles(client, 'guild-1');

        expect(summary).toEqual({ members: 0, rolesRemoved: 0, failed: 0 });
        expect(bystander.roles.remove).not.toHaveBeenCalled();
    });

    it('never removes retired legacy rank roles even if a threshold still points at one', async () => {
        const CONSTANTS = require('../../src/utils/constants');
        const { clearAllCompetitiveRankRoles } = loadServiceWithThresholds([
            { RankNumber: 1, DiscordRoleId: BRONZE_I },
            { RankNumber: 2, DiscordRoleId: CONSTANTS.ROLES.SUPERSTAR }
        ]);
        const member = createMember('m1', [CONSTANTS.ROLES.SUPERSTAR, BRONZE_I]);
        const { client } = createClient([member]);

        const summary = await clearAllCompetitiveRankRoles(client, 'guild-1');

        expect(summary).toEqual({ members: 1, rolesRemoved: 1, failed: 0 });
        expect(member.removeCalls).toEqual([[BRONZE_I]]);
    });

    it('counts a failed removal without aborting the sweep', async () => {
        const { clearAllCompetitiveRankRoles } = loadServiceWithThresholds([
            { RankNumber: 1, DiscordRoleId: BRONZE_I },
            { RankNumber: 4, DiscordRoleId: SILVER_I }
        ]);
        const failing = createMember('m1', [BRONZE_I], { failRemoval: true });
        const ok = createMember('m2', [SILVER_I]);
        const { client } = createClient([failing, ok]);

        const summary = await clearAllCompetitiveRankRoles(client, 'guild-1');

        expect(summary).toEqual({ members: 2, rolesRemoved: 1, failed: 1 });
        expect(ok.removeCalls).toEqual([[SILVER_I]]);
    });

    it('returns an empty summary when the guild cannot be fetched', async () => {
        const { clearAllCompetitiveRankRoles } = loadServiceWithThresholds([
            { RankNumber: 1, DiscordRoleId: BRONZE_I }
        ]);
        const client = { guilds: { fetch: jest.fn(async () => { throw new Error('unknown guild'); }) } };

        await expect(clearAllCompetitiveRankRoles(client, 'guild-1'))
            .resolves.toEqual({ members: 0, rolesRemoved: 0, failed: 0 });
    });
});
