const { MessageFlags, SlashCommandBuilder } = require('discord.js');

const competitiveRatedQueue = require('../../services/competitiveRatedQueue');
const { isStaffInteraction } = require('../../utils/permissions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ratedsetup')
        .setDescription('Create or repair the Competitive Rated queue panels'),

    async execute(interaction) {
        if (!isStaffInteraction(interaction)) {
            await interaction.reply({
                content: 'You do not have permission to manage the Competitive Rated panel.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Repairing the panels takes longer than Discord's 3-second reply window.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await competitiveRatedQueue.ensureCompetitiveRatedQueue(interaction.client);
        await interaction.editReply({
            content: 'Competitive Rated panels repaired and channel locks reapplied.'
        });
    }
};
