const crypto = require('node:crypto');
const path = require('node:path');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    PermissionsBitField
} = require('discord.js');

const { executeQuery } = require('../../db/sqlClient');
const { fetchChannel, safeFollowUp, safeReply } = require('../../utils/discord');
const {
    recordCompetitiveResult,
    getPlayerRating,
    getPlayerRatingForSeason,
    getActiveSeason,
    getDefaultCompetitiveRating,
    recoverPendingCompetitiveWhrSync,
    getSeasonQueueAvailability,
    beginDueSeasonEnding,
    finalizeDueEndingSeason,
    activateDueSeason
} = require('../competitiveRating');
const { runPendingCompetitiveWhrRunner } = require('../competitiveWhrRunner');
const { COMP_RANK_EMOJIS, COMP_RANK_NAMES, PLACEMENT_GAMES_REQUIRED } = require('../../utils/competitiveConstants');
const RatedMatchDao = require('../../db/daos/ratedMatchDao');
const ratedMatchDao = new RatedMatchDao();
const {
    ARROW_EMOJI,
    BL_CHECK_EMOJI,
    BL_CUP_EMOJI,
    BL_TIME_EMOJI,
    BL_X_EMOJI,
    CANCELLED_THREAD_PREFIX,
    CAPTAIN_DISPLAY_OVERRIDES,
    CAPTAIN_BUTTON_ORDER_BY_GAME_TYPE,
    COMPLETED_THREAD_CLOSE_DELAY_MS,
    COMPLETED_THREAD_PREFIX,
    CONFIG,
    CONSTANTS,
    CONTROL_EXPIRY_MESSAGE,
    DEFAULT_POOL_DURATION_MINUTES,
    LOSER_CHOICE_TIMEOUT_MINUTES,
    MATCH_TIMEOUT_PHASES,
    MSC_CAPTAIN_BUTTON_ORDER,
    PANEL_BYPASS_ROLES,
    PLAYER_COUNT_EMOJI,
    RULES_IMAGE_PATHS_BY_GAME_TYPE,
    SCORE_EMOJIS,
    SELECTION_TIMEOUT_MINUTES,
    STADIUM_BUTTON_ORDER_BY_GAME_TYPE,
    STADIUM_DISPLAY_OVERRIDES
} = require('./constants');
const {
    cancelSearchCustomId,
    captainButtonCustomId,
    extendSearchCustomId,
    loserAdvantageCustomId,
    loserConfirmCustomId,
    panelJoinCustomId,
    parseActionTokenFromCustomId,
    parseChannelIdFromCustomId,
    parseIdFromCustomId,
    parseLoserChoiceFromCustomId,
    parseModeFromCustomId,
    parseOptionValueFromCustomId,
    reportIssueCustomId,
    stadiumButtonCustomId,
    startSetupCustomId,
    winnerButtonCustomId
} = require('./customIds');
const {
    buildTerminalThreadName,
    buildThreadTextPayload,
    buildThreadUrl,
    quoteThreadBlock,
    quoteThreadLines,
    renderCountdownLine,
    renderTimedMessage,
    truncateButtonLabel,
    truncateDiscordName
} = require('./formatting');
const {
    clearCompletedThreadCloseTimer,
    clearCompletedThreadCloseTimers,
    clearPendingCompletedThreadFinalizations,
    state,
    withInteractionLock,
    withOperationQueue
} = require('./state');
const {
    ensureDeferredReply,
    ensureDeferredUpdate,
    ensureImmediateReply,
    silentlyAcknowledgeInteraction
} = require('./interactions');
const {
    buildGameImageMessage,
    buildImageMessage,
    buildPanelImageMessage,
    buildSeparatorImageMessage,
    getGameImagePath,
    getPanelImagePath
} = require('./messages');
const {
    applyLoserChoice,
    areSinglesSearchesCompatible,
    buildBalancedDoublesTeams,
    buildDoublesTeams,
    buildSinglesTeams,
    computeFirstTo
} = require('./matchLogic');
const {
    clearPendingResult,
    getMatchActionToken,
    getNextGameNumber,
    getPendingResultGameNumber,
    getPendingResultLoserTeamIndex,
    getPendingResultWinnerMention: getPendingResultWinnerMentionFromState,
    getPendingResultWinnerTeam,
    getPrivateDeliveryInteraction,
    matchActionTokenMatches,
    rememberPrivateDeliveryInteraction,
    requiresSetup,
    setPendingResult
} = require('./matchState');
const {
    clearRuntimeLogTimers,
    flushRuntimeLogsForTests,
    logRatedError,
    logRatedInfo,
    logRatedWarn,
    runRatedRuntimeLogCleanup,
    startRatedRuntimeLogCleanupLoop
} = require('./runtimeLogger');
const {
    clearWinnerWaitingPrompt,
    deliverPrivateInteractionPayload,
    rememberWinnerWaitingPrompt,
    replaceWinnerWaitingPrompt
} = require('./privatePrompts');
const {
    clearCurrentControlMessage,
    clearSetupMessageComponents,
    deleteSetupMessageAndPostConfirmation,
    deleteThreadMessage,
    editOrSendThreadMessage,
    fetchThreadMessage
} = require('./threadMessages');
const { runMatchTransition } = require('./matchTransitions');
const {
    createIssueReportPost,
    isReportableMatch,
    storeReportableMatch
} = require('./terminalFlow');

function getModeCompactLabel(mode) {
    return mode === '2v2' ? '2vs2' : '1vs1';
}

function getPanelConfigByChannelId(channelId) {
    return CONFIG.PANEL_CHANNELS.find(panel => panel.channelId === channelId) ?? null;
}

function isManagedPanelChannel(channelId) {
    return Boolean(getPanelConfigByChannelId(channelId));
}

function getSearchLogDetails(search) {
    return {
        search: search?.id,
        user: search?.userId,
        channel: search?.channelId
    };
}

function getMatchLogDetails(match, extra = {}) {
    return {
        match: match?.id,
        thread: match?.threadId,
        score: match?.score ? `${match.score.team1}-${match.score.team2}` : null,
        stage: match?.stage,
        ...extra
    };
}

function hasExpectedMatchStageAndToken(match, interaction, expectedStage, gameNumber = getNextGameNumber(match)) {
    return match.stage === expectedStage
        && matchActionTokenMatches(match, interaction.customId, gameNumber);
}

async function ignoreMatchInteraction(interaction, match, event, reason, extra = {}, acknowledgeOptions = {}) {
    logRatedInfo(interaction.client, match, event, getMatchLogDetails(match, {
        user: interaction.user.id,
        reason,
        ...extra
    }));
    await silentlyAcknowledgeInteraction(interaction, acknowledgeOptions);
}

const SEASON_UNAVAILABLE_MESSAGE = 'Season ended. New Season will start soon.';
const QUEUE_JOIN_SEASON_UNAVAILABLE_MESSAGE = 'Season has not started yet. Rated matches open soon.';

function buildPanelMessage(channelId = CONFIG.PANEL_CHANNELS[0].channelId) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(panelJoinCustomId(channelId, '1v1'))
            .setLabel('Search 1vs1')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(panelJoinCustomId(channelId, '2v2'))
            .setLabel('Search 2vs2')
            .setStyle(ButtonStyle.Primary)
    );

    return {
        components: [row]
    };
}

function buildStatusMessageContent(counts) {
    const lines = [];

    if ((counts['1v1'] ?? 0) > 0) {
        lines.push(`Players in 1vs1 Pool: **${PLAYER_COUNT_EMOJI} ${counts['1v1']}**`);
    }

    if ((counts['2v2'] ?? 0) > 0) {
        lines.push(`Players in 2vs2 Pool: **👥 ${counts['2v2']}**`);
    }

    return lines.join('\n');
}

function buildExtendButtons(search) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(extendSearchCustomId(search.id, DEFAULT_POOL_DURATION_MINUTES, search.warningToken))
                .setLabel(`Extend ${DEFAULT_POOL_DURATION_MINUTES} min`)
                .setStyle(ButtonStyle.Primary)
        )
    ];
}

function buildGoToMatchComponents(threadUrl) {
    if (!threadUrl) {
        return [];
    }

    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Go to Match')
                .setStyle(ButtonStyle.Link)
                .setURL(threadUrl)
        )
    ];
}

function buildMatchFoundPayload(mode, threadUrl, mentions = []) {
    let content = mentions.join(' ');
    if (mode === '1v1' && mentions.length >= 2) {
        content = `${mentions[0]} VS ${mentions[1]}`;
    } else if (mode === '2v2' && mentions.length >= 4) {
        content = `${mentions[0]} ${mentions[1]} VS ${mentions[2]} ${mentions[3]}`;
    }

    return {
        content: `${BL_CHECK_EMOJI} Opponent found!\n${content}`,
        components: buildGoToMatchComponents(threadUrl)
    };
}

function buildLeavePoolLabel(mode) {
    return `Leave ${getModeCompactLabel(mode)}`;
}

function buildDefaultCompetitiveRating(defaultRating) {
    const rating = Number(defaultRating);
    if (!Number.isFinite(rating)) {
        throw new Error('Default competitive rating is not available');
    }
    return {
        Elo: rating,
        RankNumber: 0,
        Rank: 0,
        PlacementPlayed: 0,
        PlacementComplete: false
    };
}

function renderPoolJoinMessage(search, compRating = null) {
    const joinLine = `You joined the ${getModeCompactLabel(search.mode)} pool.`;
    let body = joinLine;
    const parsedRank = Number(compRating?.RankNumber ?? compRating?.Rank ?? 0);
    const rank = Number.isFinite(parsedRank) ? parsedRank : 0;
    const baseRankName = COMP_RANK_NAMES[rank] ?? 'Unranked';
    const parsedPlacement = Number(compRating?.PlacementPlayed ?? 0);
    const placementPlayed = Number.isFinite(parsedPlacement)
        ? Math.max(0, Math.min(PLACEMENT_GAMES_REQUIRED, Math.round(parsedPlacement)))
        : 0;
    const rankName = rank === 0
        ? `${baseRankName} ${placementPlayed}/${PLACEMENT_GAMES_REQUIRED}`
        : baseRankName;
    const parsedElo = Number(compRating?.Elo);
    if (!Number.isFinite(parsedElo)) {
        throw new Error('Competitive rating ELO is not available');
    }
    const elo = Math.round(parsedElo);
    body += `\n${COMP_RANK_EMOJIS[rank] ?? COMP_RANK_EMOJIS[0]} **${rankName}** (${elo})`;
    return renderTimedMessage(
        body,
        search.expiresAt,
        `**${search.durationMinutes ?? DEFAULT_POOL_DURATION_MINUTES} mins**`
    );
}

function buildSearchExpiryWarningPayload(search) {
    return {
        content: renderTimedMessage(
            `Your ${getModeCompactLabel(search.mode)} pool entry is still active.`,
            search.expiresAt,
            `**${CONFIG.EXPIRING_SOON_MINUTES} minutes**`
        ),
        components: buildExtendButtons(search)
    };
}

function buildSearchExpiredPayload(search) {
    return {
        content: `${BL_X_EMOJI} Your ${getModeCompactLabel(search.mode)} pool entry **expired**. You were removed from the pool!`,
        components: []
    };
}

function buildSearchSeasonEndedPayload(search) {
    return {
        content: `${BL_X_EMOJI} ${SEASON_UNAVAILABLE_MESSAGE}`,
        components: []
    };
}

function createPanelMeta(channelId) {
    return {
        channelId,
        imageMessageId: null,
        panelMessageId: null,
        statusMessageId: null,
        channelLockApplied: false,
        availabilityKey: 'active'
    };
}

function getOrCreatePanelMeta(channelId) {
    if (!state.panelMetaByChannelId.has(channelId)) {
        state.panelMetaByChannelId.set(channelId, createPanelMeta(channelId));
    }
    return state.panelMetaByChannelId.get(channelId);
}

function hasBypassRole(member) {
    if (!member?.roles?.cache) {
        return false;
    }

    if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) {
        return true;
    }

    return member.roles.cache.some(role => PANEL_BYPASS_ROLES.has(role.id));
}

function buildSearchCounts(channelId) {
    const counts = {
        '1v1': 0,
        '2v2': 0
    };

    for (const search of state.activeSearchesById.values()) {
        if (search.channelId !== channelId) {
            continue;
        }
        counts[search.mode] += 1;
    }

    return counts;
}

function createId() {
    return crypto.randomBytes(6).toString('hex');
}

function describeTeam(team) {
    return team.members.map(member => member.mention).join(' + ');
}

function describeThreadTeam(team) {
    return team.members.map(member => member.username).join(' + ');
}

function getInteractionDisplayName(interaction) {
    return interaction.member?.displayName
        ?? interaction.user.globalName
        ?? interaction.user.username
        ?? `Player ${interaction.user.id}`;
}

function normalizePlayerName(name, discordId) {
    const value = String(name ?? '').trim() || `Player ${discordId}`;
    return value.slice(0, 100);
}

async function getPlayerIdByDiscordId(discordId) {
    const result = await executeQuery(`
        SELECT TOP 1 ID AS Id
        FROM dbo.Player
        WHERE DiscordID = @discordId
    `, { discordId: String(discordId) });
    return result.recordset[0]?.Id ?? null;
}

async function ensureCompetitivePlayer(discordId, displayName = null) {
    const normalizedDiscordId = String(discordId);
    const existingId = await getPlayerIdByDiscordId(normalizedDiscordId);
    if (existingId) {
        return existingId;
    }

    try {
        const inserted = await executeQuery(`
            INSERT INTO dbo.Player (Name, DiscordID)
            OUTPUT INSERTED.ID AS Id
            VALUES (@name, @discordId)
        `, {
            discordId: normalizedDiscordId,
            name: normalizePlayerName(displayName, normalizedDiscordId)
        });
        const insertedId = inserted.recordset[0]?.Id;
        if (insertedId) {
            return insertedId;
        }
    } catch (error) {
        const existingAfterRace = await getPlayerIdByDiscordId(normalizedDiscordId);
        if (existingAfterRace) {
            return existingAfterRace;
        }
        throw error;
    }

    throw new Error(`Failed to create Player row for Discord ID ${normalizedDiscordId}`);
}

function buildThreadName(mode, displayNumber, homeTeam, awayTeam) {
    return truncateDiscordName(`${mode} #${displayNumber} | ${describeThreadTeam(homeTeam)} VS ${describeThreadTeam(awayTeam)}`);
}

function getStadiumDisplayDescription(description) {
    return STADIUM_DISPLAY_OVERRIDES[description] ?? description;
}

function getCaptainDisplayDescription(description) {
    return CAPTAIN_DISPLAY_OVERRIDES[description] ?? description;
}

function formatCustomEmoji(emoji) {
    if (!emoji?.name || !emoji?.id) {
        return '';
    }

    return `<:${emoji.name}:${emoji.id}>`;
}

function getCaptainEmoji(captain, gameType) {
    const order = CAPTAIN_BUTTON_ORDER_BY_GAME_TYPE[gameType] ?? MSC_CAPTAIN_BUTTON_ORDER;
    return order.find(captainConfig =>
        optionMatchesAliases(captain, captainConfig.aliases)
    )?.emoji ?? null;
}

function renderStadiumSelectionConfirmation(match) {
    const homeTeam = match.teams[match.homeTeamIndex - 1];
    const stadiumName = getStadiumDisplayDescription(match.selectedStadium.description);
    return `${ARROW_EMOJI} ${homeTeam.repMention} chose **${stadiumName}**`;
}

function renderCaptainSelectionConfirmation(match) {
    const awayTeam = match.teams[match.awayTeamIndex - 1];
    const captainEmoji = formatCustomEmoji(getCaptainEmoji(match.selectedCaptain, match.gameType));
    const captainPrefix = captainEmoji ? `${captainEmoji} ` : '';
    const captainName = getCaptainDisplayDescription(match.selectedCaptain.description);
    return `${ARROW_EMOJI} ${awayTeam.repMention} chose ${captainPrefix}**${captainName}**`;
}

function formatPlayerRating(rating, mode) {
    if (!rating) {
        throw new Error('Competitive rating is not available');
    }
    const rank = rating.RankNumber ?? rating.Rank ?? 0;
    const elo  = rating.Elo;
    const parsedElo = Number(elo);
    if (!Number.isFinite(parsedElo)) {
        throw new Error('Competitive rating ELO is not available');
    }
    return { emoji: COMP_RANK_EMOJIS[rank] ?? COMP_RANK_EMOJIS[0], elo: Math.round(parsedElo) };
}

function renderWelcomeRulesMessage(match, homeRating = null, awayRating = null) {
    const homeTeam = match.teams[match.homeTeamIndex - 1];
    const awayTeam = match.teams[match.awayTeamIndex - 1];
    const homeDesc = describeTeam(homeTeam);
    const awayDesc = describeTeam(awayTeam);
    const { emoji: hEmoji, elo: hElo } = formatPlayerRating(homeRating, match.mode);
    const { emoji: aEmoji, elo: aElo } = formatPlayerRating(awayRating, match.mode);
    return `Welcome to a rated match between ${homeDesc} ${hEmoji} **${hElo}** and ${awayDesc} ${aEmoji} **${aElo}**! ${homeDesc} has been selected as HOME!`;
}

function getMatchCountdownLine(match, fallbackMinutes) {
    return renderCountdownLine(match?.timeoutDeadlineAt, `**${fallbackMinutes} mins**`);
}

function renderStartMessage(match) {
    const homeTeam = match.teams[match.homeTeamIndex - 1];
    const gameNumber = getNextGameNumber(match);
    const lines = [];
    if (gameNumber > 1) {
        lines.push(`**Game ${gameNumber}!** ${describeTeam(homeTeam)} plays **HOME**.`);
    }

    lines.push('Click **Start Match**.');
    lines.push(getMatchCountdownLine(match, CONFIG.MATCH_START_TIMEOUT_MINUTES));
    return lines.join('\n');
}

function renderHomeSelectionPrompt(match) {
    const awayTeam = match.teams[match.awayTeamIndex - 1];
    return renderTimedMessage(
        `Please select the **STADIUM**. ${describeTeam(awayTeam)} will select the captain.`,
        match.homeSelectionDeadlineAt,
        `**${SELECTION_TIMEOUT_MINUTES} mins**`
    );
}

function renderAwaySelectionPrompt(match) {
    const homeTeam = match.teams[match.homeTeamIndex - 1];
    return renderTimedMessage(
        `Please select your **CAPTAIN**. ${describeTeam(homeTeam)} will select the stadium.`,
        match.awaySelectionDeadlineAt,
        `**${SELECTION_TIMEOUT_MINUTES} mins**`
    );
}

function getSetupSelectionConfig(match, userId) {
    const homeRepId = match.teams[match.homeTeamIndex - 1].repUserId;
    const awayRepId = match.teams[match.awayTeamIndex - 1].repUserId;

    if (userId === homeRepId) {
        return {
            player: 'home',
            repId: homeRepId,
            selectedKey: 'selectedStadium',
            buildRows: buildStadiumButtonRows,
            renderPrompt: renderHomeSelectionPrompt,
            otherRepId: awayRepId
        };
    }

    if (userId === awayRepId) {
        return {
            player: 'away',
            repId: awayRepId,
            selectedKey: 'selectedCaptain',
            buildRows: buildCaptainButtonRows,
            renderPrompt: renderAwaySelectionPrompt,
            otherRepId: homeRepId
        };
    }

    return null;
}

function getSetupPermissionMessage(match) {
    if (!match.selectedStadium) {
        return match.mode === '1v1'
            ? 'Only the **HOME** player may choose the stadium.'
            : 'Only the **HOME** team rep may choose the stadium.';
    }

    return match.mode === '1v1'
        ? 'Only the **AWAY** player may choose the captain.'
        : 'Only the **AWAY** team rep may choose the captain.';
}

function renderCombinedSelectionsMessage(match) {
    return `${renderStadiumSelectionConfirmation(match)}\n${renderCaptainSelectionConfirmation(match)}`;
}

function buildStadiumSelectionConfirmationPayload(match) {
    return buildThreadTextPayload(renderStadiumSelectionConfirmation(match), 'line', { components: [] });
}

function buildCaptainSelectionConfirmationPayload(match) {
    return buildThreadTextPayload(renderCaptainSelectionConfirmation(match), 'line', { components: [] });
}

function formatScoreResult(match) {
    const left = SCORE_EMOJIS[match.score.team1] ?? String(match.score.team1);
    const right = SCORE_EMOJIS[match.score.team2] ?? String(match.score.team2);
    return `${left} **-** ${right}`;
}

function getDisplayedDelta(delta) {
    const rounded = Math.round(delta);
    if (!Number.isFinite(rounded)) {
        return '+0';
    }

    return rounded >= 0 ? `+${rounded}` : `${rounded}`;
}

function renderCompetitiveRatingLine(change) {
    const rank = change.rankAfter ?? 0;
    const rankEmoji = COMP_RANK_EMOJIS[rank] ?? COMP_RANK_EMOJIS[0];
    const eloAfter = Math.round(change.eloAfter);
    return `<@${change.discordId}> ${getDisplayedDelta(change.eloDelta)} ${ARROW_EMOJI} ${rankEmoji} **${eloAfter}**`;
}

function renderCompetitiveRatingSummaryMessage(competitiveResult = null) {
    if (!Array.isArray(competitiveResult?.changes) || competitiveResult.changes.length === 0) {
        return null;
    }

    return competitiveResult.changes
        .slice()
        .sort((left, right) => {
            if (left.outcome !== right.outcome) return left.outcome === 'win' ? -1 : 1;
            return left.teamNumber - right.teamNumber;
        })
        .map(renderCompetitiveRatingLine)
        .join('\n');
}

function renderGameResultMessage(winnerMention, gameNumber, match) {
    return quoteThreadBlock(`${winnerMention} wins **Game ${gameNumber}**.\nResult: ${formatScoreResult(match)}`);
}

async function renderFinalMatchResultMessage(winnerMention, match, competitiveResult = null) {
    return quoteThreadBlock(
        `${BL_CUP_EMOJI} **${winnerMention} WINS THE MATCH!**\n` +
        `Result: ${formatScoreResult(match)}`
    );
}

function renderMatchCompleteNoticeMessage() {
    return quoteThreadLines(`${BL_CHECK_EMOJI} **MATCH COMPLETE!** Thanks for playing.`);
}

function getPendingResultWinnerMention(match) {
    return getPendingResultWinnerMentionFromState(match, describeTeam);
}

function renderNoSetupGameResultMessage(match, statusLine = null) {
    const winnerTeam = getPendingResultWinnerTeam(match);
    const loserTeamIndex = getPendingResultLoserTeamIndex(match);
    const loserTeam = match.teams[loserTeamIndex - 1];
    const winnerDescription = winnerTeam ? describeTeam(winnerTeam) : 'The winner';
    const loserDescription = loserTeam ? describeTeam(loserTeam) : 'The loser';
    const status = statusLine ?? `${loserDescription}, press **Confirm Game Loss** to confirm the result.`;
    const lines = [
        `**${winnerDescription} WINS GAME ${getPendingResultGameNumber(match)}!**`,
        `Result: ${formatScoreResult(match)}`
    ];
    if (status) {
        lines.push(status);
    }

    return quoteThreadBlock(lines.join('\n'));
}

const INACTIVITY_REASONS = {
    game:  n => `Game ${n} was not completed within the allowed time.`,
    start: n => `Game ${n} was not started within the allowed time.`,
    loser_confirmation: n => `Game ${n} setup was not completed within the allowed time.`
};

function renderInactivityCancelMessage(match, phase) {
    const gameNumber = getNextGameNumber(match);
    const reason = (INACTIVITY_REASONS[phase] ?? INACTIVITY_REASONS.loser_confirmation)(gameNumber);

    return quoteThreadBlock(
        `${reason}\n` +
        'The match was automatically ended because players were inactive.'
    );
}

function renderMatchControlContent(match) {
    if (match.stage === 'awaiting_winner') {
        const homeDesc = describeTeam(match.teams[match.homeTeamIndex - 1]);
        const awayDesc = describeTeam(match.teams[match.awayTeamIndex - 1]);
        const countdownLine = getMatchCountdownLine(match, CONFIG.MATCH_GAME_TIMEOUT_MINUTES);
        if (requiresSetup(match.gameType)) {
            return quoteThreadLines(
                `We're ready to start Game ${getNextGameNumber(match)}! Please set up a game at ${getStadiumDisplayDescription(match.selectedStadium.description)}. ` +
                `${homeDesc} will play the **HOME** side, while ${awayDesc} will play the **AWAY** side with ${getCaptainDisplayDescription(match.selectedCaptain.description)} as their captain!\n` +
                'Press **GAME WIN** when the game is over.\n' +
                countdownLine
            );
        }
        return quoteThreadLines(
            `We're ready to start Game ${getNextGameNumber(match)}! ${homeDesc} vs ${awayDesc}.\n` +
            'Press **GAME WIN** when the game is over.\n' +
            countdownLine
        );
    }

    if (match.stage === 'awaiting_loser_confirmation') {
        const loserTeam = match.teams[getPendingResultLoserTeamIndex(match) - 1];
        const countdownLine = getMatchCountdownLine(match, LOSER_CHOICE_TIMEOUT_MINUTES);
        if (!requiresSetup(match.gameType)) {
            return quoteThreadLines(
                `${describeTeam(loserTeam)}, press **Confirm Game Loss** to confirm the result.\n` +
                countdownLine
            );
        }
        return quoteThreadLines(
            `${describeTeam(loserTeam)}! Press **Confirm Game Loss** to choose your advantage for the next game.\n` +
            countdownLine
        );
    }

    return quoteThreadLines(`${BL_CHECK_EMOJI} **MATCH COMPLETE!** Thanks for playing.`);
}

function createGameBlock(gameNumber) {
    return {
        gameNumber,
        gameImageSeparatorMessageId: null,
        gameImageMessageId: null,
        startMessageId: null,
        homeSelectionPromptId: null,
        awaySelectionPromptId: null,
        selectionsMessageId: null,
        delayedResult: null,
        delayedResultMessageId: null
    };
}

function getOrCreateGameBlock(match, gameNumber = getNextGameNumber(match)) {
    if (!Array.isArray(match.gameBlocks)) {
        match.gameBlocks = [];
    }

    let block = match.gameBlocks.find(existingBlock => existingBlock.gameNumber === gameNumber);
    if (!block) {
        block = createGameBlock(gameNumber);
        match.gameBlocks.push(block);
    }

    return block;
}

function buildStartButton(matchId, gameNumber = 1) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(startSetupCustomId(matchId, gameNumber))
            .setLabel('Start Match')
            .setStyle(ButtonStyle.Primary)
    );
}

function buildStartPayload(match) {
    return buildThreadTextPayload(renderStartMessage(match), 'line', {
        components: [buildStartButton(match.id, getMatchActionToken(match, getNextGameNumber(match)))]
    });
}

function buildReportIssueButton(matchId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(reportIssueCustomId(matchId))
            .setLabel('Report Issue')
            .setStyle(ButtonStyle.Secondary)
    );
}

function buildFinalMatchComponents(match) {
    return isReportableMatch(match)
        ? [buildReportIssueButton(match.id)]
        : [];
}

function buildWelcomeRulesPayload(match, homeRating = null, awayRating = null) {
    const rulesImagePath = RULES_IMAGE_PATHS_BY_GAME_TYPE[match.gameType] ?? null;
    const rulesPayload = rulesImagePath ? buildImageMessage(rulesImagePath) ?? {} : {};
    return buildThreadTextPayload(renderWelcomeRulesMessage(match, homeRating, awayRating), 'block', {
        files: rulesPayload.files ?? []
    });
}

function buildInitialGameSetupPayloads(match, includeRulesImage = false, homeRating = null, awayRating = null) {
    const payloads = [];

    if (includeRulesImage) {
        payloads.push({ type: 'welcome-rules', payload: buildWelcomeRulesPayload(match, homeRating, awayRating) });
    }

    if (requiresSetup(match.gameType)) {
        payloads.push({ type: 'start', payload: buildStartPayload(match) });
    }

    return payloads.filter(item => item.payload);
}

function chunkOptions(options, size) {
    const chunks = [];
    for (let index = 0; index < options.length; index += size) {
        chunks.push(options.slice(index, index + size));
    }
    return chunks;
}

function sortStadiumButtons(stadiums, gameType) {
    const order = STADIUM_BUTTON_ORDER_BY_GAME_TYPE[gameType] ?? [];
    const byDescription = new Map(stadiums.map(option => [option.description, option]));
    const ordered = order.map(description => byDescription.get(description)).filter(Boolean);
    return ordered.length > 0 ? ordered : stadiums;
}

function normalizeButtonOptionKey(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function optionMatchesAliases(option, aliases) {
    const optionKeys = [
        option.description,
        option.code
    ].map(normalizeButtonOptionKey);

    return aliases.some(alias => optionKeys.includes(normalizeButtonOptionKey(alias)));
}

function buildCaptainButtonOptions(captains, gameType) {
    const captainOrder = CAPTAIN_BUTTON_ORDER_BY_GAME_TYPE[gameType] ?? MSC_CAPTAIN_BUTTON_ORDER;
    const usedValues = new Set();
    const ordered = [];

    for (const captainConfig of captainOrder) {
        const option = captains.find(candidate =>
            !usedValues.has(candidate.value)
                && optionMatchesAliases(candidate, captainConfig.aliases)
        );
        if (!option) {
            continue;
        }

        usedValues.add(option.value);
        ordered.push({
            ...option,
            emoji: captainConfig.emoji,
            emojiOnly: true
        });
    }

    const unmatched = captains.filter(option => !usedValues.has(option.value));
    return ordered.length > 0 ? [...ordered, ...unmatched] : captains;
}

function buildOptionButtonRows(options, customIdBuilder, style = ButtonStyle.Primary, maxRows = 5, buttonsPerRow = 5, labelTransformer = null) {
    return chunkOptions(options, buttonsPerRow)
        .slice(0, maxRows)
        .map(chunk => new ActionRowBuilder().addComponents(
            chunk.map(option => {
                const button = new ButtonBuilder()
                    .setCustomId(customIdBuilder(option.value))
                    .setStyle(style);

                if (option.emoji) {
                    button.setEmoji(option.emoji);
                }
                if (!option.emojiOnly) {
                    const label = labelTransformer
                        ? labelTransformer(option)
                        : option.description;
                    button.setLabel(truncateButtonLabel(label));
                }

                return button;
            })
        ));
}

function buildStadiumButtonRows(match, options) {
    if (match.selectedStadium || match.stage !== 'awaiting_start') {
        return [];
    }

    const sorted = sortStadiumButtons(options.stadiums, match.gameType);
    const maxRows = Math.min(Math.ceil(sorted.length / 4), 5);
    return buildOptionButtonRows(
        sorted,
        optionValue => stadiumButtonCustomId(match.id, optionValue, getMatchActionToken(match, getNextGameNumber(match))),
        ButtonStyle.Secondary,
        maxRows,
        4,
        option => getStadiumDisplayDescription(option.description).toUpperCase()
    );
}

function buildCaptainButtonRows(match, options) {
    if (match.selectedCaptain || match.stage !== 'awaiting_start') {
        return [];
    }

    return buildOptionButtonRows(
        buildCaptainButtonOptions(options.captains, match.gameType),
        optionValue => captainButtonCustomId(match.id, optionValue, getMatchActionToken(match, getNextGameNumber(match))),
        ButtonStyle.Secondary,
        4,
        4
    );
}

function buildMatchComponents(match, options) {
    if (match.stage === 'complete') {
        return [];
    }

    if (match.stage === 'awaiting_winner') {
        const gameNumber = getNextGameNumber(match);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(winnerButtonCustomId(match.id, getMatchActionToken(match, gameNumber)))
                .setLabel('GAME WIN')
                .setStyle(ButtonStyle.Success)
        );
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(loserConfirmCustomId(match.id, getMatchActionToken(match, gameNumber)))
                .setLabel('Confirm Game Loss')
                .setStyle(ButtonStyle.Danger)
        );
        return [row];
    }

    if (match.stage === 'awaiting_loser_confirmation') {
        const gameNumber = getPendingResultGameNumber(match);
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(winnerButtonCustomId(match.id, getMatchActionToken(match, gameNumber)))
                    .setLabel('GAME WIN')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(loserConfirmCustomId(match.id, getMatchActionToken(match, gameNumber)))
                    .setLabel('Confirm Game Loss')
                    .setStyle(ButtonStyle.Danger)
            )
        ];
    }

    return [];
}

function getMatchParticipantMentions(match) {
    return match.teams.flatMap(team => team.members.map(member => member.mention));
}

async function getOptionsForGameType(gameType) {
    const cached = state.cachedOptionsByGameType.get(gameType);
    if (cached) {
        return cached;
    }

    const stadiumType = `${gameType.toLowerCase()}stadium`;
    const captainType = `${gameType.toLowerCase()}captain`;
    const result = await executeQuery(`
        SELECT Type, Value, Code, Description
        FROM Enumeration
        WHERE Type IN (@stadiumType, @captainType)
        ORDER BY Type, Value
    `, {
        stadiumType,
        captainType
    });

    const options = {
        stadiums: result.recordset
            .filter(row => row.Type.toLowerCase() === stadiumType)
            .map(row => ({
                value: row.Value,
                code: row.Code,
                description: row.Description
            })),
        captains: result.recordset
            .filter(row => row.Type.toLowerCase() === captainType)
            .map(row => ({
                value: row.Value,
                code: row.Code,
                description: row.Description
            }))
    };

    state.cachedOptionsByGameType.set(gameType, options);
    return options;
}

async function getPlayerQueueProfile(discordId, gameType, mode = '1v1', displayName = null) {
    const gameTypeNumber = CONSTANTS.SQL_GAME_TYPE_TO_NUMBER[gameType];
    const playerId = await ensureCompetitivePlayer(discordId, displayName);
    const season = await getActiveSeason();
    if (!season?.Id) {
        throw new Error('No active competitive season found');
    }

    const [compRating, defaultRating, result] = await Promise.all([
        getPlayerRatingForSeason(discordId, gameTypeNumber, season.Id, mode),
        getDefaultCompetitiveRating(),
        executeQuery(`
        SELECT TOP 1
            p.ID AS PlayerId,
            cr.Club
        FROM dbo.Player p
        LEFT JOIN ClubRoster cr
            ON p.ID = cr.Player
        WHERE p.ID = @playerId
    `, {
            playerId
        })
    ]);

    const row = result.recordset[0];
    const effectiveRating = compRating ?? buildDefaultCompetitiveRating(defaultRating);
    const elo = Number(effectiveRating.Elo);
    if (!Number.isFinite(elo)) {
        throw new Error(`Competitive rating ELO is invalid for Discord user ${discordId}`);
    }

    return {
        playerId,
        elo,
        doublesElo: elo,
        rankedThreshold: null,
        ratingTs: elo,
        compRating: effectiveRating,
        clubId: row?.Club == null
            ? -playerId
            : Number(row.Club)
    };
}

async function isUserInLiveQueue(discordId) {
    const result = await executeQuery(`
        SELECT COUNT(*) AS QueueCount
        FROM Queue q
        INNER JOIN Player p
            ON q.Player = p.ID
        WHERE p.DiscordID = @discordId
    `, {
        discordId
    });

    return Number(result.recordset[0]?.QueueCount ?? 0) > 0;
}

function getCompetitiveRatedBusyReason(userId) {
    if (state.activeSearchesByUserId.has(userId)) {
        return 'You already have an active pool entry.';
    }

    if (state.activeMatchesByUserId.has(userId)) {
        return 'You are already in an active match thread.';
    }

    return null;
}

function removeSearchFromState(search) {
    state.activeSearchesById.delete(search.id);
    state.activeSearchesByUserId.delete(search.userId);
}

function clearSearchTimers(search) {
    if (!search) {
        return;
    }

    if (search.warningTimer) {
        clearTimeout(search.warningTimer);
        search.warningTimer = null;
    }

    if (search.expiryTimer) {
        clearTimeout(search.expiryTimer);
        search.expiryTimer = null;
    }
}

function isSearchAvailableForMatch(search) {
    if (!search?.id || search.matchedThreadUrl || search.matchmakingReservedBy) {
        return false;
    }

    const activeSearch = state.activeSearchesById.get(search.id);
    return !activeSearch || activeSearch === search;
}

function reserveSearchesForMatch(searches, reservationId) {
    if (!Array.isArray(searches) || searches.length === 0 || !searches.every(isSearchAvailableForMatch)) {
        return false;
    }

    for (const search of searches) {
        search.matchmakingReservedBy = reservationId;
    }

    return true;
}

function releaseSearchesForMatch(searches, reservationId) {
    for (const search of searches ?? []) {
        if (search?.matchmakingReservedBy === reservationId) {
            search.matchmakingReservedBy = null;
        }
    }
}

function scheduleSearchTimeout(callback, delayMs) {
    const timer = setTimeout(callback, Math.max(delayMs, 0));
    timer.unref?.();
    return timer;
}

function scheduleSearchTimers(search, client) {
    clearSearchTimers(search);

    const now = Date.now();
    if (!search.hasWarnedExpiry && Number.isFinite(search.warningAt) && search.warningAt <= search.expiresAt) {
        search.warningTimer = scheduleSearchTimeout(() => {
            warnSearchIfActive(search.id, client).catch(error => {
                console.error(`Competitive pool warning timer failed: ${error.message}`);
                logRatedError(client, search, 'queue.warning_timer_failed', error, getSearchLogDetails(search));
            });
        }, search.warningAt - now);
    }

    if (Number.isFinite(search.expiresAt)) {
        search.expiryTimer = scheduleSearchTimeout(() => {
            expireSearchIfActive(search.id, client).catch(error => {
                console.error(`Competitive pool expiry timer failed: ${error.message}`);
                logRatedError(client, search, 'queue.expiry_timer_failed', error, getSearchLogDetails(search));
            });
        }, search.expiresAt - now);
    }
}

function schedulePanelStatusRefresh(channelId, client) {
    if (!channelId || state.panelStatusRefreshTimersByChannelId.has(channelId)) {
        return;
    }

    const timer = scheduleSearchTimeout(() => {
        state.panelStatusRefreshTimersByChannelId.delete(channelId);
        refreshPanelStatus(channelId, client).catch(error => {
            const panelConfig = getPanelConfigByChannelId(channelId);
            logRatedError(client, panelConfig ?? { channel: channelId }, 'panel.status.refresh_failed', error, {
                channel: channelId
            });
        });
    }, 500);
    state.panelStatusRefreshTimersByChannelId.set(channelId, timer);
}

function clearMatchTimers(match) {
    if (!match) {
        return;
    }

    if (match.timeoutTimer) {
        clearTimeout(match.timeoutTimer);
        match.timeoutTimer = null;
    }

    match.timeoutPhase = null;
    match.timeoutDeadlineAt = null;
    clearSelectionTimers(match);
}

function getMatchTimeoutMinutes(phase) {
    if (phase === 'game') return CONFIG.MATCH_GAME_TIMEOUT_MINUTES;
    if (phase === 'loser_confirmation') return LOSER_CHOICE_TIMEOUT_MINUTES;
    return CONFIG.MATCH_START_TIMEOUT_MINUTES;
}

function scheduleMatchTimeout(match, phase, client) {
    if (!match || !MATCH_TIMEOUT_PHASES.has(phase)) {
        return;
    }

    clearMatchTimers(match);

    const delayMs = getMatchTimeoutMinutes(phase) * 60000;
    const deadlineAt = Date.now() + delayMs;
    match.timeoutPhase = phase;
    match.timeoutDeadlineAt = deadlineAt;

    const callback = phase === 'loser_confirmation'
        ? () => resolveLoserConfirmationIfTimedOut(match.id, phase, client).catch(err => {
            console.error(`Competitive match loser_confirmation timeout failed: ${err.message}`);
            logRatedError(client, match, 'match.timeout_failed', err, getMatchLogDetails(match, { phase }));
        })
        : () => cancelMatchIfTimedOut(match.id, phase, client).catch(err => {
            console.error(`Competitive match ${phase} timeout failed: ${err.message}`);
            logRatedError(client, match, 'match.timeout_failed', err, getMatchLogDetails(match, { phase }));
        });

    match.timeoutTimer = scheduleSearchTimeout(callback, delayMs);
    logRatedInfo(client, match, 'match.timeout.scheduled', getMatchLogDetails(match, {
        phase,
        minutes: getMatchTimeoutMinutes(phase)
    }));
}

function ensureMatchTimeoutScheduled(match, phase, client) {
    if (
        match?.timeoutPhase === phase
        && match?.timeoutTimer
        && Number.isFinite(match?.timeoutDeadlineAt)
        && match.timeoutDeadlineAt > Date.now()
    ) {
        return false;
    }

    scheduleMatchTimeout(match, phase, client);
    return true;
}

function removeMatchFromState(match) {
    clearMatchTimers(match);
    state.activeMatchesById.delete(match.id);
    state.activeMatchesByThreadId.delete(match.threadId);
    for (const team of match.teams) {
        for (const memberId of team.memberIds) {
            state.activeMatchesByUserId.delete(memberId);
        }
    }
}

async function deleteSearchWarningMessage(search, client) {
    if (!search?.warningMessageId && !search?.warningMessage) {
        if (search) search.warningToken = null;
        return;
    }

    if (search.warningMessage?.edit) {
        await search.warningMessage.edit({ components: [] }).catch(() => {});
    } else {
        const channel = await fetchChannel(client, search.channelId);
        if (channel?.messages?.fetch) {
            const message = await channel.messages.fetch(search.warningMessageId).catch(() => null);
            await message?.delete?.().catch(() => {});
        }
    }

    search.warningMessage = null;
    search.warningMessageId = null;
    search.warningToken = null;
}

async function sendPrivateSearchNotification(search, payload) {
    const privatePayload = {
        ...payload,
        ephemeral: true
    };
    return search.notificationInteraction
        ? await safeFollowUp(search.notificationInteraction, privatePayload)
        : null;
}

async function warnSearchAboutExpiry(search, client) {
    if (search.hasWarnedExpiry) {
        return;
    }

    search.warningToken = createId();
    const warningMessage = await sendPrivateSearchNotification(search, buildSearchExpiryWarningPayload(search));
    search.hasWarnedExpiry = true;
    search.warningMessage = warningMessage;
    search.warningMessageId = warningMessage?.id ?? null;
    logRatedWarn(client, search, 'queue.expiring_soon', {
        ...getSearchLogDetails(search),
        expiresAt: new Date(search.expiresAt).toISOString()
    });
}

async function warnSearchIfActive(searchId, client) {
    const search = state.activeSearchesById.get(searchId);
    if (!search || search.hasWarnedExpiry) {
        return;
    }

    if (Date.now() < search.warningAt) {
        scheduleSearchTimers(search, client);
        return;
    }

    await warnSearchAboutExpiry(search, client);
}

async function expireSearchIfActive(searchId, client) {
    const search = state.activeSearchesById.get(searchId);
    if (!search) {
        return;
    }

    if (Date.now() < search.expiresAt) {
        scheduleSearchTimers(search, client);
        return;
    }

    await closeSearch(search, 'expired', client);
    schedulePanelStatusRefresh(search.channelId, client);
}

async function closeSearch(search, reason, client) {
    clearSearchTimers(search);
    await deleteSearchWarningMessage(search, client);
    removeSearchFromState(search);

    if (reason === 'expired') {
        await sendPrivateSearchNotification(search, buildSearchExpiredPayload(search));
    }
    const log = reason === 'expired' ? logRatedWarn : logRatedInfo;
    log(client, search, `queue.${reason}`, getSearchLogDetails(search));
}

async function reconcilePanelChannel(client, panelConfig) {
    const channel = await fetchChannel(client, panelConfig.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
        console.warn(`[RatedQueue] Panel channel ${panelConfig.channelId} not found or not a text channel. Bot may not be in the correct guild.`);
        logRatedWarn(client, panelConfig, 'panel.channel_missing', { channel: panelConfig.channelId });
        return;
    }
    const panelMeta = getOrCreatePanelMeta(channel.id);

    if (!panelMeta.channelLockApplied) {
        await applyChannelLock(channel, panelConfig.gameType);
        panelMeta.channelLockApplied = true;
    }

    const counts = buildSearchCounts(channel.id);
    const hasAnySearches = counts['1v1'] > 0 || counts['2v2'] > 0;
    const panelIsBootstrapped = panelMeta.imageMessageId && panelMeta.panelMessageId;
    const needsFullReconcile = !panelIsBootstrapped || hasAnySearches || panelMeta.statusMessageId != null;
    const existingMessages = needsFullReconcile ? await fetchRecentMessages(channel, 100) : [];
    const deletedMessageIds = new Set();

    const panelImagePayload = buildPanelImageMessage(panelConfig);
    let panelImageMessage = findPanelImageMessage(existingMessages, client.user?.id, panelConfig);
    if (panelImagePayload) {
        if (panelImageMessage) {
            panelMeta.imageMessageId = panelImageMessage.id;
        } else if (!panelMeta.imageMessageId) {
            try {
                const createdPanelImageMessage = await channel.send(panelImagePayload);
                panelMeta.imageMessageId = createdPanelImageMessage.id;
                panelImageMessage = createdPanelImageMessage;
                console.log('[RatedQueue] Panel image sent.');
                logRatedInfo(client, panelConfig, 'panel.image.created', {
                    channel: channel.id,
                    message: createdPanelImageMessage.id
                });
            } catch (err) {
                console.error(`[RatedQueue] Failed to send panel image: ${err.message}. Check bot permissions (SendMessages) in channel ${channel.id}.`);
                logRatedError(client, panelConfig, 'panel.image.create_failed', err, { channel: channel.id });
                return;
            }
        }
    }

    const panelPayload = buildPanelMessage(channel.id);
    let panelMessage = findPanelMessage(existingMessages, client.user?.id, channel.id);
    const shouldRecreatePanelMessage = Boolean(
        panelMessage
            && panelImageMessage
            && panelMessage.createdTimestamp < panelImageMessage.createdTimestamp
    ) || panelMessageNeedsRecreate(panelMessage);
    if (shouldRecreatePanelMessage) {
        await panelMessage.delete().catch(() => {});
        deletedMessageIds.add(panelMessage.id);
        panelMessage = null;
        panelMeta.panelMessageId = null;
    }

    if (panelMessage) {
        panelMeta.panelMessageId = panelMessage.id;
    } else if (!panelMeta.panelMessageId) {
        try {
            const createdPanelMessage = await channel.send(panelPayload);
            panelMeta.panelMessageId = createdPanelMessage.id;
            console.log('[RatedQueue] Panel buttons sent.');
            logRatedInfo(client, panelConfig, 'panel.controls.created', {
                channel: channel.id,
                message: createdPanelMessage.id
            });
        } catch (err) {
            console.error(`[RatedQueue] Failed to send panel buttons: ${err.message}. Check bot permissions (SendMessages) in channel ${channel.id}.`);
            logRatedError(client, panelConfig, 'panel.controls.create_failed', err, { channel: channel.id });
            return;
        }
    }
    panelMeta.availabilityKey = 'static';

    const statusMessage = findStatusMessage(existingMessages, client.user?.id);
    if (hasAnySearches) {
        const statusPayload = {
            content: buildStatusMessageContent(counts),
            components: []
        };
        if (statusMessage) {
            panelMeta.statusMessageId = statusMessage.id;
            await statusMessage.edit(statusPayload).catch(err =>
                {
                    console.warn(`[RatedQueue] Failed to edit status message in ${channel.id}: ${err.message}`);
                    logRatedWarn(client, panelConfig, 'panel.status.edit_failed', { channel: channel.id, error: err.message });
                }
            );
        } else {
            const createdStatusMessage = await channel.send(statusPayload);
            panelMeta.statusMessageId = createdStatusMessage.id;
            logRatedInfo(client, panelConfig, 'panel.status.created', {
                channel: channel.id,
                message: createdStatusMessage.id
            });
        }
    } else if (statusMessage) {
        panelMeta.statusMessageId = null;
        await statusMessage.delete().catch(err =>
            {
                console.warn(`[RatedQueue] Failed to delete status message in ${channel.id}: ${err.message}`);
                logRatedWarn(client, panelConfig, 'panel.status.delete_failed', { channel: channel.id, error: err.message });
            }
        );
    }

    await prunePanelChannelMessages(existingMessages, panelMeta, deletedMessageIds);
}

async function fetchPanelMessageById(channel, messageId) {
    if (!messageId || typeof channel.messages?.fetch !== 'function') {
        return null;
    }

    return await channel.messages.fetch(messageId).catch(() => null);
}

async function refreshPanelStatus(channelId, client) {
    const panelConfig = getPanelConfigByChannelId(channelId);
    if (!panelConfig) {
        return;
    }

    const channel = await fetchChannel(client, panelConfig.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
        logRatedWarn(client, panelConfig, 'panel.status.channel_missing', { channel: panelConfig.channelId });
        return;
    }

    const panelMeta = getOrCreatePanelMeta(channel.id);
    const counts = buildSearchCounts(channel.id);
    const hasAnySearches = counts['1v1'] > 0 || counts['2v2'] > 0;
    const statusMessage = await fetchPanelMessageById(channel, panelMeta.statusMessageId);

    if (hasAnySearches) {
        const statusPayload = {
            content: buildStatusMessageContent(counts),
            components: []
        };

        if (statusMessage) {
            await statusMessage.edit(statusPayload).catch(err => {
                console.warn(`[RatedQueue] Failed to edit status message in ${channel.id}: ${err.message}`);
                logRatedWarn(client, panelConfig, 'panel.status.edit_failed', { channel: channel.id, error: err.message });
            });
            return;
        }

        const createdStatusMessage = await channel.send(statusPayload);
        panelMeta.statusMessageId = createdStatusMessage.id;
        logRatedInfo(client, panelConfig, 'panel.status.created', {
            channel: channel.id,
            message: createdStatusMessage.id,
            mode: 'fast_refresh'
        });
        return;
    }

    if (statusMessage) {
        await statusMessage.delete().catch(err => {
            console.warn(`[RatedQueue] Failed to delete status message in ${channel.id}: ${err.message}`);
            logRatedWarn(client, panelConfig, 'panel.status.delete_failed', { channel: channel.id, error: err.message });
        });
    }
    panelMeta.statusMessageId = null;
}

async function prunePanelChannelMessages(messages, panelMeta, skipMessageIds = new Set()) {
    const keepMessageIds = new Set([
        panelMeta.imageMessageId,
        panelMeta.panelMessageId,
        panelMeta.statusMessageId
    ].filter(Boolean));

    for (const message of messages) {
        if (keepMessageIds.has(message.id) || skipMessageIds.has(message.id)) {
            continue;
        }

        await message.delete().catch(() => {});
    }
}

async function getCurrentQueueAvailability(client, context = {}) {
    if (typeof getSeasonQueueAvailability !== 'function') {
        return { canQueue: true, status: 'active', message: null };
    }

    try {
        return await getSeasonQueueAvailability();
    } catch (error) {
        logRatedError(client, context, 'season.availability_failed', error, context);
        return {
            canQueue: false,
            status: 'unavailable',
            message: SEASON_UNAVAILABLE_MESSAGE
        };
    }
}

async function closeSearchForSeasonEnd(search, client) {
    clearSearchTimers(search);
    await deleteSearchWarningMessage(search, client);
    removeSearchFromState(search);
    await sendPrivateSearchNotification(search, buildSearchSeasonEndedPayload(search));
    logRatedWarn(client, search, 'queue.season_ended_removed', getSearchLogDetails(search));
}

async function closeAllSearchesForSeasonEnd(client) {
    const searches = [...state.activeSearchesById.values()];
    const affectedChannels = new Set();
    for (const search of searches) {
        affectedChannels.add(search.channelId);
        await closeSearchForSeasonEnd(search, client);
    }
    for (const channelId of affectedChannels) {
        schedulePanelStatusRefresh(channelId, client);
    }
    return searches.length;
}

function renderSeasonEndCancelMessage() {
    return quoteThreadLines(
        `${BL_X_EMOJI} Season ended. The match was cancelled because the season finalization grace period expired.`
    );
}

async function fetchRecentMessages(channel, limit) {
    try {
        if (typeof channel.messages?.fetch !== 'function') {
            return [];
        }
        const collection = await channel.messages.fetch({ limit, cache: false });
        return [...collection.values()];
    } catch {
        return [];
    }
}

function findPanelMessage(messages, botUserId, channelId) {
    const joinPrefix = `${CONFIG.PREFIX}:join:${channelId}:`;
    return messages.find(message => {
        if (message.author?.id !== botUserId) {
            return false;
        }

        return (message.components ?? []).some(row =>
            (row.components ?? []).some(component =>
                (component.customId?.startsWith?.(joinPrefix) ?? false)
                    || (component.data?.custom_id?.startsWith?.(joinPrefix) ?? false)
            )
        );
    }) ?? null;
}

function componentIsDisabled(component) {
    return component?.disabled === true || component?.data?.disabled === true;
}

function panelMessageNeedsRecreate(message) {
    if (!message) {
        return false;
    }

    if (typeof message.content === 'string' && message.content.trim().length > 0) {
        return true;
    }

    return (message.components ?? []).some(row =>
        (row.components ?? []).some(component => componentIsDisabled(component))
    );
}

function findPanelImageMessage(messages, botUserId, panelConfig) {
    const imagePath = getPanelImagePath(panelConfig);
    const imageName = imagePath ? path.basename(imagePath) : null;
    if (!imageName) {
        return null;
    }

    return messages.find(message => {
        if (message.author?.id !== botUserId) {
            return false;
        }

        if (!message.attachments) {
            return false;
        }

        if (typeof message.attachments.some === 'function') {
            return message.attachments.some(attachment => attachment?.name === imageName);
        }

        return false;
    }) ?? null;
}

function findStatusMessage(messages, botUserId) {
    return messages.find(message =>
        message.author?.id === botUserId
            && typeof message.content === 'string'
            && message.content.startsWith('Players in ')
    ) ?? null;
}

async function applyChannelLock(channel, gameType) {
    try {
        const botMemberId = channel.guild.members.me?.id ?? channel.client.user?.id;
        if (botMemberId) {
            await channel.permissionOverwrites.edit(botMemberId, {
                ViewChannel: true,
                SendMessages: true,
                SendMessagesInThreads: true,
                CreatePrivateThreads: true,
                ManageMessages: true,
                ManageThreads: true,
                ReadMessageHistory: true
            }, { reason: `Allow the ${gameType} Competitive Rated queue to manage its panel.` });
        }

        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
            SendMessages: false
        }, { reason: `Managed by the ${gameType} Competitive Rated queue.` });
    } catch (error) {
        console.error(`Failed to apply competitive panel channel lock: ${error.message}`);
        logRatedError(channel.client, { gameType }, 'panel.lock_failed', error, { channel: channel.id });
    }
}

function createSearchFromInteraction(interaction, panelConfig, mode, durationMinutes, options, ratingProfile) {
    const now = Date.now();
    return {
        id: createId(),
        channelId: panelConfig.channelId,
        gameType: panelConfig.gameType,
        mode,
        userId: interaction.user.id,
        mention: interaction.user.toString(),
        notificationInteraction: interaction,
        username: getInteractionDisplayName(interaction),
        createdAt: now,
        durationMinutes,
        expiresAt: now + durationMinutes * 60000,
        warningAt: now + Math.max(durationMinutes - CONFIG.EXPIRING_SOON_MINUTES, 0) * 60000,
        hasWarnedExpiry: false,
        matchedThreadUrl: null,
        warningMessage: null,
        warningMessageId: null,
        warningToken: null,
        options,
        ratingProfile
    };
}

async function addSearch(search, client) {
    state.activeSearchesById.set(search.id, search);
    state.activeSearchesByUserId.set(search.userId, search);
    scheduleSearchTimers(search, client);
    logRatedInfo(client, search, 'queue.joined', {
        ...getSearchLogDetails(search),
        durationMin: search.durationMinutes,
        threshold: search.options?.threshold
    });

    scheduleMatchmaking(search.channelId, client);
}

function scheduleMatchmaking(channelId, client) {
    if (state.matchmakingTimersByChannelId.has(channelId)) {
        state.pendingMatchmakingChannels.add(channelId);
        return;
    }

    const timer = setTimeout(() => {
        state.matchmakingTimersByChannelId.delete(channelId);
        tryCreateMatches(channelId, client).catch(err => {
            const panelConfig = getPanelConfigByChannelId(channelId);
            logRatedError(client, panelConfig ?? { channel: channelId }, 'matchmaking.async_failed', err, {
                channel: channelId
            });
        });
    }, 0);
    timer.unref?.();
    state.matchmakingTimersByChannelId.set(channelId, timer);
}

async function clearMatchedInteractionResponse(interaction) {
    if (typeof interaction.deleteReply === 'function') {
        try {
            await interaction.deleteReply();
            return;
        } catch {
            // Fall back to removing controls from the original ephemeral prompt.
        }
    }

    await safeReply(interaction, {
        content: 'Request processed.',
        components: [],
        ephemeral: true
    });
}

async function maybeJoinSearch(interaction, panelConfig, mode, durationMinutes, options) {
    const availability = await getCurrentQueueAvailability(interaction.client, { gameType: panelConfig.gameType, mode });
    if (availability?.canQueue === false) {
        await safeReply(interaction, {
            content: QUEUE_JOIN_SEASON_UNAVAILABLE_MESSAGE,
            components: [],
            ephemeral: true
        });
        logRatedWarn(interaction.client, { gameType: panelConfig.gameType, mode }, 'queue.join_blocked_season_unavailable', {
            user: interaction.user.id,
            status: availability.status
        });
        return;
    }

    const busyReason = getCompetitiveRatedBusyReason(interaction.user.id);
    if (busyReason) {
        logRatedInfo(interaction.client, { gameType: panelConfig.gameType, mode }, 'queue.join_ignored', {
            user: interaction.user.id,
            reason: busyReason
        });
        await silentlyAcknowledgeInteraction(interaction, { deleteReply: true });
        return;
    }

    let inLiveQueue;
    let ratingProfile;
    try {
        [inLiveQueue, ratingProfile] = await Promise.all([
            isUserInLiveQueue(interaction.user.id),
            getPlayerQueueProfile(
                interaction.user.id,
                panelConfig.gameType,
                mode,
                getInteractionDisplayName(interaction)
            )
        ]);
    } catch (err) {
        logRatedError(interaction.client, { gameType: panelConfig.gameType, mode }, 'queue.join_failed', err, {
            user: interaction.user.id
        });
        await safeReply(interaction, {
            content: `${BL_X_EMOJI} Competitive queue setup failed. Staff has been notified; try again after review.`,
            components: [],
            ephemeral: true
        });
        return;
    }

    if (inLiveQueue) {
        logRatedWarn(interaction.client, { gameType: panelConfig.gameType, mode }, 'queue.live_queue_blocked', {
            user: interaction.user.id
        });
        await safeReply(interaction, { content: 'You are already in the live rated queue.', components: [], ephemeral: true });
        return;
    }

    const searchOptions = {
        ...options,
        threshold: options.threshold == null
            ? ratingProfile.rankedThreshold
            : options.threshold
    };
    const search = createSearchFromInteraction(interaction, panelConfig, mode, durationMinutes, searchOptions, ratingProfile);
    await addSearch(search, interaction.client);

    if (search.matchedThreadUrl || !state.activeSearchesById.has(search.id)) {
        if (!search.matchedThreadUrl) {
            await clearMatchedInteractionResponse(interaction);
        }
        return;
    }

    const compRating = ratingProfile.compRating ?? null;

    await safeReply(interaction, {
        content: renderPoolJoinMessage(search, compRating),
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(cancelSearchCustomId(search.id))
                    .setLabel(buildLeavePoolLabel(mode))
                    .setStyle(ButtonStyle.Danger)
            )
        ],
        ephemeral: true
    });
    schedulePanelStatusRefresh(panelConfig.channelId, interaction.client);
}

function getOldestCompatibleSinglesPair(sortedSearches) {
    for (let leftIndex = 0; leftIndex < sortedSearches.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < sortedSearches.length; rightIndex++) {
            if (areSinglesSearchesCompatible(sortedSearches[leftIndex], sortedSearches[rightIndex])) {
                return [sortedSearches[leftIndex], sortedSearches[rightIndex]];
            }
        }
    }

    return null;
}

async function tryCreateMatches(channelId, client) {
    const lockKey = `matchmaking:${channelId}`;
    if (state.operationQueues.has(lockKey)) {
        state.pendingMatchmakingChannels.add(channelId);
        const panelConfig = getPanelConfigByChannelId(channelId);
        if (panelConfig) {
            logRatedInfo(client, panelConfig, 'matchmaking.queued', { channel: channelId });
        }
        return;
    }

    await withOperationQueue(lockKey, async () => {
        let createdAny = false;
        const panelConfig = getPanelConfigByChannelId(channelId);
        if (!panelConfig) {
            return;
        }
        const availability = await getCurrentQueueAvailability(client, panelConfig);
        if (availability?.canQueue === false) {
            await closeAllSearchesForSeasonEnd(client);
            return;
        }

        do {
            state.pendingMatchmakingChannels.delete(channelId);

            while (true) {
                const singlesSearches = [...state.activeSearchesById.values()]
                    .filter(search => search.channelId === channelId && search.mode === '1v1' && !search.matchmakingReservedBy && !search.matchedThreadUrl)
                    .sort((left, right) => left.createdAt - right.createdAt);
                const doublesSearches = [...state.activeSearchesById.values()]
                    .filter(search => search.channelId === channelId && search.mode === '2v2' && !search.matchmakingReservedBy && !search.matchedThreadUrl)
                    .sort((left, right) => left.createdAt - right.createdAt);

                const singlesPair = getOldestCompatibleSinglesPair(singlesSearches);
                if (singlesPair) {
                    logRatedInfo(client, { gameType: panelConfig.gameType, mode: '1v1' }, 'matchmaking.match_found', {
                        searches: singlesPair.map(search => search.id),
                        players: singlesPair.map(search => search.userId)
                    });
                    const match = await createCompetitiveRatedMatch(panelConfig, singlesPair, client, { skipReconcile: true });
                    if (match) {
                        createdAny = true;
                        continue;
                    }
                    break;
                }

                if (doublesSearches.length >= 4) {
                    logRatedInfo(client, { gameType: panelConfig.gameType, mode: '2v2' }, 'matchmaking.match_found', {
                        searches: doublesSearches.slice(0, 4).map(search => search.id),
                        players: doublesSearches.slice(0, 4).map(search => search.userId)
                    });
                    const match = await createCompetitiveRatedMatch(panelConfig, doublesSearches.slice(0, 4), client, { skipReconcile: true });
                    if (match) {
                        createdAny = true;
                        continue;
                    }
                    break;
                }

                break;
            }
        } while (state.pendingMatchmakingChannels.has(channelId));

        if (createdAny) {
            schedulePanelStatusRefresh(channelId, client);
        }
    });
}

async function createCompetitiveRatedMatch(panelConfig, searches, client, { skipReconcile = false } = {}) {
    const matchId = createId();
    if (!reserveSearchesForMatch(searches, matchId)) {
        logRatedWarn(client, { gameType: panelConfig.gameType, mode: searches[0]?.mode }, 'match.create_skipped', {
            channel: panelConfig.channelId,
            reason: 'searches_already_reserved_or_matched',
            searches: searches.map(search => search?.id).filter(Boolean)
        });
        return null;
    }

    const channel = await fetchChannel(client, panelConfig.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
        releaseSearchesForMatch(searches, matchId);
        logRatedWarn(client, { gameType: panelConfig.gameType, mode: searches[0]?.mode }, 'match.create_skipped', {
            channel: panelConfig.channelId,
            reason: 'panel_channel_missing'
        });
        return null;
    }

    const teams = searches[0].mode === '1v1' ? buildSinglesTeams(searches) : buildDoublesTeams(searches);
    const firstTo = searches[0].mode === '1v1'
        ? computeFirstTo(
            searches[0].options.minBestOf,
            searches[0].options.maxBestOf,
            searches[1].options.minBestOf,
            searches[1].options.maxBestOf
        )
        : 2;
    const homeTeamIndex = Math.random() >= 0.5 ? 1 : 2;
    const awayTeamIndex = homeTeamIndex === 1 ? 2 : 1;
    let matchHeader = null;
    try {
        const season = await getActiveSeason();
        if (!season?.Id) {
            throw new Error('No active competitive season found');
        }
        matchHeader = await ratedMatchDao.createMatchHeader({
            matchCode: matchId,
            gameId: CONSTANTS.SQL_GAME_TYPE_TO_NUMBER[panelConfig.gameType],
            modeCode: searches[0].mode,
            firstTo,
            seasonId: season.Id,
            homeTeamNumber: homeTeamIndex,
            awayTeamNumber: awayTeamIndex,
            guildId: CONSTANTS.GUILD_ID
        });
    } catch (error) {
        releaseSearchesForMatch(searches, matchId);
        logRatedError(client, { gameType: panelConfig.gameType, mode: searches[0]?.mode }, 'match.header_create_failed', error, {
            channel: channel.id,
            searches: searches.map(search => search.id)
        });
        return null;
    }

    const threadName = buildThreadName(
        searches[0].mode,
        matchHeader.matchNumber,
        teams[homeTeamIndex - 1],
        teams[awayTeamIndex - 1]
    );
    let thread;
    try {
        thread = await channel.threads.create({
            name: threadName,
            type: ChannelType.PrivateThread,
            autoArchiveDuration: 60,
            invitable: false,
            reason: `${panelConfig.gameType} Competitive Rated match`
        });
    } catch (error) {
        releaseSearchesForMatch(searches, matchId);
        if (matchHeader?.id) {
            await ratedMatchDao.cancelMatchById({
                matchId: matchHeader.id,
                cancelReason: 'thread_create_failed'
            }).catch(() => {});
        }
        console.error(`[RatedQueue] Failed to create match thread in ${channel.id}: ${error.message}`);
        logRatedError(client, { gameType: panelConfig.gameType, mode: searches[0]?.mode }, 'match.thread_create_failed', error, {
            channel: channel.id,
            searches: searches.map(search => search.id)
        });
        return null;
    }
    const threadUrl = thread.url ?? buildThreadUrl(channel.guild.id, thread.id);
    logRatedInfo(client, { gameType: panelConfig.gameType, mode: searches[0].mode }, 'match.created', {
        thread: thread.id,
        name: threadName,
        firstTo,
        homeTeam: homeTeamIndex,
        players: searches.map(search => search.userId)
    });

    for (const search of searches) {
        await closeSearch(search, 'matched', client);
    }

    const match = {
        id: matchId,
        channelId: channel.id,
        gameType: panelConfig.gameType,
        mode: searches[0].mode,
        matchNumber: matchHeader.matchNumber,
        seasonMatchNumber: matchHeader.seasonMatchNumber,
        seasonId: matchHeader.seasonId,
        firstTo,
        teams,
        score: {
            team1: 0,
            team2: 0
        },
        homeTeamIndex,
        awayTeamIndex,
        stage: 'awaiting_start',
        selectedStadium: null,
        selectedCaptain: null,
        threadId: thread.id,
        threadUrl,
        threadName,
        loserTeamIndex: null,
        loserRepMention: null,
        pendingResult: null,
        pendingResultGameNumber: null,
        loserAdvantagePromptShown: false,
        rulesImageMessageId: null,
        startClickedUserIds: [],
        gameBlocks: [],
        controlMessageId: null,
        controlVersion: 0,
        timeoutPhase: null,
        timeoutDeadlineAt: null,
        timeoutTimer: null,
        homeSelectionTimer: null,
        homeSelectionDeadlineAt: null,
        awaySelectionTimer: null,
        awaySelectionDeadlineAt: null,
        notificationInteractions: new Map(searches.map(s => [s.userId, s.notificationInteraction]).filter(([, i]) => i)),
        privateDeliveryInteractionsByUserId: new Map(searches.map(s => [s.userId, s.notificationInteraction]).filter(([, i]) => i)),
        privatePromptHandles: {},
        ratedMatchId: matchHeader.id,
        participantIdByDiscordId: new Map()
    };

    state.activeMatchesById.set(match.id, match);
    state.activeMatchesByThreadId.set(thread.id, match);
    const participantMentions = getMatchParticipantMentions(match);
    for (const search of searches) {
        search.matchedThreadUrl = threadUrl;
        search.matchmakingReservedBy = null;
    }

    const allMemberIds = match.teams.flatMap(team => team.memberIds);
    for (const memberId of allMemberIds) {
        state.activeMatchesByUserId.set(memberId, match);
    }
    await Promise.all(allMemberIds.map(memberId =>
        thread.members.add(memberId).catch(err =>
            {
                console.warn(`[RatedQueue] Failed to add member ${memberId} to thread ${thread.id}: ${err.message}`);
                logRatedWarn(client, match, 'match.member_add_failed', getMatchLogDetails(match, {
                    user: memberId,
                    error: err.message
                }));
            }
        )
    ));

    const participants = match.teams.flatMap(team =>
        team.members.map(member => ({
            playerId: member.ratingProfile?.playerId,
            discordId: member.id,
            teamNumber: team.teamIndex,
            isRepresentative: member.id === team.repUserId
        }))
    );
    try {
        const insertedParticipants = await ratedMatchDao.activateMatch({
            matchId: match.ratedMatchId,
            panelChannelId: channel.id,
            threadId: thread.id,
            threadUrl,
            participants
        });
        for (const participant of insertedParticipants ?? []) {
            match.participantIdByDiscordId.set(String(participant.DiscordId), participant.Id);
        }
    } catch (error) {
        match.competitiveDbFailed = true;
        await ratedMatchDao.cancelMatchById({
            matchId: match.ratedMatchId,
            cancelReason: 'activation_failed'
        }).catch(() => {});
        logRatedError(client, match, 'rated_match.activate_failed', error, getMatchLogDetails(match));
        await thread.send({
            content: `${BL_X_EMOJI} **Competitive DB setup failed.** Staff has been notified; this match cannot record Competitive ELO until the DB issue is fixed.`
        }).catch(() => {});
    }

    let notifiedCount = 0;
    for (const search of searches) {
        const interaction = search.notificationInteraction;
        if (interaction) {
            const delivered = await deliverPrivateInteractionPayload(
                interaction,
                buildMatchFoundPayload(match.mode, threadUrl, participantMentions),
                'match found notification'
            );
            if (delivered) {
                notifiedCount += 1;
            }
        }
    }
    logRatedInfo(client, match, 'match.notifications.sent', getMatchLogDetails(match, {
        count: notifiedCount
    }));

    if (requiresSetup(match.gameType)) {
        scheduleMatchTimeout(match, 'start', client);
        await updateMatchControlMessage(match, client);
    } else {
        logRatedInfo(client, match, 'match.auto_start', getMatchLogDetails(match, {
            reason: 'no_setup_required'
        }));
        await postInitialGameSetup(match, client);
        match.stage = 'awaiting_winner';
        await postGameImageIfMissing(match, client, thread);
        await postWinnerControl(match, client, thread);
    }

    if (!skipReconcile) {
        schedulePanelStatusRefresh(panelConfig.channelId, client);
    }

    return match;
}

async function postGameImageIfMissing(match, client, thread = null) {
    thread ??= await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        logRatedWarn(client, match, 'game.image.skipped', getMatchLogDetails(match, { reason: 'thread_missing' }));
        return null;
    }

    const block = getOrCreateGameBlock(match);
    if (block.gameImageMessageId) return null;

    const nextGameNumber = getNextGameNumber(match);
    const gameImagePayload = buildGameImageMessage(nextGameNumber);
    if (!gameImagePayload) return null;

    const separatorPayload = nextGameNumber > 1 ? buildSeparatorImageMessage() : null;
    const separatorMessage = separatorPayload
        ? await thread.send(separatorPayload).catch(() => null)
        : null;
    if (separatorPayload && !separatorMessage) {
        logRatedWarn(client, match, 'game.separator.failed', getMatchLogDetails(match, {
            game: nextGameNumber
        }));
        return null;
    }

    const msg = await thread.send(gameImagePayload).catch(() => null);
    if (msg) {
        if (separatorMessage) block.gameImageSeparatorMessageId = separatorMessage.id;
        block.gameImageMessageId = msg.id;
        logRatedInfo(client, match, 'game.image.posted', getMatchLogDetails(match, {
            game: nextGameNumber,
            message: msg.id,
            separator: separatorMessage?.id
        }));
    } else {
        logRatedWarn(client, match, 'game.image.failed', getMatchLogDetails(match, {
            game: nextGameNumber
        }));
    }
    return msg;
}

function storeDelayedGameResult(match, gameNumber, winnerMention) {
    const block = getOrCreateGameBlock(match);
    block.delayedResult = {
        gameNumber,
        winnerMention
    };
    block.delayedResultMessageId = block.delayedResultMessageId ?? null;
    return block;
}

async function postDelayedGameResultIfMissing(match, client, thread = null) {
    const block = getOrCreateGameBlock(match);
    if (!block.delayedResult || block.delayedResultMessageId) {
        return null;
    }

    thread ??= await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        logRatedWarn(client, match, 'game.delayed_result.skipped', getMatchLogDetails(match, {
            game: block.delayedResult.gameNumber,
            reason: 'thread_missing'
        }));
        return null;
    }

    const message = await thread.send(buildThreadTextPayload(
        renderGameResultMessage(block.delayedResult.winnerMention, block.delayedResult.gameNumber, match),
        'line',
        { components: [] }
    )).catch(() => null);
    if (!message) {
        logRatedWarn(client, match, 'game.delayed_result.failed', getMatchLogDetails(match, {
            game: block.delayedResult.gameNumber
        }));
        return null;
    }

    block.delayedResultMessageId = message.id;
    logRatedInfo(client, match, 'game.result.posted', getMatchLogDetails(match, {
        game: block.delayedResult.gameNumber,
        message: message.id,
        mode: 'delayed_after_setup'
    }));
    return message;
}

async function clearStartButtonComponents(thread, block) {
    if (!block?.startMessageId) return;
    const msg = await fetchThreadMessage(thread, block.startMessageId);
    if (msg) {
        await msg.delete().catch(() => {});
        block.startMessageId = null;
    }
}

function clearSelectionTimers(match) {
    if (!match) return;
    if (match.homeSelectionTimer) {
        clearTimeout(match.homeSelectionTimer);
        match.homeSelectionTimer = null;
        match.homeSelectionDeadlineAt = null;
    }
    if (match.awaySelectionTimer) {
        clearTimeout(match.awaySelectionTimer);
        match.awaySelectionTimer = null;
        match.awaySelectionDeadlineAt = null;
    }
}

function clearSelectionTimer(match, player) {
    const timerKey = player === 'home' ? 'homeSelectionTimer' : 'awaySelectionTimer';
    const deadlineKey = player === 'home' ? 'homeSelectionDeadlineAt' : 'awaySelectionDeadlineAt';
    if (match?.[timerKey]) {
        clearTimeout(match[timerKey]);
    }
    if (match) {
        match[timerKey] = null;
        match[deadlineKey] = null;
    }
}

function scheduleSelectionTimeout(match, player, client) {
    const delayMs = SELECTION_TIMEOUT_MINUTES * 60000;
    const timerKey = player === 'home' ? 'homeSelectionTimer' : 'awaySelectionTimer';
    const deadlineKey = player === 'home' ? 'homeSelectionDeadlineAt' : 'awaySelectionDeadlineAt';
    const expectedActionToken = getMatchActionToken(match, getNextGameNumber(match));

    if (match[timerKey]) clearTimeout(match[timerKey]);
    match[deadlineKey] = Date.now() + delayMs;
    match[timerKey] = scheduleSearchTimeout(
        () => autoRandomizeSelection(match.id, player, client, expectedActionToken)
            .catch(err => {
                console.error(`Selection auto-random failed: ${err.message}`);
                logRatedError(client, match, 'setup.selection_auto_failed', err, getMatchLogDetails(match, { player }));
            }),
        delayMs
    );
}

async function autoRandomizeSelection(matchId, player, client, expectedActionToken = null) {
    const lockKey = `match:${matchId}`;
    await withOperationQueue(lockKey, async () => {
        const match = state.activeMatchesById.get(matchId);
        if (!match || match.stage === 'cancelled' || match.stage === 'complete') return;
        if (match.stage !== 'awaiting_start') {
            logRatedInfo(client, match, 'setup.selection.timer_race_resolved', getMatchLogDetails(match, {
                player,
                reason: 'stage_changed'
            }));
            return;
        }
        if (expectedActionToken != null && String(expectedActionToken) !== String(getMatchActionToken(match, getNextGameNumber(match)))) {
            logRatedInfo(client, match, 'setup.selection.timer_race_resolved', getMatchLogDetails(match, {
                player,
                reason: 'token_mismatch'
            }));
            return;
        }

        const options = await getOptionsForGameType(match.gameType);
        const thread = await client.channels.fetch(match.threadId).catch(() => null);
        const block = getOrCreateGameBlock(match);

        if (player === 'home' && !match.selectedStadium) {
            match.selectedStadium = options.stadiums[Math.floor(Math.random() * options.stadiums.length)];
            match.homeSelectionTimer = null;
            match.homeSelectionDeadlineAt = null;
            await deleteThreadMessage(thread, block.homeSelectionPromptId);
            block.homeSelectionPromptId = null;
            logRatedWarn(client, match, 'setup.selection.auto_randomized', getMatchLogDetails(match, {
                kind: 'stadium',
                value: match.selectedStadium?.description
            }));
        } else if (player === 'away' && !match.selectedCaptain) {
            match.selectedCaptain = options.captains[Math.floor(Math.random() * options.captains.length)];
            match.awaySelectionTimer = null;
            match.awaySelectionDeadlineAt = null;
            await deleteThreadMessage(thread, block.awaySelectionPromptId);
            block.awaySelectionPromptId = null;
            logRatedWarn(client, match, 'setup.selection.auto_randomized', getMatchLogDetails(match, {
                kind: 'captain',
                value: match.selectedCaptain?.description
            }));
        } else {
            logRatedInfo(client, match, 'setup.selection.timer_race_resolved', getMatchLogDetails(match, {
                player,
                reason: 'already_selected'
            }));
            return;
        }

        if (match.selectedStadium && match.selectedCaptain) {
            await advanceMatchToWinnerControlAfterSelections(match, client, thread);
        }
    });
}

async function clearCurrentSetupComponents(match, thread) {
    const block = Array.isArray(match.gameBlocks)
        ? match.gameBlocks.find(existingBlock => existingBlock.gameNumber === getNextGameNumber(match))
        : null;

    if (!block) {
        return;
    }

    await deleteThreadMessage(thread, block.startMessageId);
    block.startMessageId = null;
    await deleteThreadMessage(thread, block.homeSelectionPromptId);
    block.homeSelectionPromptId = null;
    await deleteThreadMessage(thread, block.awaySelectionPromptId);
    block.awaySelectionPromptId = null;
}

function formatThreadActionError(error) {
    return error?.message ?? String(error);
}

async function setThreadStateWithRetry(thread, methodName, value, reason, step, attempts = 2) {
    if (typeof thread?.[methodName] !== 'function') {
        return {
            ok: false,
            errors: [{ step, message: `${methodName} unavailable` }]
        };
    }

    const errors = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            await thread[methodName](value, reason);
            return { ok: true, errors };
        } catch (error) {
            errors.push({
                step: `${step}_attempt_${attempt}`,
                message: formatThreadActionError(error)
            });
        }
    }

    return { ok: false, errors };
}

async function closeMatchThread(thread, reason) {
    if (!thread) {
        return {
            archivedOk: false,
            lockedOk: false,
            errors: [{ step: 'thread_missing', message: 'thread unavailable' }]
        };
    }

    const lockResult = thread.locked === true
        ? { ok: true, errors: [] }
        : await setThreadStateWithRetry(
            thread,
            'setLocked',
            true,
            reason,
            'lock'
        );
    const archiveResult = thread.archived === true
        ? { ok: true, errors: [] }
        : await setThreadStateWithRetry(
            thread,
            'setArchived',
            true,
            reason,
            'archive'
        );

    return {
        archivedOk: archiveResult.ok,
        lockedOk: lockResult.ok,
        errors: [...archiveResult.errors, ...lockResult.errors]
    };
}

async function trySetThreadTerminalName(thread, terminalName) {
    if (!thread?.setName) {
        return { ok: false, error: new Error('setName unavailable') };
    }

    try {
        await thread.setName(terminalName);
        return { ok: true };
    } catch (error) {
        return { ok: false, error };
    }
}

async function reopenThreadForTerminalRename(thread, reason) {
    if (!thread) {
        return {
            opened: false,
            errors: [{ step: 'rename_reopen_thread_missing', message: 'thread unavailable' }]
        };
    }

    const unarchiveResult = await setThreadStateWithRetry(
        thread,
        'setArchived',
        false,
        `${reason} (rename reopen unarchive)`,
        'rename_reopen_unarchive'
    );
    const unlockResult = await setThreadStateWithRetry(
        thread,
        'setLocked',
        false,
        `${reason} (rename reopen unlock)`,
        'rename_reopen_unlock'
    );

    return {
        opened: unarchiveResult.ok || unlockResult.ok,
        errors: [...unarchiveResult.errors, ...unlockResult.errors]
    };
}

async function setTerminalThreadNameReliably(thread, match, prefix, client, reason) {
    const terminalName = buildTerminalThreadName(match, prefix);
    const errors = [];
    if (!thread) {
        return {
            terminalName,
            renamed: false,
            errors: [{ step: 'rename_thread_missing', message: 'thread unavailable' }]
        };
    }

    const initialRename = await trySetThreadTerminalName(thread, terminalName);
    if (initialRename.ok) {
        return { terminalName, renamed: true, errors };
    }
    errors.push({
        step: 'rename_initial',
        message: formatThreadActionError(initialRename.error)
    });

    const fetchedThread = thread?.id && client?.channels?.fetch
        ? await client.channels.fetch(thread.id).catch(error => {
            errors.push({
                step: 'rename_refetch',
                message: formatThreadActionError(error)
            });
            return null;
        })
        : null;
    if (fetchedThread) {
        const fetchedRename = await trySetThreadTerminalName(fetchedThread, terminalName);
        if (fetchedRename.ok) {
            return { terminalName, renamed: true, errors };
        }
        errors.push({
            step: 'rename_refetch_attempt',
            message: formatThreadActionError(fetchedRename.error)
        });
    }

    const fallbackThread = fetchedThread ?? thread;
    if (fallbackThread?.setArchived && fallbackThread?.setLocked) {
        const reopenResult = await reopenThreadForTerminalRename(fallbackThread, reason);
        errors.push(...reopenResult.errors);
        if (reopenResult.opened) {
            const fallbackRename = await trySetThreadTerminalName(fallbackThread, terminalName);
            if (fallbackRename.ok) {
                const restoreArchive = await setThreadStateWithRetry(
                    fallbackThread,
                    'setArchived',
                    true,
                    `${reason} (rename fallback restore archive)`,
                    'rename_restore_archive'
                );
                const restoreLock = await setThreadStateWithRetry(
                    fallbackThread,
                    'setLocked',
                    true,
                    `${reason} (rename fallback restore lock)`,
                    'rename_restore_lock'
                );
                errors.push(...restoreArchive.errors, ...restoreLock.errors);
                return { terminalName, renamed: true, errors };
            }
            errors.push({
                step: 'rename_fallback_attempt',
                message: formatThreadActionError(fallbackRename.error)
            });
        }
    }

    logRatedWarn(client, match, 'thread.rename_failed', getMatchLogDetails(match, {
        thread: thread.id,
        targetName: terminalName,
        errors: errors.map(error => `${error.step}:${error.message}`).join(';')
    }));
    return { terminalName, renamed: false, errors };
}

function buildCompletedThreadFinalizationSnapshot(match) {
    return {
        id: match.id,
        ratedMatchId: match.ratedMatchId ?? null,
        threadId: match.threadId,
        threadName: match.threadName,
        gameType: match.gameType,
        mode: match.mode,
        score: match.score ? { ...match.score } : null,
        stage: 'complete',
        finalizeAfterAt: Date.now() + COMPLETED_THREAD_CLOSE_DELAY_MS
    };
}

function getDateMs(value) {
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
}

function buildCompletedThreadFinalizationSnapshotFromDb(row) {
    const completedAtMs = getDateMs(row.CompletedAtUtc);
    return {
        id: row.MatchCode,
        ratedMatchId: row.Id,
        threadId: row.ThreadId,
        threadName: null,
        gameType: row.GameType,
        mode: row.ModeCode,
        matchNumber: row.MatchNumber,
        seasonMatchNumber: row.SeasonMatchNumber,
        score: {
            team1: Number(row.Team1Score ?? 0),
            team2: Number(row.Team2Score ?? 0)
        },
        stage: 'complete',
        completedAtMs,
        finalizeAfterAt: completedAtMs + COMPLETED_THREAD_CLOSE_DELAY_MS
    };
}

function buildCancelledThreadSnapshotFromDb(row) {
    return {
        id: row.MatchCode,
        ratedMatchId: row.Id,
        threadId: row.ThreadId,
        threadName: null,
        gameType: row.GameType,
        mode: row.ModeCode,
        matchNumber: row.MatchNumber,
        seasonMatchNumber: row.SeasonMatchNumber,
        score: null,
        stage: 'cancelled'
    };
}

function clearCompletedThreadFinalization(matchId) {
    clearCompletedThreadCloseTimer(matchId);
    state.pendingCompletedThreadFinalizationsByMatchId.delete(matchId);
}

function getThreadFinalizationErrorSummary(result) {
    const closeErrors = result?.closeStatus?.errors ?? [];
    const renameErrors = result?.renameStatus?.errors ?? [];
    return [...closeErrors, ...renameErrors]
        .map(error => `${error.step}:${error.message}`)
        .join('; ') || 'Thread finalization failed';
}

async function finalizeThreadLifecycle(matchSnapshot, client, {
    prefix,
    closeReason,
    renameReason,
    result,
    source = 'direct'
}) {
    const lockKey = `thread-finalize:${matchSnapshot.threadId}`;
    return await withOperationQueue(lockKey, async () => {
        const thread = await client.channels.fetch(matchSnapshot.threadId).catch(error => {
            logRatedWarn(client, matchSnapshot, 'thread.finalize_fetch_failed', getMatchLogDetails(matchSnapshot, {
                result,
                source,
                error: formatThreadActionError(error)
            }));
            return null;
        });

        const matchForThread = {
            ...matchSnapshot,
            threadName: matchSnapshot.threadName ?? thread?.name ?? 'Match'
        };
        const expectedTerminalName = buildTerminalThreadName(matchForThread, prefix);
        const alreadyFinalized = Boolean(
            thread
                && thread.archived === true
                && thread.locked === true
                && thread.name === expectedTerminalName
        );
        const renameStatus = alreadyFinalized || thread?.name === expectedTerminalName
            ? { terminalName: expectedTerminalName, renamed: true, errors: [] }
            : await setTerminalThreadNameReliably(
                thread,
                matchForThread,
                prefix,
                client,
                renameReason
            );
        const closeStatus = alreadyFinalized
            ? { archivedOk: true, lockedOk: true, errors: [] }
            : await closeMatchThread(thread, closeReason);
        const success = closeStatus.archivedOk && closeStatus.lockedOk && renameStatus.renamed;

        if (success) {
            logRatedInfo(client, matchSnapshot, 'thread.closed', getMatchLogDetails(matchSnapshot, {
                result,
                source
            }));
        } else {
            logRatedWarn(client, matchSnapshot, 'thread.finalize_failed', getMatchLogDetails(matchSnapshot, {
                result,
                source,
                archivedOk: closeStatus.archivedOk,
                lockedOk: closeStatus.lockedOk,
                renamed: renameStatus.renamed,
                closeErrors: closeStatus.errors.map(error => `${error.step}:${error.message}`).join(';'),
                renameErrors: renameStatus.errors.map(error => `${error.step}:${error.message}`).join(';')
            }));
        }

        return { success, closeStatus, renameStatus };
    });
}

async function finalizeCompletedThreadIfDue(matchId, client, source = 'timer') {
    const pending = state.pendingCompletedThreadFinalizationsByMatchId.get(matchId);
    if (!pending) {
        return false;
    }
    if (Date.now() < pending.finalizeAfterAt) {
        return false;
    }

    const result = await finalizeThreadLifecycle(pending, client, {
        prefix: COMPLETED_THREAD_PREFIX,
        closeReason: `${pending.gameType} competitive completed match close delay`,
        renameReason: `${pending.gameType} competitive completed match rename`,
        result: 'completed',
        source
    });
    if (result.success) {
        try {
            await ratedMatchDao.markThreadFinalizationSucceeded({ ratedMatchId: pending.ratedMatchId });
            clearCompletedThreadFinalization(matchId);
        } catch (error) {
            logRatedError(client, pending, 'rated_match.thread_finalize_mark_success_failed', error, getMatchLogDetails(pending));
            return false;
        }
    } else {
        const errorSummary = getThreadFinalizationErrorSummary(result);
        await ratedMatchDao.markThreadFinalizationFailed({
            ratedMatchId: pending.ratedMatchId,
            error: errorSummary
        }).catch(error => {
            logRatedError(client, pending, 'rated_match.thread_finalize_mark_failed_failed', error, getMatchLogDetails(pending, {
                finalizeError: errorSummary
            }));
        });
    }
    return result.success;
}

function scheduleCompletedThreadFinalization(pendingFinalization, client, source = 'completion') {
    clearCompletedThreadFinalization(pendingFinalization.id);
    state.pendingCompletedThreadFinalizationsByMatchId.set(pendingFinalization.id, pendingFinalization);
    const delayMs = Math.max(pendingFinalization.finalizeAfterAt - Date.now(), 0);
    logRatedInfo(client, pendingFinalization, 'thread.close_scheduled', getMatchLogDetails(pendingFinalization, {
        delayMs,
        source
    }));

    const timer = setTimeout(async () => {
        try {
            await finalizeCompletedThreadIfDue(pendingFinalization.id, client, 'timer');
        } finally {
            state.completedThreadCloseTimersByMatchId.delete(pendingFinalization.id);
        }
    }, delayMs);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    state.completedThreadCloseTimersByMatchId.set(pendingFinalization.id, timer);
}

function scheduleCompletedThreadClose(match, client) {
    scheduleCompletedThreadFinalization(
        buildCompletedThreadFinalizationSnapshot(match),
        client,
        'completion'
    );
}

async function clearMatchNotifications(match) {
    if (!match.notificationInteractions) return;
    for (const interaction of match.notificationInteractions.values()) {
        try {
            await interaction.deleteReply();
        } catch { /* token expired — user can dismiss manually */ }
    }
}

async function cancelMatchForInactivity(match, phase, client) {
    clearMatchTimers(match);
    const cancelMessage = renderInactivityCancelMessage(match, phase);
    const thread = await client.channels.fetch(match.threadId).catch(() => null);
    logRatedWarn(client, match, 'match.cancelled', getMatchLogDetails(match, {
        reason: 'inactivity',
        phase
    }));

    match.stage = 'cancelled';
    if (match.ratedMatchId) {
        ratedMatchDao.cancelMatch({ matchCode: match.id, cancelReason: `inactivity_${phase}` })
            .catch(err => logRatedError(client, match, 'rated_match.cancel_failed', err, getMatchLogDetails(match)));
    }
    if (thread?.send) {
        await clearCurrentSetupComponents(match, thread);
    }
    await clearCurrentControlMessage(match, client, cancelMessage, thread);
    await postTerminalThreadNotice(thread, match, client, renderMatchCancelledNoticeMessage(), [], 'match.cancel_notice_failed');
    await clearMatchNotifications(match);
    removeMatchFromState(match);
    await finalizeThreadLifecycle(match, client, {
        prefix: CANCELLED_THREAD_PREFIX,
        closeReason: `${match.gameType} competitive match inactivity timeout`,
        renameReason: `${match.gameType} competitive match inactivity rename`,
        result: 'cancelled',
        source: 'cancel_inactivity'
    });
}

function renderMatchCancelledNoticeMessage() {
    return quoteThreadLines(`${BL_X_EMOJI} **MATCH CANCELLED.**`);
}

async function cancelInMemoryMatchForSeasonEnd(match, client) {
    clearMatchTimers(match);
    const thread = await client.channels.fetch(match.threadId).catch(() => null);
    logRatedWarn(client, match, 'match.season_end_cancelled', getMatchLogDetails(match, {
        reason: 'season_end_cancelled'
    }));

    match.stage = 'cancelled';
    if (thread?.send) {
        await clearCurrentSetupComponents(match, thread);
    }
    await clearCurrentControlMessage(match, client, renderSeasonEndCancelMessage(), thread);
    await postTerminalThreadNotice(thread, match, client, renderMatchCancelledNoticeMessage(), [], 'match.cancel_notice_failed');
    await clearMatchNotifications(match);
    removeMatchFromState(match);
    await finalizeThreadLifecycle(match, client, {
        prefix: CANCELLED_THREAD_PREFIX,
        closeReason: `${match.gameType} competitive match cancelled by season end`,
        renameReason: `${match.gameType} competitive match season-end rename`,
        result: 'cancelled',
        source: 'season_end'
    });
}

async function finalizeSeasonEndCancelledThread(row, client) {
    if (!row?.ThreadId) {
        return;
    }
    const snapshot = buildCancelledThreadSnapshotFromDb(row);
    const thread = await client.channels.fetch(row.ThreadId).catch(() => null);
    await postTerminalThreadNotice(thread, snapshot, client, renderSeasonEndCancelMessage(), [], 'match.season_end_cancel_notice_failed');
    await postTerminalThreadNotice(thread, snapshot, client, renderMatchCancelledNoticeMessage(), [], 'match.cancel_notice_failed');
    await finalizeThreadLifecycle(snapshot, client, {
        prefix: CANCELLED_THREAD_PREFIX,
        closeReason: `${snapshot.gameType} competitive match cancelled by season end`,
        renameReason: `${snapshot.gameType} competitive match season-end rename`,
        result: 'cancelled',
        source: 'season_end_recovery'
    });
}

async function postTerminalThreadNotice(thread, match, client, content, components = [], event = 'thread.notice_post_failed') {
    if (!thread?.send || !content) {
        return null;
    }

    const payload = buildThreadTextPayload(content, 'line', { components });
    return await thread.send(payload).catch(err => {
        logRatedWarn(client, match, event, getMatchLogDetails(match, { error: err.message }));
        return null;
    });
}

async function postTerminalThreadImageNotice(thread, match, client, payload, event = 'thread.notice_image_post_failed') {
    if (!thread?.send || !payload) {
        return null;
    }

    return await thread.send(payload).catch(err => {
        logRatedWarn(client, match, event, getMatchLogDetails(match, { error: err.message }));
        return null;
    });
}

async function cancelMatchIfTimedOut(matchId, phase, client) {
    const match = state.activeMatchesById.get(matchId);
    if (!match || match.timeoutPhase !== phase || Date.now() < match.timeoutDeadlineAt) {
        return;
    }

    const lockKey = `match:${matchId}`;
    await withOperationQueue(lockKey, async () => {
        if (!state.activeMatchesById.has(matchId) || match.timeoutPhase !== phase || Date.now() < match.timeoutDeadlineAt) return;
        await cancelMatchForInactivity(match, phase, client);
    });
}

async function finalizeOverdueCompletedThreads(client, now = Date.now()) {
    const pendingFinalizations = [...state.pendingCompletedThreadFinalizationsByMatchId.values()]
        .filter(pending => now >= pending.finalizeAfterAt);
    for (const pending of pendingFinalizations) {
        await finalizeCompletedThreadIfDue(pending.id, client, 'tick_overdue');
    }
}

async function recoverCompletedThreadFinalizations(client, now = Date.now()) {
    const rows = await ratedMatchDao.getPendingCompletedThreadFinalizations();
    for (const row of rows) {
        const pending = buildCompletedThreadFinalizationSnapshotFromDb(row);
        const existing = state.pendingCompletedThreadFinalizationsByMatchId.get(pending.id);
        const hasTimer = state.completedThreadCloseTimersByMatchId.has(pending.id);
        if (now >= pending.finalizeAfterAt) {
            clearCompletedThreadCloseTimer(pending.id);
            state.pendingCompletedThreadFinalizationsByMatchId.set(pending.id, pending);
            await finalizeCompletedThreadIfDue(pending.id, client, 'db_recovery_due');
        } else if (!existing || !hasTimer) {
            scheduleCompletedThreadFinalization(pending, client, 'db_recovery_pending');
        }
    }
}

async function postInitialGameSetup(match, client) {
    const thread = await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        logRatedWarn(client, match, 'setup.initial.skipped', getMatchLogDetails(match, { reason: 'thread_missing' }));
        return;
    }

    if (requiresSetup(match.gameType)) {
        ensureMatchTimeoutScheduled(match, 'start', client);
    }

    const block = getOrCreateGameBlock(match);
    const includeRulesImage = !match.rulesImageMessageId;

    let homeRating = null, awayRating = null;
    if (includeRulesImage) {
        const homeRepId  = match.teams[match.homeTeamIndex - 1].repUserId;
        const awayRepId  = match.teams[match.awayTeamIndex - 1].repUserId;
        const gameTypeNum = CONSTANTS.SQL_GAME_TYPE_TO_NUMBER[match.gameType];
        const [defaultRating, loadedHomeRating, loadedAwayRating] = await Promise.all([
            getDefaultCompetitiveRating(),
            getPlayerRating(homeRepId, gameTypeNum, match.mode),
            getPlayerRating(awayRepId, gameTypeNum, match.mode)
        ]);
        homeRating = loadedHomeRating ?? buildDefaultCompetitiveRating(defaultRating);
        awayRating = loadedAwayRating ?? buildDefaultCompetitiveRating(defaultRating);
    }

    const payloads = buildInitialGameSetupPayloads(match, includeRulesImage, homeRating, awayRating);

    for (const item of payloads) {
        if (item.type === 'welcome-rules' && !match.rulesImageMessageId) {
            const msg = await thread.send(item.payload);
            match.rulesImageMessageId = msg.id;
            logRatedInfo(client, match, 'setup.rules.posted', getMatchLogDetails(match, { message: msg.id }));
        } else if (item.type === 'start') {
            const msg = await editOrSendThreadMessage(thread, block.startMessageId, item.payload);
            block.startMessageId = msg.id;
            logRatedInfo(client, match, 'setup.start_control.posted', getMatchLogDetails(match, { message: msg.id }));
        }
    }
}

async function advanceMatchToWinnerControlAfterSelections(match, client, thread = null) {
    thread ??= await client.channels.fetch(match.threadId).catch(() => null);
    const block = getOrCreateGameBlock(match);

    await postDelayedGameResultIfMissing(match, client, thread);
    await postGameImageIfMissing(match, client, thread);

    if (requiresSetup(match.gameType) && thread?.send && !block.selectionsMessageId) {
        const confMsg = await thread.send(buildThreadTextPayload(renderCombinedSelectionsMessage(match), 'line', { components: [] })).catch(() => null);
        if (confMsg) block.selectionsMessageId = confMsg.id;
        if (confMsg) {
            logRatedInfo(client, match, 'setup.selections.posted', getMatchLogDetails(match, { message: confMsg.id }));
        }
    }

    match.stage = 'awaiting_winner';
    if (thread) await clearStartButtonComponents(thread, block);
    await postWinnerControl(match, client);
}

async function postWinnerControl(match, client, thread = null) {
    thread ??= await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        return;
    }

    ensureMatchTimeoutScheduled(match, 'game', client);
    const options = await getOptionsForGameType(match.gameType);

    const payload = {
        content: renderMatchControlContent(match),
        components: buildMatchComponents(match, options)
    };
    const controlMessage = await editOrSendThreadMessage(thread, match.controlMessageId, payload);
    match.controlMessageId = controlMessage.id;
    logRatedInfo(client, match, 'control.winner.posted', getMatchLogDetails(match, {
        game: getNextGameNumber(match),
        message: controlMessage.id
    }));
}

async function recoverNextSetupViaStartGate(match, client, reason) {
    clearSelectionTimers(match);
    match.startClickedUserIds = [];
    match.stage = 'awaiting_start';
    match.controlVersion = (match.controlVersion ?? 0) + 1;
    logRatedWarn(client, match, 'setup.private_prompt_reopened', getMatchLogDetails(match, {
        reason
    }));
    await updateMatchControlMessage(match, client);
}

async function updateMatchControlMessage(match, client) {
    if (match.stage === 'awaiting_start') {
        await postInitialGameSetup(match, client);
        return;
    }

    if (match.stage === 'awaiting_winner') {
        await postWinnerControl(match, client);
        return;
    }

    const thread = await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        return;
    }

    if (match.stage === 'awaiting_loser_confirmation') {
        ensureMatchTimeoutScheduled(match, 'loser_confirmation', client);
    }

    const options = await getOptionsForGameType(match.gameType);
    const payload = {
        content: renderMatchControlContent(match),
        components: buildMatchComponents(match, options)
    };
    const controlMessage = await editOrSendThreadMessage(thread, match.controlMessageId, payload);
    match.controlMessageId = controlMessage.id;
}

async function recordConfirmedGameResult(match, client, confirmedByDiscordId = null) {
    if (!match.pendingResult) {
        return true;
    }
    if (!match.ratedMatchId) {
        match.competitiveDbFailed = true;
        logRatedError(client, match, 'rated_match.game_record_missing_match', new Error('Missing RatedMatch id while recording confirmed game'), getMatchLogDetails(match, {
            game: match.pendingResult.gameNumber
        }));
        return false;
    }

    try {
        await ratedMatchDao.recordGame({
            matchId: match.ratedMatchId,
            gameNumber: match.pendingResult.gameNumber,
            winnerTeamNumber: match.pendingResult.winnerTeamIndex,
            homeTeamNumber: match.pendingResult.homeTeamNumber ?? match.homeTeamIndex,
            stadiumCode: match.pendingResult.stadiumCode ?? null,
            captainCode: match.pendingResult.captainCode ?? null,
            reportedByParticipantId: match.participantIdByDiscordId?.get(String(match.pendingResult.reporterDiscordId)),
            confirmedByParticipantId: match.participantIdByDiscordId?.get(String(confirmedByDiscordId)),
            reportedByDiscordId: match.pendingResult.reporterDiscordId ?? null,
            confirmedByDiscordId
        });
        return true;
    } catch (err) {
        match.competitiveDbFailed = true;
        logRatedError(client, match, 'rated_match.game_record_failed', err, getMatchLogDetails(match, {
            game: match.pendingResult.gameNumber
        }));
        const thread = await client.channels.fetch(match.threadId).catch(() => null);
        if (thread?.send) {
            await thread.send({
                content: `${BL_X_EMOJI} **Competitive game write failed.** Staff has been notified; this match cannot record Competitive ELO until the DB issue is fixed.`
            }).catch(() => {});
        }
        return false;
    }
}

async function finishMatchWithCompetitiveDbFailure(match, client, thread, completedThreadName, eventName, error) {
    logRatedError(client, match, eventName, error, getMatchLogDetails(match));
    const failureMessage = await clearCurrentControlMessage(
        match,
        client,
        `${BL_X_EMOJI} **Competitive Rating write failed.** Staff has been notified; keep this thread for review.`,
        thread,
        buildFinalMatchComponents(match)
    );
    storeReportableMatch(match, completedThreadName, failureMessage?.id ?? null);
    logRatedInfo(client, match, 'match.complete_blocked_by_competitive_db', getMatchLogDetails(match, {
        message: failureMessage?.id,
        reason: eventName
    }));
    await clearMatchNotifications(match);
    removeMatchFromState(match);
}

async function completeMatch(match, winnerMention, client) {
    match.stage = 'complete';
    const thread = await client.channels.fetch(match.threadId).catch(() => null);
    const completedThreadName = buildTerminalThreadName(match, COMPLETED_THREAD_PREFIX);
    const winnerTeamNumber = match.score.team1 >= match.firstTo ? 1 : 2;
    let competitiveResult = null;
    logRatedInfo(client, match, 'match.complete', getMatchLogDetails(match, {
        winner: winnerMention,
        finalThreadName: completedThreadName
    }));

    const reportableMatch = isReportableMatch(match);
    if (reportableMatch && match.competitiveDbFailed) {
        await finishMatchWithCompetitiveDbFailure(
            match,
            client,
            thread,
            completedThreadName,
            'comp.rating.prerequisite_failed',
            new Error('Competitive DB setup or game write failed before match completion')
        );
        return;
    }

    if (reportableMatch && !match.ratedMatchId) {
        await finishMatchWithCompetitiveDbFailure(
            match,
            client,
            thread,
            completedThreadName,
            'comp.rating.missing_rated_match',
            new Error('Missing RatedMatch id at match completion')
        );
        return;
    }

    if (match.ratedMatchId && reportableMatch) {
        try {
            competitiveResult = await recordCompetitiveResult({
                ratedMatchId:    match.ratedMatchId,
                matchCode:       match.id,
                seasonId:        match.seasonId,
                gameType:        CONSTANTS.SQL_GAME_TYPE_TO_NUMBER[match.gameType],
                mode:            match.mode,
                winnerTeamNumber,
                team1Score:      match.score.team1,
                team2Score:      match.score.team2,
                homeTeamNumber:  match.homeTeamIndex,
                awayTeamNumber:  match.awayTeamIndex,
                client,
                guildId:         CONSTANTS.GUILD_ID
            });
            if (!Array.isArray(competitiveResult?.changes) || competitiveResult.changes.length === 0) {
                throw new Error('Competitive rating write produced no rating changes');
            }
        } catch (err) {
            await finishMatchWithCompetitiveDbFailure(
                match,
                client,
                thread,
                completedThreadName,
                'comp.rating.failed',
                err
            );
            return;
        }
    } else if (match.ratedMatchId) {
        try {
            await ratedMatchDao.completeMatch({
                matchCode:        match.id,
                team1Score:       match.score.team1,
                team2Score:       match.score.team2,
                winnerTeamNumber,
                homeTeamNumber:   match.homeTeamIndex,
                awayTeamNumber:   match.awayTeamIndex
            });
        } catch (err) {
            logRatedError(client, match, 'rated_match.complete_failed', err, getMatchLogDetails(match));
        }
    }

    const hasCompetitiveSummary = Array.isArray(competitiveResult?.changes) && competitiveResult.changes.length > 0;
    const finalResultMessage = await clearCurrentControlMessage(
        match,
        client,
        await renderFinalMatchResultMessage(winnerMention, match, competitiveResult),
        thread,
        []
    );
    const competitiveSummarySeparatorMessage = hasCompetitiveSummary
        ? await postTerminalThreadImageNotice(
            thread,
            match,
            client,
            buildSeparatorImageMessage(),
            'match.competitive_summary_separator_failed'
        )
        : null;
    const competitiveSummaryMessage = hasCompetitiveSummary
        ? await postTerminalThreadNotice(
            thread,
            match,
            client,
            renderCompetitiveRatingSummaryMessage(competitiveResult),
            [],
            'match.competitive_summary_notice_failed'
        )
        : null;
    const completionNoticeMessage = await postTerminalThreadNotice(
        thread,
        match,
        client,
        renderMatchCompleteNoticeMessage(),
        buildFinalMatchComponents(match),
        'match.complete_notice_failed'
    );
    const completionMessage = completionNoticeMessage ?? competitiveSummaryMessage ?? finalResultMessage;
    storeReportableMatch(match, completedThreadName, completionMessage?.id ?? null);
    logRatedInfo(client, match, 'match.final_result.posted', getMatchLogDetails(match, {
        message: finalResultMessage?.id,
        competitiveSeparatorMessage: competitiveSummarySeparatorMessage?.id,
        competitiveMessage: competitiveSummaryMessage?.id,
        noticeMessage: completionNoticeMessage?.id,
        reportable: isReportableMatch(match)
    }));

    await clearMatchNotifications(match);
    removeMatchFromState(match);
    scheduleCompletedThreadClose(match, client);
}

function getTeamIndexForReporter(match, userId) {
    const teamOne = match.teams[0];
    const teamTwo = match.teams[1];

    if (teamOne.memberIds.includes(userId)) return 1;
    if (teamTwo.memberIds.includes(userId)) return 2;
    return null;
}

async function handleWinnerSelection(interaction, match) {
    if (!hasExpectedMatchStageAndToken(match, interaction, 'awaiting_winner')) {
        await ignoreMatchInteraction(interaction, match, 'game.win_ignored', 'stale_or_wrong_stage', {}, { deleteReply: true });
        return;
    }

    const teamIndex = getTeamIndexForReporter(match, interaction.user.id);
    if (!teamIndex) {
        await safeReply(interaction, { content: 'Only a player in this match may report a win.', ephemeral: true });
        return;
    }

    await ensureDeferredReply(interaction);
    const completedGameNumber = getNextGameNumber(match);
    const winnerMention = `<@${interaction.user.id}>`;
    clearMatchTimers(match);
    if (teamIndex === 1) {
        match.score.team1 += 1;
    } else {
        match.score.team2 += 1;
    }
    logRatedInfo(interaction.client, match, 'game.win.reported', getMatchLogDetails(match, {
        game: completedGameNumber,
        reporter: interaction.user.id,
        winnerTeam: teamIndex,
        score: `${match.score.team1}-${match.score.team2}`
    }));

    const isMatchComplete = match.score.team1 >= match.firstTo || match.score.team2 >= match.firstTo;
    const loserTeamIndex = teamIndex === 1 ? 2 : 1;
    setPendingResult(match, {
        gameNumber: completedGameNumber,
        winnerTeamIndex: teamIndex,
        winnerMention,
        loserTeamIndex,
        reporterDiscordId: interaction.user.id,
        homeTeamNumber: match.homeTeamIndex,
        stadiumCode: match.selectedStadium?.code ?? null,
        captainCode: match.selectedCaptain?.code ?? null
    });
    match.loserAdvantagePromptShown = false;

    match.selectedStadium = null;
    match.selectedCaptain = null;
    match.stage = 'awaiting_loser_confirmation';

    if (!requiresSetup(match.gameType)) {
        await interaction.deleteReply().catch(() => {});
        ensureMatchTimeoutScheduled(match, 'loser_confirmation', interaction.client);
        await updateMatchControlMessage(match, interaction.client);
        logRatedInfo(interaction.client, match, 'game.awaiting_loss_confirm', getMatchLogDetails(match, {
            game: completedGameNumber,
            loserTeam: match.loserTeamIndex
        }));
        return;
    }

    const waitingPrompt = await deliverPrivateInteractionPayload(
        interaction,
        { content: '⏳ Waiting for your opponent to confirm the game result...' },
        'winner waiting message'
    );
    if (waitingPrompt) {
        rememberWinnerWaitingPrompt(match, interaction, waitingPrompt);
    }

    ensureMatchTimeoutScheduled(match, 'loser_confirmation', interaction.client);
    await updateMatchControlMessage(match, interaction.client);
}

async function handleLoserConfirm(interaction, match) {
    const pendingGameNumber = getPendingResultGameNumber(match);
    if (
        !hasExpectedMatchStageAndToken(match, interaction, 'awaiting_loser_confirmation', pendingGameNumber)
        || match.loserAdvantagePromptShown
    ) {
        await ignoreMatchInteraction(interaction, match, 'game.loss_confirm_ignored', 'stale_or_already_processed', {}, { deleteReply: true });
        return;
    }
    const loserRepId = match.teams[match.loserTeamIndex - 1].repUserId;
    if (interaction.user.id !== loserRepId) {
        await safeReply(interaction, { content: 'Only the losing player may confirm the game result.', ephemeral: true });
        return;
    }

    if (!requiresSetup(match.gameType)) {
        await ensureDeferredReply(interaction);
        const confirmedGameNumber = pendingGameNumber;
        const isMatchComplete = match.score.team1 >= match.firstTo || match.score.team2 >= match.firstTo;
        if (isMatchComplete) {
            match.loserAdvantagePromptShown = true;
            const winnerMention = getPendingResultWinnerMention(match);
            await recordConfirmedGameResult(match, interaction.client, interaction.user.id);
            clearPendingResult(match);
            await interaction.deleteReply().catch(() => {});
            await completeMatch(match, winnerMention, interaction.client);
            logRatedInfo(interaction.client, match, 'game.loss_confirmed', getMatchLogDetails(match, {
                game: confirmedGameNumber,
                loser: interaction.user.id
            }));
            return;
        }

        const confirmedResultMessage = renderNoSetupGameResultMessage(match, '');
        match.loserAdvantagePromptShown = true;
        await recordConfirmedGameResult(match, interaction.client, interaction.user.id);
        clearPendingResult(match);
        match.startClickedUserIds = [];
        match.stage = 'awaiting_winner';
        await clearCurrentControlMessage(match, interaction.client, confirmedResultMessage);
        logRatedInfo(interaction.client, match, 'game.loss_confirmed', getMatchLogDetails(match, {
            game: confirmedGameNumber,
            loser: interaction.user.id
        }));
        logRatedInfo(interaction.client, match, 'game.result.posted', getMatchLogDetails(match, {
            game: confirmedGameNumber,
            mode: 'no_setup'
        }));
        await interaction.deleteReply().catch(() => {});
        await postGameImageIfMissing(match, interaction.client);
        await updateMatchControlMessage(match, interaction.client);
        return;
    }

    await ensureDeferredReply(interaction);
    const loserTeamIndex = getPendingResultLoserTeamIndex(match);
    const confirmedGameNumber = pendingGameNumber;
    const isMatchComplete = match.score.team1 >= match.firstTo || match.score.team2 >= match.firstTo;
    if (isMatchComplete) {
        match.loserAdvantagePromptShown = true;
        const winnerMention = getPendingResultWinnerMention(match);
        await recordConfirmedGameResult(match, interaction.client, interaction.user.id);
        await clearWinnerWaitingPrompt(match);
        clearPendingResult(match);
        await interaction.deleteReply().catch(() => {});
        await completeMatch(match, winnerMention, interaction.client);
        logRatedInfo(interaction.client, match, 'game.loss_confirmed', getMatchLogDetails(match, {
            game: confirmedGameNumber,
            loser: interaction.user.id
        }));
        return;
    }

    const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
    await clearCurrentControlMessage(match, interaction.client, null, thread);
    await recordConfirmedGameResult(match, interaction.client, interaction.user.id);
    scheduleMatchTimeout(match, 'loser_confirmation', interaction.client);
    const advantagePromptContent = renderTimedMessage(
        'Choose your advantage for the next game:',
        match.timeoutDeadlineAt,
        `${LOSER_CHOICE_TIMEOUT_MINUTES} minutes`
    );

    const prompt = await deliverPrivateInteractionPayload(interaction, {
        content: advantagePromptContent,
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(loserAdvantageCustomId(match.id, 'home', getMatchActionToken(match, confirmedGameNumber)))
                    .setLabel('Choose Home')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(loserAdvantageCustomId(match.id, 'captain', getMatchActionToken(match, confirmedGameNumber)))
                    .setLabel('Choose Captain First')
                    .setStyle(ButtonStyle.Secondary)
            )
        ]
    }, 'loser advantage prompt');
    if (prompt) {
        storeDelayedGameResult(match, confirmedGameNumber, getPendingResultWinnerMention(match));
        match.loserAdvantagePromptShown = true;
        await replaceWinnerWaitingPrompt(match, {
            content: '⏳ Waiting for your opponent to choose the next-game advantage...',
            components: []
        }, 'winner waiting advantage message');
        logRatedInfo(interaction.client, match, 'game.advantage_prompt.posted', getMatchLogDetails(match, {
            loser: interaction.user.id,
            loserTeam: loserTeamIndex
        }));
        return;
    }

    await updateMatchControlMessage(match, interaction.client);
    logRatedWarn(interaction.client, match, 'game.advantage_prompt.retry_required', getMatchLogDetails(match, {
        game: confirmedGameNumber,
        loser: interaction.user.id
    }));
}

async function handleLoserAdvantage(interaction, match, choice) {
    const pendingGameNumber = getPendingResultGameNumber(match);
    if (
        !hasExpectedMatchStageAndToken(match, interaction, 'awaiting_loser_confirmation', pendingGameNumber)
        || !['home', 'captain'].includes(choice)
    ) {
        await ignoreMatchInteraction(interaction, match, 'game.advantage_ignored', 'stale_or_wrong_stage', { choice });
        return;
    }
    const loserRepId = match.teams[match.loserTeamIndex - 1].repUserId;
    if (interaction.user.id !== loserRepId) {
        await safeReply(interaction, { content: 'Only the losing player may choose the advantage.', ephemeral: true });
        return;
    }

    await ensureDeferredUpdate(interaction);
    const options = await getOptionsForGameType(match.gameType);
    const nextSides = applyLoserChoice(match.homeTeamIndex, match.loserTeamIndex, choice);
    const pendingResult = match.pendingResult;
    const confirmedGameNumber = getPendingResultGameNumber(match);
    const winnerTeamIndex = pendingResult?.winnerTeamIndex ?? (match.loserTeamIndex === 1 ? 2 : 1);
    const winnerRepId = match.teams[winnerTeamIndex - 1]?.repUserId;
    match.homeTeamIndex = nextSides.homeTeamIndex;
    match.awayTeamIndex = nextSides.awayTeamIndex;
    match.startClickedUserIds = [];
    clearPendingResult(match);
    match.loserAdvantagePromptShown = false;
    match.stage = 'awaiting_start';
    scheduleSelectionTimeout(match, choice === 'home' ? 'home' : 'away', interaction.client);
    scheduleSelectionTimeout(match, choice === 'home' ? 'away' : 'home', interaction.client);
    ensureMatchTimeoutScheduled(match, 'start', interaction.client);

    const loserPayload = choice === 'home'
        ? {
            content: renderHomeSelectionPrompt(match),
            components: buildStadiumButtonRows(match, options)
        }
        : {
            content: renderAwaySelectionPrompt(match),
            components: buildCaptainButtonRows(match, options)
        };
    const winnerPayload = choice === 'home'
        ? {
            content: renderAwaySelectionPrompt(match),
            components: buildCaptainButtonRows(match, options)
        }
        : {
            content: renderHomeSelectionPrompt(match),
            components: buildStadiumButtonRows(match, options)
        };

    const loserPrompt = await deliverPrivateInteractionPayload(interaction, loserPayload, 'loser private setup');
    if (!loserPrompt) {
        await recoverNextSetupViaStartGate(match, interaction.client, 'loser_private_setup_delivery_failed');
        return;
    }

    const winnerPrompt = await deliverPrivateInteractionPayload(
        getPrivateDeliveryInteraction(match, winnerRepId),
        winnerPayload,
        'winner private setup'
    );
    if (!winnerPrompt) {
        await deliverPrivateInteractionPayload(interaction, {
            content: 'Private setup controls could not be delivered to both players. Please use **Start Match** in the thread to reopen setup.',
            components: []
        }, 'loser private setup cancel notice').catch(() => {});
        await recoverNextSetupViaStartGate(match, interaction.client, 'winner_private_setup_delivery_failed');
        return;
    }

    match.loserTeamIndex = null;
    match.loserRepMention = null;
    await clearCurrentControlMessage(match, interaction.client, null);
    logRatedInfo(interaction.client, match, 'game.advantage.chosen', getMatchLogDetails(match, {
        game: confirmedGameNumber,
        loser: interaction.user.id,
        choice
    }));
    logRatedInfo(interaction.client, match, 'setup.private_controls.posted', getMatchLogDetails(match, {
        loserPrompt: loserPrompt.id,
        winnerPrompt: winnerPrompt.id
    }));
}

async function resolveLoserConfirmationIfTimedOut(matchId, phase, client) {
    const match = state.activeMatchesById.get(matchId);
    if (!match || match.timeoutPhase !== phase || Date.now() < match.timeoutDeadlineAt) return;
    if (match.stage !== 'awaiting_loser_confirmation') return;

    const lockKey = `match:${matchId}`;
    await withOperationQueue(lockKey, async () => {
        if (!state.activeMatchesById.has(matchId) || match.stage !== 'awaiting_loser_confirmation') return;

        if (!requiresSetup(match.gameType)) {
            const loserMention = match.teams[match.loserTeamIndex - 1].repMention;
            const timedOutGameNumber = getPendingResultGameNumber(match);
            const isMatchComplete = match.score.team1 >= match.firstTo || match.score.team2 >= match.firstTo;
            if (isMatchComplete) {
                const winnerMention = getPendingResultWinnerMention(match);
                await recordConfirmedGameResult(match, client, null);
                clearPendingResult(match);
                match.loserAdvantagePromptShown = true;
                await completeMatch(match, winnerMention, client);
                logRatedWarn(client, match, 'game.loss_confirm_timeout', getMatchLogDetails(match, {
                    game: timedOutGameNumber,
                    result: 'completed'
                }));
                return;
            }

            const timeoutResultMessage = renderNoSetupGameResultMessage(
                match,
                `${loserMention} did not confirm in time — proceeding to the next game.`
            );
            await recordConfirmedGameResult(match, client, null);
            clearPendingResult(match);
            match.loserAdvantagePromptShown = false;
            match.startClickedUserIds = [];
            match.stage = 'awaiting_winner';
            await clearCurrentControlMessage(match, client, timeoutResultMessage);
            logRatedWarn(client, match, 'game.loss_confirm_timeout', getMatchLogDetails(match, {
                game: timedOutGameNumber
            }));
            await postGameImageIfMissing(match, client);
            await updateMatchControlMessage(match, client);
            return;
        }

        const options = await getOptionsForGameType(match.gameType);
        const choice = Math.random() >= 0.5 ? 'home' : 'captain';
        const nextSides = applyLoserChoice(match.homeTeamIndex, match.loserTeamIndex, choice);
        const timedOutGameNumber = getPendingResultGameNumber(match);
        const winnerMention = getPendingResultWinnerMention(match);
        match.homeTeamIndex = nextSides.homeTeamIndex;
        match.awayTeamIndex = nextSides.awayTeamIndex;
        match.selectedStadium = options.stadiums[Math.floor(Math.random() * options.stadiums.length)];
        match.selectedCaptain = options.captains[Math.floor(Math.random() * options.captains.length)];
        await clearWinnerWaitingPrompt(match);
        await recordConfirmedGameResult(match, client, null);
        storeDelayedGameResult(match, timedOutGameNumber, winnerMention);
        clearPendingResult(match);
        match.loserAdvantagePromptShown = false;
        match.startClickedUserIds = [];
        match.stage = 'awaiting_start';
        const thread = await client.channels.fetch(match.threadId).catch(() => null);
        await clearCurrentControlMessage(match, client, null, thread);
        await postDelayedGameResultIfMissing(match, client, thread);
        await postGameImageIfMissing(match, client, thread);
        logRatedWarn(client, match, 'game.advantage_timeout', getMatchLogDetails(match, {
            game: timedOutGameNumber,
            choice,
            stadium: match.selectedStadium?.description,
            captain: match.selectedCaptain?.description
        }));
        const block = getOrCreateGameBlock(match);
        if (thread?.send && !block.selectionsMessageId) {
            const confMsg = await thread.send(buildThreadTextPayload(renderCombinedSelectionsMessage(match), 'line', { components: [] })).catch(() => null);
            if (confMsg) block.selectionsMessageId = confMsg.id;
        }
        match.stage = 'awaiting_winner';
        await postWinnerControl(match, client);
    });
}

function getSetupPickConfig(kind) {
    if (kind === 'stadium') {
        return {
            selectedKey: 'selectedStadium',
            otherSelectedKey: 'selectedCaptain',
            optionsKey: 'stadiums',
            teamIndexKey: 'homeTeamIndex',
            timerKey: 'homeSelectionTimer',
            deadlineKey: 'homeSelectionDeadlineAt',
            promptIdKey: 'homeSelectionPromptId',
            invalidMessage: 'Invalid stadium selection.',
            permissionMessage: mode => mode === '1v1'
                ? 'Only the **HOME** player may choose the stadium.'
                : 'Only the **HOME** team representative may choose the stadium.'
        };
    }

    return {
        selectedKey: 'selectedCaptain',
        otherSelectedKey: 'selectedStadium',
        optionsKey: 'captains',
        teamIndexKey: 'awayTeamIndex',
        timerKey: 'awaySelectionTimer',
        deadlineKey: 'awaySelectionDeadlineAt',
        promptIdKey: 'awaySelectionPromptId',
        invalidMessage: 'Invalid captain selection.',
        permissionMessage: mode => mode === '1v1'
            ? 'Only the **AWAY** player may choose the captain.'
            : 'Only the **AWAY** team representative may choose the captain.'
    };
}

async function handleSetupSelection(interaction, match, kind) {
    if (!hasExpectedMatchStageAndToken(match, interaction, 'awaiting_start')) {
        await ignoreMatchInteraction(interaction, match, 'setup.selection_ignored', 'stale_or_wrong_stage', { kind });
        return;
    }

    const config = getSetupPickConfig(kind);
    const repId = match.teams[match[config.teamIndexKey] - 1].repUserId;
    if (interaction.user.id !== repId) {
        await safeReply(interaction, {
            content: config.permissionMessage(match.mode),
            ephemeral: true
        });
        return;
    }
    if (match[config.selectedKey]) {
        await ignoreMatchInteraction(interaction, match, 'setup.selection_ignored', 'already_selected', { kind });
        return;
    }

    await ensureDeferredUpdate(interaction);
    const options = await getOptionsForGameType(match.gameType);
    const selectedValue = parseOptionValueFromCustomId(interaction.customId);
    const selectedOption = options[config.optionsKey].find(option => String(option.value) === selectedValue);
    if (!selectedOption) {
        await interaction.followUp({ content: config.invalidMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
    }

    match[config.selectedKey] = selectedOption;
    logRatedInfo(interaction.client, match, 'setup.selection.chosen', getMatchLogDetails(match, {
        user: interaction.user.id,
        kind,
        value: selectedOption.description
    }));

    if (match[config.timerKey]) {
        clearTimeout(match[config.timerKey]);
        match[config.timerKey] = null;
        match[config.deadlineKey] = null;
    }

    const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
    const block = getOrCreateGameBlock(match);
    await deleteThreadMessage(thread, block[config.promptIdKey]);
    block[config.promptIdKey] = null;

    if (match[config.otherSelectedKey]) {
        await advanceMatchToWinnerControlAfterSelections(match, interaction.client, thread);
    }

    await interaction.deleteReply().catch(() => {});
}

async function handleStadiumSelection(interaction, match) {
    await handleSetupSelection(interaction, match, 'stadium');
}

async function handleCaptainSelection(interaction, match) {
    await handleSetupSelection(interaction, match, 'captain');
}

async function showPrivateStartSetupControls(interaction, match, config) {
    await ensureDeferredReply(interaction);
    const options = await getOptionsForGameType(match.gameType);
    const block = getOrCreateGameBlock(match);
    const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
    scheduleSelectionTimeout(match, config.player, interaction.client);

    const privatePrompt = await deliverPrivateInteractionPayload(interaction, {
        content: config.renderPrompt(match),
        components: config.buildRows(match, options)
    }, `${config.player} start setup`);
    if (!privatePrompt) {
        clearSelectionTimer(match, config.player);
        logRatedWarn(interaction.client, match, 'setup.start_retry_required', getMatchLogDetails(match, {
            user: interaction.user.id,
            player: config.player
        }));
        return;
    }
    logRatedInfo(interaction.client, match, 'setup.start.clicked', getMatchLogDetails(match, {
        user: interaction.user.id,
        player: config.player
    }));

    if (!Array.isArray(match.startClickedUserIds)) {
        match.startClickedUserIds = [];
    }
    if (!match.startClickedUserIds.includes(config.repId)) {
        match.startClickedUserIds.push(config.repId);
    }

    if (match.startClickedUserIds.includes(config.otherRepId) && thread && !block.gameImageMessageId) {
        await clearStartButtonComponents(thread, block);
        await postGameImageIfMissing(match, interaction.client, thread);
        logRatedInfo(interaction.client, match, 'setup.start_gate.complete', getMatchLogDetails(match, {
            game: getNextGameNumber(match)
        }));
    }
}

async function handleStartSetupButton(interaction, match) {
    if (!hasExpectedMatchStageAndToken(match, interaction, 'awaiting_start')) {
        await ignoreMatchInteraction(interaction, match, 'setup.start_ignored', 'stale_or_wrong_stage', {}, { deleteReply: true });
        return;
    }

    const config = getSetupSelectionConfig(match, interaction.user.id);
    if (config && match[config.selectedKey]) {
        await ignoreMatchInteraction(interaction, match, 'setup.start_ignored', 'selection_already_done', {}, { deleteReply: true });
        return;
    }

    if (Array.isArray(match.startClickedUserIds) && match.startClickedUserIds.includes(interaction.user.id)) {
        await ignoreMatchInteraction(interaction, match, 'setup.start_ignored', 'duplicate_click', {}, { deleteReply: true });
        return;
    }

    if (config) {
        await showPrivateStartSetupControls(interaction, match, config);
        return;
    }

    await safeReply(interaction, {
        content: getSetupPermissionMessage(match),
        ephemeral: true
    });
}

async function reconcileAllPanels(client) {
    for (const panelConfig of CONFIG.PANEL_CHANNELS) {
        const lockKey = `reconcile:${panelConfig.channelId}`;
        if (state.operationQueues.has(lockKey)) { continue; }
        await withOperationQueue(lockKey, async () => {
            await reconcilePanelChannel(client, panelConfig);
        });
    }
}

async function finalizeSeasonEndCancelledMatches(cancelledMatches, client) {
    const handledRatedMatchIds = new Set();
    for (const match of [...state.activeMatchesById.values()]) {
        if (!cancelledMatches.some(row => Number(row.Id) === Number(match.ratedMatchId))) {
            continue;
        }
        handledRatedMatchIds.add(Number(match.ratedMatchId));
        await cancelInMemoryMatchForSeasonEnd(match, client);
    }

    for (const row of cancelledMatches) {
        if (handledRatedMatchIds.has(Number(row.Id))) {
            continue;
        }
        await finalizeSeasonEndCancelledThread(row, client);
    }
}

async function handleAutomaticSeasonTransitions(client) {
    const result = {
        endingSeason: null,
        finalizedSeason: null,
        activatedSeason: null,
        removedSearches: 0,
        cancelledMatches: 0
    };

    if (typeof beginDueSeasonEnding === 'function') {
        const endingSeason = await beginDueSeasonEnding();
        if (endingSeason) {
            result.endingSeason = endingSeason;
            result.removedSearches = await closeAllSearchesForSeasonEnd(client);
            logRatedWarn(client, { all: true }, 'season.ending_started', {
                season: endingSeason.Id,
                removedSearches: result.removedSearches
            });
        }
    }

    if (typeof finalizeDueEndingSeason === 'function') {
        const finalized = await finalizeDueEndingSeason();
        if (finalized?.season) {
            result.finalizedSeason = finalized.season;
            const cancelledMatches = finalized.cancelledMatches ?? [];
            result.cancelledMatches = cancelledMatches.length;
            await finalizeSeasonEndCancelledMatches(cancelledMatches, client);
            logRatedWarn(client, { all: true }, 'season.finalized', {
                season: finalized.season.Id,
                cancelledMatches: result.cancelledMatches
            });
        }
    }

    if (typeof activateDueSeason === 'function') {
        const activatedSeason = await activateDueSeason();
        if (activatedSeason) {
            result.activatedSeason = activatedSeason;
            logRatedInfo(client, { all: true }, 'season.activated', {
                season: activatedSeason.Id
            });
        }
    }

    return result;
}

async function recoverPendingCompetitiveWhrRunner(client, event) {
    const result = await runPendingCompetitiveWhrRunner?.();
    if (result?.updatedRows > 0) {
        logRatedWarn(client, { all: true }, event, {
            rows: result.updatedRows,
            partitions: result.partitions?.map(partition => `${partition.gameId}:${partition.mode}:${partition.count}`).join(',')
        });
    }
    return result;
}

async function tick(client) {
    const now = Date.now();
    await handleAutomaticSeasonTransitions(client).catch(error => {
        logRatedError(client, { all: true }, 'season.transition_failed', error);
    });

    const searches = [...state.activeSearchesById.values()];
    for (const search of searches) {
        if (now >= search.expiresAt) {
            await closeSearch(search, 'expired', client);
            continue;
        }
        if (!search.hasWarnedExpiry && now >= search.warningAt) {
            await warnSearchAboutExpiry(search, client);
        }
    }

    const matches = [...state.activeMatchesById.values()];
    for (const match of matches) {
        if (!match.timeoutPhase || now < match.timeoutDeadlineAt) {
            continue;
        }
        if (match.timeoutPhase === 'loser_confirmation') {
            await resolveLoserConfirmationIfTimedOut(match.id, match.timeoutPhase, client);
        } else {
            await cancelMatchIfTimedOut(match.id, match.timeoutPhase, client);
        }
    }

    await recoverCompletedThreadFinalizations(client, now).catch(error => {
        logRatedError(client, { all: true }, 'thread.finalize_recovery_failed', error);
    });
    await recoverPendingCompetitiveWhrSync?.().catch(error => {
        logRatedError(client, { all: true }, 'whr.sync_recovery_failed', error);
    });
    await recoverPendingCompetitiveWhrRunner(client, 'whr.runner_not_configured').catch(error => {
        logRatedError(client, { all: true }, 'whr.runner_recovery_failed', error);
    });
    await finalizeOverdueCompletedThreads(client, now);
    await reconcileAllPanels(client);
}

function startReconcileLoop(client) {
    if (state.reconcileTimer) {
        return;
    }

    state.reconcileTimer = setInterval(() => {
        tick(client).catch(error => {
            console.error(`Competitive pool tick failed: ${error.message}`);
            logRatedError(client, { all: true }, 'queue.tick_failed', error);
        });
    }, CONFIG.STATUS_RECONCILE_INTERVAL_MS);
}

async function ensureCompetitiveRatedQueue(client) {
    state.client = client;
    startReconcileLoop(client);
    startRatedRuntimeLogCleanupLoop(client);
    for (const panelConfig of CONFIG.PANEL_CHANNELS) {
        logRatedInfo(client, panelConfig, 'queue.started', { channel: panelConfig.channelId });
    }
    for (const meta of state.panelMetaByChannelId.values()) {
        meta.channelLockApplied = false;
    }
    try {
        await handleAutomaticSeasonTransitions(client);
    } catch (err) {
        console.error(`[RatedQueue] Season transition recovery failed: ${err.message}`);
        logRatedError(client, { all: true }, 'season.transition_recovery_failed', err);
    }
    try {
        await reconcileAllPanels(client);
    } catch (err) {
        console.error(`[RatedQueue] Initial panel reconcile failed: ${err.message}`);
        for (const panelConfig of CONFIG.PANEL_CHANNELS) {
            logRatedError(client, panelConfig, 'panel.reconcile.initial_failed', err, { channel: panelConfig.channelId });
        }
    }
    try {
        await recoverCompletedThreadFinalizations(client);
    } catch (err) {
        console.error(`[RatedQueue] Completed thread recovery failed: ${err.message}`);
        logRatedError(client, { all: true }, 'thread.finalize_recovery_initial_failed', err);
    }
    try {
        await recoverPendingCompetitiveWhrSync?.();
    } catch (err) {
        console.error(`[RatedQueue] WHR/TST sync recovery failed: ${err.message}`);
        logRatedError(client, { all: true }, 'whr.sync_recovery_initial_failed', err);
    }
    try {
        await recoverPendingCompetitiveWhrRunner(client, 'whr.runner_initial_not_configured');
    } catch (err) {
        console.error(`[RatedQueue] WHR/TST runner recovery failed: ${err.message}`);
        logRatedError(client, { all: true }, 'whr.runner_recovery_initial_failed', err);
    }
}

async function resetCompetitiveRatedQueue(client) {
    const activeSearches = [...state.activeSearchesById.values()];
    for (const search of activeSearches) {
        clearSearchTimers(search);
        removeSearchFromState(search);
    }

    for (const match of state.activeMatchesById.values()) {
        clearMatchTimers(match);
    }
    clearCompletedThreadCloseTimers();
    clearPendingCompletedThreadFinalizations();
    clearRuntimeLogTimers();

    state.activeMatchesById.clear();
    state.activeMatchesByThreadId.clear();
    state.activeMatchesByUserId.clear();
    state.reportableMatchesById.clear();
    state.panelMetaByChannelId.clear();
    state.cachedOptionsByGameType.clear();
    state.operationQueues.clear();
    state.pendingMatchmakingChannels.clear();
    for (const timer of state.matchmakingTimersByChannelId.values()) {
        clearTimeout(timer);
    }
    state.matchmakingTimersByChannelId.clear();
    for (const timer of state.panelStatusRefreshTimersByChannelId.values()) {
        clearTimeout(timer);
    }
    state.panelStatusRefreshTimersByChannelId.clear();
    state.runtimeLogQueuesByThreadId.clear();

    startRatedRuntimeLogCleanupLoop(client);
    await reconcileAllPanels(client);
}

async function handleJoinButton(interaction) {
    const channelId = parseChannelIdFromCustomId(interaction.customId);
    const mode = parseModeFromCustomId(interaction.customId);
    const panelConfig = getPanelConfigByChannelId(channelId);
    if (!panelConfig) {
        await safeReply(interaction, { content: CONTROL_EXPIRY_MESSAGE, ephemeral: true });
        return true;
    }

    if (!await ensureImmediateReply(interaction, {
        content: `Joining the ${getModeCompactLabel(mode)} pool...`,
        components: []
    })) {
        return true;
    }
    return await withInteractionLock(`queue:${interaction.user.id}`, async () => {
        await maybeJoinSearch(interaction, panelConfig, mode, DEFAULT_POOL_DURATION_MINUTES, {
            minBestOf: 3,
            maxBestOf: 3,
            threshold: null
        });
        return true;
    });
}

async function handleCancelSearch(interaction) {
    const searchId = parseIdFromCustomId(interaction.customId);
    if (!await ensureDeferredUpdate(interaction)) {
        return true;
    }
    return await withInteractionLock(`queue:${interaction.user.id}`, async () => {
        const search = state.activeSearchesById.get(searchId);
        if (!search) {
            logRatedInfo(interaction.client, {}, 'queue.leave_ignored', {
                search: searchId,
                user: interaction.user.id,
                reason: 'missing_search'
            });
            await silentlyAcknowledgeInteraction(interaction);
            return true;
        }

        if (interaction.user.id !== search.userId) {
            await safeReply(interaction, { content: 'Only the player in this pool can leave with this button.', ephemeral: true });
            return true;
        }

        await closeSearch(search, 'cancelled', interaction.client);
        schedulePanelStatusRefresh(search.channelId, interaction.client);
        await safeReply(interaction, { content: `You left the ${getModeCompactLabel(search.mode)} pool!`, components: [], ephemeral: true });
        return true;
    });
}

async function handleExtendSearch(interaction) {
    const searchId = parseIdFromCustomId(interaction.customId);
    const durationMinutes = DEFAULT_POOL_DURATION_MINUTES;
    if (!await ensureDeferredUpdate(interaction)) {
        return true;
    }
    return await withInteractionLock(`queue:${interaction.user.id}`, async () => {
        const search = state.activeSearchesById.get(searchId);
        if (!search) {
            logRatedInfo(interaction.client, {}, 'queue.extend_ignored', {
                search: searchId,
                user: interaction.user.id,
                reason: 'missing_search'
            });
            await silentlyAcknowledgeInteraction(interaction);
            return true;
        }

        if (interaction.user.id !== search.userId) {
            await safeReply(interaction, { content: 'Only the player in this pool can extend this search.', ephemeral: true });
            return true;
        }

        const token = parseActionTokenFromCustomId(interaction.customId);
        if (!search.hasWarnedExpiry || (token != null && token !== search.warningToken)) {
            logRatedInfo(interaction.client, search, 'queue.extend_ignored', {
                ...getSearchLogDetails(search),
                reason: 'stale_or_unwarned'
            });
            await silentlyAcknowledgeInteraction(interaction);
            return true;
        }

        const now = Date.now();
        search.notificationInteraction = interaction;
        search.hasWarnedExpiry = false;
        search.durationMinutes = durationMinutes;
        search.expiresAt = now + durationMinutes * 60000;
        search.warningAt = now + Math.max(durationMinutes - CONFIG.EXPIRING_SOON_MINUTES, 0) * 60000;
        await deleteSearchWarningMessage(search, interaction.client);
        scheduleSearchTimers(search, interaction.client);

        await safeFollowUp(interaction, {
            content: renderTimedMessage(
                `Your ${getModeCompactLabel(search.mode)} pool entry was extended.`,
                search.expiresAt,
                `**${durationMinutes} minutes**`
            ),
            components: [],
            ephemeral: true
        });
        logRatedInfo(interaction.client, search, 'queue.extended', {
            ...getSearchLogDetails(search),
            durationMin: durationMinutes
        });
        return true;
    });
}

async function getReportableMatchSnapshot(matchId, client) {
    const existingSnapshot = state.reportableMatchesById.get(matchId);
    if (existingSnapshot) {
        return existingSnapshot;
    }

    if (typeof ratedMatchDao.getReportableMatchSnapshot !== 'function') {
        return null;
    }

    try {
        const rebuiltSnapshot = await ratedMatchDao.getReportableMatchSnapshot(matchId);
        if (!isReportableMatch(rebuiltSnapshot)) {
            return null;
        }

        state.reportableMatchesById.set(matchId, rebuiltSnapshot);
        logRatedInfo(client, rebuiltSnapshot, 'report_issue.snapshot_rebuilt', {
            match: matchId
        });
        return rebuiltSnapshot;
    } catch (err) {
        logRatedError(client, { all: true }, 'report_issue.snapshot_rebuild_failed', err, {
            match: matchId
        });
        return null;
    }
}

async function handleReportIssueInteraction(interaction) {
    const matchId = parseIdFromCustomId(interaction.customId);
    if (!await ensureDeferredReply(interaction)) {
        return true;
    }
    return await withInteractionLock(`report_issue:${matchId}`, async () => {
        const snapshot = await getReportableMatchSnapshot(matchId, interaction.client);
        if (!snapshot || snapshot.issueThreadId) {
            logRatedInfo(interaction.client, snapshot ?? {}, 'report_issue.ignored', {
                match: matchId,
                user: interaction.user.id,
                reason: snapshot?.issueThreadId ? 'already_created' : 'missing_snapshot'
            });
            await silentlyAcknowledgeInteraction(interaction, { deleteReply: true });
            return true;
        }

        if (!snapshot.participantIds.includes(interaction.user.id)) {
            logRatedWarn(interaction.client, snapshot, 'report_issue.denied', {
                match: matchId,
                user: interaction.user.id
            });
            await safeReply(interaction, {
                content: 'Only players from this match can report an issue from here.',
                components: [],
                ephemeral: true
            });
            return true;
        }

        const reportThread = await createIssueReportPost(interaction.client, snapshot);
        if (!reportThread) {
            await safeReply(interaction, {
                content: 'Could not create the issue report post. Please contact staff directly.',
                components: [],
                ephemeral: true
            });
            return true;
        }

        snapshot.issueThreadId = reportThread.id;
        snapshot.issueThreadUrl = reportThread.url ?? null;
        await safeReply(interaction, {
            content: snapshot.issueThreadUrl
                ? `Issue report created: ${snapshot.issueThreadUrl}`
                : 'Issue report created.',
            components: [],
            ephemeral: true
        });
        return true;
    });
}

async function handleMatchInteraction(interaction) {
    const matchId = parseIdFromCustomId(interaction.customId);
    const matchAction = interaction.customId.split(':')[3];
    if (matchAction === 'report_issue') {
        return await handleReportIssueInteraction(interaction);
    }

    const match = state.activeMatchesById.get(matchId);
    if (!match) {
        await silentlyAcknowledgeInteraction(interaction);
        return true;
    }

    const lockKey = `match:${match.id}`;

    return await runMatchTransition({
        interaction,
        match,
        matchAction,
        lockKey,
        ensureImmediateReply,
        ensureDeferredUpdate,
        rememberPrivateDeliveryInteraction,
        withInteractionLock,
        handleExpiredMatch: async () => {
            if (match.timeoutPhase && match.timeoutPhase !== 'loser_confirmation' && Date.now() >= match.timeoutDeadlineAt) {
                await ensureDeferredUpdate(interaction);
                await cancelMatchForInactivity(match, match.timeoutPhase, interaction.client);
                return true;
            }
            return false;
        },
        onAckFailed: async () => {
            logRatedWarn(interaction.client, match, 'match.transition.ack_failed', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id,
                error: interaction.__ratedAckError?.message
            }));
        },
        onQueued: async () => {
            logRatedInfo(interaction.client, match, 'match.transition.queued', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id
            }));
        },
        onStarted: async () => {
            logRatedInfo(interaction.client, match, 'match.transition.started', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id
            }));
        },
        onFinished: async () => {
            logRatedInfo(interaction.client, match, 'match.transition.finished', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id
            }));
        },
        transition: async () => {
            if (interaction.customId.includes(':match:start:')) {
                await handleStartSetupButton(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:stadium:')) {
                await handleStadiumSelection(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:captain:')) {
                await handleCaptainSelection(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:winner:')) {
                await handleWinnerSelection(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:loser_confirm:')) {
                await handleLoserConfirm(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:loser_advantage:')) {
                await handleLoserAdvantage(interaction, match, parseLoserChoiceFromCustomId(interaction.customId));
                return true;
            }

            return false;
        }
    });
}

function isCompetitiveRatedInteraction(interaction) {
    return interaction?.customId?.startsWith?.(CONFIG.PREFIX) ?? false;
}

async function handleInteraction(interaction) {
    if (!isCompetitiveRatedInteraction(interaction)) {
        return false;
    }

    if (interaction.isModalSubmit && interaction.isModalSubmit()) {
        await safeReply(interaction, { content: CONTROL_EXPIRY_MESSAGE, ephemeral: true });
        return true;
    }

    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
        return await handleMatchInteraction(interaction);
    }

    if (!interaction.isButton || !interaction.isButton()) {
        return false;
    }

    if (interaction.customId.includes(':join:')) {
        return await handleJoinButton(interaction);
    }
    if (interaction.customId.includes(':search:cancel:')) {
        return await handleCancelSearch(interaction);
    }
    if (interaction.customId.includes(':search:extend:')) {
        return await handleExtendSearch(interaction);
    }
    if (interaction.customId.includes(':match:')) {
        return await handleMatchInteraction(interaction);
    }

    return false;
}

async function enforcePanelMessagePolicy(message) {
    if (!message?.guild || message.author?.bot || !isManagedPanelChannel(message.channel?.id)) {
        return false;
    }

    if (hasBypassRole(message?.member)) {
        return false;
    }

    await message.delete().catch(() => {});
    return true;
}

function __resetState() {
    if (state.reconcileTimer) {
        clearInterval(state.reconcileTimer);
        state.reconcileTimer = null;
    }

    for (const search of state.activeSearchesById.values()) {
        clearSearchTimers(search);
    }

    for (const match of state.activeMatchesById.values()) {
        clearMatchTimers(match);
    }
    clearCompletedThreadCloseTimers();
    clearPendingCompletedThreadFinalizations();
    clearRuntimeLogTimers();

    state.client = null;
    state.panelMetaByChannelId.clear();
    state.activeSearchesById.clear();
    state.activeSearchesByUserId.clear();
    state.activeMatchesById.clear();
    state.activeMatchesByThreadId.clear();
    state.activeMatchesByUserId.clear();
    state.reportableMatchesById.clear();
    state.cachedOptionsByGameType.clear();
    state.operationQueues.clear();
    state.pendingMatchmakingChannels.clear();
    for (const timer of state.matchmakingTimersByChannelId.values()) {
        clearTimeout(timer);
    }
    state.matchmakingTimersByChannelId.clear();
    for (const timer of state.panelStatusRefreshTimersByChannelId.values()) {
        clearTimeout(timer);
    }
    state.panelStatusRefreshTimersByChannelId.clear();
    state.runtimeLogQueuesByThreadId.clear();
}

function __getStateSnapshot() {
    return {
        activeSearchCount: state.activeSearchesById.size,
        activeMatchCount: state.activeMatchesById.size,
        reportableMatchCount: state.reportableMatchesById.size,
        completedThreadCloseTimerCount: state.completedThreadCloseTimersByMatchId.size,
        pendingCompletedThreadFinalizationCount: state.pendingCompletedThreadFinalizationsByMatchId.size,
        panelCount: state.panelMetaByChannelId.size,
        pendingInteractionLockCount: state.operationQueues.size,
        pendingMatchmakingChannelCount: state.pendingMatchmakingChannels.size,
        pendingMatchmakingTimerCount: state.matchmakingTimersByChannelId.size,
        runtimeLogBufferCount: state.runtimeLogBuffersByThreadId.size,
        runtimeLogQueueCount: state.runtimeLogQueuesByThreadId.size,
        runtimeLogCleanupTimerActive: Boolean(state.runtimeLogCleanupTimer)
    };
}

function __seedStateForTests({
    activeSearchUserIds = [],
    activeMatchUserIds = [],
    activeSearches = [],
    activeMatches = [],
    pendingCompletedThreadFinalizations = [],
    cachedOptionsByGameType = {}
} = {}) {
    for (const userId of activeSearchUserIds) {
        state.activeSearchesByUserId.set(userId, { userId });
    }

    for (const userId of activeMatchUserIds) {
        state.activeMatchesByUserId.set(userId, { userId });
    }

    for (const search of activeSearches) {
        state.activeSearchesById.set(search.id, search);
        state.activeSearchesByUserId.set(search.userId, search);
    }

    for (const match of activeMatches) {
        state.activeMatchesById.set(match.id, match);
        state.activeMatchesByThreadId.set(match.threadId, match);
        for (const team of match.teams ?? []) {
            for (const memberId of team.memberIds ?? []) {
                state.activeMatchesByUserId.set(memberId, match);
            }
        }
    }

    for (const pending of pendingCompletedThreadFinalizations) {
        state.pendingCompletedThreadFinalizationsByMatchId.set(pending.id, pending);
    }

    for (const [gameType, options] of Object.entries(cachedOptionsByGameType)) {
        state.cachedOptionsByGameType.set(gameType, options);
    }
}

module.exports = {
    __createCompetitiveRatedMatchForTests: createCompetitiveRatedMatch,
    __flushRuntimeLogsForTests: flushRuntimeLogsForTests,
    __getStateSnapshot,
    __resetState,
    __runMatchmakingForTests: tryCreateMatches,
    __runRuntimeLogCleanupForTests: runRatedRuntimeLogCleanup,
    __runSeasonTransitionsForTests: handleAutomaticSeasonTransitions,
    __seedStateForTests,
    __tickForTests: tick,
    applyLoserChoice,
    areSinglesSearchesCompatible,
    buildBalancedDoublesTeams,
    buildCaptainSelectionConfirmationPayload,
    buildLeavePoolLabel,
    buildStadiumSelectionConfirmationPayload,
    buildSearchExpiredPayload,
    buildSearchExpiryWarningPayload,
    buildStartPayload,
    buildInitialGameSetupPayloads,
    buildMatchFoundPayload,
    buildMatchComponents,
    buildPanelMessage,
    buildStatusMessageContent,
    buildThreadUrl,
    clearMatchedInteractionResponse,
    computeFirstTo,
    ensureCompetitiveRatedQueue,
    enforcePanelMessagePolicy,
    getGameImagePath,
    getCompetitiveRatedBusyReason,
    getPlayerQueueProfile,
    handleInteraction,
    isCompetitiveRatedInteraction,
    isManagedPanelChannel,
    isUserInLiveQueue,
    renderFinalMatchResultMessage,
    renderGameResultMessage,
    resetCompetitiveRatedQueue
};
