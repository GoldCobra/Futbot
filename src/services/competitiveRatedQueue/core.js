const crypto = require('node:crypto');

const { logRatedError } = require('./runtimeLogger');
const { isRuntimeStateEnabled, saveCompetitiveRatedRuntimeState } = require('./runtimeState');
const { state } = require('./state');

const RUNTIME_STATE_SAVE_DELAY_MS = 250;
let runtimeStatePersistTimer = null;
let runtimeStatePersistPromise = Promise.resolve();

function createId() {
    return crypto.randomBytes(6).toString('hex');
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

// Per-match serialized output queue: thread sends/edits for a match always run in
// order, independent of the per-match interaction lock, so out-of-order Discord
// writes cannot interleave. Failures are logged but never reject the chain.
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

function hasPendingMatchOutput(match) {
    const meta = state.outputQueueMetaByMatchId.get(String(match?.id));
    return Boolean(meta?.pending);
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

function resetRuntimePersist() {
    if (runtimeStatePersistTimer) {
        clearTimeout(runtimeStatePersistTimer);
        runtimeStatePersistTimer = null;
    }
    runtimeStatePersistPromise = Promise.resolve();
}

module.exports = {
    buildRuntimeStateSnapshotForPersist,
    createId,
    flushMatchOutputQueuesForTests,
    flushRuntimeStatePersist,
    getMatchLogDetails,
    getMatchOutputMeta,
    getSearchLogDetails,
    hasPendingMatchOutput,
    queueMatchOutput,
    resetRuntimePersist,
    scheduleRuntimeStatePersist
};
