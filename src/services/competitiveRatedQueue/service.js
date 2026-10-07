const { recoverPendingCompetitiveWhrSync } = require('../competitiveRating');
const { runPendingCompetitiveWhrRunner } = require('../competitiveWhrRunner');
const RatedMatchDao = require('../../db/daos/ratedMatchDao');
const ratedMatchDao = new RatedMatchDao();
const { CANCELLED_THREAD_PREFIX, CONFIG } = require('./constants');
const { buildThreadUrl } = require('./formatting');
const {
    clearCompletedThreadCloseTimers,
    clearPendingCompletedThreadFinalizations,
    clearPendingRematches,
    state,
    withOperationQueue
} = require('./state');
const { getGameImagePath } = require('./messages');
const {
    applyLoserChoice,
    areSinglesSearchesCompatible,
    buildBalancedDoublesTeams,
    computeFirstTo
} = require('./matchLogic');
const {
    clearRuntimeLogTimers,
    flushRuntimeLogs,
    logRatedError,
    logRatedInfo,
    logRatedWarn,
    runRatedRuntimeLogCleanup,
    startRatedRuntimeLogCleanupLoop
} = require('./runtimeLogger');
const { isRuntimeStateEnabled, loadCompetitiveRatedRuntimeState } = require('./runtimeState');
const { isTerminalStage } = require('./matchTransitions');
const { isReportableMatch } = require('./terminalFlow');
const {
    buildPanelMessage,
    buildStatusMessageContent,
    enforcePanelMessagePolicy,
    isManagedPanelChannel,
    reconcilePanelChannel
} = require('./panel');
const {
    flushMatchOutputQueuesForTests,
    flushRuntimeStatePersist,
    getMatchLogDetails,
    resetRuntimePersist,
    scheduleRuntimeStatePersist
} = require('./core');
const {
    buildCompleteCompetitiveDbPayload,
    enqueueCompetitiveDbOp,
    runPendingCompetitiveDbOps
} = require('./dbOps');
const {
    finalizeOverdueCompletedThreads,
    finalizeThreadLifecycle,
    recoverCompletedThreadFinalizations,
    scheduleCompletedThreadClose
} = require('./threadLifecycle');
const {
    buildCancelMatchDbPayload,
    buildCaptainSelectionConfirmationPayload,
    buildInitialGameSetupPayloads,
    buildMatchComponents,
    buildStadiumSelectionConfirmationPayload,
    buildStartPayload,
    cancelMatchIfTimedOut,
    clearMatchTimers,
    getOptionsForGameType,
    handleRatedMatchCancelFailure,
    postInitialGameSetup,
    renderFinalMatchResultMessage,
    renderGameResultMessage,
    resolveLoserConfirmationIfTimedOut
} = require('./matchFlow');
const {
    buildLeavePoolLabel,
    buildMatchFoundPayload,
    buildSearchExpiredPayload,
    buildSearchExpiryWarningPayload,
    clearMatchedInteractionResponse,
    clearMatchmakingRetryTimers,
    clearSearchTimers,
    closeSearch,
    createCompetitiveRatedMatch,
    getCompetitiveRatedBusyReason,
    getPlayerQueueProfile,
    isUserInLiveQueue,
    normalizeDiscordId,
    removeSearchFromState,
    tryCreateMatches,
    warnSearchAboutExpiry
} = require('./matchmaking');
const { reconcileActiveMatchControls } = require('./watchdog');
const { handleAutomaticSeasonTransitions } = require('./season');
const { handleInteraction, isCompetitiveRatedInteraction } = require('./interactionRouter');
const { logBackgroundJobError, startDbOutageLog, stopDbOutageLog } = require('./dbOutage');

let runtimeStateRecovered = false;

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
    let restoredDbOps = 0;
    for (const op of runtimeState.pendingCompetitiveDbOps) {
        if (!state.pendingCompetitiveDbOpsByKey.has(op.key)) {
            state.pendingCompetitiveDbOpsByKey.set(op.key, op);
            restoredDbOps += 1;
        }
    }

    let restoredMatches = 0;
    let interruptedMatches = 0;
    for (const match of runtimeState.activeMatches) {
        if (state.activeMatchesById.has(match.id)) {
            continue;
        }
        if (isTerminalStage(match.stage)) {
            await recoverInterruptedTerminalMatch(match, client);
            interruptedMatches += 1;
            continue;
        }
        restoreRuntimeMatchIndexes(match);
        restoredMatches += 1;
        logRatedWarn(client, match, 'runtime_state.match_recovered', getMatchLogDetails(match, {
            recoveredTimeoutPhase: match.recoveredRuntimeTimeoutPhase ?? null,
            recoveredTimeoutDeadlineAt: match.recoveredRuntimeTimeoutDeadlineAt ?? null
        }));
    }

    if (restoredMatches || restoredDbOps || interruptedMatches) {
        logRatedWarn(client, { all: true }, 'runtime_state.recovered', {
            activeMatches: restoredMatches,
            interruptedMatches,
            pendingCompetitiveDbOps: restoredDbOps
        });
        await reconcileActiveMatchControls(client);
        scheduleRuntimeStatePersist('runtime_recovered');
    }
}

// A match reaches the runtime file with a terminal stage only when the bot stopped in the
// middle of completeMatch/cancelMatch. Its players are released right away; the one-time DB
// write is finished through the idempotent pending-write queue and the thread is closed.
async function recoverInterruptedTerminalMatch(match, client) {
    logRatedWarn(client, match, 'runtime_state.interrupted_terminal_match', getMatchLogDetails(match, {
        cancelReason: match.cancelReason ?? null
    }));
    if (match.stage === 'complete') {
        if (match.ratedMatchId && isReportableMatch(match) && !match.competitiveDbFailed) {
            const winnerTeamNumber = match.score.team1 >= match.firstTo ? 1 : 2;
            enqueueCompetitiveDbOp(
                'complete_competitive',
                buildCompleteCompetitiveDbPayload(match, winnerTeamNumber),
                match,
                client,
                'runtime_recovered_completion'
            );
        }
        scheduleCompletedThreadClose(match, client);
        return;
    }

    if (match.cancelReason && match.ratedMatchId) {
        enqueueCompetitiveDbOp('cancel_match', buildCancelMatchDbPayload(match, match.cancelReason), match, client, 'runtime_recovered_cancel');
    }
    await finalizeThreadLifecycle(match, client, {
        prefix: CANCELLED_THREAD_PREFIX,
        closeReason: `${match.gameType} competitive match cancel recovery`,
        renameReason: `${match.gameType} competitive match cancel recovery rename`,
        result: 'cancelled',
        source: 'runtime_recovery'
    });
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

async function reconcileAllPanels(client) {
    for (const panelConfig of CONFIG.PANEL_CHANNELS) {
        const lockKey = `reconcile:${panelConfig.channelId}`;
        if (state.operationQueues.has(lockKey)) { continue; }
        await withOperationQueue(lockKey, async () => {
            await reconcilePanelChannel(client, panelConfig);
        });
    }
}

function summarizeWhrGame(game) {
    const written = game.historyInserted + game.historyUpdated + game.historyDeleted + game.ratingsUpdated;
    return `${game.gameType}:${game.reason}:matches=${game.matches}:players=${game.players}:written=${written}:sync=${game.syncRows}:${game.durationMs}ms`;
}

async function recoverPendingCompetitiveWhrRunner(client) {
    const result = await runPendingCompetitiveWhrRunner?.();
    const changedGames = (result?.games ?? []).filter(game => (
        game.historyInserted + game.historyUpdated + game.historyDeleted + game.ratingsUpdated + game.syncRows > 0
    ));
    const legacyStatsRows = result?.legacyStats?.stampedRows ?? 0;
    if (changedGames.length || legacyStatsRows > 0 || result?.tstRows > 0) {
        logRatedInfo(client, { all: true }, 'whr.recalc_complete', {
            games: changedGames.map(summarizeWhrGame).join(',') || 'unchanged',
            legacyStats: `${legacyStatsRows}:1v1=${result?.legacyStats?.countedSingles ?? 0}:2v2=${result?.legacyStats?.countedDoubles ?? 0}`,
            tstRows: result?.tstRows ?? 0
        });
    }
    return result;
}

// The recalculation runs beside the match engine: ticks never wait for it, and at most one run is active.
let competitiveWhrRunInFlight = null;

function scheduleCompetitiveWhrRunner(client, failureEvent) {
    if (!competitiveWhrRunInFlight) {
        competitiveWhrRunInFlight = recoverPendingCompetitiveWhrRunner(client)
            .catch(error => {
                console.error(`[RatedQueue] WHR recalculation failed: ${error.message}`);
                logBackgroundJobError(client, failureEvent, error);
            })
            .finally(() => {
                competitiveWhrRunInFlight = null;
            });
    }
    return competitiveWhrRunInFlight;
}

// Snapshots of finished matches serve Report Issue and Rematch. Old ones are rebuilt from the DB
// on demand, so they are dropped after a week unless an issue post or a rematch still uses them.
const REPORTABLE_MATCH_RETENTION_MS = 7 * 24 * 60 * 60_000;

function pruneReportableMatches(now) {
    for (const [matchId, snapshot] of state.reportableMatchesById) {
        if (snapshot.issueThreadId || state.pendingRematchesByMatchId.has(matchId)) {
            continue;
        }
        if (now - (snapshot.completedAtMs ?? now) > REPORTABLE_MATCH_RETENTION_MS) {
            state.reportableMatchesById.delete(matchId);
        }
    }
}

async function tick(client) {
    const now = Date.now();
    pruneReportableMatches(now);
    await handleAutomaticSeasonTransitions(client).catch(error => {
        logBackgroundJobError(client, 'season.transition_failed', error);
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
        logBackgroundJobError(client, 'thread.finalize_recovery_failed', error);
    });
    await recoverPendingCompetitiveWhrSync?.().catch(error => {
        logBackgroundJobError(client, 'whr.sync_recovery_failed', error);
    });
    scheduleCompetitiveWhrRunner(client, 'whr.runner_recovery_failed');
    await runPendingCompetitiveDbOps(client).catch(error => {
        logBackgroundJobError(client, 'competitive_db.pending_recovery_failed', error);
    });
    await finalizeOverdueCompletedThreads(client, now);
    await reconcileAllPanels(client);
}

// A slow tick (season finalization, a guild-wide rank role sweep) must not overlap the next one.
let tickInFlight = false;

function startReconcileLoop(client) {
    if (state.reconcileTimer) {
        return;
    }

    state.reconcileTimer = setInterval(() => {
        if (tickInFlight) {
            return;
        }
        tickInFlight = true;
        tick(client)
            .catch(error => {
                console.error(`Competitive pool tick failed: ${error.message}`);
                logBackgroundJobError(client, 'queue.tick_failed', error);
            })
            .finally(() => {
                tickInFlight = false;
            });
    }, CONFIG.STATUS_RECONCILE_INTERVAL_MS);
}

async function ensureCompetitiveRatedQueue(client) {
    state.client = client;
    startDbOutageLog(client);
    startReconcileLoop(client);
    startRatedRuntimeLogCleanupLoop(client);
    for (const panelConfig of CONFIG.PANEL_CHANNELS) {
        logRatedInfo(client, panelConfig, 'queue.started', { channel: panelConfig.channelId });
    }
    let finishRuntimeRecovery = null;
    if (!runtimeStateRecovered && isRuntimeStateEnabled()) {
        state.runtimeRecoveryInFlight = new Promise(resolve => {
            finishRuntimeRecovery = resolve;
        });
    }
    try {
        await prewarmOptionsForPanelGameTypes(client);
        await recoverRuntimeState(client);
    } catch (err) {
        console.error(`[RatedQueue] Runtime state recovery failed: ${err.message}`);
        logRatedError(client, { all: true }, 'runtime_state.recovery_failed', err);
    } finally {
        if (finishRuntimeRecovery) {
            finishRuntimeRecovery();
            state.runtimeRecoveryInFlight = null;
        }
    }
    for (const meta of state.panelMetaByChannelId.values()) {
        meta.channelLockApplied = false;
    }
    try {
        await handleAutomaticSeasonTransitions(client);
    } catch (err) {
        console.error(`[RatedQueue] Season transition recovery failed: ${err.message}`);
        logBackgroundJobError(client, 'season.transition_recovery_failed', err);
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
        logBackgroundJobError(client, 'thread.finalize_recovery_initial_failed', err);
    }
    try {
        await recoverPendingCompetitiveWhrSync?.();
    } catch (err) {
        console.error(`[RatedQueue] WHR/TST sync recovery failed: ${err.message}`);
        logBackgroundJobError(client, 'whr.sync_recovery_initial_failed', err);
    }
    scheduleCompetitiveWhrRunner(client, 'whr.runner_recovery_initial_failed');
    try {
        await runPendingCompetitiveDbOps(client);
    } catch (err) {
        console.error(`[RatedQueue] Pending Competitive DB op recovery failed: ${err.message}`);
        logBackgroundJobError(client, 'competitive_db.pending_recovery_initial_failed', err);
    }
}

// Staff escape hatch (/ratedreset): drops every search and live match from memory, including
// stuck operation queues. Results waiting in the pending-write queue are kept; the DB rows of
// the dropped matches are cancelled ('staff_reset') so they do not stay active until season end.
// Shutdown (SIGTERM from docker compose): stops the queue's timers, sends buffered log lines and
// saves the runtime state one last time, so the restarted bot resumes from the latest state.
async function stopCompetitiveRatedQueue() {
    if (state.reconcileTimer) {
        clearInterval(state.reconcileTimer);
        state.reconcileTimer = null;
    }
    stopDbOutageLog();
    clearMatchmakingRetryTimers();
    await flushRuntimeLogs().catch(() => {});
    clearRuntimeLogTimers();
    await flushRuntimeStatePersist('shutdown');
}

async function resetCompetitiveRatedQueue(client) {
    const activeSearches = [...state.activeSearchesById.values()];
    for (const search of activeSearches) {
        clearSearchTimers(search);
        removeSearchFromState(search);
    }

    const droppedMatches = [...state.activeMatchesById.values()];
    for (const match of droppedMatches) {
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
    clearMatchmakingRetryTimers();
    for (const timer of state.panelStatusRefreshTimersByChannelId.values()) {
        clearTimeout(timer);
    }
    state.panelStatusRefreshTimersByChannelId.clear();
    state.runtimeLogQueuesByThreadId.clear();

    for (const match of droppedMatches) {
        if (!match.ratedMatchId) {
            continue;
        }
        await ratedMatchDao.cancelMatch({ matchCode: match.id, cancelReason: 'staff_reset' })
            .catch(err => handleRatedMatchCancelFailure(match, client, 'staff_reset', err));
    }
    if (droppedMatches.length) {
        logRatedWarn(client, { all: true }, 'queue.reset_matches_cancelled', {
            matches: droppedMatches.map(match => match.id)
        });
    }

    startRatedRuntimeLogCleanupLoop(client);
    await reconcileAllPanels(client);
}

function __resetState() {
    if (state.reconcileTimer) {
        clearInterval(state.reconcileTimer);
        state.reconcileTimer = null;
    }
    resetRuntimePersist();
    stopDbOutageLog();
    runtimeStateRecovered = false;
    state.runtimeRecoveryInFlight = null;
    tickInFlight = false;
    competitiveWhrRunInFlight = null;

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
    clearMatchmakingRetryTimers();
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
    __flushRuntimeLogsForTests: flushRuntimeLogs,
    __flushOutputQueuesForTests: flushMatchOutputQueuesForTests,
    __getStateSnapshot,
    __postInitialGameSetupForTests: postInitialGameSetup,
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
    resetCompetitiveRatedQueue,
    stopCompetitiveRatedQueue
};
