const { SlashCommandBuilder } = require('discord.js');

const CONSTANTS = require('../../utils/constants');
const startgg = require('../../integrations/startgg');
const { getStandardizeSetUrl } = startgg;
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

function validateWinOrder(winorder, p1wins, p2wins) {
    if (!winorder) {
        throw new Error('You must provide this option: `winorder`.');
    }
    if (!/^[12]+$/.test(winorder)) {
        throw new Error('Win order can only contain `1` or `2` indicating whether p1 or p2 won the game.');
    }

    const count1 = (winorder.match(/1/g) || []).length;
    const count2 = (winorder.match(/2/g) || []).length;

    if (count1 !== p1wins) {
        throw new Error(`Values are not consistent: p1wins=${p1wins} but win order has ${count1} '1' values.`);
    }
    if (count2 !== p2wins) {
        throw new Error(`Values are not consistent: p2wins=${p2wins} but win order has ${count2} '2' values.`);
    }
    if (p1wins > p2wins && winorder.endsWith('2')) {
        throw new Error(`Win order does not seem correct. p1 had ${count1} wins, and p2 had ${count2} wins, but the last game was won by p2.`);
    }
    if (p1wins < p2wins && winorder.endsWith('1')) {
        throw new Error(`Win order does not seem correct. p1 had ${count1} wins, and p2 had ${count2} wins, but the last game was won by p1.`);
    }
}

module.exports = {
    data: addGameOption(new SlashCommandBuilder()
        .setName('report1v1')
        .setDescription('Report a 1v1 set.'))
        .addUserOption(option =>
            option
                .setName('p1')
                .setDescription('Player 1')
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName('p2')
                .setDescription('Player 2')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName('p1wins')
                .setDescription('Number of games p1 won this set')
                .setRequired(true)
                .setMinValue(0)
        )
        .addIntegerOption(option =>
            option
                .setName('p2wins')
                .setDescription('Number of games p2 won this set')
                .setRequired(true)
                .setMinValue(0)
        )
        .addStringOption(option =>
            option
                .setName('winorder')
                .setDescription('Win order of the set. Example: 11222')
        )
        .addStringOption(option =>
            option
                .setName('seturi')
                .setDescription('URI to uniquely identify the set.')
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
        ),
    async execute(interaction) {
        const game = interaction.options.getString('game');
        const p1 = interaction.options.getUser('p1');
        const p2 = interaction.options.getUser('p2');
        const p1Wins = interaction.options.getInteger('p1wins');
        const p2Wins = interaction.options.getInteger('p2wins');
        const rawSeturi = interaction.options.getString('seturi');
        const winorder = interaction.options.getString('winorder');
        const tournament = interaction.options.getString('tournament') ?? '';
        const tournamentStage = interaction.options.getString('tournamentstage') ?? '';

        await interaction.deferReply();
        try {
            let seturi = null;
            if (rawSeturi) {
                seturi = getStandardizeSetUrl(rawSeturi);
                const preapprovedRoles = new Set([
                    CONSTANTS.ROLES.DEVELOPER,
                    CONSTANTS.ROLES.MSL_STAFF_MSBL,
                    CONSTANTS.ROLES.MSL_STAFF_MSC,
                    CONSTANTS.ROLES.MSL_STAFF_SMS,
                    CONSTANTS.ROLES.ADMIN
                ]);
                const approvedSubmitter = interaction.member?.roles?.cache?.some(role => preapprovedRoles.has(role.id)) ?? false;

                validateWinOrder(winorder, p1Wins, p2Wins);
                const discordIdWinOrder = [];
                for (let i = 0; i < winorder.length; i++) {
                    const winner = parseInt(winorder.charAt(i), 10);
                    discordIdWinOrder.push(winner === 1 ? p1.id : p2.id);
                }
                const result = await startgg.updateSet(seturi, discordIdWinOrder, p1.id, p2.id, approvedSubmitter);
                if ('errors' in result) {
                    await interaction.followUp(`Start gg result already updated review at ${result.url}`);
                } else if ('url' in result) {
                    await interaction.followUp(`Succesfully updated start gg! ${result.url}`);
                }
            }

            const report = await manualReport.recordManualReport1v1({
                interaction,
                p1,
                p2,
                p1Wins,
                p2Wins,
                gametype: game,
                guildid: interaction.guildId,
                tournament,
                stage: tournamentStage,
                setUri: seturi ?? ''
            });

            await interaction.editReply(manualReport.buildReportReply({
                legacyMatchId: report.legacyMatchId,
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
