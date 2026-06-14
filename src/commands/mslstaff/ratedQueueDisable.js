const { SlashCommandSubcommandBuilder } = require('discord.js');
const { setQueueSearchEnabled } = require('../../services/competitiveRatedQueue/state');

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName('rated-queue-disable')
        .setDescription('Disable rated 1v1 and 2v2 search globally. Running matches are unaffected.'),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        setQueueSearchEnabled(false);
        await interaction.editReply(
            '🔴 Rated queue search is now **disabled**.\nNew searches and rematch requests are blocked. Running matches continue normally.\nUse `/mslstaff rated-queue-enable` to re-enable.'
        );
    }
};
