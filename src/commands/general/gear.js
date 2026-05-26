const { SlashCommandBuilder } = require('discord.js');

const gear = require('../../services/gear');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('gear')
        .setDescription('Gear Build Constructor')
        .addIntegerOption(option => option
            .setName('strength')
            .setDescription('Desired strength stat')
            .setRequired(true)
        )
        .addIntegerOption(option => option
            .setName('speed')
            .setDescription('Desired speed stat')
            .setRequired(true)
        )
        .addIntegerOption(option => option
            .setName('shooting')
            .setDescription('Desired shooting stat')
            .setRequired(true)
        )
        .addIntegerOption(option => option
            .setName('passing')
            .setDescription('Desired passing stat')
            .setRequired(true)
        )
        .addIntegerOption(option => option
            .setName('technique')
            .setDescription('Desired technique stat')
            .setRequired(true)
        )
        .addStringOption(option => option
            .setName('character')
            .setDescription('Character name')
            .setRequired(true)
        ),
    async execute(interaction) {
        await interaction.reply(gear.buildGearResponse(
            interaction.options.getInteger('strength'),
            interaction.options.getInteger('speed'),
            interaction.options.getInteger('shooting'),
            interaction.options.getInteger('passing'),
            interaction.options.getInteger('technique'),
            interaction.options.getString('character')
        ));
    }
};
