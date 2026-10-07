// The rated match itself, in the order of SYSTEM-OVERVIEW 3c: setup (start gate, private
// stadium/captain picks) → games (GAME WIN, loss confirmation, loser advantage) → completion
// (result, ELO, thread) or cancellation (timeouts, unanimous vote). Kept in one module on
// purpose: the order of these steps is load-bearing.
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const { executeQuery, isTransientDbError } = require('../../db/sqlClient');
const { safeFollowUp, safeReply } = require('../../utils/discord');
const {
    getDefaultCompetitiveRating,
    getPlayerRating,
    recordCompetitiveResult
} = require('../competitiveRating');
const { COMP_RANK_EMOJIS } = require('../../utils/competitiveConstants');
const RatedMatchDao = require('../../db/daos/ratedMatchDao');
const ratedMatchDao = new RatedMatchDao();
const {
    ARROW_EMOJI,
    BL_CHECK_EMOJI,
    BL_CUP_EMOJI,
    BL_TIME_EMOJI,
    BL_X_EMOJI,
    CANCELLED_THREAD_PREFIX,
    CAPTAIN_BUTTON_ORDER_BY_GAME_TYPE,
    CAPTAIN_DISPLAY_OVERRIDES,
    COMPLETED_THREAD_PREFIX,
    CONFIG,
    CONSTANTS,
    LOSER_CHOICE_TIMEOUT_MINUTES,
    MATCH_TIMEOUT_PHASES,
    MSC_CAPTAIN_BUTTON_ORDER,
    RULES_IMAGE_PATHS_BY_GAME_TYPE,
    SCORE_EMOJIS,
    SELECTION_TIMEOUT_MINUTES,
    STADIUM_BUTTON_ORDER_BY_GAME_TYPE,
    STADIUM_DISPLAY_OVERRIDES
} = require('./constants');
const {
    cancelMatchCustomId,
    captainButtonCustomId,
    loserAdvantageCustomId,
    loserConfirmCustomId,
    openPrivatePickCustomId,
    parseOpenPickPlayerFromCustomId,
    parseOptionValueFromCustomId,
    rematchCustomId,
    reportIssueCustomId,
    stadiumButtonCustomId,
    startSetupCustomId,
    winnerButtonCustomId
} = require('./customIds');
const {
    buildTerminalThreadName,
    buildThreadTextPayload,
    quoteThreadBlock,
    quoteThreadLines,
    quoteThreadPayload,
    renderCountdownLine,
    renderTimedMessage,
    truncateButtonLabel
} = require('./formatting');
const { state, withOperationQueue } = require('./state');
const {
    ensureDeferredReply,
    ensureDeferredUpdate,
    silentlyAcknowledgeInteraction
} = require('./interactions');
const { buildGameImageMessage, buildImageMessage } = require('./messages');
const { applyLoserChoice } = require('./matchLogic');
const {
    clearPendingResult,
    getMatchActionToken,
    getNextGameNumber,
    getPendingResultGameNumber,
    getPendingResultLoserTeamIndex,
    getPendingResultWinnerMention: getPendingResultWinnerMentionFromState,
    getPendingResultWinnerTeam,
    getPrivateDeliveryInteraction,
    isMatchDecided,
    matchActionTokenMatches,
    requiresSetup,
    setPendingResult
} = require('./matchState');
const {
    logRatedError,
    logRatedInfo,
    logRatedWarn
} = require('./runtimeLogger');
const {
    clearWinnerWaitingPrompt,
    deliverPrivateInteractionPayload,
    rememberWinnerWaitingPrompt,
    replaceWinnerWaitingPrompt
} = require('./privatePrompts');
const {
    clearCurrentControlMessage,
    deleteThreadMessage,
    editOrSendRequiredThreadMessage,
    editOrSendThreadMessage
} = require('./threadMessages');
const { transitionMatchStage } = require('./matchTransitions');
const { isReportableMatch, storeReportableMatch } = require('./terminalFlow');
const {
    getMatchLogDetails,
    queueMatchOutput,
    scheduleRuntimeStatePersist
} = require('./core');
const {
    buildCompleteCompetitiveDbPayload,
    buildRecordGameDbPayload,
    enqueueCompetitiveDbOp,
    hasPendingCompetitiveDbOpsForMatch,
    postCompetitiveDbPendingNotice,
    renderCompetitiveRatingSummaryMessage
} = require('./dbOps');
const { finalizeThreadLifecycle, scheduleCompletedThreadClose } = require('./threadLifecycle');

function setMatchStage(match, stage, reason) {
    transitionMatchStage(match, stage, {
        onInvalid: fromStage => logRatedWarn(state.client, match, 'match.stage_transition_unexpected', getMatchLogDetails(match, {
            from: fromStage,
            to: stage,
            reason
        }))
    });
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

const CANCEL_VOTE_PERMISSION_MESSAGE = 'Only the players in this match can cancel it.';

const CANCEL_VOTE_COMPLETE_MESSAGE = 'Everyone agreed. Cancelling the match...';

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

function describeTeam(team) {
    return team.members.map(member => member.mention).join(' + ');
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

// Neutral in-thread prompt used only as the private re-request when the ephemeral could not
// be delivered. It reveals only whose turn it is and the category — never the options.
function renderHomeOpenPickPrompt(match) {
    const homeTeam = match.teams[match.homeTeamIndex - 1];
    return renderTimedMessage(
        `${describeTeam(homeTeam)} — it's your turn to pick the **STADIUM**. Click **Choose Stadium** to open your private selection.`,
        match.homeSelectionDeadlineAt,
        `**${SELECTION_TIMEOUT_MINUTES} mins**`
    );
}

function renderAwayOpenPickPrompt(match) {
    const awayTeam = match.teams[match.awayTeamIndex - 1];
    return renderTimedMessage(
        `${describeTeam(awayTeam)} — it's your turn to pick the **CAPTAIN**. Click **Choose Captain** to open your private selection.`,
        match.awaySelectionDeadlineAt,
        `**${SELECTION_TIMEOUT_MINUTES} mins**`
    );
}

function getSetupPromptConfig(player) {
    if (player === 'home') {
        return {
            player,
            selectedKey: 'selectedStadium',
            openButtonIdKey: 'homeOpenButtonMessageId',
            deliveredKey: 'homeSelectionDelivered',
            timerKey: 'homeSelectionTimer',
            deadlineKey: 'homeSelectionDeadlineAt',
            buildRows: buildStadiumButtonRows,
            renderPrompt: renderHomeSelectionPrompt,
            renderOpenPrompt: renderHomeOpenPickPrompt,
            openButtonLabel: 'Choose Stadium'
        };
    }

    if (player === 'away') {
        return {
            player,
            selectedKey: 'selectedCaptain',
            openButtonIdKey: 'awayOpenButtonMessageId',
            deliveredKey: 'awaySelectionDelivered',
            timerKey: 'awaySelectionTimer',
            deadlineKey: 'awaySelectionDeadlineAt',
            buildRows: buildCaptainButtonRows,
            renderPrompt: renderAwaySelectionPrompt,
            renderOpenPrompt: renderAwayOpenPickPrompt,
            openButtonLabel: 'Choose Captain'
        };
    }

    return null;
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
        if (requiresSetup(match.gameType) && match.loserAdvantagePromptShown) {
            return quoteThreadLines(
                `${describeTeam(loserTeam)}, choose your advantage for the next game.\n` +
                countdownLine
            );
        }
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
        gameImageMessageId: null,
        startMessageId: null,
        // Neutral "it's your turn — click to open your private pick" buttons. These are the
        // ONLY in-thread selection artifact and are posted solely when the private ephemeral
        // could not be delivered. They never reveal the stadium/captain options.
        homeOpenButtonMessageId: null,
        awayOpenButtonMessageId: null,
        // Whether the private ephemeral selection prompt is currently live for each side.
        // true → rely on the ephemeral (no neutral button needed). false → owed (delivery
        // failed or post-restart) → the neutral open button is the private re-request.
        homeSelectionDelivered: false,
        awaySelectionDelivered: false,
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
            .setStyle(ButtonStyle.Primary),
        // Appended AFTER Start deliberately: the test helpers read components[0] of this row to
        // find the Start button. Secondary, not Danger, because the vote is reversible and must
        // not read louder than the primary action.
        new ButtonBuilder()
            .setCustomId(cancelMatchCustomId(matchId, gameNumber))
            .setLabel('Cancel Match')
            .setStyle(ButtonStyle.Secondary)
    );
}

function buildStartPayload(match) {
    return buildThreadTextPayload(renderStartMessage(match), 'line', {
        components: [buildStartButton(match.id, getMatchActionToken(match, getNextGameNumber(match)))]
    });
}

function buildFinalMatchActionRow(matchId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(rematchCustomId(matchId))
            .setLabel('Rematch')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(reportIssueCustomId(matchId))
            .setLabel('Report Issue')
            .setStyle(ButtonStyle.Secondary)
    );
}

function buildFinalMatchComponents(match) {
    return isReportableMatch(match)
        ? [buildFinalMatchActionRow(match.id)]
        : [];
}

function buildLoserAdvantageComponents(match, gameNumber = getPendingResultGameNumber(match)) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(loserAdvantageCustomId(match.id, 'home', getMatchActionToken(match, gameNumber)))
                .setLabel('Choose Home')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(loserAdvantageCustomId(match.id, 'captain', getMatchActionToken(match, gameNumber)))
                .setLabel('Choose Captain First')
                .setStyle(ButtonStyle.Secondary)
        )
    ];
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
    const byDescription = new Map(stadiums.map(option => [
        normalizeButtonOptionKey(getStadiumDisplayDescription(option.description)),
        option
    ]));
    const usedValues = new Set();
    const ordered = [];

    for (const description of order) {
        const option = byDescription.get(normalizeButtonOptionKey(getStadiumDisplayDescription(description)));
        if (!option || usedValues.has(option.value)) {
            continue;
        }
        usedValues.add(option.value);
        ordered.push(option);
    }

    const unmatched = stadiums.filter(option => !usedValues.has(option.value));
    return ordered.length > 0 ? [...ordered, ...unmatched] : stadiums;
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
    if (match.stage === 'complete' || match.stage === 'cancelled') {
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
        // MSBL skips the start gate entirely (requiresSetup covers MSC/SMS only), so the game
        // control is its only place to bail out early. MSC and SMS keep the button on the start
        // control instead - see buildStartButton.
        if (!requiresSetup(match.gameType)) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(cancelMatchCustomId(match.id, getMatchActionToken(match, gameNumber)))
                    .setLabel('Cancel Match')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        return [row];
    }

    if (match.stage === 'awaiting_loser_confirmation') {
        const gameNumber = getPendingResultGameNumber(match);
        if (requiresSetup(match.gameType) && match.loserAdvantagePromptShown) {
            return buildLoserAdvantageComponents(match, gameNumber);
        }
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

function scheduleSearchTimeout(callback, delayMs) {
    const timer = setTimeout(callback, Math.max(delayMs, 0));
    timer.unref?.();
    return timer;
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
    if (phase === 'loser_confirmation' || phase === 'loser_advantage') return LOSER_CHOICE_TIMEOUT_MINUTES;
    return CONFIG.MATCH_START_TIMEOUT_MINUTES;
}

function scheduleMatchTimeout(match, phase, client) {
    if (!match || !MATCH_TIMEOUT_PHASES.has(phase)) {
        return false;
    }

    clearMatchTimers(match);

    const delayMs = getMatchTimeoutMinutes(phase) * 60000;
    const deadlineAt = Date.now() + delayMs;
    match.timeoutPhase = phase;
    match.timeoutDeadlineAt = deadlineAt;

    const callback = phase === 'loser_confirmation' || phase === 'loser_advantage'
        ? () => resolveLoserConfirmationIfTimedOut(match.id, phase, client).catch(err => {
            console.error(`Competitive match ${phase} timeout failed: ${err.message}`);
            logRatedError(client, match, 'match.timeout_failed', err, getMatchLogDetails(match, { phase }));
        })
        : () => cancelMatchIfTimedOut(match.id, phase, client).catch(err => {
            console.error(`Competitive match ${phase} timeout failed: ${err.message}`);
            logRatedError(client, match, 'match.timeout_failed', err, getMatchLogDetails(match, { phase }));
        });

    match.timeoutTimer = scheduleSearchTimeout(callback, delayMs);
    return true;
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

    return scheduleMatchTimeout(match, phase, client);
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
    scheduleRuntimeStatePersist('match_removed');
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

    const msg = await thread.send(gameImagePayload).catch(() => null);
    if (msg) {
        block.gameImageMessageId = msg.id;
        logRatedInfo(client, match, 'game.image.posted', getMatchLogDetails(match, {
            game: nextGameNumber,
            message: msg.id
        }));
        logRatedInfo(client, match, 'match.output.image_sent', getMatchLogDetails(match, {
            game: nextGameNumber,
            message: msg.id
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
    if (!thread?.send) return;
    await deleteThreadMessage(thread, block.startMessageId);
    block.startMessageId = null;
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

// Arms the auto-randomize selection deadline for a pending pick WITHOUT any thread message.
// Pure state mutation (no thread I/O) so handlers and the watchdog can call it directly — the
// selection deadline no longer depends on a visible message existing.
function armSelectionTimeout(match, player, client) {
    const config = getSetupPromptConfig(player);
    if (!config || match?.stage !== 'awaiting_start' || match[config.selectedKey]) {
        return false;
    }
    // The match-level 'start' phase timeout must be (re)scheduled FIRST: scheduleMatchTimeout()
    // clears the selection timers, so arming the selection timer before it would be wiped.
    ensureMatchTimeoutScheduled(match, 'start', client);
    // Idempotent: keep a still-valid selection deadline rather than resetting it, so repeated
    // calls (re-open, watchdog) can't push the auto-randomize deadline forever forward.
    if (match[config.timerKey] && Number.isFinite(match[config.deadlineKey]) && match[config.deadlineKey] > Date.now()) {
        return false;
    }
    scheduleSelectionTimeout(match, player, client);
    return true;
}

function buildOpenPickButtonRow(match, player) {
    const config = getSetupPromptConfig(player);
    if (!config) {
        return [];
    }
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(openPrivatePickCustomId(match.id, player, getMatchActionToken(match, getNextGameNumber(match))))
                .setLabel(config.openButtonLabel)
                .setStyle(ButtonStyle.Primary)
        )
    ];
}

// Posts the neutral rep-gated "it's your turn — click to open your private pick" button for a
// single side, idempotently (edits the stored message instead of sending a duplicate). It never
// reveals the stadium/captain options. Used only when the private ephemeral could not be
// delivered (e.g. a winner rep with a stale interaction token) or during watchdog recovery.
async function postNeutralOpenButton(match, client, player, details = {}) {
    const config = getSetupPromptConfig(player);
    if (!config || match?.stage !== 'awaiting_start' || match[config.selectedKey]) {
        return null;
    }

    const thread = await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        logRatedWarn(client, match, 'setup.open_button.thread_missing', getMatchLogDetails(match, { player, ...details }));
        return null;
    }

    // Keep the auto-randomize deadline running so the neutral prompt's countdown is accurate
    // and the pick can never stall forever waiting on a click.
    armSelectionTimeout(match, player, client);

    const block = getOrCreateGameBlock(match);
    const payload = buildThreadTextPayload(config.renderOpenPrompt(match), 'line', {
        components: buildOpenPickButtonRow(match, player)
    });
    try {
        const message = await editOrSendRequiredThreadMessage(thread, block[config.openButtonIdKey], payload);
        block[config.openButtonIdKey] = message.id;
        block[config.deliveredKey] = false;
        logRatedInfo(client, match, 'setup.open_button.posted', getMatchLogDetails(match, {
            player,
            message: message.id,
            ...details
        }));
        return message;
    } catch (error) {
        logRatedError(client, match, 'setup.open_button.post_failed', error, getMatchLogDetails(match, {
            player,
            ...details
        }));
        return null;
    }
}

async function postNeutralOpenButtons(match, client, players, details = {}) {
    const uniquePlayers = [...new Set(players)].filter(player => player === 'home' || player === 'away');
    const posted = [];
    for (const player of uniquePlayers) {
        const message = await postNeutralOpenButton(match, client, player, details);
        if (message) {
            posted.push({ player, message });
        }
    }
    return posted;
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
            await deleteThreadMessage(thread, block.homeOpenButtonMessageId);
            block.homeOpenButtonMessageId = null;
            block.homeSelectionDelivered = false;
            logRatedWarn(client, match, 'setup.selection.auto_randomized', getMatchLogDetails(match, {
                kind: 'stadium',
                value: match.selectedStadium?.description
            }));
        } else if (player === 'away' && !match.selectedCaptain) {
            match.selectedCaptain = options.captains[Math.floor(Math.random() * options.captains.length)];
            match.awaySelectionTimer = null;
            match.awaySelectionDeadlineAt = null;
            await deleteThreadMessage(thread, block.awayOpenButtonMessageId);
            block.awayOpenButtonMessageId = null;
            block.awaySelectionDelivered = false;
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
            queueAdvanceMatchToWinnerControlAfterSelections(match, client, thread, 'auto_selection_timeout');
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
    await deleteThreadMessage(thread, block.homeOpenButtonMessageId);
    block.homeOpenButtonMessageId = null;
    block.homeSelectionDelivered = false;
    await deleteThreadMessage(thread, block.awayOpenButtonMessageId);
    block.awayOpenButtonMessageId = null;
    block.awaySelectionDelivered = false;
}

async function clearMatchNotifications(match) {
    if (!match.notificationInteractions) return;
    for (const interaction of match.notificationInteractions.values()) {
        try {
            await interaction.deleteReply();
        } catch { /* token expired — user can dismiss manually */ }
    }
}

// The one place a live match is torn down. The step order is load-bearing and is kept exactly as
// it was when this lived in cancelMatchForInactivity: setting stage='cancelled' is what makes the
// terminal guards in updateMatchControlMessage/postWinnerControl/reconcileActiveMatchControl no-op
// for workers that were already queued. Pass cancelReason: null when the DB row is already
// cancelled elsewhere (season end).
async function cancelMatch(match, client, {
    cancelReason = null,
    reasonMessage,
    closeReason,
    renameReason,
    source,
    logEvent = 'match.cancelled',
    logDetails = {}
}) {
    clearMatchTimers(match);
    const thread = await client.channels.fetch(match.threadId).catch(() => null);
    logRatedWarn(client, match, logEvent, getMatchLogDetails(match, logDetails));

    setMatchStage(match, 'cancelled', source);
    match.cancelReason = cancelReason;
    if (cancelReason && match.ratedMatchId) {
        // Not awaited, so a slow or unreachable DB never delays the thread notice; a transient
        // failure is retried from the pending-write queue instead of being lost.
        ratedMatchDao.cancelMatch({ matchCode: match.id, cancelReason })
            .catch(err => handleRatedMatchCancelFailure(match, client, cancelReason, err));
    }
    if (thread?.send) {
        await clearCurrentSetupComponents(match, thread);
    }
    await clearCurrentControlMessage(match, client, reasonMessage, thread);
    await postTerminalThreadNotice(thread, match, client, renderMatchCancelledNoticeMessage(), [], 'match.cancel_notice_failed');
    await clearMatchNotifications(match);
    removeMatchFromState(match);
    await finalizeThreadLifecycle(match, client, {
        prefix: CANCELLED_THREAD_PREFIX,
        closeReason,
        renameReason,
        result: 'cancelled',
        source
    });
}

function buildCancelMatchDbPayload(match, cancelReason) {
    return {
        ratedMatchId: match.ratedMatchId,
        matchCode: match.id,
        threadId: match.threadId,
        cancelReason
    };
}

function handleRatedMatchCancelFailure(match, client, cancelReason, err) {
    if (isTransientDbError(err)) {
        enqueueCompetitiveDbOp('cancel_match', buildCancelMatchDbPayload(match, cancelReason), match, client, 'transient_cancel_failure');
        return;
    }
    logRatedError(client, match, 'rated_match.cancel_failed', err, getMatchLogDetails(match));
}

async function cancelMatchForInactivity(match, phase, client) {
    await cancelMatch(match, client, {
        cancelReason: `inactivity_${phase}`,
        reasonMessage: renderInactivityCancelMessage(match, phase),
        closeReason: `${match.gameType} competitive match inactivity timeout`,
        renameReason: `${match.gameType} competitive match inactivity rename`,
        source: 'cancel_inactivity',
        logDetails: { reason: 'inactivity', phase }
    });
}

function renderMatchCancelledNoticeMessage() {
    return quoteThreadLines(`${BL_X_EMOJI} **MATCH CANCELLED.**`);
}

function getMatchMemberIds(match) {
    return (match?.teams ?? []).flatMap(team => team.memberIds ?? []);
}

// The cancel vote is scoped to the game currently on screen: a vote left over from game 1 must not
// combine with a vote from game 3 into a cancel nobody wants any more. Returns the now-orphaned
// tally message id when the scope moved on, so the caller can clear it out of the thread.
function resetCancelVotesOnGameChange(match, gameNumber) {
    if (match.cancelVoteGameNumber === gameNumber) {
        return null;
    }

    const staleMessageId = match.cancelVoteMessageId;
    match.cancelVoteGameNumber = gameNumber;
    match.cancelVoteUserIds = [];
    match.cancelVoteMessageId = null;
    return staleMessageId;
}

function renderCancelVoteStatusMessage(match) {
    const memberIds = getMatchMemberIds(match);
    const votedIds = match.cancelVoteUserIds ?? [];
    const pendingMentions = memberIds
        .filter(memberId => !votedIds.includes(memberId))
        .map(memberId => `<@${memberId}>`);

    return quoteThreadBlock(
        `${BL_TIME_EMOJI} **CANCEL MATCH: ${votedIds.length}/${memberIds.length} AGREED.**\n` +
        `Still waiting for ${pendingMentions.join(', ')}.\n` +
        'The match only ends once everyone agrees. Press **Cancel Match** again to take your vote back.'
    );
}

function renderPlayerVoteCancelMessage(match) {
    return quoteThreadBlock(
        `All ${getMatchMemberIds(match).length} players agreed to cancel.\n` +
        "The match was ended early at the players' request."
    );
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

async function postInitialGameSetup(match, client) {
    // Guard against concurrent runs: match creation posts the initial setup
    // directly while the periodic reconcile watchdog can also fire before the
    // welcome/start message IDs are recorded — that race posted the welcome+rules
    // twice. The flag is set synchronously, so the second overlapping call bails
    // before any thread.send. In-memory only; sequential recovery still works via
    // the existing !rulesImageMessageId guard.
    if (match.initialGameSetupInFlight) {
        return;
    }
    match.initialGameSetupInFlight = true;
    try {
        return await postInitialGameSetupInner(match, client);
    } finally {
        match.initialGameSetupInFlight = false;
    }
}

async function postInitialGameSetupInner(match, client) {
    const thread = await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        logRatedWarn(client, match, 'setup.initial.skipped', getMatchLogDetails(match, { reason: 'thread_missing' }));
        return;
    }

    const shouldScheduleStartTimeout = requiresSetup(match.gameType);
    if (shouldScheduleStartTimeout && match.timeoutPhase !== 'start') {
        clearMatchTimers(match);
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
            const msg = await editOrSendRequiredThreadMessage(thread, block.startMessageId, item.payload);
            block.startMessageId = msg.id;
            const timerStarted = shouldScheduleStartTimeout
                ? ensureMatchTimeoutScheduled(match, 'start', client)
                : false;
            if (timerStarted && msg?.edit) {
                await msg.edit(quoteThreadPayload(buildStartPayload(match))).catch(error => {
                    logRatedWarn(client, match, 'setup.start_control.deadline_refresh_failed', getMatchLogDetails(match, {
                        message: msg.id,
                        error: error.message
                    }));
                });
            }
            logRatedInfo(client, match, 'setup.start_control.posted', getMatchLogDetails(match, { message: msg.id }));
        }
    }
}

// Output worker for a game whose stadium and captain are set; the stage is already
// awaiting_winner when it is queued. It runs outside the match lock, so it must never move the
// stage itself: a win reported (or a cancel) while it waits would otherwise be undone.
async function advanceMatchToWinnerControlAfterSelections(match, client, thread = null) {
    if (match.stage !== 'awaiting_winner') {
        logRatedInfo(client, match, 'match.output.stale_winner_control_skipped', getMatchLogDetails(match));
        return;
    }
    thread ??= await client.channels.fetch(match.threadId).catch(() => null);
    const block = getOrCreateGameBlock(match);

    await postDelayedGameResultIfMissing(match, client, thread);
    await postGameImageIfMissing(match, client, thread);

    if (requiresSetup(match.gameType) && thread?.send && !block.selectionsMessageId) {
        const confMsg = await thread.send(buildThreadTextPayload(renderCombinedSelectionsMessage(match), 'line', { components: [] })).catch(() => null);
        if (confMsg) block.selectionsMessageId = confMsg.id;
        if (confMsg) {
            logRatedInfo(client, match, 'setup.selections.posted', getMatchLogDetails(match, { message: confMsg.id }));
            logRatedInfo(client, match, 'match.output.selection_message_sent', getMatchLogDetails(match, { message: confMsg.id }));
        }
    }

    if (match.stage !== 'awaiting_winner') {
        logRatedInfo(client, match, 'match.output.stale_winner_control_skipped', getMatchLogDetails(match));
        return;
    }
    if (thread) await clearStartButtonComponents(thread, block);
    await postWinnerControl(match, client, thread);
}

function queueAdvanceMatchToWinnerControlAfterSelections(match, client, thread = null, source = 'manual_selection') {
    setMatchStage(match, 'awaiting_winner', source);
    return queueMatchOutput(match, client, 'advance_to_winner_control_after_selections', async () => {
        await advanceMatchToWinnerControlAfterSelections(match, client, thread);
    }, {
        source,
        required: true,
        game: getNextGameNumber(match)
    });
}

async function postWinnerControl(match, client, thread = null) {
    // Never render the game control for a terminal match (defense-in-depth against a racing
    // worker firing after cancel/complete — see updateMatchControlMessage).
    if (match.stage === 'cancelled' || match.stage === 'complete') {
        return;
    }
    thread ??= await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        return;
    }

    if (match.timeoutPhase !== 'game') {
        clearMatchTimers(match);
    }
    const options = await getOptionsForGameType(match.gameType);

    const payload = {
        content: renderMatchControlContent(match),
        components: buildMatchComponents(match, options)
    };
    const controlMessage = await editOrSendRequiredThreadMessage(thread, match.controlMessageId, payload);
    match.controlMessageId = controlMessage.id;
    const timerStarted = ensureMatchTimeoutScheduled(match, 'game', client);
    if (timerStarted && controlMessage?.edit) {
        const timedPayload = {
            content: renderMatchControlContent(match),
            components: buildMatchComponents(match, options)
        };
        await controlMessage.edit(quoteThreadPayload(timedPayload)).catch(error => {
            logRatedWarn(client, match, 'control.winner.deadline_refresh_failed', getMatchLogDetails(match, {
                game: getNextGameNumber(match),
                message: controlMessage.id,
                error: error.message
            }));
        });
    }
    logRatedInfo(client, match, 'control.winner.posted', getMatchLogDetails(match, {
        game: getNextGameNumber(match),
        message: controlMessage.id
    }));
    logRatedInfo(client, match, 'match.output.control_sent', getMatchLogDetails(match, {
        phase: 'game',
        game: getNextGameNumber(match),
        message: controlMessage.id
    }));
}

function getLoserControlTimeoutPhase(match) {
    if (match.stage !== 'awaiting_loser_confirmation') {
        return null;
    }
    return requiresSetup(match.gameType) && match.loserAdvantagePromptShown
        ? 'loser_advantage'
        : 'loser_confirmation';
}

async function updateMatchControlMessage(match, client, thread = null) {
    // A cancelled/complete match must never (re)render a control message. Its terminal notice
    // ("MATCH CANCELLED." / the completion embed) is posted separately and the control message is
    // already cleared — without this guard a reconcile/output-queue worker that was queued while
    // the match was still live can run after cancellation and edit the control to the stale
    // "MATCH COMPLETE!" fallback (renderMatchControlContent), which makes no sense on a cancel.
    if (match.stage === 'cancelled' || match.stage === 'complete') {
        return;
    }
    if (match.stage === 'awaiting_start') {
        await postInitialGameSetup(match, client);
        return;
    }

    if (match.stage === 'awaiting_winner') {
        await postWinnerControl(match, client);
        return;
    }

    thread ??= await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        return;
    }

    const timeoutPhase = getLoserControlTimeoutPhase(match);
    if (timeoutPhase && match.timeoutPhase !== timeoutPhase) {
        clearMatchTimers(match);
    }

    const options = await getOptionsForGameType(match.gameType);
    const payload = {
        content: renderMatchControlContent(match),
        components: buildMatchComponents(match, options)
    };
    const controlMessage = await editOrSendRequiredThreadMessage(thread, match.controlMessageId, payload);
    match.controlMessageId = controlMessage.id;
    const timerStarted = timeoutPhase
        ? ensureMatchTimeoutScheduled(match, timeoutPhase, client)
        : false;
    if (timerStarted && controlMessage?.edit) {
        const timedPayload = {
            content: renderMatchControlContent(match),
            components: buildMatchComponents(match, options)
        };
        await controlMessage.edit(quoteThreadPayload(timedPayload)).catch(error => {
            logRatedWarn(client, match, 'control.loser_confirmation.deadline_refresh_failed', getMatchLogDetails(match, {
                message: controlMessage.id,
                error: error.message
            }));
        });
    }
    if (timeoutPhase) {
        logRatedInfo(client, match, 'match.output.control_sent', getMatchLogDetails(match, {
            phase: timeoutPhase,
            game: getPendingResultGameNumber(match),
            message: controlMessage.id
        }));
    }
}

function clearCurrentControlMessageBestEffort(match, client, thread = null, reason = 'cleanup') {
    const controlMessageId = match?.controlMessageId;
    if (!controlMessageId) {
        return;
    }

    match.controlMessageId = null;
    const cleanupSnapshot = {
        ...match,
        controlMessageId
    };
    clearCurrentControlMessage(cleanupSnapshot, client, null, thread).catch(error => {
        logRatedWarn(client, match, 'control.cleanup_failed', getMatchLogDetails(match, {
            reason,
            message: controlMessageId,
            error: error.message
        }));
    });
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
        await ratedMatchDao.recordGame(buildRecordGameDbPayload(match, confirmedByDiscordId));
        match.competitiveDbFailed = false;
        return true;
    } catch (err) {
        if (isTransientDbError(err)) {
            enqueueCompetitiveDbOp(
                'record_game',
                buildRecordGameDbPayload(match, confirmedByDiscordId),
                match,
                client,
                'transient_record_game_failure'
            );
            logRatedWarn(client, match, 'rated_match.game_record_pending', getMatchLogDetails(match, {
                game: match.pendingResult.gameNumber,
                error: err.message
            }));
            await postCompetitiveDbPendingNotice(match, client);
            return true;
        }

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

async function finishMatchWithCompetitiveDbPending(match, winnerMention, client, thread, completedThreadName, winnerTeamNumber) {
    const op = enqueueCompetitiveDbOp(
        'complete_competitive',
        buildCompleteCompetitiveDbPayload(match, winnerTeamNumber),
        match,
        client,
        'pending_game_or_transient_completion_dependency'
    );
    const finalResultMessage = await clearCurrentControlMessage(
        match,
        client,
        await renderFinalMatchResultMessage(winnerMention, match, null),
        thread,
        []
    );
    const pendingNoticeMessage = await postTerminalThreadNotice(
        thread,
        match,
        client,
        `${BL_TIME_EMOJI} **Competitive DB sync pending.** Results are saved for retry and Competitive ELO will be synced automatically when the database is reachable again.`,
        buildFinalMatchComponents(match),
        'competitive_db.final_pending_notice_failed'
    );
    const completionMessage = pendingNoticeMessage ?? finalResultMessage;
    storeReportableMatch(match, completedThreadName, completionMessage?.id ?? null);
    logRatedWarn(client, match, 'match.complete_pending_competitive_db', getMatchLogDetails(match, {
        op: op.key,
        message: completionMessage?.id
    }));
    await clearMatchNotifications(match);
    removeMatchFromState(match);
    scheduleCompletedThreadClose(match, client);
}

async function completeMatch(match, winnerMention, client) {
    if (match.stage === 'complete') return;
    setMatchStage(match, 'complete', 'match_decided');
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

    if (reportableMatch && hasPendingCompetitiveDbOpsForMatch(match)) {
        await finishMatchWithCompetitiveDbPending(match, winnerMention, client, thread, completedThreadName, winnerTeamNumber);
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
            if (isTransientDbError(err)) {
                await finishMatchWithCompetitiveDbPending(match, winnerMention, client, thread, completedThreadName, winnerTeamNumber);
                return;
            }
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
    }

    const hasCompetitiveSummary = Array.isArray(competitiveResult?.changes) && competitiveResult.changes.length > 0;
    const finalResultMessage = await clearCurrentControlMessage(
        match,
        client,
        await renderFinalMatchResultMessage(winnerMention, match, competitiveResult),
        thread,
        []
    );
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
    setMatchStage(match, 'awaiting_loser_confirmation', 'game_win_reported');

    if (!requiresSetup(match.gameType)) {
        interaction.deleteReply().catch(error => {
            logRatedWarn(interaction.client, match, 'game.win_private_cleanup_failed', getMatchLogDetails(match, {
                game: completedGameNumber,
                error: error.message
            }));
        });
        queueMatchOutput(match, interaction.client, 'post_loss_confirmation_control_after_win', async () => {
            await updateMatchControlMessage(match, interaction.client);
        }, {
            source: 'winner_selection_no_setup',
            required: true,
            game: completedGameNumber
        });
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

    queueMatchOutput(match, interaction.client, 'post_loss_confirmation_control_after_win', async () => {
        await updateMatchControlMessage(match, interaction.client);
    }, {
        source: 'winner_selection',
        required: true,
        game: completedGameNumber
    });
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

    // loserAdvantagePromptShown doubles as "this game's result is recorded": it is set only after
    // recordConfirmedGameResult succeeded, so a failed write leaves the confirmation retryable
    // instead of letting the timeout path skip the write.
    if (!requiresSetup(match.gameType)) {
        await ensureDeferredReply(interaction);
        const confirmedGameNumber = pendingGameNumber;
        const isMatchComplete = isMatchDecided(match);
        if (isMatchComplete) {
            const winnerMention = getPendingResultWinnerMention(match);
            if (!await recordConfirmedGameResult(match, interaction.client, interaction.user.id)) {
                await interaction.deleteReply().catch(() => {});
                return;
            }
            match.loserAdvantagePromptShown = true;
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
        if (!await recordConfirmedGameResult(match, interaction.client, interaction.user.id)) {
            await interaction.deleteReply().catch(() => {});
            return;
        }
        match.loserAdvantagePromptShown = true;
        clearPendingResult(match);
        match.startClickedUserIds = [];
        setMatchStage(match, 'awaiting_winner', 'loss_confirmed_no_setup');
        logRatedInfo(interaction.client, match, 'game.loss_confirmed', getMatchLogDetails(match, {
            game: confirmedGameNumber,
            loser: interaction.user.id
        }));
        interaction.deleteReply().catch(error => {
            logRatedWarn(interaction.client, match, 'game.loss_confirm_private_cleanup_failed', getMatchLogDetails(match, {
                game: confirmedGameNumber,
                error: error.message
            }));
        });
        queueMatchOutput(match, interaction.client, 'advance_no_setup_after_loss_confirm', async () => {
            const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
            await clearCurrentControlMessage(match, interaction.client, confirmedResultMessage, thread);
            logRatedInfo(interaction.client, match, 'game.result.posted', getMatchLogDetails(match, {
                game: confirmedGameNumber,
                mode: 'no_setup'
            }));
            await postGameImageIfMissing(match, interaction.client, thread);
            await postWinnerControl(match, interaction.client, thread);
        }, {
            source: 'loss_confirm_no_setup',
            required: true,
            game: confirmedGameNumber
        });
        return;
    }

    await ensureDeferredReply(interaction);
    const loserTeamIndex = getPendingResultLoserTeamIndex(match);
    const confirmedGameNumber = pendingGameNumber;
    const isMatchComplete = isMatchDecided(match);
    if (isMatchComplete) {
        const winnerMention = getPendingResultWinnerMention(match);
        if (!await recordConfirmedGameResult(match, interaction.client, interaction.user.id)) {
            await interaction.deleteReply().catch(() => {});
            return;
        }
        match.loserAdvantagePromptShown = true;
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

    if (!await recordConfirmedGameResult(match, interaction.client, interaction.user.id)) {
        await interaction.deleteReply().catch(() => {});
        return;
    }
    clearMatchTimers(match);
    const advantagePromptContent = renderTimedMessage(
        'Choose your advantage for the next game:',
        match.timeoutDeadlineAt,
        `${LOSER_CHOICE_TIMEOUT_MINUTES} minutes`
    );
    const advantageComponents = buildLoserAdvantageComponents(match, confirmedGameNumber);

    const prompt = await deliverPrivateInteractionPayload(interaction, {
        content: advantagePromptContent,
        components: advantageComponents
    }, 'loser advantage prompt');

    storeDelayedGameResult(match, confirmedGameNumber, getPendingResultWinnerMention(match));
    match.loserAdvantagePromptShown = true;
    await replaceWinnerWaitingPrompt(match, {
        content: '⏳ Waiting for your opponent to choose the next-game advantage...',
        components: []
    }, 'winner waiting advantage message');

    queueMatchOutput(match, interaction.client, 'post_loser_advantage_control_after_loss_confirm', async () => {
        const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
        await updateMatchControlMessage(match, interaction.client, thread);
        if (prompt?.edit) {
            await prompt.edit({
                content: renderTimedMessage(
                    'Choose your advantage for the next game:',
                    match.timeoutDeadlineAt,
                    `${LOSER_CHOICE_TIMEOUT_MINUTES} minutes`
                ),
                components: advantageComponents
            }).catch(error => {
                logRatedWarn(interaction.client, match, 'game.advantage_prompt.deadline_refresh_failed', getMatchLogDetails(match, {
                    game: confirmedGameNumber,
                    error: error.message
                }));
            });
        }
    }, {
        source: 'loss_confirm',
        required: true,
        game: confirmedGameNumber
    });

    if (prompt) {
        logRatedInfo(interaction.client, match, 'game.advantage_prompt.posted', getMatchLogDetails(match, {
            loser: interaction.user.id,
            loserTeam: loserTeamIndex,
            fallback: 'thread_advantage_control'
        }));
    } else {
        logRatedWarn(interaction.client, match, 'game.advantage_prompt.private_failed', getMatchLogDetails(match, {
            game: confirmedGameNumber,
            loser: interaction.user.id,
            fallback: 'thread_advantage_control'
        }));
    }
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
    setMatchStage(match, 'awaiting_start', 'advantage_chosen');
    clearMatchTimers(match);

    const loserSelectionPlayer = choice === 'home' ? 'home' : 'away';
    const winnerSelectionPlayer = choice === 'home' ? 'away' : 'home';
    const loserPlayerConfig = getSetupPromptConfig(loserSelectionPlayer);
    const winnerPlayerConfig = getSetupPromptConfig(winnerSelectionPlayer);

    const block = getOrCreateGameBlock(match);
    const loserPayload = {
        content: loserPlayerConfig.renderPrompt(match),
        components: loserPlayerConfig.buildRows(match, options)
    };
    const winnerPayload = {
        content: winnerPlayerConfig.renderPrompt(match),
        components: winnerPlayerConfig.buildRows(match, options)
    };
    // Arm the auto-randomize deadlines for BOTH sides (after rendering the payloads) so neither
    // pick can stall — even if a private prompt fails and only the neutral open button remains.
    armSelectionTimeout(match, loserSelectionPlayer, interaction.client);
    armSelectionTimeout(match, winnerSelectionPlayer, interaction.client);

    // Loser rep always has a fresh live interaction (they just clicked advantage) → ephemeral.
    const loserPrompt = await deliverPrivateInteractionPayload(interaction, loserPayload, 'loser private setup');
    block[loserPlayerConfig.deliveredKey] = Boolean(loserPrompt);
    if (!loserPrompt) {
        logRatedWarn(interaction.client, match, 'setup.private_loser_delivery_failed', getMatchLogDetails(match, {
            game: confirmedGameNumber,
            loser: loserRepId,
            fallback: 'neutral_open_button'
        }));
    }

    // Winner rep only has a stored interaction (its token may be expired) → may need the button.
    const winnerPrompt = await deliverPrivateInteractionPayload(
        getPrivateDeliveryInteraction(match, winnerRepId),
        winnerPayload,
        'winner private setup'
    );
    block[winnerPlayerConfig.deliveredKey] = Boolean(winnerPrompt);
    if (!winnerPrompt) {
        logRatedWarn(interaction.client, match, 'setup.private_winner_delivery_failed', getMatchLogDetails(match, {
            game: confirmedGameNumber,
            winner: winnerRepId,
            fallback: 'neutral_open_button'
        }));
    }

    match.loserTeamIndex = null;
    match.loserRepMention = null;
    queueMatchOutput(match, interaction.client, 'cleanup_current_control_after_advantage_choice', async () => {
        clearCurrentControlMessageBestEffort(match, interaction.client, null, 'advantage_choice');
    }, {
        source: 'advantage_choice',
        game: confirmedGameNumber
    });

    // Strictly private: only post the neutral, rep-gated "open your pick" button for a side
    // whose ephemeral could not be delivered. Never leak the options publicly.
    const owedPlayers = [];
    if (!loserPrompt) { owedPlayers.push(loserSelectionPlayer); }
    if (!winnerPrompt) { owedPlayers.push(winnerSelectionPlayer); }
    if (owedPlayers.length) {
        queueMatchOutput(match, interaction.client, 'post_neutral_open_buttons_after_advantage', async () => {
            await postNeutralOpenButtons(match, interaction.client, owedPlayers, {
                source: 'advantage_choice',
                choice,
                game: confirmedGameNumber
            });
        }, {
            source: 'advantage_choice',
            required: true,
            choice,
            game: confirmedGameNumber
        });
    }
    logRatedInfo(interaction.client, match, 'game.advantage.chosen', getMatchLogDetails(match, {
        game: confirmedGameNumber,
        loser: interaction.user.id,
        choice
    }));
    logRatedInfo(interaction.client, match, 'setup.private_controls.posted', getMatchLogDetails(match, {
        loserPrompt: loserPrompt?.id,
        winnerPrompt: winnerPrompt?.id,
        fallback: 'neutral_open_button'
    }));
}

async function resolveLoserConfirmationIfTimedOut(matchId, phase, client) {
    const match = state.activeMatchesById.get(matchId);
    if (!match || match.timeoutPhase !== phase || Date.now() < match.timeoutDeadlineAt) return;
    if (match.stage !== 'awaiting_loser_confirmation') return;

    const lockKey = `match:${matchId}`;
    await withOperationQueue(lockKey, async () => {
        if (!state.activeMatchesById.has(matchId) || match.stage !== 'awaiting_loser_confirmation') return;
        const advantagePromptAlreadyShown = phase === 'loser_advantage' || match.loserAdvantagePromptShown;
        if (phase === 'loser_advantage' && !match.loserAdvantagePromptShown) return;

        if (!requiresSetup(match.gameType)) {
            const loserMention = match.teams[match.loserTeamIndex - 1].repMention;
            const timedOutGameNumber = getPendingResultGameNumber(match);
            const isMatchComplete = isMatchDecided(match);
            if (isMatchComplete) {
                const winnerMention = getPendingResultWinnerMention(match);
                if (!await recordConfirmedGameResult(match, client, null)) return;
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
            if (!await recordConfirmedGameResult(match, client, null)) return;
            clearPendingResult(match);
            match.loserAdvantagePromptShown = false;
            match.startClickedUserIds = [];
            setMatchStage(match, 'awaiting_winner', 'loss_confirm_timeout_no_setup');
            logRatedWarn(client, match, 'game.loss_confirm_timeout', getMatchLogDetails(match, {
                game: timedOutGameNumber
            }));
            queueMatchOutput(match, client, 'advance_no_setup_after_loss_confirm_timeout', async () => {
                const thread = await client.channels.fetch(match.threadId).catch(() => null);
                await clearCurrentControlMessage(match, client, timeoutResultMessage, thread);
                await postGameImageIfMissing(match, client, thread);
                await postWinnerControl(match, client, thread);
            }, {
                source: 'loss_confirm_timeout_no_setup',
                game: timedOutGameNumber
            });
            return;
        }

        // If the just-confirmed game already decided the match (someone reached firstTo),
        // complete it here instead of advancing to another game. This mirrors the no-setup
        // branch above and the normal handleLoserConfirm path; without it, a loser timing out
        // on the deciding game's confirmation wrongly serves an extra game (e.g. Bo3 going to
        // Game 3 at 2-0).
        const isMatchComplete = isMatchDecided(match);
        if (!advantagePromptAlreadyShown && isMatchComplete) {
            const completedGameNumber = getPendingResultGameNumber(match);
            const winnerMention = getPendingResultWinnerMention(match);
            await clearWinnerWaitingPrompt(match);
            if (!await recordConfirmedGameResult(match, client, null)) return;
            clearPendingResult(match);
            match.loserAdvantagePromptShown = true;
            await completeMatch(match, winnerMention, client);
            logRatedWarn(client, match, 'game.loss_confirm_timeout', getMatchLogDetails(match, {
                game: completedGameNumber,
                result: 'completed'
            }));
            return;
        }

        const options = await getOptionsForGameType(match.gameType);
        const choice = Math.random() >= 0.5 ? 'home' : 'captain';
        const nextSides = applyLoserChoice(match.homeTeamIndex, match.loserTeamIndex, choice);
        const timedOutGameNumber = getPendingResultGameNumber(match);
        const winnerMention = getPendingResultWinnerMention(match);
        const randomStadium = options.stadiums[Math.floor(Math.random() * options.stadiums.length)];
        const randomCaptain = options.captains[Math.floor(Math.random() * options.captains.length)];
        await clearWinnerWaitingPrompt(match);
        // Sides and picks for the next game change only once the timed-out game is recorded; a
        // failed write leaves the match as it was, so the next attempt cannot swap twice.
        if (!advantagePromptAlreadyShown && !await recordConfirmedGameResult(match, client, null)) return;
        match.homeTeamIndex = nextSides.homeTeamIndex;
        match.awayTeamIndex = nextSides.awayTeamIndex;
        match.selectedStadium = randomStadium;
        match.selectedCaptain = randomCaptain;
        storeDelayedGameResult(match, timedOutGameNumber, winnerMention);
        clearPendingResult(match);
        match.loserAdvantagePromptShown = false;
        match.startClickedUserIds = [];
        setMatchStage(match, 'awaiting_winner', 'advantage_timeout');
        logRatedWarn(client, match, 'game.advantage_timeout', getMatchLogDetails(match, {
            game: timedOutGameNumber,
            choice,
            stadium: match.selectedStadium?.description,
            captain: match.selectedCaptain?.description
        }));
        queueMatchOutput(match, client, 'advance_to_winner_control_after_advantage_timeout', async () => {
            const thread = await client.channels.fetch(match.threadId).catch(() => null);
            clearCurrentControlMessageBestEffort(match, client, thread, 'advantage_timeout');
            await postDelayedGameResultIfMissing(match, client, thread);
            await postGameImageIfMissing(match, client, thread);
            const block = getOrCreateGameBlock(match);
            if (thread?.send && !block.selectionsMessageId) {
                const confMsg = await thread.send(buildThreadTextPayload(renderCombinedSelectionsMessage(match), 'line', { components: [] })).catch(() => null);
                if (confMsg) {
                    block.selectionsMessageId = confMsg.id;
                    logRatedInfo(client, match, 'match.output.selection_message_sent', getMatchLogDetails(match, { message: confMsg.id }));
                }
            }
            await postWinnerControl(match, client, thread);
        }, {
            source: 'advantage_timeout',
            required: true,
            game: timedOutGameNumber
        });
    });
}

function getSetupPickConfig(kind) {
    if (kind === 'stadium') {
        return {
            player: 'home',
            selectedKey: 'selectedStadium',
            otherSelectedKey: 'selectedCaptain',
            optionsKey: 'stadiums',
            teamIndexKey: 'homeTeamIndex',
            timerKey: 'homeSelectionTimer',
            deadlineKey: 'homeSelectionDeadlineAt',
            openButtonIdKey: 'homeOpenButtonMessageId',
            deliveredKey: 'homeSelectionDelivered',
            invalidMessage: 'Invalid stadium selection.',
            permissionMessage: mode => mode === '1v1'
                ? 'Only the **HOME** player may choose the stadium.'
                : 'Only the **HOME** team representative may choose the stadium.'
        };
    }

    return {
        player: 'away',
        selectedKey: 'selectedCaptain',
        otherSelectedKey: 'selectedStadium',
        optionsKey: 'captains',
        teamIndexKey: 'awayTeamIndex',
        timerKey: 'awaySelectionTimer',
        deadlineKey: 'awaySelectionDeadlineAt',
        openButtonIdKey: 'awayOpenButtonMessageId',
        deliveredKey: 'awaySelectionDelivered',
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
        await safeFollowUp(interaction, {
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
        value: selectedOption.description,
        source: 'manual'
    }));
    logRatedInfo(interaction.client, match, 'setup.selection.state_saved', getMatchLogDetails(match, {
        user: interaction.user.id,
        kind,
        value: selectedOption.description
    }));

    if (match[config.timerKey]) {
        clearTimeout(match[config.timerKey]);
        match[config.timerKey] = null;
        match[config.deadlineKey] = null;
    }

    const block = getOrCreateGameBlock(match);
    // The neutral "open your pick" button (if one was posted as a delivery fallback) is now
    // resolved — drop its id and mark the side no longer owed so the watchdog won't restore it.
    const selectedOpenButtonId = block[config.openButtonIdKey];
    block[config.openButtonIdKey] = null;
    block[config.deliveredKey] = false;

    if (match[config.otherSelectedKey]) {
        setMatchStage(match, 'awaiting_winner', 'selections_complete');
        queueMatchOutput(match, interaction.client, 'advance_to_winner_control_after_manual_selection', async () => {
            const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
            if (selectedOpenButtonId) {
                await deleteThreadMessage(thread, selectedOpenButtonId);
            }
            await advanceMatchToWinnerControlAfterSelections(match, interaction.client, thread);
        }, {
            source: 'manual_selection',
            required: true,
            kind,
            game: getNextGameNumber(match)
        });
    } else if (selectedOpenButtonId) {
        queueMatchOutput(match, interaction.client, 'cleanup_setup_selection_prompt', async () => {
            const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
            await deleteThreadMessage(thread, selectedOpenButtonId);
        }, {
            source: 'manual_selection',
            kind
        });
    }

    interaction.deleteReply().catch(error => {
        logRatedWarn(interaction.client, match, 'setup.selection_private_cleanup_failed', getMatchLogDetails(match, {
            user: interaction.user.id,
            kind,
            error: error.message
        }));
    });
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

    if (!Array.isArray(match.startClickedUserIds)) {
        match.startClickedUserIds = [];
    }
    if (!match.startClickedUserIds.includes(config.repId)) {
        match.startClickedUserIds.push(config.repId);
    }

    // The rep clicking Start has a live interaction → deliver their selection privately. No public
    // selection prompt is posted; the neutral open button is used only if the ephemeral fails.
    const deliveredKey = getSetupPromptConfig(config.player)?.deliveredKey;
    const privatePrompt = await deliverPrivateInteractionPayload(interaction, {
        content: config.renderPrompt(match),
        components: config.buildRows(match, options)
    }, `${config.player} start setup`);
    // Arm the auto-randomize deadline after rendering so the pick can't stall on a missed click.
    armSelectionTimeout(match, config.player, interaction.client);
    if (deliveredKey) {
        block[deliveredKey] = Boolean(privatePrompt);
    }
    if (!privatePrompt) {
        logRatedWarn(interaction.client, match, 'setup.start_retry_required', getMatchLogDetails(match, {
            user: interaction.user.id,
            player: config.player,
            fallback: 'neutral_open_button'
        }));
        queueMatchOutput(match, interaction.client, 'post_neutral_open_button_after_start', async () => {
            await postNeutralOpenButton(match, interaction.client, config.player, {
                source: 'start_click',
                player: config.player,
                user: interaction.user.id,
                game: getNextGameNumber(match)
            });
        }, {
            source: 'start_click',
            required: true,
            player: config.player,
            game: getNextGameNumber(match)
        });
    }
    logRatedInfo(interaction.client, match, 'setup.start.clicked', getMatchLogDetails(match, {
        user: interaction.user.id,
        player: config.player
    }));

    if (match.startClickedUserIds.includes(config.otherRepId) && !block.gameImageMessageId) {
        queueMatchOutput(match, interaction.client, 'post_start_gate_game_image', async () => {
            const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
            await clearStartButtonComponents(thread, block);
            await postGameImageIfMissing(match, interaction.client, thread);
            logRatedInfo(interaction.client, match, 'setup.start_gate.complete', getMatchLogDetails(match, {
                game: getNextGameNumber(match)
            }));
        }, {
            source: 'start_gate',
            game: getNextGameNumber(match)
        });
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

// Cancelling is unanimous by design - a single vote never ends a match. Membership is checked
// against every team member rather than the reps, because in 2v2 the teammates have to be able to
// agree as well; that is deliberately a wider gate than "Start Match", which stays rep-only.
async function handleCancelMatchButton(interaction, match) {
    if (match.stage === 'complete' || match.stage === 'cancelled') {
        await ignoreMatchInteraction(interaction, match, 'match.cancel_vote_ignored', 'terminal_stage', {}, { deleteReply: true });
        return;
    }

    // MSC and SMS carry the button on the start gate, MSBL on the game control - it has no gate.
    const expectedStage = requiresSetup(match.gameType) ? 'awaiting_start' : 'awaiting_winner';
    if (!hasExpectedMatchStageAndToken(match, interaction, expectedStage)) {
        await ignoreMatchInteraction(interaction, match, 'match.cancel_vote_ignored', 'stale_or_wrong_stage', {}, { deleteReply: true });
        return;
    }

    const memberIds = getMatchMemberIds(match);
    if (!memberIds.includes(interaction.user.id)) {
        await safeReply(interaction, { content: CANCEL_VOTE_PERMISSION_MESSAGE, ephemeral: true });
        return;
    }

    const gameNumber = getNextGameNumber(match);
    const staleVoteMessageId = resetCancelVotesOnGameChange(match, gameNumber);
    const withdrawn = match.cancelVoteUserIds.includes(interaction.user.id);
    match.cancelVoteUserIds = withdrawn
        ? match.cancelVoteUserIds.filter(userId => userId !== interaction.user.id)
        : [...match.cancelVoteUserIds, interaction.user.id];

    const voteCount = match.cancelVoteUserIds.length;
    logRatedInfo(interaction.client, match, 'match.cancel_vote', getMatchLogDetails(match, {
        user: interaction.user.id,
        withdrawn,
        votes: voteCount,
        required: memberIds.length,
        game: gameNumber
    }));

    if (voteCount >= memberIds.length) {
        // Cancel directly instead of going through cancelMatchIfTimedOut: this handler already
        // holds match:<id> and withOperationQueue is not reentrant.
        const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
        await deleteThreadMessage(thread, staleVoteMessageId);
        await deleteThreadMessage(thread, match.cancelVoteMessageId);
        match.cancelVoteMessageId = null;
        await safeReply(interaction, { content: CANCEL_VOTE_COMPLETE_MESSAGE, ephemeral: true });
        await cancelMatch(match, interaction.client, {
            cancelReason: 'player_vote',
            reasonMessage: renderPlayerVoteCancelMessage(match),
            closeReason: `${match.gameType} competitive match cancelled by players`,
            renameReason: `${match.gameType} competitive match player cancel rename`,
            source: 'player_vote',
            logDetails: { reason: 'player_vote', votes: voteCount, game: gameNumber }
        });
        return;
    }

    await safeReply(interaction, {
        content: withdrawn
            ? `Cancel vote withdrawn. ${voteCount}/${memberIds.length} still want to cancel.`
            : `Cancel vote recorded: ${voteCount}/${memberIds.length}. The match ends once everyone agrees.`,
        ephemeral: true
    });

    // Own thread message, never the start or control message: those are watchdog-managed and an
    // edit here would fight the controlVersion tokens.
    queueMatchOutput(match, interaction.client, 'render_cancel_vote_status', async () => {
        if (match.stage === 'complete' || match.stage === 'cancelled') {
            return;
        }

        const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
        if (!thread?.send) {
            return;
        }

        await deleteThreadMessage(thread, staleVoteMessageId);
        if (!match.cancelVoteUserIds.length) {
            await deleteThreadMessage(thread, match.cancelVoteMessageId);
            match.cancelVoteMessageId = null;
            return;
        }

        const statusMessage = await editOrSendThreadMessage(thread, match.cancelVoteMessageId, {
            content: renderCancelVoteStatusMessage(match)
        });
        match.cancelVoteMessageId = statusMessage?.id ?? null;
    }, {
        source: 'cancel_vote',
        game: gameNumber,
        votes: voteCount
    });
}

// Handles a click on the neutral rep-gated "Choose Stadium/Captain" button. It opens the actual
// options as a fresh private ephemeral (the immediate ack reply is edited into the options), so
// the choice is never shown to anyone but the correct rep.
async function handleOpenPrivatePick(interaction, match) {
    if (!hasExpectedMatchStageAndToken(match, interaction, 'awaiting_start')) {
        await ignoreMatchInteraction(interaction, match, 'setup.openpick_ignored', 'stale_or_wrong_stage', {}, { deleteReply: true });
        return;
    }

    const config = getSetupSelectionConfig(match, interaction.user.id);
    const requestedPlayer = parseOpenPickPlayerFromCustomId(interaction.customId);
    if (!config || config.player !== requestedPlayer) {
        await safeReply(interaction, { content: getSetupPermissionMessage(match), ephemeral: true });
        return;
    }
    if (match[config.selectedKey]) {
        await ignoreMatchInteraction(interaction, match, 'setup.openpick_ignored', 'already_selected', {}, { deleteReply: true });
        return;
    }

    const options = await getOptionsForGameType(match.gameType);
    // Keep the deadline armed, then edit the acked ephemeral into the real (private) options.
    armSelectionTimeout(match, config.player, interaction.client);
    const prompt = await deliverPrivateInteractionPayload(interaction, {
        content: config.renderPrompt(match),
        components: config.buildRows(match, options)
    }, `${config.player} open pick`);
    const block = getOrCreateGameBlock(match);
    const deliveredKey = getSetupPromptConfig(config.player)?.deliveredKey;
    if (deliveredKey) {
        block[deliveredKey] = Boolean(prompt);
    }
    logRatedInfo(interaction.client, match, 'setup.openpick.opened', getMatchLogDetails(match, {
        user: interaction.user.id,
        player: config.player,
        delivered: Boolean(prompt)
    }));
}

module.exports = {
    advanceMatchToWinnerControlAfterSelections,
    armSelectionTimeout,
    buildCancelMatchDbPayload,
    buildCaptainSelectionConfirmationPayload,
    buildDefaultCompetitiveRating,
    buildInitialGameSetupPayloads,
    buildMatchComponents,
    buildStadiumSelectionConfirmationPayload,
    buildStartPayload,
    cancelMatch,
    cancelMatchForInactivity,
    cancelMatchIfTimedOut,
    clearMatchTimers,
    getLoserControlTimeoutPhase,
    getOptionsForGameType,
    getOrCreateGameBlock,
    getSetupPromptConfig,
    handleCancelMatchButton,
    handleCaptainSelection,
    handleLoserAdvantage,
    handleLoserConfirm,
    handleOpenPrivatePick,
    handleRatedMatchCancelFailure,
    handleStadiumSelection,
    handleStartSetupButton,
    handleWinnerSelection,
    postGameImageIfMissing,
    postInitialGameSetup,
    postNeutralOpenButtons,
    postTerminalThreadNotice,
    postWinnerControl,
    renderFinalMatchResultMessage,
    renderGameResultMessage,
    renderMatchCancelledNoticeMessage,
    resolveLoserConfirmationIfTimedOut,
    scheduleSearchTimeout,
    setMatchStage,
    updateMatchControlMessage
};
