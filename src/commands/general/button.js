const { MessageFlags, SlashCommandBuilder } = require('discord.js');

const rolePanel = require('../../services/rolePanel');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('button')
        .setDescription('Creates the buttons'),
    async execute(interaction) {
        for (const message of rolePanel.buildRolePanelMessages()) {
            await interaction.channel.send(message);
        }

        await interaction.reply({
            content: 'Role button panel created.',
            flags: MessageFlags.Ephemeral
        });
    }
};
