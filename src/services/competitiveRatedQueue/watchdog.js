// Reconcile watchdog: restores missing match controls, start gates and private-pick buttons
// and re-arms lost timers (after a restart or a failed Discord write). It never moves a match
// forward; recovery work goes through the per-match output queue.
const { state } = require('./state');
const { getNextGameNumber, requiresSetup } = require('./matchState');
const { logRatedError, logRatedWarn } = require('./runtimeLogger');
const { fetchThreadMessage } = require('./threadMessages');
const {
    getMatchLogDetails,
    hasPendingMatchOutput,
    queueMatchOutput
} = require('./core');
const {
    advanceMatchToWinnerControlAfterSelections,
    armSelectionTimeout,
    getLoserControlTimeoutPhase,
    getOrCreateGameBlock,
    getSetupPromptConfig,
    postInitialGameSetup,
    postNeutralOpenButtons,
    updateMatchControlMessage
} = require('./matchFlow');

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

    // Turn-aware recovery. A player is only "engaged" (owed a pick) once it is actually their
    // turn: always in games 2+, but in game 1 only after that rep has clicked the Start gate.
    const gameNumber = getNextGameNumber(match);
    const homeRepId = match.teams[match.homeTeamIndex - 1]?.repUserId;
    const awayRepId = match.teams[match.awayTeamIndex - 1]?.repUserId;
    const startClicked = match.startClickedUserIds ?? [];
    const isEngaged = repId => gameNumber >= 2 || startClicked.includes(repId);
    const repIdFor = player => (player === 'home' ? homeRepId : awayRepId);

    // Game 1: a rep who has not clicked Start is not yet owed a pick — the correct recovery for
    // them is the shared Start control (idempotent), never a selection/open-pick prompt.
    if (gameNumber === 1) {
        const homeStillNeedsStart = !match.selectedStadium && !isEngaged(homeRepId);
        const awayStillNeedsStart = !match.selectedCaptain && !isEngaged(awayRepId);
        if ((homeStillNeedsStart || awayStillNeedsStart) && !(await threadMessageExists(thread, block.startMessageId))) {
            await queueControlWatchdogRecovery(match, client, 'watchdog_restore_start_control', async () => {
                await postInitialGameSetup(match, client);
            }, {
                phase: 'start',
                missingMessage: block.startMessageId ?? null
            });
            return;
        }
    }

    // Re-arm the auto-randomize deadline for any engaged, still-pending side whose timer is not
    // running (timers are null after a restart). Pure state — safe to run outside the output queue.
    for (const player of ['home', 'away']) {
        const config = getSetupPromptConfig(player);
        if (isEngaged(repIdFor(player)) && !match[config.selectedKey] && !match[config.timerKey]) {
            armSelectionTimeout(match, player, client);
        }
    }

    // Restore the neutral open button ONLY for an engaged side that is owed one (private delivery
    // failed or was lost on restart) and whose button is missing. Never post the options publicly.
    const owedPlayers = [];
    for (const player of ['home', 'away']) {
        const config = getSetupPromptConfig(player);
        if (
            !match[config.selectedKey]
            && isEngaged(repIdFor(player))
            && block[config.deliveredKey] !== true
            && !(await threadMessageExists(thread, block[config.openButtonIdKey]))
        ) {
            owedPlayers.push(player);
        }
    }
    if (!owedPlayers.length) {
        return;
    }

    await queueControlWatchdogRecovery(match, client, 'watchdog_restore_open_pick_buttons', async () => {
        await postNeutralOpenButtons(match, client, owedPlayers, {
            source: 'watchdog',
            players: owedPlayers.join(',')
        });
    }, {
        phase: 'selection',
        players: owedPlayers.join(',')
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

module.exports = {
    reconcileActiveMatchControls
};
