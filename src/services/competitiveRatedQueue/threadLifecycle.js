const RatedMatchDao = require('../../db/daos/ratedMatchDao');
const ratedMatchDao = new RatedMatchDao();
const { COMPLETED_THREAD_PREFIX, COMPLETED_THREAD_CLOSE_DELAY_MS } = require('./constants');
const { buildTerminalThreadName } = require('./formatting');
const { getMatchLogDetails } = require('./core');
const { logRatedInfo, logRatedWarn, logRatedError } = require('./runtimeLogger');
const {
    clearCompletedThreadCloseTimer,
    clearPendingRematch,
    state,
    withOperationQueue
} = require('./state');

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

module.exports = {
    buildCancelledThreadSnapshotFromDb,
    finalizeCompletedThreadFromSnapshot,
    finalizeOverdueCompletedThreads,
    finalizeThreadLifecycle,
    isRematchWindowOpen,
    recoverCompletedThreadFinalizations,
    restoreCompletedThreadFinalization,
    scheduleCompletedThreadClose,
    setCompletedThreadFinalizationDeadline
};
