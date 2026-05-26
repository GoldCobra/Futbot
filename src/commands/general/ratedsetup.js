const { MessageFlags, PermissionsBitField, SlashCommandBuilder } = require('discord.js');

const CONSTANTS = require('../../utils/constants');
const competitiveRatedQueue = require('../../services/competitiveRatedQueue');

const STAFF_ROLES = new Set([
    CONSTANTS.ROLES.ADMIN,
    CONSTANTS.ROLES.DEVELOPER,
    CONSTANTS.ROLES.MSL_STAFF,
    CONSTANTS.ROLES.MSL_STAFF_MSC,
    CONSTANTS.ROLES.MSL_STAFF_SMS,
    CONSTANTS.ROLES.MSL_STAFF_MSBL
]);

function canManageCompetitiveRatedQueue(interaction) {
    if (interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return true;
    }

    return interaction.member?.roles?.cache?.some(role => STAFF_ROLES.has(role.id)) ?? false;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ratedsetup')
        .setDescription('Create or repair the Competitive Rated queue panels'),

    async execute(interaction) {
        if (!canManageCompetitiveRatedQueue(interaction)) {
            await interaction.reply({
                content: 'You do not have permission to manage the Competitive Rated panel.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await competitiveRatedQueue.ensureCompetitiveRatedQueue(interaction.client);
        await interaction.reply({
            content: 'Competitive Rated panels repaired and channel locks reapplied.',
            flags: MessageFlags.Ephemeral
        });
    }
};
