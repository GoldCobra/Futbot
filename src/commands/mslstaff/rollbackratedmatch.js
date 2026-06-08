const { SlashCommandSubcommandBuilder } = require('discord.js');

const CompetitiveRatingDao = require('../../db/daos/competitiveRatingDao');
const { rollbackCompetitiveMatch } = require('../../services/competitiveRating');
const { buildTerminalThreadName, quoteThreadLines } = require('../../services/competitiveRatedQueue/formatting');
const { ROLLED_BACK_THREAD_PREFIX } = require('../../services/competitiveRatedQueue/constants');
const CONSTANTS = require('../../utils/constants');

const dao = new CompetitiveRatingDao();
const GAME_CHOICES = [
    { name: 'MSC', value: 'msc', id: 1 },
    { name: 'SMS', value: 'sms', id: 2 },
    { name: 'MSBL', value: 'msbl', id: 3 }
];
const GAME_BY_KEY = new Map(GAME_CHOICES.map(game => [game.value, game]));

function formatSigned(value) {
    const rounded = Math.round(Number(value) || 0);
    return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

function formatCurrentRatings(rollback) {
    return (rollback.currentRatings ?? [])
        .map(row => `<@${row.discordId}> **${Math.round(row.currentElo)}**`)
        .join('\n');
}

function renderRollbackThreadNotice(rollback) {
    const currentRatings = formatCurrentRatings(rollback) || 'No participant ratings found.';
    return [
        `${ROLLED_BACK_THREAD_PREFIX} **MATCH ROLLED BACK.**`,
        `Reason: ${rollback.reason}`,
        `Staff: <@${rollback.rolledBackByDiscordId}>`,
        `Ratings rebuilt for ${rollback.gameCode} ${rollback.mode}.`,
        '',
        currentRatings
    ].join('\n');
}

async function finalizeRollbackThread(client, rollback) {
    if (!rollback.threadId) {
        return { status: 'missing', messageId: null, detail: 'Match has no stored thread id.' };
    }

    const thread = await client.channels.fetch(rollback.threadId).catch(() => null);
    if (!thread?.send) {
        return { status: 'missing', messageId: null, detail: 'Thread could not be fetched.' };
    }

    const reason = `Competitive rollback ${rollback.gameCode} ${rollback.mode} #${rollback.matchNumber}`;
    let messageId = null;
    let status = 'posted';
    let detail = null;

    try {
        if (thread.locked && thread.setLocked) {
            await thread.setLocked(false, reason).catch(() => {});
        }
        if (thread.archived && thread.setArchived) {
            await thread.setArchived(false, reason);
        }
        if (thread.locked && thread.setLocked) {
            await thread.setLocked(false, reason);
        }

        const rolledBackName = buildTerminalThreadName({ threadName: thread.name }, ROLLED_BACK_THREAD_PREFIX);
        if (thread.setName && thread.name !== rolledBackName) {
            await thread.setName(rolledBackName, reason);
        }

        const notice = await thread.send({
            content: quoteThreadLines(renderRollbackThreadNotice(rollback)),
            allowedMentions: { parse: [] }
        });
        messageId = notice?.id ?? null;
    } catch (err) {
        status = 'failed';
        detail = err.message;
    } finally {
        await thread.setLocked?.(true, reason).catch(() => {});
        await thread.setArchived?.(true, reason).catch(() => {});
    }

    return { status, messageId, detail };
}

function renderStaffSummary(rollback, threadResult) {
    const originalLines = (rollback.changes ?? [])
        .map(change => `<@${change.discordId}> ${formatSigned(change.eloDelta)} ELO (${Math.round(change.eloBefore)} → ${Math.round(change.eloAfter)})`);
    const currentLines = (rollback.currentRatings ?? [])
        .map(row => `<@${row.discordId}> current ELO: **${Math.round(row.currentElo)}**`);
    const threadLine = threadResult.status === 'posted'
        ? 'Thread updated, renamed, locked and archived.'
        : `Thread update warning: ${threadResult.detail ?? threadResult.status}`;
    const whrLine = rollback.whrSync?.syncStatus === 'failed'
        ? `WHR/TST sync warning: ${rollback.whrSync.lastError}`
        : rollback.whrSync?.syncStatus
            ? `WHR/TST sync: ${rollback.whrSync.syncStatus}.`
            : 'WHR/TST sync: no mirrored WHR/TST row found.';
    const dbVerificationLine = rollback.dbVerification?.verified
        ? `DB verification: RatedMatch #${rollback.matchId} is rolled_back; rollback audit #${rollback.dbVerification.rollbackId} confirmed.`
        : 'DB verification: not available.';

    return [
        rollback.alreadyRolledBack
            ? `Match was already rolled back: ${rollback.gameCode} ${rollback.mode} #${rollback.matchNumber}.`
            : `Match rolled back: ${rollback.gameCode} ${rollback.mode} #${rollback.matchNumber}.`,
        `Audit row: #${rollback.rollbackId}`,
        dbVerificationLine,
        `Snapshot rows: ${rollback.snapshotCount}`,
        `Replayed matches: ${rollback.replayedMatchCount}`,
        `Recalculated rating changes: ${rollback.recalculatedChangeCount}`,
        '',
        '**Original removed result:**',
        ...(originalLines.length ? originalLines : ['No original rating changes found.']),
        '',
        '**Current ratings after rebuild:**',
        ...(currentLines.length ? currentLines : ['No current participant ratings found.']),
        '',
        threadLine,
        whrLine
    ].join('\n');
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName('rollbackratedmatch')
        .setDescription('Rollback one competitive rated match by game, mode and match number')
        .addStringOption(option =>
            option
                .setName('game')
                .setDescription('Competitive game')
                .setRequired(true)
                .addChoices(...GAME_CHOICES.map(game => ({ name: game.name, value: game.value })))
        )
        .addStringOption(option =>
            option
                .setName('mode')
                .setDescription('Player size')
                .setRequired(true)
                .addChoices(
                    { name: '1v1', value: '1v1' },
                    { name: '2v2', value: '2v2' }
                )
        )
        .addIntegerOption(option =>
            option
                .setName('matchnumber')
                .setDescription('Visible match number from the thread title')
                .setRequired(true)
                .setMinValue(1)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Why this match is being rolled back')
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(500)
        )
        .addBooleanOption(option =>
            option
                .setName('confirm')
                .setDescription('Must be true to execute the rollback')
                .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const confirm = interaction.options.getBoolean('confirm');
        if (!confirm) {
            return interaction.editReply('Rollback not executed. Set `confirm:true` to confirm this destructive rating correction.');
        }

        const gameKey = interaction.options.getString('game');
        const game = GAME_BY_KEY.get(gameKey);
        const mode = interaction.options.getString('mode');
        const matchNumber = interaction.options.getInteger('matchnumber');
        const reason = interaction.options.getString('reason')?.trim();

        try {
            const rollback = await rollbackCompetitiveMatch({
                gameId: game.id,
                mode,
                matchNumber,
                reason,
                rolledBackByDiscordId: interaction.user.id,
                client: interaction.client,
                guildId: CONSTANTS.GUILD_ID
            });

            if (!rollback) {
                return interaction.editReply(`No competitive match found for ${game.name} ${mode} #${matchNumber}.`);
            }

            const threadResult = rollback.alreadyRolledBack
                && rollback.threadFinalizeStatus === 'posted'
                && rollback.threadNoticeMessageId
                ? {
                    status: 'posted',
                    messageId: rollback.threadNoticeMessageId,
                    detail: 'Thread was already marked rolled back.'
                }
                : await finalizeRollbackThread(interaction.client, rollback);
            await dao.updateRollbackThreadStatus({
                rollbackId: rollback.rollbackId,
                threadNoticeMessageId: threadResult.messageId,
                threadFinalizeStatus: threadResult.status
            }).catch(err => console.warn(`[rollbackratedmatch] Failed to update thread status: ${err.message}`));

            return interaction.editReply(renderStaffSummary(rollback, threadResult));
        } catch (err) {
            console.error('[rollbackratedmatch]', err);
            return interaction.editReply(`Error: ${err.message}`);
        }
    },

    __private: {
        finalizeRollbackThread,
        renderRollbackThreadNotice,
        renderStaffSummary
    }
};
