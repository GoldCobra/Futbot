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

const { executeQuery, isTransientDbError } = require('../../db/sqlClient');
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
    REMATCH_CONFIRM_TIMEOUT_MS,
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
    rematchCustomId,
    stadiumButtonCustomId,
    startSetupCustomId,
    winnerButtonCustomId
} = require('./customIds');
const {
    buildTerminalThreadName,
    buildThreadTextPayload,
    buildThreadUrl,
    quoteThreadPayload,
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
    clearPendingRematch,
    clearPendingRematches,
    clearRematchTimer,
    isQueueSearchEnabled,
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
    isRuntimeStateEnabled,
    loadCompetitiveRatedRuntimeState,
    saveCompetitiveRatedRuntimeState
} = require('./runtimeState');
const {
    clearCurrentControlMessage,
    clearSetupMessageComponents,
    deleteSetupMessageAndPostConfirmation,
    deleteThreadMessage,
    editOrSendThreadMessage,
    editOrSendRequiredThreadMessage,
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

function getPanelConfigByGameType(gameType) {
    return CONFIG.PANEL_CHANNELS.find(panel => panel.gameType === gameType) ?? null;
}

function isManagedPanelChannel(channelId) {
    return Boolean(getPanelConfigByChannelId(channelId));
}

const MATCH_OUTPUT_WARN_MS = 5000;
const RUNTIME_STATE_SAVE_DELAY_MS = 250;
let runtimeStatePersistTimer = null;
let runtimeStatePersistPromise = Promise.resolve();
let runtimeStateRecovered = false;

function getMatchOutputMeta(matchId) {
    const key = String(matchId);
    const meta = state.outputQueueMetaByMatchId.get(key) ?? {
        pending: 0,
        lastLabel: null,
        queuedAt: null,
        required: false,
        attempt: 0,
        nextRetryAt: null,
        lastError: null
    };
    state.outputQueueMetaByMatchId.set(key, meta);
    return meta;
}

function queueMatchOutput(match, client, label, worker, details = {}) {
    if (!match?.id || typeof worker !== 'function') {
        return Promise.resolve(null);
    }

    const matchId = String(match.id);
    const queuedAt = Date.now();
    const meta = getMatchOutputMeta(matchId);
    meta.pending += 1;
    meta.lastLabel = label;
    meta.queuedAt = queuedAt;
    meta.required = Boolean(details.required);
    meta.attempt += 1;
    meta.nextRetryAt = null;
    meta.lastError = null;

    const previous = state.outputQueuesByMatchId.get(matchId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(async () => {
        const startedAt = Date.now();

        try {
            return await worker();
        } catch (error) {
            meta.lastError = error.message;
            logRatedError(client, match, 'match.output.failed', error, getMatchLogDetails(match, {
                label,
                required: Boolean(details.required)
            }));
            return null;
        } finally {
            const durationMs = Date.now() - startedAt;
            meta.pending = Math.max(0, meta.pending - 1);
        }
    });

    const cleanup = queued.finally(() => {
        if (state.outputQueuesByMatchId.get(matchId) === cleanup) {
            state.outputQueuesByMatchId.delete(matchId);
        }
        if (meta.pending === 0 && state.outputQueuesByMatchId.get(matchId) !== cleanup) {
            state.outputQueueMetaByMatchId.delete(matchId);
        }
        scheduleRuntimeStatePersist(`output:${label}`);
    });

    state.outputQueuesByMatchId.set(matchId, cleanup);
    return cleanup;
}

async function flushMatchOutputQueuesForTests() {
    await Promise.all([...state.outputQueuesByMatchId.values()].map(queue => queue.catch(() => {})));
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

function buildRuntimeStateSnapshotForPersist() {
    return {
        activeMatches: [...state.activeMatchesById.values()],
        pendingCompetitiveDbOps: [...state.pendingCompetitiveDbOpsByKey.values()]
    };
}

async function flushRuntimeStatePersist(reason = 'state_change') {
    if (!isRuntimeStateEnabled()) {
        return false;
    }

    runtimeStatePersistPromise = runtimeStatePersistPromise
        .catch(() => {})
        .then(async () => {
            await saveCompetitiveRatedRuntimeState(buildRuntimeStateSnapshotForPersist());
            return true;
        })
        .catch(error => {
            logRatedError(state.client, { all: true }, 'runtime_state.persist_failed', error, {
                reason
            });
            return false;
        });

    return await runtimeStatePersistPromise;
}

function scheduleRuntimeStatePersist(reason = 'state_change') {
    if (!isRuntimeStateEnabled()) {
        return;
    }

    if (runtimeStatePersistTimer) {
        clearTimeout(runtimeStatePersistTimer);
    }
    runtimeStatePersistTimer = setTimeout(() => {
        runtimeStatePersistTimer = null;
        flushRuntimeStatePersist(reason).catch(error => {
            logRatedError(state.client, { all: true }, 'runtime_state.persist_timer_failed', error, {
                reason
            });
        });
    }, RUNTIME_STATE_SAVE_DELAY_MS);
    runtimeStatePersistTimer.unref?.();
}

function restoreRuntimeMatchIndexes(match) {
    state.activeMatchesById.set(match.id, match);
    state.activeMatchesByThreadId.set(match.threadId, match);
    for (const team of match.teams ?? []) {
        for (const memberId of team.memberIds ?? []) {
            state.activeMatchesByUserId.set(memberId, match);
        }
    }
}

async function recoverRuntimeState(client) {
    if (runtimeStateRecovered || !isRuntimeStateEnabled()) {
        return;
    }
    runtimeStateRecovered = true;

    const runtimeState = await loadCompetitiveRatedRuntimeState();
    let restoredMatches = 0;
    for (const match of runtimeState.activeMatches) {
        if (state.activeMatchesById.has(match.id)) {
            continue;
        }
        restoreRuntimeMatchIndexes(match);
        restoredMatches += 1;
        logRatedWarn(client, match, 'runtime_state.match_recovered', getMatchLogDetails(match, {
            recoveredTimeoutPhase: match.recoveredRuntimeTimeoutPhase ?? null,
            recoveredTimeoutDeadlineAt: match.recoveredRuntimeTimeoutDeadlineAt ?? null
        }));
    }

    let restoredDbOps = 0;
    for (const op of runtimeState.pendingCompetitiveDbOps) {
        if (!state.pendingCompetitiveDbOpsByKey.has(op.key)) {
            state.pendingCompetitiveDbOpsByKey.set(op.key, op);
            restoredDbOps += 1;
        }
    }

    if (restoredMatches || restoredDbOps) {
        logRatedWarn(client, { all: true }, 'runtime_state.recovered', {
            activeMatches: restoredMatches,
            pendingCompetitiveDbOps: restoredDbOps
        });
        await reconcileActiveMatchControls(client);
        scheduleRuntimeStatePersist('runtime_recovered');
    }
}

function getCompetitiveDbOpKey(type, payload) {
    if (type === 'record_game') {
        return `${type}:${payload.ratedMatchId}:${payload.gameNumber}`;
    }
    if (type === 'complete_competitive') {
        return `${type}:${payload.ratedMatchId}`;
    }
    return `${type}:${payload.matchCode ?? payload.ratedMatchId ?? createId()}`;
}

function enqueueCompetitiveDbOp(type, payload, match, client, reason) {
    const key = getCompetitiveDbOpKey(type, payload);
    const existing = state.pendingCompetitiveDbOpsByKey.get(key);
    const op = existing ?? {
        key,
        type,
        payload,
        matchId: match?.id ?? payload.matchCode ?? null,
        threadId: match?.threadId ?? payload.threadId ?? null,
        createdAt: Date.now(),
        attempts: 0,
        lastError: null,
        nextRetryAt: Date.now()
    };
    op.payload = payload;
    op.reason = reason;
    op.updatedAt = Date.now();
    state.pendingCompetitiveDbOpsByKey.set(key, op);
    if (match) {
        match.competitiveDbPending = true;
    }
    logRatedWarn(client, match ?? { all: true }, 'competitive_db.op_queued', getMatchLogDetails(match, {
        key,
        type,
        reason
    }));
    scheduleRuntimeStatePersist('competitive_db_op_queued');
    return op;
}

function hasPendingCompetitiveDbOpsForMatch(match) {
    if (!match?.ratedMatchId) return false;
    return [...state.pendingCompetitiveDbOpsByKey.values()]
        .some(op => Number(op.payload?.ratedMatchId) === Number(match.ratedMatchId));
}

function hasPendingRecordGameOpsForRatedMatch(ratedMatchId) {
    return [...state.pendingCompetitiveDbOpsByKey.values()]
        .some(op => op.type === 'record_game' && Number(op.payload?.ratedMatchId) === Number(ratedMatchId));
}

function buildRecordGameDbPayload(match, confirmedByDiscordId = null) {
    return {
        ratedMatchId: match.ratedMatchId,
        matchCode: match.id,
        threadId: match.threadId,
        gameNumber: match.pendingResult.gameNumber,
        winnerTeamNumber: match.pendingResult.winnerTeamIndex,
        homeTeamNumber: match.pendingResult.homeTeamNumber ?? match.homeTeamIndex,
        stadiumCode: match.pendingResult.stadiumCode ?? null,
        captainCode: match.pendingResult.captainCode ?? null,
        reportedByParticipantId: match.participantIdByDiscordId?.get(String(match.pendingResult.reporterDiscordId)),
        confirmedByParticipantId: match.participantIdByDiscordId?.get(String(confirmedByDiscordId)),
        reportedByDiscordId: match.pendingResult.reporterDiscordId ?? null,
        confirmedByDiscordId
    };
}

function buildCompleteCompetitiveDbPayload(match, winnerTeamNumber) {
    return {
        ratedMatchId: match.ratedMatchId,
        matchCode: match.id,
        threadId: match.threadId,
        seasonId: match.seasonId,
        gameType: CONSTANTS.SQL_GAME_TYPE_TO_NUMBER[match.gameType],
        mode: match.mode,
        winnerTeamNumber,
        team1Score: match.score.team1,
        team2Score: match.score.team2,
        homeTeamNumber: match.homeTeamIndex,
        awayTeamNumber: match.awayTeamIndex,
        guildId: CONSTANTS.GUILD_ID
    };
}

async function postCompetitiveDbPendingNotice(match, client, thread = null) {
    thread ??= await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) return null;

    const payload = buildThreadTextPayload(
        `${BL_TIME_EMOJI} **Competitive DB sync pending.** The match can continue; Competitive ELO will be synced automatically when the database is reachable again.`,
        'line',
        { components: [] }
    );
    try {
        const message = await editOrSendRequiredThreadMessage(
            thread,
            match.competitiveDbPendingNoticeMessageId,
            payload
        );
        match.competitiveDbPendingNoticeMessageId = message.id;
        return message;
    } catch (error) {
        logRatedError(client, match, 'competitive_db.pending_notice_failed', error, getMatchLogDetails(match));
        return null;
    }
}

async function runPendingCompetitiveDbOps(client) {
    const now = Date.now();
    const ops = [...state.pendingCompetitiveDbOpsByKey.values()]
        .filter(op => !op.nextRetryAt || op.nextRetryAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt);

    for (const op of ops) {
        try {
            if (op.type === 'record_game') {
                await ratedMatchDao.recordGame(op.payload);
            } else if (op.type === 'complete_competitive') {
                if (hasPendingRecordGameOpsForRatedMatch(op.payload.ratedMatchId)) {
                    continue;
                }
                const result = await recordCompetitiveResult({
                    ...op.payload,
                    client,
                    guildId: op.payload.guildId ?? CONSTANTS.GUILD_ID
                });
                const thread = await client.channels.fetch(op.threadId).catch(() => null);
                if (thread?.send && Array.isArray(result?.changes) && result.changes.length > 0) {
                    await thread.send(buildThreadTextPayload(
                        `${BL_CHECK_EMOJI} **Competitive DB sync completed.**\n${renderCompetitiveRatingSummaryMessage(result)}`,
                        'line',
                        { components: [] }
                    )).catch(error => {
                        logRatedWarn(client, { id: op.matchId, threadId: op.threadId }, 'competitive_db.sync_notice_failed', {
                            match: op.matchId,
                            thread: op.threadId,
                            error: error.message
                        });
                    });
                }
            }
            state.pendingCompetitiveDbOpsByKey.delete(op.key);
            scheduleRuntimeStatePersist('competitive_db_op_completed');
            logRatedInfo(client, { id: op.matchId, threadId: op.threadId }, 'competitive_db.op_completed', {
                match: op.matchId,
                thread: op.threadId,
                key: op.key,
                type: op.type
            });
        } catch (error) {
            op.attempts += 1;
            op.lastError = error.message;
            op.nextRetryAt = Date.now() + Math.min(60000, 5000 * Math.max(op.attempts, 1));
            scheduleRuntimeStatePersist('competitive_db_op_retry_scheduled');
            logRatedWarn(client, { id: op.matchId, threadId: op.threadId }, 'competitive_db.op_retry_scheduled', {
                match: op.matchId,
                thread: op.threadId,
                key: op.key,
                type: op.type,
                attempts: op.attempts,
                nextRetryAt: op.nextRetryAt,
                error: error.message
            });
        }
    }
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
const LFG_ROLE_ID_BY_GAME_TYPE = {
    MSBL: '944150830972538923',
    MSC: '680810288605298744',
    SMS: '781487757176209428'
};

function getLfgRoleIdForPanel(channelId) {
    const panelConfig = getPanelConfigByChannelId(channelId);
    return panelConfig ? LFG_ROLE_ID_BY_GAME_TYPE[panelConfig.gameType] ?? null : null;
}

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

function buildStatusMessageContent(counts, channelId = null) {
    const lines = [];
    const hasSingles = (counts['1v1'] ?? 0) > 0;
    const hasDoubles = (counts['2v2'] ?? 0) > 0;

    if (hasSingles || hasDoubles) {
        const roleId = getLfgRoleIdForPanel(channelId);
        if (roleId) {
            lines.push(`<@&${roleId}>`);
        }
    }

    if (hasSingles) {
        lines.push(`Players in 1vs1 Pool: **${PLAYER_COUNT_EMOJI} ${counts['1v1']}**`);
    }

    if (hasDoubles) {
        lines.push(`Players in 2vs2 Pool: **👥 ${counts['2v2']}**`);
    }

    return lines.join('\n');
}

function buildStatusMessagePayload(panelConfig, counts) {
    const roleId = LFG_ROLE_ID_BY_GAME_TYPE[panelConfig?.gameType];
    const payload = {
        content: buildStatusMessageContent(counts, panelConfig?.channelId),
        components: [],
        allowedMentions: { parse: [] }
    };
    if (roleId) {
        payload.allowedMentions.roles = [roleId];
    }
    return payload;
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

function buildLeavePoolComponents(search) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(cancelSearchCustomId(search.id))
                .setLabel(buildLeavePoolLabel(search.mode))
                .setStyle(ButtonStyle.Danger)
        )
    ];
}

function buildPoolJoinPayload(search, compRating = null) {
    return {
        content: renderPoolJoinMessage(search, compRating),
        components: buildLeavePoolComponents(search),
        ephemeral: true
    };
}

function buildExistingPoolEntryPayload(search) {
    return {
        content: renderTimedMessage(
            `Your ${getModeCompactLabel(search.mode)} pool entry is still active.`,
            search.expiresAt,
            `**${search.durationMinutes ?? DEFAULT_POOL_DURATION_MINUTES} mins**`
        ),
        components: buildLeavePoolComponents(search),
        ephemeral: true
    };
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

// Normalize any Discord identity (mention <@id>/<@!id>/<@&id>, &id, x-id, raw) to a bare snowflake.
// Mirrors dbo.fn_NormalizeDiscordId so direct Player inserts can never store a wrapped id.
function normalizeDiscordId(raw) {
    const original = String(raw ?? '').trim();
    if (!original) return original;
    const stripped = original
        .replace(/^<@[!&]?/, '')
        .replace(/>$/, '')
        .replace(/^&+/, '')
        .replace(/^x-/, '')
        .trim();
    return /^[0-9]{15,20}$/.test(stripped) ? stripped : original;
}

async function getPlayerIdByDiscordId(discordId) {
    const result = await executeQuery(`
        SELECT TOP 1 ID AS Id
        FROM dbo.Player
        WHERE DiscordID = @discordId
    `, { discordId: normalizeDiscordId(discordId) });
    return result.recordset[0]?.Id ?? null;
}

async function ensureCompetitivePlayer(discordId, displayName = null) {
    const normalizedDiscordId = normalizeDiscordId(discordId);
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

function getSetupPromptConfig(player) {
    if (player === 'home') {
        return {
            player,
            selectedKey: 'selectedStadium',
            promptIdKey: 'homeSelectionPromptId',
            buildRows: buildStadiumButtonRows,
            renderPrompt: renderHomeSelectionPrompt
        };
    }

    if (player === 'away') {
        return {
            player,
            selectedKey: 'selectedCaptain',
            promptIdKey: 'awaySelectionPromptId',
            buildRows: buildCaptainButtonRows,
            renderPrompt: renderAwaySelectionPrompt
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

async function prewarmOptionsForPanelGameTypes(client) {
    const gameTypes = [...new Set(CONFIG.PANEL_CHANNELS.map(panel => panel.gameType).filter(Boolean))];
    await Promise.all(gameTypes.map(async gameType => {
        try {
            await getOptionsForGameType(gameType);
            logRatedInfo(client, { gameType }, 'queue.options.prewarmed', { gameType });
        } catch (error) {
            logRatedError(client, { gameType }, 'queue.options.prewarm_failed', error, { gameType });
        }
    }));
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

    if (state.rematchInitiatorsByUserId.has(userId)) {
        return 'You are waiting for a rematch confirmation.';
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
        const statusPayload = buildStatusMessagePayload(panelConfig, counts);
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
    let statusMessage = await fetchPanelMessageById(channel, panelMeta.statusMessageId);
    let existingStatusMessages = [];

    if (!statusMessage) {
        const recentMessages = await fetchRecentMessages(channel, 100);
        existingStatusMessages = findStatusMessages(recentMessages, client.user?.id);
        statusMessage = existingStatusMessages[0] ?? null;
        panelMeta.statusMessageId = statusMessage?.id ?? null;
    }

    if (hasAnySearches) {
        const statusPayload = buildStatusMessagePayload(panelConfig, counts);

        if (statusMessage) {
            if (existingStatusMessages.length === 0) {
                const recentMessages = await fetchRecentMessages(channel, 100);
                existingStatusMessages = findStatusMessages(recentMessages, client.user?.id);
            }
            await statusMessage.edit(statusPayload).catch(err => {
                console.warn(`[RatedQueue] Failed to edit status message in ${channel.id}: ${err.message}`);
                logRatedWarn(client, panelConfig, 'panel.status.edit_failed', { channel: channel.id, error: err.message });
            });
            panelMeta.statusMessageId = statusMessage.id;
            await deleteDuplicateStatusMessages(existingStatusMessages, statusMessage.id, panelConfig, channel, client);
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

    const deletedStatusMessageIds = new Set();
    if (statusMessage && existingStatusMessages.length === 0) {
        const recentMessages = await fetchRecentMessages(channel, 100);
        existingStatusMessages = findStatusMessages(recentMessages, client.user?.id);
    }
    if (statusMessage) {
        await statusMessage.delete().catch(err => {
            console.warn(`[RatedQueue] Failed to delete status message in ${channel.id}: ${err.message}`);
            logRatedWarn(client, panelConfig, 'panel.status.delete_failed', { channel: channel.id, error: err.message });
        });
        deletedStatusMessageIds.add(statusMessage.id);
    }
    await deleteDuplicateStatusMessages(existingStatusMessages, null, panelConfig, channel, client, deletedStatusMessageIds);
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
            && message.content.includes('Players in ')
    ) ?? null;
}

function findStatusMessages(messages, botUserId) {
    return messages.filter(message =>
        message.author?.id === botUserId
            && typeof message.content === 'string'
            && message.content.includes('Players in ')
    );
}

async function deleteDuplicateStatusMessages(statusMessages, keepMessageId, panelConfig, channel, client, skipMessageIds = new Set()) {
    for (const message of statusMessages) {
        if (message.id === keepMessageId || skipMessageIds.has(message.id)) {
            continue;
        }

        await message.delete().catch(err => {
            console.warn(`[RatedQueue] Failed to delete duplicate status message in ${channel.id}: ${err.message}`);
            logRatedWarn(client, panelConfig, 'panel.status.duplicate_delete_failed', {
                channel: channel.id,
                message: message.id,
                error: err.message
            });
        });
    }
}

async function applyChannelLock(channel, gameType) {
    try {
        const botMemberId = channel.guild.members.me?.id ?? channel.client.user?.id;
        if (botMemberId) {
            await channel.permissionOverwrites.edit(botMemberId, {
                ViewChannel: true,
                SendMessages: true,
                SendMessagesInThreads: true,
                CreatePublicThreads: true,
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

    const existingSearch = state.activeSearchesByUserId.get(interaction.user.id);
    if (existingSearch?.id && state.activeSearchesById.has(existingSearch.id)) {
        logRatedInfo(interaction.client, { gameType: panelConfig.gameType, mode }, 'queue.join_replayed', {
            user: interaction.user.id,
            search: existingSearch.id
        });
        await safeReply(interaction, buildExistingPoolEntryPayload(existingSearch));
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

    await safeReply(interaction, buildPoolJoinPayload(search, compRating));
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

async function createCompetitiveRatedMatch(panelConfig, searches, client, {
    skipReconcile = false,
    firstToOverride = null,
    teamsOverride = null
} = {}) {
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

    const teams = teamsOverride ?? (searches[0].mode === '1v1' ? buildSinglesTeams(searches) : buildDoublesTeams(searches));
    const firstTo = firstToOverride != null && Number.isFinite(Number(firstToOverride))
        ? Number(firstToOverride)
        : searches[0].mode === '1v1'
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
            type: ChannelType.PublicThread,
            autoArchiveDuration: 60,
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
        participantIdByDiscordId: new Map(),
        competitiveDbPending: false,
        competitiveDbPendingNoticeMessageId: null
    };

    state.activeMatchesById.set(match.id, match);
    state.activeMatchesByThreadId.set(thread.id, match);
    scheduleRuntimeStatePersist('match_created');
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

async function sendThreadSetupSelectionPrompt(match, thread, player, options) {
    const config = getSetupPromptConfig(player);
    if (!config || match?.stage !== 'awaiting_start' || match[config.selectedKey]) {
        return null;
    }

    const block = getOrCreateGameBlock(match);
    const payload = buildThreadTextPayload(config.renderPrompt(match), 'line');
    const message = await editOrSendRequiredThreadMessage(thread, block[config.promptIdKey], payload);
    block[config.promptIdKey] = message.id;
    return { message, config };
}

async function armVisibleSelectionPromptTimer(match, client, thread, player, message, options) {
    const config = getSetupPromptConfig(player);
    if (!config) {
        return false;
    }

    if (match?.stage !== 'awaiting_start' || match[config.selectedKey]) {
        clearSelectionTimer(match, player);
        const block = getOrCreateGameBlock(match);
        if (block[config.promptIdKey] === message?.id) {
            await deleteThreadMessage(thread, message.id);
            block[config.promptIdKey] = null;
        }
        return false;
    }

    scheduleSelectionTimeout(match, player, client);
    await message.edit?.(quoteThreadPayload({
        content: config.renderPrompt(match)
    })).catch(error => {
        logRatedWarn(client, match, 'setup.selection_control.deadline_refresh_failed', getMatchLogDetails(match, {
            player,
            message: message.id,
            error: error.message
        }));
    });

    logRatedInfo(client, match, 'setup.selection_control.posted', getMatchLogDetails(match, {
        player,
        message: message.id
    }));
    return true;
}

async function postVisibleSetupSelectionControls(match, client, players, details = {}) {
    const uniquePlayers = [...new Set(players)].filter(player => player === 'home' || player === 'away');
    if (!uniquePlayers.length || match?.stage !== 'awaiting_start') {
        return [];
    }

    const thread = await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        logRatedWarn(client, match, 'setup.selection_control.thread_missing', getMatchLogDetails(match, details));
        return [];
    }

    const options = await getOptionsForGameType(match.gameType);
    const posted = [];
    for (const player of uniquePlayers) {
        try {
            const result = await sendThreadSetupSelectionPrompt(match, thread, player, options);
            if (result) {
                posted.push({ player, ...result });
            }
        } catch (error) {
            clearSelectionTimer(match, player);
            logRatedError(client, match, 'setup.selection_control.post_failed', error, getMatchLogDetails(match, {
                player,
                ...details
            }));
        }
    }

    if (!posted.length || match.stage !== 'awaiting_start') {
        return posted;
    }

    ensureMatchTimeoutScheduled(match, 'start', client);
    for (const item of posted) {
        await armVisibleSelectionPromptTimer(match, client, thread, item.player, item.message, options);
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

function isUnknownDiscordMessageError(error) {
    return Number(error?.code) === 10008
        || Number(error?.rawError?.code) === 10008
        || String(error?.message ?? '').toLowerCase().includes('unknown message');
}

async function deleteParentThreadStarterMessage(matchSnapshot, thread, client, source) {
    const parentChannelId = matchSnapshot.channelId
        ?? matchSnapshot.panelChannelId
        ?? thread?.parentId
        ?? thread?.parent?.id
        ?? null;
    const threadId = matchSnapshot.threadId ?? thread?.id ?? null;
    if (!parentChannelId || !threadId || typeof client?.channels?.fetch !== 'function') {
        return { deleted: false, skipped: true };
    }

    const parentChannel = await client.channels.fetch(parentChannelId).catch(error => {
        logRatedWarn(client, matchSnapshot, 'thread.parent_starter_fetch_channel_failed', getMatchLogDetails(matchSnapshot, {
            source,
            channel: parentChannelId,
            error: formatThreadActionError(error)
        }));
        return null;
    });
    if (!parentChannel?.messages?.fetch) {
        return { deleted: false, skipped: true };
    }

    let directFetchWasUnknown = false;
    let starterMessage = await parentChannel.messages.fetch(threadId).catch(error => {
        if (!isUnknownDiscordMessageError(error)) {
            logRatedWarn(client, matchSnapshot, 'thread.parent_starter_fetch_failed', getMatchLogDetails(matchSnapshot, {
                source,
                channel: parentChannelId,
                message: threadId,
                error: formatThreadActionError(error)
            }));
        } else {
            directFetchWasUnknown = true;
        }
        return null;
    });
    if (!starterMessage && directFetchWasUnknown) {
        const recentMessages = await parentChannel.messages.fetch({ limit: 50 }).catch(error => {
            logRatedWarn(client, matchSnapshot, 'thread.parent_starter_history_fetch_failed', getMatchLogDetails(matchSnapshot, {
                source,
                channel: parentChannelId,
                message: threadId,
                error: formatThreadActionError(error)
            }));
            return null;
        });
        const candidates = recentMessages?.values
            ? Array.from(recentMessages.values())
            : Array.isArray(recentMessages)
            ? recentMessages
            : [];
        starterMessage = candidates.find(message =>
            String(message?.id ?? '') === String(threadId)
            || String(message?.thread?.id ?? '') === String(threadId)
        ) ?? null;
    }
    if (!starterMessage) {
        return { deleted: false, missing: true };
    }

    try {
        await starterMessage.delete();
        logRatedInfo(client, matchSnapshot, 'thread.parent_starter_deleted', getMatchLogDetails(matchSnapshot, {
            source,
            channel: parentChannelId,
            message: threadId
        }));
        return { deleted: true };
    } catch (error) {
        if (!isUnknownDiscordMessageError(error)) {
            logRatedWarn(client, matchSnapshot, 'thread.parent_starter_delete_failed', getMatchLogDetails(matchSnapshot, {
                source,
                channel: parentChannelId,
                message: threadId,
                error: formatThreadActionError(error)
            }));
            return { deleted: false, error };
        }
        return { deleted: false, missing: true };
    }
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
        channelId: match.channelId,
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
        channelId: row.PanelChannelId ? String(row.PanelChannelId) : null,
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
        channelId: row.PanelChannelId ? String(row.PanelChannelId) : null,
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
            await deleteParentThreadStarterMessage(matchSnapshot, thread, client, source);
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
            markReportableMatchThreadFinalized(matchId);
            clearPendingRematch(matchId);
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

function markReportableMatchThreadFinalized(matchId) {
    const snapshot = state.reportableMatchesById.get(matchId);
    if (snapshot) {
        snapshot.threadFinalizedAt = new Date().toISOString();
    }
}

function getSnapshotCompletedAtMs(snapshot) {
    if (Number.isFinite(snapshot?.completedAtMs)) {
        return Number(snapshot.completedAtMs);
    }
    const ms = new Date(snapshot?.completedAtUtc ?? snapshot?.completedAt ?? Date.now()).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
}

function getCompletedThreadOriginalFinalizeAt(snapshot) {
    return getSnapshotCompletedAtMs(snapshot) + COMPLETED_THREAD_CLOSE_DELAY_MS;
}

function isRematchWindowOpen(snapshot) {
    if (!snapshot?.threadId || snapshot.threadFinalizedAt) {
        return false;
    }
    return Date.now() <= getCompletedThreadOriginalFinalizeAt(snapshot);
}

function buildCompletedThreadFinalizationSnapshotFromReportable(snapshot, finalizeAfterAt = Date.now()) {
    return {
        id: snapshot.id,
        ratedMatchId: snapshot.ratedMatchId ?? null,
        channelId: snapshot.channelId ?? null,
        threadId: snapshot.threadId,
        threadName: snapshot.threadName,
        gameType: snapshot.gameType,
        mode: snapshot.mode,
        score: snapshot.score ? { ...snapshot.score } : null,
        stage: 'complete',
        finalizeAfterAt
    };
}

function setCompletedThreadFinalizationDeadline(snapshot, finalizeAfterAt) {
    const existing = state.pendingCompletedThreadFinalizationsByMatchId.get(snapshot.id)
        ?? buildCompletedThreadFinalizationSnapshotFromReportable(snapshot, finalizeAfterAt);
    existing.finalizeAfterAt = finalizeAfterAt;
    state.pendingCompletedThreadFinalizationsByMatchId.set(snapshot.id, existing);
    clearCompletedThreadCloseTimer(snapshot.id);
    return existing;
}

function restoreCompletedThreadFinalization(snapshot, client, source = 'rematch_restore') {
    scheduleCompletedThreadFinalization(
        buildCompletedThreadFinalizationSnapshotFromReportable(
            snapshot,
            Math.max(Date.now(), getCompletedThreadOriginalFinalizeAt(snapshot))
        ),
        client,
        source
    );
}

async function finalizeCompletedThreadFromSnapshot(snapshot, client, source = 'rematch') {
    const pending = setCompletedThreadFinalizationDeadline(snapshot, Date.now());
    const result = await finalizeCompletedThreadIfDue(pending.id, client, source);
    if (result) {
        markReportableMatchThreadFinalized(pending.id);
    }
    return result;
}

function getSnapshotParticipants(snapshot) {
    return Array.isArray(snapshot?.participants) ? snapshot.participants : [];
}

function findSnapshotParticipant(snapshot, userId) {
    return getSnapshotParticipants(snapshot).find(participant => participant.id === userId) ?? null;
}

function isEligibleRematchParticipant(snapshot, participant) {
    if (!participant) return false;
    if (snapshot.mode === '2v2') {
        return participant.isRepresentative === true;
    }
    return true;
}

function getRequiredRematchResponders(snapshot, initiatorParticipant) {
    return getSnapshotParticipants(snapshot)
        .filter(participant => isEligibleRematchParticipant(snapshot, participant))
        .filter(participant => Number(participant.teamNumber) !== Number(initiatorParticipant.teamNumber));
}

function getRematchParticipantIds(snapshot) {
    return [...new Set(getSnapshotParticipants(snapshot).map(participant => participant.id).filter(Boolean))];
}

function getRematchFirstTo(snapshot) {
    const firstTo = Number(snapshot?.firstTo);
    return Number.isFinite(firstTo) && firstTo > 0 ? firstTo : 2;
}

function getRematchBestOf(firstTo) {
    return Math.max(1, (Number(firstTo) * 2) - 1);
}

function getRematchPanelConfig(snapshot) {
    return getPanelConfigByChannelId(snapshot?.channelId)
        ?? getPanelConfigByGameType(snapshot?.gameType);
}

function renderRematchWaitingMessage(snapshot, initiatorParticipant, requiredResponders, expiresAt) {
    const requiredMentions = requiredResponders.map(participant => participant.mention ?? `<@${participant.id}>`).join(' ');
    const initiatorMention = initiatorParticipant.mention ?? `<@${initiatorParticipant.id}>`;
    return renderTimedMessage(
        `${initiatorMention} requested a rematch.\n${requiredMentions}, press **Rematch** to start a new match.`,
        expiresAt,
        '**5 minutes**'
    );
}

function buildRematchSearch(participant, panelConfig, mode, firstTo, ratingProfile) {
    const now = Date.now();
    const bestOf = getRematchBestOf(firstTo);
    return {
        id: createId(),
        channelId: panelConfig.channelId,
        gameType: panelConfig.gameType,
        mode,
        userId: participant.id,
        mention: participant.mention ?? `<@${participant.id}>`,
        notificationInteraction: null,
        username: participant.username ?? participant.id,
        createdAt: now,
        durationMinutes: DEFAULT_POOL_DURATION_MINUTES,
        expiresAt: now + DEFAULT_POOL_DURATION_MINUTES * 60000,
        warningAt: now + Math.max(DEFAULT_POOL_DURATION_MINUTES - CONFIG.EXPIRING_SOON_MINUTES, 0) * 60000,
        hasWarnedExpiry: false,
        matchedThreadUrl: null,
        warningMessage: null,
        warningMessageId: null,
        warningToken: null,
        options: {
            minBestOf: bestOf,
            maxBestOf: bestOf,
            threshold: null
        },
        ratingProfile
    };
}

async function buildRematchSearches(snapshot, panelConfig) {
    const firstTo = getRematchFirstTo(snapshot);
    const searches = [];
    for (const participant of getSnapshotParticipants(snapshot)) {
        const ratingProfile = await getPlayerQueueProfile(
            participant.id,
            snapshot.gameType,
            snapshot.mode,
            participant.username ?? participant.id
        );
        searches.push(buildRematchSearch(participant, panelConfig, snapshot.mode, firstTo, ratingProfile));
    }
    return searches;
}

function buildFixedRematchTeams(snapshot, searches) {
    const searchesByUserId = new Map(searches.map(search => [search.userId, search]));
    return [1, 2].map(teamNumber => {
        const teamParticipants = getSnapshotParticipants(snapshot)
            .filter(participant => Number(participant.teamNumber) === teamNumber);
        if (teamParticipants.length === 0) {
            throw new Error(`Cannot build rematch team ${teamNumber}: no participants found.`);
        }

        const members = teamParticipants.map(participant => {
            const search = searchesByUserId.get(participant.id);
            if (!search) {
                throw new Error(`Cannot build rematch team ${teamNumber}: missing search for ${participant.id}.`);
            }
            return {
                id: search.userId,
                mention: search.mention,
                username: search.username,
                ratingProfile: {
                    ...search.ratingProfile
                }
            };
        });
        const repParticipant = teamParticipants.find(participant => participant.isRepresentative === true)
            ?? teamParticipants[0];
        const repSearch = searchesByUserId.get(repParticipant.id);
        return {
            teamIndex: teamNumber,
            members,
            memberIds: members.map(member => member.id),
            repUserId: repSearch.userId,
            repMention: repSearch.mention
        };
    });
}

async function closeActiveSearchesForRematch(userIds, client) {
    const affectedChannels = new Set();
    for (const userId of userIds) {
        const search = state.activeSearchesByUserId.get(userId);
        if (!search?.id || !state.activeSearchesById.has(search.id)) {
            continue;
        }
        affectedChannels.add(search.channelId);
        await closeSearch(search, 'rematch', client);
    }
    for (const channelId of affectedChannels) {
        schedulePanelStatusRefresh(channelId, client);
    }
}

function getActiveMatchUserId(userIds) {
    return userIds.find(userId => state.activeMatchesByUserId.has(userId)) ?? null;
}

function scheduleRematchTimeout(pending, client) {
    clearRematchTimer(pending.matchId);
    const delayMs = Math.max(pending.expiresAt - Date.now(), 0);
    const timer = setTimeout(() => {
        expirePendingRematch(pending.matchId, client).catch(error => {
            logRatedError(client, pending.snapshot, 'rematch.timeout_failed', error, getMatchLogDetails(pending.snapshot));
        });
    }, delayMs);
    timer.unref?.();
    state.rematchTimersByMatchId.set(pending.matchId, timer);
}

async function expirePendingRematchUnlocked(matchId, client) {
    const pending = state.pendingRematchesByMatchId.get(matchId);
    if (!pending) return;
    clearPendingRematch(matchId);
    const thread = await client.channels.fetch(pending.snapshot.threadId).catch(() => null);
    await thread?.send?.({
        content: `${BL_TIME_EMOJI} Rematch request expired. Closing this match thread.`
    }).catch(() => {});
    logRatedInfo(client, pending.snapshot, 'rematch.expired', getMatchLogDetails(pending.snapshot, {
        initiator: pending.initiatorId
    }));
    await finalizeCompletedThreadFromSnapshot(pending.snapshot, client, 'rematch_timeout');
}

async function expirePendingRematch(matchId, client) {
    await withInteractionLock(`rematch:${matchId}`, async () => {
        await expirePendingRematchUnlocked(matchId, client);
    });
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
            logRatedInfo(client, match, 'match.output.selection_message_sent', getMatchLogDetails(match, { message: confMsg.id }));
        }
    }

    match.stage = 'awaiting_winner';
    if (thread) await clearStartButtonComponents(thread, block);
    await postWinnerControl(match, client, thread);
}

function queueAdvanceMatchToWinnerControlAfterSelections(match, client, thread = null, source = 'manual_selection') {
    match.stage = 'awaiting_winner';
    return queueMatchOutput(match, client, 'advance_to_winner_control_after_selections', async () => {
        await advanceMatchToWinnerControlAfterSelections(match, client, thread);
    }, {
        source,
        required: true,
        game: getNextGameNumber(match)
    });
}

async function postWinnerControl(match, client, thread = null) {
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

function getLoserControlTimeoutPhase(match) {
    if (match.stage !== 'awaiting_loser_confirmation') {
        return null;
    }
    return requiresSetup(match.gameType) && match.loserAdvantagePromptShown
        ? 'loser_advantage'
        : 'loser_confirmation';
}

async function updateMatchControlMessage(match, client, thread = null) {
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

function hasPendingMatchOutput(match) {
    const meta = state.outputQueueMetaByMatchId.get(String(match?.id));
    return Boolean(meta?.pending);
}

function needsAwaitingWinnerSetupOutputRecovery(match) {
    if (
        match?.stage !== 'awaiting_winner'
        || !requiresSetup(match.gameType)
        || !match.selectedStadium
        || !match.selectedCaptain
    ) {
        return false;
    }

    const block = getOrCreateGameBlock(match);
    return Boolean(block.delayedResult && !block.delayedResultMessageId)
        || !block.gameImageMessageId
        || !block.selectionsMessageId;
}

async function threadMessageExists(thread, messageId) {
    if (!messageId) return false;
    return Boolean(await fetchThreadMessage(thread, messageId));
}

async function queueControlWatchdogRecovery(match, client, label, worker, details = {}) {
    if (hasPendingMatchOutput(match)) {
        return;
    }
    logRatedWarn(client, match, 'control.watchdog.recovery_queued', getMatchLogDetails(match, {
        label,
        ...details
    }));
    queueMatchOutput(match, client, label, worker, {
        source: 'watchdog',
        required: true,
        ...details
    });
}

async function reconcileActiveMatchControl(match, client) {
    if (!match || match.stage === 'complete' || match.stage === 'cancelled' || hasPendingMatchOutput(match)) {
        return;
    }

    const thread = await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        logRatedWarn(client, match, 'control.watchdog.thread_missing', getMatchLogDetails(match));
        return;
    }

    if (match.stage === 'awaiting_winner' || match.stage === 'awaiting_loser_confirmation') {
        const phase = match.stage === 'awaiting_winner'
            ? 'game'
            : getLoserControlTimeoutPhase(match);
        const controlExists = await threadMessageExists(thread, match.controlMessageId);
        const needsFullWinnerOutputRecovery = match.stage === 'awaiting_winner'
            && needsAwaitingWinnerSetupOutputRecovery(match);
        if (
            controlExists
            && !needsFullWinnerOutputRecovery
            && match.timeoutPhase === phase
            && match.timeoutTimer
            && Number.isFinite(match.timeoutDeadlineAt)
            && match.timeoutDeadlineAt > Date.now()
        ) {
            return;
        }
        const recoveryLabel = needsFullWinnerOutputRecovery
            ? 'watchdog_recover_winner_output'
            : controlExists ? 'watchdog_refresh_match_control_timer' : 'watchdog_restore_match_control';
        await queueControlWatchdogRecovery(match, client, recoveryLabel, async () => {
            if (needsFullWinnerOutputRecovery) {
                await advanceMatchToWinnerControlAfterSelections(match, client, thread);
            } else {
                await updateMatchControlMessage(match, client, thread);
            }
        }, {
            phase,
            refreshTimer: controlExists,
            fullOutputRecovery: needsFullWinnerOutputRecovery,
            missingMessage: match.controlMessageId ?? null
        });
        return;
    }

    if (match.stage !== 'awaiting_start' || !requiresSetup(match.gameType)) {
        return;
    }

    const block = getOrCreateGameBlock(match);
    const isInitialStartGate = getNextGameNumber(match) === 1
        && !match.selectedStadium
        && !match.selectedCaptain
        && !match.startClickedUserIds?.length;
    if (isInitialStartGate) {
        const startExists = await threadMessageExists(thread, block.startMessageId);
        if (
            startExists
            && match.timeoutPhase === 'start'
            && match.timeoutTimer
            && Number.isFinite(match.timeoutDeadlineAt)
            && match.timeoutDeadlineAt > Date.now()
        ) {
            return;
        }
        await queueControlWatchdogRecovery(match, client, startExists ? 'watchdog_refresh_start_timer' : 'watchdog_restore_start_control', async () => {
            await postInitialGameSetup(match, client);
        }, {
            phase: 'start',
            refreshTimer: startExists,
            missingMessage: block.startMessageId ?? null
        });
        return;
    }

    const missingPlayers = [];
    const homeSelectionExists = await threadMessageExists(thread, block.homeSelectionPromptId);
    const awaySelectionExists = await threadMessageExists(thread, block.awaySelectionPromptId);
    if (!match.selectedStadium && (!homeSelectionExists || !match.homeSelectionTimer)) {
        missingPlayers.push('home');
    }
    if (!match.selectedCaptain && (!awaySelectionExists || !match.awaySelectionTimer)) {
        missingPlayers.push('away');
    }
    if (!missingPlayers.length) {
        return;
    }

    await queueControlWatchdogRecovery(match, client, 'watchdog_restore_setup_selection_controls', async () => {
        await postVisibleSetupSelectionControls(match, client, missingPlayers, {
            source: 'watchdog',
            players: missingPlayers.join(',')
        });
    }, {
        phase: 'selection',
        players: missingPlayers.join(',')
    });
}

async function reconcileActiveMatchControls(client) {
    const matches = [...state.activeMatchesById.values()];
    for (const match of matches) {
        await reconcileActiveMatchControl(match, client).catch(error => {
            logRatedError(client, match, 'control.watchdog.failed', error, getMatchLogDetails(match));
        });
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

    if (!requiresSetup(match.gameType)) {
        await ensureDeferredReply(interaction);
        const confirmedGameNumber = pendingGameNumber;
        const isMatchComplete = match.score.team1 >= match.firstTo || match.score.team2 >= match.firstTo;
        if (isMatchComplete) {
            match.loserAdvantagePromptShown = true;
            const winnerMention = getPendingResultWinnerMention(match);
            if (!await recordConfirmedGameResult(match, interaction.client, interaction.user.id)) {
                await interaction.deleteReply().catch(() => {});
                return;
            }
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
        if (!await recordConfirmedGameResult(match, interaction.client, interaction.user.id)) {
            await interaction.deleteReply().catch(() => {});
            return;
        }
        clearPendingResult(match);
        match.startClickedUserIds = [];
        match.stage = 'awaiting_winner';
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
    const isMatchComplete = match.score.team1 >= match.firstTo || match.score.team2 >= match.firstTo;
    if (isMatchComplete) {
        match.loserAdvantagePromptShown = true;
        const winnerMention = getPendingResultWinnerMention(match);
        if (!await recordConfirmedGameResult(match, interaction.client, interaction.user.id)) {
            await interaction.deleteReply().catch(() => {});
            return;
        }
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
    match.stage = 'awaiting_start';
    clearMatchTimers(match);

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
        logRatedWarn(interaction.client, match, 'setup.private_loser_delivery_failed', getMatchLogDetails(match, {
            game: confirmedGameNumber,
            loser: loserRepId,
            fallback: 'thread_selection_control'
        }));
    }

    const winnerPrompt = await deliverPrivateInteractionPayload(
        getPrivateDeliveryInteraction(match, winnerRepId),
        winnerPayload,
        'winner private setup'
    );
    if (!winnerPrompt) {
        logRatedWarn(interaction.client, match, 'setup.private_winner_delivery_failed', getMatchLogDetails(match, {
            game: confirmedGameNumber,
            winner: winnerRepId,
            fallback: 'thread_selection_control'
        }));
    }

    const loserSelectionPlayer = choice === 'home' ? 'home' : 'away';
    const winnerSelectionPlayer = choice === 'home' ? 'away' : 'home';

    match.loserTeamIndex = null;
    match.loserRepMention = null;
    queueMatchOutput(match, interaction.client, 'cleanup_current_control_after_advantage_choice', async () => {
        clearCurrentControlMessageBestEffort(match, interaction.client, null, 'advantage_choice');
    }, {
        source: 'advantage_choice',
        game: confirmedGameNumber
    });
    queueMatchOutput(match, interaction.client, 'post_visible_setup_selection_controls_after_advantage', async () => {
        await postVisibleSetupSelectionControls(
            match,
            interaction.client,
            [loserSelectionPlayer, winnerSelectionPlayer],
            {
                source: 'advantage_choice',
                choice,
                game: confirmedGameNumber
            }
        );
    }, {
        source: 'advantage_choice',
        required: true,
        choice,
        game: confirmedGameNumber
    });
    logRatedInfo(interaction.client, match, 'game.advantage.chosen', getMatchLogDetails(match, {
        game: confirmedGameNumber,
        loser: interaction.user.id,
        choice
    }));
    logRatedInfo(interaction.client, match, 'setup.private_controls.posted', getMatchLogDetails(match, {
        loserPrompt: loserPrompt?.id,
        winnerPrompt: winnerPrompt?.id,
        fallback: 'thread_selection_control'
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
            const isMatchComplete = match.score.team1 >= match.firstTo || match.score.team2 >= match.firstTo;
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
            match.stage = 'awaiting_winner';
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
        if (!advantagePromptAlreadyShown && !await recordConfirmedGameResult(match, client, null)) return;
        storeDelayedGameResult(match, timedOutGameNumber, winnerMention);
        clearPendingResult(match);
        match.loserAdvantagePromptShown = false;
        match.startClickedUserIds = [];
        match.stage = 'awaiting_winner';
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
    const selectedPromptId = block[config.promptIdKey];
    block[config.promptIdKey] = null;

    if (match[config.otherSelectedKey]) {
        match.stage = 'awaiting_winner';
        queueMatchOutput(match, interaction.client, 'advance_to_winner_control_after_manual_selection', async () => {
            const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
            if (selectedPromptId) {
                await deleteThreadMessage(thread, selectedPromptId);
            }
            await advanceMatchToWinnerControlAfterSelections(match, interaction.client, thread);
        }, {
            source: 'manual_selection',
            required: true,
            kind,
            game: getNextGameNumber(match)
        });
    } else if (selectedPromptId) {
        queueMatchOutput(match, interaction.client, 'cleanup_setup_selection_prompt', async () => {
            const thread = await interaction.client.channels.fetch(match.threadId).catch(() => null);
            await deleteThreadMessage(thread, selectedPromptId);
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

    queueMatchOutput(match, interaction.client, 'post_visible_setup_selection_control_after_start', async () => {
        await postVisibleSetupSelectionControls(match, interaction.client, [config.player], {
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

    const privatePrompt = await deliverPrivateInteractionPayload(interaction, {
        content: config.renderPrompt(match),
        components: config.buildRows(match, options)
    }, `${config.player} start setup`);
    if (!privatePrompt) {
        logRatedWarn(interaction.client, match, 'setup.start_retry_required', getMatchLogDetails(match, {
            user: interaction.user.id,
            player: config.player,
            fallback: 'thread_selection_control'
        }));
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

    await reconcileActiveMatchControls(client);

    const matches = [...state.activeMatchesById.values()];
    for (const match of matches) {
        if (!match.timeoutPhase || now < match.timeoutDeadlineAt) {
            continue;
        }
        if (match.timeoutPhase === 'loser_confirmation' || match.timeoutPhase === 'loser_advantage') {
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
    await runPendingCompetitiveDbOps(client).catch(error => {
        logRatedError(client, { all: true }, 'competitive_db.pending_recovery_failed', error);
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
    await prewarmOptionsForPanelGameTypes(client);
    try {
        await recoverRuntimeState(client);
    } catch (err) {
        console.error(`[RatedQueue] Runtime state recovery failed: ${err.message}`);
        logRatedError(client, { all: true }, 'runtime_state.recovery_failed', err);
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
    try {
        await runPendingCompetitiveDbOps(client);
    } catch (err) {
        console.error(`[RatedQueue] Pending Competitive DB op recovery failed: ${err.message}`);
        logRatedError(client, { all: true }, 'competitive_db.pending_recovery_initial_failed', err);
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
    clearPendingRematches();
    clearRuntimeLogTimers();

    state.activeMatchesById.clear();
    state.activeMatchesByThreadId.clear();
    state.activeMatchesByUserId.clear();
    scheduleRuntimeStatePersist('queue_reset');
    state.reportableMatchesById.clear();
    state.panelMetaByChannelId.clear();
    state.cachedOptionsByGameType.clear();
    state.operationQueues.clear();
    state.outputQueuesByMatchId.clear();
    state.outputQueueMetaByMatchId.clear();
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

    if (!isQueueSearchEnabled()) {
        await safeReply(interaction, {
            content: 'Rated queue search is currently disabled. Please try again later.',
            ephemeral: true
        });
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

async function beginPendingRematch(interaction, snapshot, initiatorParticipant, requiredResponders) {
    const busyReason = getCompetitiveRatedBusyReason(interaction.user.id);
    if (busyReason) {
        await safeReply(interaction, {
            content: `Rematch cannot be requested: ${busyReason}`,
            components: [],
            ephemeral: true
        });
        return true;
    }

    const expiresAt = Date.now() + REMATCH_CONFIRM_TIMEOUT_MS;
    const pending = {
        matchId: snapshot.id,
        snapshot,
        initiatorId: interaction.user.id,
        initiatorInteraction: interaction,
        initiatorTeamNumber: initiatorParticipant.teamNumber,
        requiredResponderIds: requiredResponders.map(participant => participant.id),
        expiresAt
    };

    state.pendingRematchesByMatchId.set(snapshot.id, pending);
    state.rematchInitiatorsByUserId.set(interaction.user.id, snapshot.id);
    setCompletedThreadFinalizationDeadline(snapshot, expiresAt);
    scheduleRematchTimeout(pending, interaction.client);

    const thread = await interaction.client.channels.fetch(snapshot.threadId).catch(() => null);
    await thread?.send?.({
        content: renderRematchWaitingMessage(snapshot, initiatorParticipant, requiredResponders, expiresAt),
        allowedMentions: {
            users: [initiatorParticipant.id, ...pending.requiredResponderIds]
        }
    }).catch(error => {
        logRatedWarn(interaction.client, snapshot, 'rematch.waiting_message_failed', getMatchLogDetails(snapshot, {
            error: error.message
        }));
    });

    logRatedInfo(interaction.client, snapshot, 'rematch.requested', getMatchLogDetails(snapshot, {
        initiator: interaction.user.id,
        responders: pending.requiredResponderIds.join(',')
    }));
    await safeReply(interaction, {
        content: `Rematch requested. Waiting for ${requiredResponders.map(participant => participant.mention ?? `<@${participant.id}>`).join(' ')}.`,
        components: [],
        ephemeral: true
    });
    return true;
}

async function startConfirmedRematch(interaction, pending) {
    const snapshot = pending.snapshot;
    const participantIds = getRematchParticipantIds(snapshot);
    const activeMatchUserId = getActiveMatchUserId(participantIds);
    if (activeMatchUserId) {
        clearPendingRematch(snapshot.id);
        await finalizeCompletedThreadFromSnapshot(snapshot, interaction.client, 'rematch_aborted_active_match');
        await safeReply(interaction, {
            content: `Rematch cancelled because <@${activeMatchUserId}> is already in an active match.`,
            components: [],
            ephemeral: true
        });
        return true;
    }

    const conflictingRematchUserId = participantIds.find(userId => {
        const pendingMatchId = state.rematchInitiatorsByUserId.get(userId);
        return pendingMatchId && pendingMatchId !== snapshot.id;
    });
    if (conflictingRematchUserId) {
        await safeReply(interaction, {
            content: `Rematch cannot start because <@${conflictingRematchUserId}> is waiting for another rematch confirmation.`,
            components: [],
            ephemeral: true
        });
        return true;
    }

    clearPendingRematch(snapshot.id);
    await closeActiveSearchesForRematch(participantIds, interaction.client);

    const panelConfig = getRematchPanelConfig(snapshot);
    if (!panelConfig) {
        restoreCompletedThreadFinalization(snapshot, interaction.client, 'rematch_missing_panel');
        await safeReply(interaction, {
            content: 'Rematch cannot start because the rated panel channel is not configured.',
            components: [],
            ephemeral: true
        });
        return true;
    }

    let rematch = null;
    try {
        const searches = await buildRematchSearches(snapshot, panelConfig);
        const teamsOverride = buildFixedRematchTeams(snapshot, searches);
        rematch = await createCompetitiveRatedMatch(panelConfig, searches, interaction.client, {
            skipReconcile: false,
            firstToOverride: getRematchFirstTo(snapshot),
            teamsOverride
        });
    } catch (error) {
        logRatedError(interaction.client, snapshot, 'rematch.start_failed', error, getMatchLogDetails(snapshot));
    }

    if (!rematch) {
        restoreCompletedThreadFinalization(snapshot, interaction.client, 'rematch_start_failed');
        await safeReply(interaction, {
            content: 'Could not start the rematch. You can join the Search Pool again.',
            components: [],
            ephemeral: true
        });
        return true;
    }

    const oldThread = await interaction.client.channels.fetch(snapshot.threadId).catch(() => null);
    await oldThread?.send?.({
        content: `${BL_CHECK_EMOJI} Rematch confirmed. New match thread: ${rematch.threadUrl}`
    }).catch(() => {});
    const rematchFoundPayload = buildMatchFoundPayload(
        rematch.mode,
        rematch.threadUrl,
        getMatchParticipantMentions(rematch)
    );
    await deliverPrivateInteractionPayload(
        pending.initiatorInteraction,
        rematchFoundPayload,
        'rematch match found notification'
    );
    await finalizeCompletedThreadFromSnapshot(snapshot, interaction.client, 'rematch_confirmed');
    logRatedInfo(interaction.client, snapshot, 'rematch.started', getMatchLogDetails(snapshot, {
        newMatch: rematch.id,
        newThread: rematch.threadId,
        confirmedBy: interaction.user.id
    }));
    await safeReply(interaction, {
        ...rematchFoundPayload,
        ephemeral: true
    });
    return true;
}

async function handleRematchInteraction(interaction) {
    const matchId = parseIdFromCustomId(interaction.customId);
    if (!await ensureDeferredReply(interaction)) {
        return true;
    }

    return await withInteractionLock(`rematch:${matchId}`, async () => {
        if (!isQueueSearchEnabled()) {
            await safeReply(interaction, {
                content: 'Rated queue search is currently disabled. Please try again later.',
                ephemeral: true
            });
            return true;
        }

        const snapshot = await getReportableMatchSnapshot(matchId, interaction.client);
        if (!snapshot || !isReportableMatch(snapshot)) {
            await safeReply(interaction, {
                content: 'Rematch is no longer available for this match.',
                components: [],
                ephemeral: true
            });
            return true;
        }

        const participant = findSnapshotParticipant(snapshot, interaction.user.id);
        if (!participant) {
            await safeReply(interaction, {
                content: 'Only players from this match can request a rematch.',
                components: [],
                ephemeral: true
            });
            return true;
        }
        if (!isEligibleRematchParticipant(snapshot, participant)) {
            await safeReply(interaction, {
                content: 'Only the team representatives from this match can request a 2v2 rematch.',
                components: [],
                ephemeral: true
            });
            return true;
        }

        const pending = state.pendingRematchesByMatchId.get(matchId);
        if (pending) {
            if (Date.now() >= pending.expiresAt) {
                await expirePendingRematchUnlocked(matchId, interaction.client);
                await safeReply(interaction, {
                    content: 'Rematch is no longer available for this match.',
                    components: [],
                    ephemeral: true
                });
                return true;
            }
            if (interaction.user.id === pending.initiatorId) {
                await safeReply(interaction, {
                    content: 'Waiting for the other side to confirm the rematch.',
                    components: [],
                    ephemeral: true
                });
                return true;
            }
            if (!pending.requiredResponderIds.includes(interaction.user.id)) {
                await safeReply(interaction, {
                    content: 'Only the other side can confirm this rematch request.',
                    components: [],
                    ephemeral: true
                });
                return true;
            }
            return await startConfirmedRematch(interaction, pending);
        }

        if (!isRematchWindowOpen(snapshot)) {
            await safeReply(interaction, {
                content: 'Rematch is no longer available for this match.',
                components: [],
                ephemeral: true
            });
            return true;
        }

        const requiredResponders = getRequiredRematchResponders(snapshot, participant);
        if (requiredResponders.length === 0) {
            await safeReply(interaction, {
                content: 'Rematch cannot be requested because the other side could not be identified.',
                components: [],
                ephemeral: true
            });
            return true;
        }

        return await beginPendingRematch(interaction, snapshot, participant, requiredResponders);
    });
}

async function handleMatchInteraction(interaction) {
    const matchId = parseIdFromCustomId(interaction.customId);
    const matchAction = interaction.customId.split(':')[3];
    if (matchAction === 'report_issue') {
        return await handleReportIssueInteraction(interaction);
    }
    if (matchAction === 'rematch') {
        return await handleRematchInteraction(interaction);
    }

    const match = state.activeMatchesById.get(matchId);
    if (!match) {
        await silentlyAcknowledgeInteraction(interaction);
        return true;
    }

    const lockKey = `match:${match.id}`;
    const interactionReceivedAt = Date.now();

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
            if (
                match.timeoutPhase
                && !['loser_confirmation', 'loser_advantage'].includes(match.timeoutPhase)
                && Date.now() >= match.timeoutDeadlineAt
            ) {
                await ensureDeferredUpdate(interaction);
                await cancelMatchForInactivity(match, match.timeoutPhase, interaction.client);
                return true;
            }
            return false;
        },
        onReceived: async () => {
            logRatedInfo(interaction.client, match, 'match.transition.interaction_received', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id
            }));
        },
        onAckFailed: async () => {
            logRatedWarn(interaction.client, match, 'match.transition.ack_failed', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id,
                error: interaction.__ratedAckError?.message
            }));
        },
        onAcked: async () => {
            logRatedInfo(interaction.client, match, 'match.transition.ack_done', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id,
                ackMs: Date.now() - interactionReceivedAt
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
            scheduleRuntimeStatePersist(`interaction:${matchAction}`);
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
    if (runtimeStatePersistTimer) {
        clearTimeout(runtimeStatePersistTimer);
        runtimeStatePersistTimer = null;
    }
    runtimeStatePersistPromise = Promise.resolve();
    runtimeStateRecovered = false;

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
    state.pendingCompetitiveDbOpsByKey.clear();
    state.pendingRematchesByMatchId.clear();
    state.rematchInitiatorsByUserId.clear();
    state.rematchTimersByMatchId.clear();
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
    state.outputQueuesByMatchId.clear();
    state.outputQueueMetaByMatchId.clear();
    state.runtimeLogQueuesByThreadId.clear();
}

function __getStateSnapshot() {
    return {
        activeSearchCount: state.activeSearchesById.size,
        activeMatchCount: state.activeMatchesById.size,
        reportableMatchCount: state.reportableMatchesById.size,
        pendingRematchCount: state.pendingRematchesByMatchId.size,
        rematchInitiatorCount: state.rematchInitiatorsByUserId.size,
        rematchTimerCount: state.rematchTimersByMatchId.size,
        completedThreadCloseTimerCount: state.completedThreadCloseTimersByMatchId.size,
        pendingCompletedThreadFinalizationCount: state.pendingCompletedThreadFinalizationsByMatchId.size,
        pendingCompetitiveDbOpCount: state.pendingCompetitiveDbOpsByKey.size,
        panelCount: state.panelMetaByChannelId.size,
        pendingInteractionLockCount: state.operationQueues.size,
        pendingMatchmakingChannelCount: state.pendingMatchmakingChannels.size,
        pendingMatchmakingTimerCount: state.matchmakingTimersByChannelId.size,
        pendingOutputQueueCount: state.outputQueuesByMatchId.size,
        pendingOutputJobCount: [...state.outputQueueMetaByMatchId.values()].reduce((count, meta) => count + (meta.pending ?? 0), 0),
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
    reportableMatches = [],
    pendingCompletedThreadFinalizations = [],
    pendingCompetitiveDbOps = [],
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

    for (const reportableMatch of reportableMatches) {
        state.reportableMatchesById.set(reportableMatch.id, reportableMatch);
    }

    for (const pending of pendingCompletedThreadFinalizations) {
        state.pendingCompletedThreadFinalizationsByMatchId.set(pending.id, pending);
    }

    for (const op of pendingCompetitiveDbOps) {
        state.pendingCompetitiveDbOpsByKey.set(op.key, op);
    }

    for (const [gameType, options] of Object.entries(cachedOptionsByGameType)) {
        state.cachedOptionsByGameType.set(gameType, options);
    }
}

module.exports = {
    __createCompetitiveRatedMatchForTests: createCompetitiveRatedMatch,
    __flushRuntimeLogsForTests: flushRuntimeLogsForTests,
    __flushOutputQueuesForTests: flushMatchOutputQueuesForTests,
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
    normalizeDiscordId,
    renderFinalMatchResultMessage,
    renderGameResultMessage,
    resetCompetitiveRatedQueue
};
