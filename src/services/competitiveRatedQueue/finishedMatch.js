// The two buttons of a finished match: Rematch (both sides confirm, a new match with the same
// teams starts) and Report Issue (one staff post per match).
const { safeReply } = require('../../utils/discord');
const RatedMatchDao = require('../../db/daos/ratedMatchDao');
const ratedMatchDao = new RatedMatchDao();
const {
    BL_CHECK_EMOJI,
    BL_TIME_EMOJI,
    CONFIG,
    DEFAULT_POOL_DURATION_MINUTES,
    REMATCH_CONFIRM_TIMEOUT_MS
} = require('./constants');
const { parseIdFromCustomId } = require('./customIds');
const { renderTimedMessage } = require('./formatting');
const {
    clearPendingRematch,
    clearRematchTimer,
    isQueueSearchEnabled,
    state,
    withInteractionLock
} = require('./state');
const { ensureDeferredReply, silentlyAcknowledgeInteraction } = require('./interactions');
const {
    logRatedError,
    logRatedInfo,
    logRatedWarn
} = require('./runtimeLogger');
const { deliverPrivateInteractionPayload } = require('./privatePrompts');
const { createIssueReportPost, isReportableMatch } = require('./terminalFlow');
const {
    getPanelConfigByChannelId,
    getPanelConfigByGameType,
    schedulePanelStatusRefresh
} = require('./panel');
const { createId, getMatchLogDetails } = require('./core');
const {
    finalizeCompletedThreadFromSnapshot,
    isRematchWindowOpen,
    restoreCompletedThreadFinalization,
    setCompletedThreadFinalizationDeadline
} = require('./threadLifecycle');
const {
    buildMatchFoundPayload,
    closeSearch,
    createCompetitiveRatedMatch,
    getCompetitiveRatedBusyReason,
    getMatchParticipantMentions,
    getPlayerQueueProfile
} = require('./matchmaking');

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

module.exports = {
    handleRematchInteraction,
    handleReportIssueInteraction
};
