const {
    RATED_RUNTIME_LOG_CLEANUP_FETCH_LIMIT,
    RATED_RUNTIME_LOG_CLEANUP_INTERVAL_MS,
    RATED_RUNTIME_LOG_INFO_FLUSH_MS,
    RATED_RUNTIME_LOG_MAX_MESSAGE_LENGTH,
    RATED_RUNTIME_LOG_THREADS
} = require('./constants');
const { state } = require('./state');

const LEVEL_LABELS = {
    info: '[info]',
    warn: '⚠️ [warn]',
    error: '❗ [ERROR]'
};

function logRuntimeLoggerError(message) {
    if (process.env.NODE_ENV === 'test') {
        return;
    }
    console.error(message);
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
    return [
        date.getFullYear(),
        pad2(date.getMonth() + 1),
        pad2(date.getDate())
    ].join('-') + ' ' + [
        pad2(date.getHours()),
        pad2(date.getMinutes()),
        pad2(date.getSeconds())
    ].join(':');
}

function truncate(value, maxLength) {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function safeDetailValue(value) {
    if (value == null) {
        return null;
    }

    if (value instanceof Error) {
        return value.message || value.name;
    }

    if (Array.isArray(value)) {
        return value.map(item => safeDetailValue(item)).filter(Boolean).join(',');
    }

    if (typeof value === 'object') {
        return JSON.stringify(value);
    }

    return String(value);
}

function formatDetails(details = {}) {
    if (!details || typeof details !== 'object') {
        return '';
    }

    return Object.entries(details)
        .map(([key, value]) => {
            const safeValue = safeDetailValue(value);
            if (!safeValue) {
                return null;
            }

            return `${key}=${truncate(safeValue, 240)}`;
        })
        .filter(Boolean)
        .join(' ');
}

function getAllLogRoutes() {
    return Object.entries(RATED_RUNTIME_LOG_THREADS).flatMap(([gameType, byMode]) =>
        Object.entries(byMode).map(([mode, threadId]) => ({ gameType, mode, threadId }))
    );
}

function resolveLogRoutes(scope = {}) {
    if (scope.all === true) {
        return getAllLogRoutes();
    }

    const gameType = scope.gameType;
    const mode = scope.mode;

    if (!gameType) {
        return [];
    }

    const byMode = RATED_RUNTIME_LOG_THREADS[gameType];
    if (!byMode) {
        return [];
    }

    if (mode) {
        const threadId = byMode[mode];
        return threadId ? [{ gameType, mode, threadId }] : [];
    }

    return Object.entries(byMode).map(([nextMode, threadId]) => ({
        gameType,
        mode: nextMode,
        threadId
    }));
}

function formatLogLine(level, route, event, details = {}) {
    const label = LEVEL_LABELS[level] ?? LEVEL_LABELS.info;
    const scope = `${route.gameType} ${route.mode}`;
    const detailText = formatDetails(details);
    const line = `${label} ${formatTimestamp()} | ${scope} | ${event}${detailText ? ` | ${detailText}` : ''}`;
    return truncate(line, RATED_RUNTIME_LOG_MAX_MESSAGE_LENGTH);
}

function splitLogLines(lines) {
    const chunks = [];
    let current = '';

    for (const line of lines) {
        if (!current) {
            current = line;
            continue;
        }

        if ((current.length + 1 + line.length) > RATED_RUNTIME_LOG_MAX_MESSAGE_LENGTH) {
            chunks.push(current);
            current = line;
        } else {
            current += `\n${line}`;
        }
    }

    if (current) {
        chunks.push(current);
    }

    return chunks;
}

async function sendLogContent(client, threadId, content) {
    const fetchPromise = client?.channels?.fetch?.(threadId);
    if (!fetchPromise || typeof fetchPromise.catch !== 'function') {
        logRuntimeLoggerError(`[RatedQueueLog] Log thread ${threadId} cannot be fetched: fetch() is unavailable.`);
        return;
    }

    const thread = await fetchPromise.catch(err => {
        logRuntimeLoggerError(`[RatedQueueLog] Failed to fetch log thread ${threadId}: ${err.message}`);
        return null;
    });
    if (!thread?.send) {
        logRuntimeLoggerError(`[RatedQueueLog] Log thread ${threadId} is unavailable.`);
        return;
    }

    await thread.send({
        content,
        allowedMentions: { parse: [] }
    }).catch(err => {
        logRuntimeLoggerError(`[RatedQueueLog] Failed to send log to ${threadId}: ${err.message}`);
    });
}

function queueLogContents(client, threadId, contents) {
    if (!client || !threadId || contents.length === 0) {
        return;
    }

    const previous = state.runtimeLogQueuesByThreadId.get(threadId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(async () => {
        for (const content of contents) {
            await sendLogContent(client, threadId, content);
        }
    });
    const cleanup = queued.finally(() => {
        if (state.runtimeLogQueuesByThreadId.get(threadId) === cleanup) {
            state.runtimeLogQueuesByThreadId.delete(threadId);
        }
    });

    state.runtimeLogQueuesByThreadId.set(threadId, cleanup);
}

function queueLogLines(client, threadId, lines) {
    queueLogContents(client, threadId, splitLogLines(lines));
}

function flushInfoBuffer(threadId) {
    const buffer = state.runtimeLogBuffersByThreadId.get(threadId);
    if (!buffer || buffer.lines.length === 0) {
        return;
    }

    state.runtimeLogBuffersByThreadId.delete(threadId);
    const timer = state.runtimeLogFlushTimersByThreadId.get(threadId);
    if (timer) {
        clearTimeout(timer);
        state.runtimeLogFlushTimersByThreadId.delete(threadId);
    }

    queueLogLines(buffer.client, threadId, buffer.lines);
}

function bufferInfoLine(client, threadId, line) {
    const buffer = state.runtimeLogBuffersByThreadId.get(threadId) ?? {
        client,
        lines: []
    };
    buffer.client = client;
    buffer.lines.push(line);
    state.runtimeLogBuffersByThreadId.set(threadId, buffer);

    if (!state.runtimeLogFlushTimersByThreadId.has(threadId)) {
        const timer = setTimeout(() => flushInfoBuffer(threadId), RATED_RUNTIME_LOG_INFO_FLUSH_MS);
        timer.unref?.();
        state.runtimeLogFlushTimersByThreadId.set(threadId, timer);
    }
}

function logRated(level, client, scope, event, details = {}) {
    const routes = resolveLogRoutes(scope);
    for (const route of routes) {
        const line = formatLogLine(level, route, event, details);
        if (level === 'info') {
            bufferInfoLine(client, route.threadId, line);
        } else {
            queueLogLines(client, route.threadId, [line]);
        }
    }
}

function logRatedInfo(client, scope, event, details = {}) {
    logRated('info', client, scope, event, details);
}

function logRatedWarn(client, scope, event, details = {}) {
    logRated('warn', client, scope, event, details);
}

function logRatedError(client, scope, event, error, details = {}) {
    const errorDetails = {
        ...details,
        error: error instanceof Error ? error.message : error
    };
    if (error instanceof Error && error.stack) {
        errorDetails.stack = truncate(error.stack, 600);
    }
    logRated('error', client, scope, event, errorDetails);
}

async function flushRuntimeLogsForTests() {
    for (const threadId of [...state.runtimeLogBuffersByThreadId.keys()]) {
        flushInfoBuffer(threadId);
    }

    await Promise.all([...state.runtimeLogQueuesByThreadId.values()].map(queue => queue.catch(() => {})));
}

function clearRuntimeLogTimers() {
    for (const timer of state.runtimeLogFlushTimersByThreadId.values()) {
        clearTimeout(timer);
    }
    state.runtimeLogFlushTimersByThreadId.clear();
    state.runtimeLogBuffersByThreadId.clear();

    if (state.runtimeLogCleanupTimer) {
        clearInterval(state.runtimeLogCleanupTimer);
        state.runtimeLogCleanupTimer = null;
    }
}

function collectionValues(collection) {
    if (!collection) {
        return [];
    }
    if (typeof collection.values === 'function') {
        return [...collection.values()];
    }
    if (Array.isArray(collection)) {
        return collection;
    }
    return [];
}

function collectionHas(collection, id) {
    if (!collection || !id) {
        return false;
    }
    if (typeof collection.has === 'function') {
        return collection.has(id);
    }
    return collectionValues(collection).some(message => message?.id === id);
}

async function deleteFetchedMessages(thread, fetched) {
    const messages = collectionValues(fetched).filter(Boolean);
    if (messages.length === 0) {
        return 0;
    }

    let deletedCount = 0;
    let bulkDeleted = null;
    if (typeof thread.bulkDelete === 'function' && messages.length > 1) {
        bulkDeleted = await thread.bulkDelete(fetched, true).catch(() => null);
        deletedCount += collectionValues(bulkDeleted).length;
    }

    for (const message of messages) {
        if (collectionHas(bulkDeleted, message.id)) {
            continue;
        }
        const deleted = await message.delete?.().then(() => true).catch(() => false);
        if (deleted) {
            deletedCount += 1;
        }
    }

    return deletedCount;
}

async function cleanupLogThread(client, route) {
    const thread = await client?.channels?.fetch?.(route.threadId).catch(err => {
        console.error(`[RatedQueueLog] Failed to fetch cleanup thread ${route.threadId}: ${err.message}`);
        return null;
    });
    if (!thread?.messages?.fetch) {
        console.error(`[RatedQueueLog] Cleanup thread ${route.threadId} is unavailable.`);
        return 0;
    }

    let deletedCount = 0;
    let before = null;
    for (let page = 0; page < 100; page += 1) {
        const fetchOptions = {
            limit: RATED_RUNTIME_LOG_CLEANUP_FETCH_LIMIT,
            cache: false
        };
        if (before) {
            fetchOptions.before = before;
        }

        const fetched = await thread.messages.fetch(fetchOptions).catch(err => {
            console.error(`[RatedQueueLog] Failed to fetch messages for cleanup ${route.threadId}: ${err.message}`);
            return null;
        });
        const messages = collectionValues(fetched);
        if (messages.length === 0) {
            break;
        }

        before = messages.at(-1)?.id ?? before;
        deletedCount += await deleteFetchedMessages(thread, fetched);
        if (messages.length < RATED_RUNTIME_LOG_CLEANUP_FETCH_LIMIT) {
            break;
        }
    }

    return deletedCount;
}

async function runRatedRuntimeLogCleanup(client) {
    for (const route of getAllLogRoutes()) {
        flushInfoBuffer(route.threadId);
    }
    await flushRuntimeLogsForTests();

    for (const route of getAllLogRoutes()) {
        const deleted = await cleanupLogThread(client, route);
        const line = formatLogLine('info', route, 'cleanup.complete', { deleted });
        queueLogLines(client, route.threadId, [line]);
    }

    await Promise.all([...state.runtimeLogQueuesByThreadId.values()].map(queue => queue.catch(() => {})));
}

function startRatedRuntimeLogCleanupLoop(client) {
    if (state.runtimeLogCleanupTimer) {
        return;
    }

    state.runtimeLogCleanupTimer = setInterval(() => {
        runRatedRuntimeLogCleanup(client).catch(error => {
            console.error(`[RatedQueueLog] Cleanup failed: ${error.message}`);
        });
    }, RATED_RUNTIME_LOG_CLEANUP_INTERVAL_MS);
    state.runtimeLogCleanupTimer.unref?.();
}

module.exports = {
    clearRuntimeLogTimers,
    flushRuntimeLogsForTests,
    formatLogLine,
    logRatedError,
    logRatedInfo,
    logRatedWarn,
    resolveLogRoutes,
    runRatedRuntimeLogCleanup,
    startRatedRuntimeLogCleanupLoop
};
