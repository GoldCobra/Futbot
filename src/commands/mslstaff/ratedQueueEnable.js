const { SlashCommandSubcommandBuilder } = require('discord.js');
const { setQueueSearchEnabled } = require('../../services/competitiveRatedQueue/state');

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName('rated-queue-enable')
        .setDescription('Re-enable rated 1v1 and 2v2 search globally.'),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        setQueueSearchEnabled(true);
        await interaction.editReply(
            '🟢 Rated queue search is now **enabled**.\nPlayers can search and request rematches again.'
        );
    }
};
