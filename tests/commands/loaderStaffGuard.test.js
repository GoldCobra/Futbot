const { Collection, PermissionsBitField } = require('discord.js');

const commandLoader = require('../../src/commands/loader');
const CONSTANTS = require('../../src/utils/constants');

function createInteraction({
    command,
    roles = [],
    administrator = false
} = {}) {
    return {
        commandName: 'mslstaff',
        options: {
            getSubcommand: jest.fn(() => 'rollbackratedmatch')
        },
        client: {
            commands: new Collection([
                ['mslstaff', new Collection([
                    ['rollbackratedmatch', command]
                ])]
            ])
        },
        memberPermissions: {
            has: jest.fn(permission => administrator && permission === PermissionsBitField.Flags.Administrator)
        },
        member: {
            roles: {
                cache: new Collection(roles.map(roleId => [roleId, { id: roleId }]))
            }
        },
        reply: jest.fn(async () => {}),
        followUp: jest.fn(async () => {})
    };
}

describe('command loader staff guard', () => {
    it('blocks non-staff users from mslstaff subcommands at runtime', async () => {
        const command = jest.fn(async () => {});
        const interaction = createInteraction({ command });

        await commandLoader.execute(interaction);

        expect(command).not.toHaveBeenCalled();
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'You do not have permission to use MSL staff commands.'
        }));
    });

    it('allows configured staff roles to run mslstaff subcommands', async () => {
        const command = jest.fn(async () => {});
        const interaction = createInteraction({
            command,
            roles: [CONSTANTS.ROLES.MSL_STAFF_MSBL]
        });

        await commandLoader.execute(interaction);

        expect(command).toHaveBeenCalledWith(interaction);
        expect(interaction.reply).not.toHaveBeenCalled();
    });

    it('allows administrators to run mslstaff subcommands', async () => {
        const command = jest.fn(async () => {});
        const interaction = createInteraction({ command, administrator: true });

        await commandLoader.execute(interaction);

        expect(command).toHaveBeenCalledWith(interaction);
    });
});
