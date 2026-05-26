const { SlashCommandSubcommandBuilder } = require('discord.js');
const { executeQuery } = require('../../db/sqlClient');
const { competitiveTable } = require('../../utils/competitiveConstants');

const COMPETITIVE_SEASON_TABLE = competitiveTable('CompetitiveSeason');

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName('comp-season')
        .setDescription('Show competitive season status')
        .addStringOption(option =>
            option
                .setName('action')
                .setDescription('status')
                .setRequired(true)
                .addChoices({ name: 'status', value: 'status' })
        ),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const action = interaction.options.getString('action');
        if (action !== 'status') {
            return interaction.editReply('Manual season start/end is disabled. Seasons transition automatically from DB dates.');
        }

        const fmt = value => value ? `<t:${Math.floor(new Date(value).getTime() / 1000)}:f>` : 'N/A';
        const label = season => `**${season.DisplayName}** (Season ${season.SeasonNumber}, ID ${season.Id})`;

        try {
            const [currentRes, completedRes, upcomingRes] = await Promise.all([
                executeQuery(
                    `SELECT TOP 1 Id, SeasonNumber, DisplayName, StartDateUtc, EndDateUtc,
                            LifecycleStatus, IsActive, IsCompleted, FinalizeAfterUtc
                     FROM ${COMPETITIVE_SEASON_TABLE}
                     WHERE LifecycleStatus IN ('active','ending')
                        OR IsActive = 1
                     ORDER BY CASE WHEN LifecycleStatus = 'active' THEN 0 ELSE 1 END, Id DESC`
                ),
                executeQuery(
                    `SELECT TOP 1 Id, SeasonNumber, DisplayName, StartDateUtc, EndDateUtc,
                            LifecycleStatus, FinalizedAtUtc
                     FROM ${COMPETITIVE_SEASON_TABLE}
                     WHERE LifecycleStatus = 'completed'
                        OR IsCompleted = 1
                     ORDER BY EndDateUtc DESC, Id DESC`
                ),
                executeQuery(
                    `SELECT TOP 5 Id, SeasonNumber, DisplayName, StartDateUtc, EndDateUtc,
                            LifecycleStatus
                     FROM ${COMPETITIVE_SEASON_TABLE}
                     WHERE LifecycleStatus = 'scheduled'
                        AND IsCompleted = 0
                     ORDER BY StartDateUtc ASC, Id ASC`
                )
            ]);

            const current = currentRes.recordset[0];
            const completed = completedRes.recordset[0];
            const upcoming = upcomingRes.recordset;
            const lines = [];

            if (current?.LifecycleStatus === 'active') {
                lines.push(`**Active:** ${label(current)}`);
                lines.push(`Runs: ${fmt(current.StartDateUtc)} -> ${fmt(current.EndDateUtc)}`);
            } else if (current?.LifecycleStatus === 'ending') {
                lines.push(`**Ending:** ${label(current)}`);
                lines.push(`New rated matches are blocked. Finalizes: ${fmt(current.FinalizeAfterUtc)}`);
            } else {
                lines.push('**No active season.** Rated matches are blocked until the next scheduled season starts.');
            }

            if (completed) {
                lines.push('');
                lines.push(`**Last completed:** ${label(completed)} — finalized ${fmt(completed.FinalizedAtUtc ?? completed.EndDateUtc)}`);
            }

            if (upcoming.length) {
                lines.push('');
                lines.push('**Upcoming seasons:**');
                upcoming.forEach(season => {
                    lines.push(`- ${label(season)} — starts ${fmt(season.StartDateUtc)}, ends ${fmt(season.EndDateUtc)}`);
                });
            }

            return interaction.editReply(lines.join('\n'));
        } catch (err) {
            console.error('[comp-season]', err);
            return interaction.editReply(`Error: ${err.message}`);
        }
    }
};
