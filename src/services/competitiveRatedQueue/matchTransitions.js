// In-memory lifecycle of a rated match (SYSTEM-OVERVIEW §3c). Every match is created in
// awaiting_start; MSBL (no setup) moves straight on to awaiting_winner.
//
//   awaiting_start ──(both picks made)──────────────► awaiting_winner
//   awaiting_winner ──(GAME WIN)────────────────────► awaiting_loser_confirmation
//   awaiting_loser_confirmation ──(match decided)───► complete
//                               ──(MSC/SMS advantage chosen)──► awaiting_start
//                               ──(MSBL confirmed / timeouts)─► awaiting_winner
//   every non-terminal stage ──(timeout, player vote, season end)──► cancelled
//
// The DB row (RatedMatch.Status) follows its own path: creating → active → completed →
// rolled_back, and creating/active → cancelled.
const MATCH_STAGES = Object.freeze({
    AWAITING_START: 'awaiting_start',
    AWAITING_WINNER: 'awaiting_winner',
    AWAITING_LOSER_CONFIRMATION: 'awaiting_loser_confirmation',
    COMPLETE: 'complete',
    CANCELLED: 'cancelled'
});

const ALLOWED_STAGE_TRANSITIONS = Object.freeze({
    [MATCH_STAGES.AWAITING_START]: [MATCH_STAGES.AWAITING_WINNER, MATCH_STAGES.CANCELLED],
    [MATCH_STAGES.AWAITING_WINNER]: [MATCH_STAGES.AWAITING_LOSER_CONFIRMATION, MATCH_STAGES.CANCELLED],
    [MATCH_STAGES.AWAITING_LOSER_CONFIRMATION]: [
        MATCH_STAGES.AWAITING_START,
        MATCH_STAGES.AWAITING_WINNER,
        MATCH_STAGES.COMPLETE,
        MATCH_STAGES.CANCELLED
    ],
    [MATCH_STAGES.COMPLETE]: [],
    [MATCH_STAGES.CANCELLED]: []
});

function isTerminalStage(stage) {
    return stage === MATCH_STAGES.COMPLETE || stage === MATCH_STAGES.CANCELLED;
}

function isAllowedStageTransition(fromStage, toStage) {
    return fromStage === toStage || (ALLOWED_STAGE_TRANSITIONS[fromStage] ?? []).includes(toStage);
}

// Sets match.stage. An unexpected transition is still applied (the flow decides, this only
// watches) but reported through onInvalid; under jest it throws so tests catch every new path.
function transitionMatchStage(match, toStage, { onInvalid = null, strict = process.env.NODE_ENV === 'test' } = {}) {
    const fromStage = match.stage;
    if (!isAllowedStageTransition(fromStage, toStage)) {
        if (strict) {
            throw new Error(`Invalid rated match stage transition ${fromStage} -> ${toStage}`);
        }
        onInvalid?.(fromStage, toStage);
    }
    match.stage = toStage;
    return fromStage;
}

function getMatchActionAckPayload(matchAction) {
    if (matchAction === 'start') {
        return { content: 'Preparing match controls...', components: [] };
    }
    if (matchAction === 'winner') {
        return { content: 'Win recorded. Waiting for confirmation...', components: [] };
    }
    if (matchAction === 'loser_confirm') {
        return { content: 'Confirming result...', components: [] };
    }
    if (matchAction === 'openpick') {
        return { content: 'Opening your pick...', components: [] };
    }
    if (matchAction === 'cancel') {
        return { content: 'Recording your cancel vote...', components: [] };
    }
    return null;
}

async function acknowledgeMatchAction(interaction, matchAction, ensureImmediateReply, ensureDeferredUpdate) {
    // 'cancel' replies immediately so the voter gets a private tally back; everything else keeps
    // the silent deferUpdate.
    if (['start', 'winner', 'loser_confirm', 'openpick', 'cancel'].includes(matchAction)) {
        return await ensureImmediateReply(interaction, getMatchActionAckPayload(matchAction));
    }

    return await ensureDeferredUpdate(interaction);
}

async function runMatchTransition({
    interaction,
    match,
    matchAction,
    lockKey,
    ensureImmediateReply,
    ensureDeferredReply,
    ensureDeferredUpdate,
    rememberPrivateDeliveryInteraction,
    withInteractionLock,
    handleExpiredMatch,
    transition,
    onReceived,
    onAckFailed,
    onAcked,
    onQueued,
    onStarted,
    onFinished
}) {
    const replyAcknowledgement = ensureImmediateReply ?? ensureDeferredReply;
    await onReceived?.();
    const acknowledged = await acknowledgeMatchAction(interaction, matchAction, replyAcknowledgement, ensureDeferredUpdate);
    if (!acknowledged) {
        await onAckFailed?.();
        return true;
    }

    await onAcked?.();
    rememberPrivateDeliveryInteraction(match, interaction);
    await onQueued?.();

    return await withInteractionLock(lockKey, async () => {
        await onStarted?.();
        try {
            if (await handleExpiredMatch?.()) {
                return true;
            }

            return await transition();
        } finally {
            await onFinished?.();
        }
    });
}

module.exports = {
    ALLOWED_STAGE_TRANSITIONS,
    MATCH_STAGES,
    getMatchActionAckPayload,
    isAllowedStageTransition,
    isTerminalStage,
    runMatchTransition,
    transitionMatchStage
};
