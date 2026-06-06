const { SlashCommandBuilder } = require('discord.js');

const manualReport = require('../../services/manualReport');

function addGameOption(command) {
    return command.addStringOption(option =>
        option
            .setName('game')
            .setDescription('Game to report this set for.')
            .setRequired(true)
            .addChoices(
                { name: 'MSBL', value: 'MSBL' },
                { name: 'MSC', value: 'MSC' },
                { name: 'SMS', value: 'SMS' }
            )
    );
}

module.exports = {
    data: addGameOption(new SlashCommandBuilder()
        .setName('report2v2')
        .setDescription('Report a 2v2 set.'))
        .addUserOption(option =>
            option
                .setName('team1p1')
                .setDescription('Team 1 player 1')
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName('team1p2')
                .setDescription('Team 1 player 2')
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName('team2p1')
                .setDescription('Team 2 player 1')
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName('team2p2')
                .setDescription('Team 2 player 2')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName('team1wins')
                .setDescription('Number of games team 1 won this set')
                .setRequired(true)
                .setMinValue(0)
        )
        .addIntegerOption(option =>
            option
                .setName('team2wins')
                .setDescription('Number of games team 2 won this set')
                .setRequired(true)
                .setMinValue(0)
        )
        .addStringOption(option =>
            option
                .setName('tournament')
                .setDescription('The name of the tournament this set was for')
        )
        .addStringOption(option =>
            option
                .setName('tournamentstage')
                .setDescription('The stage of the tournament this set was for')
        )
        .addStringOption(option =>
            option
                .setName('seturi')
                .setDescription('URI to uniquely identify the set.')
        ),
    async execute(interaction) {
        const game = interaction.options.getString('game');
        const team1p1 = interaction.options.getUser('team1p1');
        const team1p2 = interaction.options.getUser('team1p2');
        const team2p1 = interaction.options.getUser('team2p1');
        const team2p2 = interaction.options.getUser('team2p2');
        const team1Wins = interaction.options.getInteger('team1wins');
        const team2Wins = interaction.options.getInteger('team2wins');
        const tournament = interaction.options.getString('tournament') ?? '';
        const tournamentStage = interaction.options.getString('tournamentstage') ?? '';

        await interaction.deferReply();
        try {
            const report = await manualReport.recordManualReport2v2({
                interaction,
                team1p1,
                team1p2,
                team2p1,
                team2p2,
                team1Wins,
                team2Wins,
                gametype: game,
                guildid: interaction.guildId,
                tournament,
                stage: tournamentStage,
                setUri: interaction.options.getString('seturi') ?? ''
            });

            await interaction.editReply(manualReport.buildReportReply({
                legacyMatchId: report.legacyMultiMatchId,
                ratedMatchId: report.ratedMatchId,
                gameType: report.gameType,
                mode: report.mode,
                matchNumber: report.matchNumber
            }));
        } catch (err) {
            console.error(err);
            await interaction.editReply(`Could not complete command: ${err.message}`).catch(() => {});
        }
    }
};
