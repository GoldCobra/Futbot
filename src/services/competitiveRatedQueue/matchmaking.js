// Search pools and matchmaking: joining, leaving and extending a pool entry, expiry, and the
// creation of a match (DB header, thread, participants) from compatible searches.
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType
} = require('discord.js');
const { executeQuery, isTransientDbError } = require('../../db/sqlClient');
const {
    fetchChannel,
    safeFollowUp,
    safeReply
} = require('../../utils/discord');
const {
    getActiveSeason,
    getDefaultCompetitiveRating,
    getPlayerRatingForSeason,
    getSeasonQueueAvailability
} = require('../competitiveRating');
const {
    COMP_RANK_EMOJIS,
    COMP_RANK_NAMES,
    PLACEMENT_GAMES_REQUIRED
} = require('../../utils/competitiveConstants');
const RatedMatchDao = require('../../db/daos/ratedMatchDao');
const ratedMatchDao = new RatedMatchDao();
const {
    BL_CHECK_EMOJI,
    BL_X_EMOJI,
    CONFIG,
    CONSTANTS,
    CONTROL_EXPIRY_MESSAGE,
    DEFAULT_POOL_DURATION_MINUTES
} = require('./constants');
const {
    cancelSearchCustomId,
    extendSearchCustomId,
    parseActionTokenFromCustomId,
    parseChannelIdFromCustomId,
    parseIdFromCustomId,
    parseModeFromCustomId
} = require('./customIds');
const {
    buildThreadUrl,
    renderTimedMessage,
    truncateDiscordName
} = require('./formatting');
const {
    isQueueSearchEnabled,
    state,
    withInteractionLock,
    withOperationQueue
} = require('./state');
const {
    ensureDeferredUpdate,
    ensureImmediateReply,
    silentlyAcknowledgeInteraction
} = require('./interactions');
const {
    areSinglesSearchesCompatible,
    buildDoublesTeams,
    buildSinglesTeams,
    computeFirstTo
} = require('./matchLogic');
const { requiresSetup } = require('./matchState');
const {
    logRatedError,
    logRatedInfo,
    logRatedWarn
} = require('./runtimeLogger');
const { deliverPrivateInteractionPayload } = require('./privatePrompts');
const { getPanelConfigByChannelId, schedulePanelStatusRefresh } = require('./panel');
const {
    createId,
    getMatchLogDetails,
    getSearchLogDetails,
    scheduleRuntimeStatePersist
} = require('./core');
const {
    buildDefaultCompetitiveRating,
    postGameImageIfMissing,
    postInitialGameSetup,
    postWinnerControl,
    scheduleSearchTimeout,
    setMatchStage,
    updateMatchControlMessage
} = require('./matchFlow');

function getModeCompactLabel(mode) {
    return mode === '2v2' ? '2vs2' : '1vs1';
}

const SEASON_UNAVAILABLE_MESSAGE = 'Season ended. New Season will start soon.';

const QUEUE_JOIN_SEASON_UNAVAILABLE_MESSAGE = 'Season has not started yet. Rated matches open soon.';

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

function getMatchParticipantMentions(match) {
    return match.teams.flatMap(team => team.members.map(member => member.mention));
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

const MATCHMAKING_RETRY_DELAY_MS = 30_000;

function scheduleMatchmakingRetry(channelId, client) {
    if (state.matchmakingRetryTimersByChannelId.has(channelId)) {
        return;
    }
    const timer = setTimeout(() => {
        state.matchmakingRetryTimersByChannelId.delete(channelId);
        scheduleMatchmaking(channelId, client);
    }, MATCHMAKING_RETRY_DELAY_MS);
    timer.unref?.();
    state.matchmakingRetryTimersByChannelId.set(channelId, timer);
}

function clearMatchmakingRetryTimers() {
    for (const timer of state.matchmakingRetryTimersByChannelId.values()) {
        clearTimeout(timer);
    }
    state.matchmakingRetryTimersByChannelId.clear();
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
    let matchHeader;
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
        // Nothing was written, so the waiting players are tried again once the DB is back
        // instead of only when someone else joins the pool.
        if (isTransientDbError(error)) {
            scheduleMatchmakingRetry(panelConfig.channelId, client);
        }
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
        // Plain arrays/ids so serializeMatch persists them with no extra mapping.
        cancelVoteUserIds: [],
        cancelVoteMessageId: null,
        cancelVoteGameNumber: null,
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

    // The players count as "in a match" before their searches are closed, so no join on
    // another panel can slip in while the searches are being cleaned up.
    const allMemberIds = match.teams.flatMap(team => team.memberIds);
    state.activeMatchesById.set(match.id, match);
    state.activeMatchesByThreadId.set(thread.id, match);
    for (const memberId of allMemberIds) {
        state.activeMatchesByUserId.set(memberId, match);
    }
    scheduleRuntimeStatePersist('match_created');

    for (const search of searches) {
        await closeSearch(search, 'matched', client);
    }

    const participantMentions = getMatchParticipantMentions(match);
    for (const search of searches) {
        search.matchedThreadUrl = threadUrl;
        search.matchmakingReservedBy = null;
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
        setMatchStage(match, 'awaiting_winner', 'no_setup_auto_start');
        await postGameImageIfMissing(match, client, thread);
        await postWinnerControl(match, client, thread);
    }

    if (!skipReconcile) {
        schedulePanelStatusRefresh(panelConfig.channelId, client);
    }

    return match;
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

module.exports = {
    buildLeavePoolLabel,
    buildMatchFoundPayload,
    buildSearchExpiredPayload,
    buildSearchExpiryWarningPayload,
    clearMatchedInteractionResponse,
    clearMatchmakingRetryTimers,
    clearSearchTimers,
    closeAllSearchesForSeasonEnd,
    closeSearch,
    createCompetitiveRatedMatch,
    getCompetitiveRatedBusyReason,
    getMatchParticipantMentions,
    getPlayerQueueProfile,
    handleCancelSearch,
    handleExtendSearch,
    handleJoinButton,
    isUserInLiveQueue,
    normalizeDiscordId,
    removeSearchFromState,
    tryCreateMatches,
    warnSearchAboutExpiry
};
