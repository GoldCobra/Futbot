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
    completedThreadCloseTimersByMatchId: new Map(),
    pendingCompletedThreadFinalizationsByMatchId: new Map(),
    cachedOptionsByGameType: new Map(),
    operationQueues: new Map(),
    pendingMatchmakingChannels: new Set(),
    matchmakingTimersByChannelId: new Map(),
    panelStatusRefreshTimersByChannelId: new Map(),
    runtimeLogQueuesByThreadId: new Map(),
    runtimeLogBuffersByThreadId: new Map(),
    runtimeLogFlushTimersByThreadId: new Map(),
    runtimeLogCleanupTimer: null
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

module.exports = {
    clearCompletedThreadCloseTimer,
    clearCompletedThreadCloseTimers,
    clearPendingCompletedThreadFinalizations,
    state,
    withInteractionLock,
    withOperationQueue
};
