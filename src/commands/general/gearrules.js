const { SlashCommandBuilder } = require('discord.js');

const gear = require('../../services/gear');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('gearrules')
        .setDescription('Manual for /gear'),
    async execute(interaction) {
        await interaction.reply(gear.getGearRulesText());
    }
};
