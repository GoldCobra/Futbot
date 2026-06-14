const state = {
    client: null,
    reconcileTimer: null,
    panelMetaByChannelId: new Map(),
    activeSearchesById: new Map(),
    activeSearchesByUserId: new Map(),
    activeMatchesById: new Map(),
    activeMatchesByThreadId: new Map(),
    activeMatchesByUserId: new Map(),
    reportableMatchesById: new Map(),
    pendingRematchesByMatchId: new Map(),
    rematchInitiatorsByUserId: new Map(),
    rematchTimersByMatchId: new Map(),
    completedThreadCloseTimersByMatchId: new Map(),
    pendingCompletedThreadFinalizationsByMatchId: new Map(),
    pendingCompetitiveDbOpsByKey: new Map(),
    cachedOptionsByGameType: new Map(),
    operationQueues: new Map(),
    pendingMatchmakingChannels: new Set(),
    matchmakingTimersByChannelId: new Map(),
    panelStatusRefreshTimersByChannelId: new Map(),
    outputQueuesByMatchId: new Map(),
    outputQueueMetaByMatchId: new Map(),
    runtimeLogQueuesByThreadId: new Map(),
    runtimeLogBuffersByThreadId: new Map(),
    runtimeLogFlushTimersByThreadId: new Map(),
    runtimeLogCleanupTimer: null,
    queueSearchEnabled: true
};

async function withOperationQueue(scopeKey, callback) {
    const previous = state.operationQueues.get(scopeKey) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(callback);
    const cleanup = queued.finally(() => {
        if (state.operationQueues.get(scopeKey) === cleanup) {
            state.operationQueues.delete(scopeKey);
        }
    });

    state.operationQueues.set(scopeKey, cleanup);
    return await queued;
}

async function withInteractionLock(lockKey, callback) {
    return await withOperationQueue(lockKey, callback);
}

function clearCompletedThreadCloseTimer(matchId) {
    const timer = state.completedThreadCloseTimersByMatchId.get(matchId);
    if (timer) {
        clearTimeout(timer);
        state.completedThreadCloseTimersByMatchId.delete(matchId);
    }
}

function clearCompletedThreadCloseTimers() {
    for (const timer of state.completedThreadCloseTimersByMatchId.values()) {
        clearTimeout(timer);
    }
    state.completedThreadCloseTimersByMatchId.clear();
}

function clearPendingCompletedThreadFinalizations() {
    state.pendingCompletedThreadFinalizationsByMatchId.clear();
}

function clearRematchTimer(matchId) {
    const timer = state.rematchTimersByMatchId.get(matchId);
    if (timer) {
        clearTimeout(timer);
        state.rematchTimersByMatchId.delete(matchId);
    }
}

function clearPendingRematch(matchId) {
    const pending = state.pendingRematchesByMatchId.get(matchId);
    clearRematchTimer(matchId);
    if (pending?.initiatorId) {
        state.rematchInitiatorsByUserId.delete(pending.initiatorId);
    }
    state.pendingRematchesByMatchId.delete(matchId);
}

function clearPendingRematches() {
    for (const matchId of state.pendingRematchesByMatchId.keys()) {
        clearPendingRematch(matchId);
    }
    for (const timer of state.rematchTimersByMatchId.values()) {
        clearTimeout(timer);
    }
    state.rematchTimersByMatchId.clear();
    state.rematchInitiatorsByUserId.clear();
}

function isQueueSearchEnabled() {
    return state.queueSearchEnabled === true;
}

function setQueueSearchEnabled(value) {
    state.queueSearchEnabled = value === true;
}

module.exports = {
    clearCompletedThreadCloseTimer,
    clearCompletedThreadCloseTimers,
    clearPendingCompletedThreadFinalizations,
    clearPendingRematch,
    clearPendingRematches,
    clearRematchTimer,
    isQueueSearchEnabled,
    setQueueSearchEnabled,
    state,
    withInteractionLock,
    withOperationQueue
};
