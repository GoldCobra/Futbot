// Automatic season transitions on the tick: ending (searches closed), finalization (running
// matches cancelled, their threads closed) and activation (competitive rank roles cleared).
const {
    activateDueSeason,
    beginDueSeasonEnding,
    clearAllCompetitiveRankRoles,
    finalizeDueEndingSeason
} = require('../competitiveRating');
const {
    BL_X_EMOJI,
    CANCELLED_THREAD_PREFIX,
    CONSTANTS
} = require('./constants');
const { quoteThreadLines } = require('./formatting');
const { state } = require('./state');
const {
    logRatedError,
    logRatedInfo,
    logRatedWarn
} = require('./runtimeLogger');
const { buildCancelledThreadSnapshotFromDb, finalizeThreadLifecycle } = require('./threadLifecycle');
const {
    cancelMatch,
    postTerminalThreadNotice,
    renderMatchCancelledNoticeMessage
} = require('./matchFlow');
const { closeAllSearchesForSeasonEnd } = require('./matchmaking');

function renderSeasonEndCancelMessage() {
    return quoteThreadLines(
        `${BL_X_EMOJI} Season ended. The match was cancelled because the season finalization grace period expired.`
    );
}

async function cancelInMemoryMatchForSeasonEnd(match, client) {
    // The season finalization transaction already flipped the DB row, so no cancelReason here.
    await cancelMatch(match, client, {
        cancelReason: null,
        reasonMessage: renderSeasonEndCancelMessage(),
        closeReason: `${match.gameType} competitive match cancelled by season end`,
        renameReason: `${match.gameType} competitive match season-end rename`,
        source: 'season_end',
        logEvent: 'match.season_end_cancelled',
        logDetails: { reason: 'season_end_cancelled' }
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
        cancelledMatches: 0,
        clearedRankRoles: null
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

            // Best-effort: the season is already active in the DB, so a Discord failure here must
            // not fail the transition. It is logged instead and retried on the next activation.
            result.clearedRankRoles = await clearAllCompetitiveRankRoles(client, CONSTANTS.GUILD_ID)
                .catch(error => {
                    logRatedError(client, { all: true }, 'season.rank_roles_clear_failed', error);
                    return null;
                });
            if (result.clearedRankRoles) {
                logRatedWarn(client, { all: true }, 'season.rank_roles_cleared', {
                    season: activatedSeason.Id,
                    members: result.clearedRankRoles.members,
                    roles: result.clearedRankRoles.rolesRemoved,
                    failed: result.clearedRankRoles.failed
                });
            }
        }
    }

    return result;
}

module.exports = {
    handleAutomaticSeasonTransitions
};
