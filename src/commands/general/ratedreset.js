const { MessageFlags, SlashCommandBuilder } = require('discord.js');

const competitiveRatedQueue = require('../../services/competitiveRatedQueue');
const { isStaffInteraction } = require('../../utils/permissions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ratedreset')
        .setDescription('Clear Competitive Rated queue state and rebuild the panels'),

    async execute(interaction) {
        if (!isStaffInteraction(interaction)) {
            await interaction.reply({
                content: 'You do not have permission to reset the Competitive Rated queue.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Reset and panel rebuild take longer than Discord's 3-second reply window.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await competitiveRatedQueue.resetCompetitiveRatedQueue(interaction.client);
        await competitiveRatedQueue.ensureCompetitiveRatedQueue(interaction.client);
        await interaction.editReply({
            content: 'Competitive Rated queue state cleared and panels rebuilt.'
        });
    }
};
