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
    return null;
}

async function acknowledgeMatchAction(interaction, matchAction, ensureImmediateReply, ensureDeferredUpdate) {
    if (['start', 'winner', 'loser_confirm'].includes(matchAction)) {
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
    onAckFailed,
    onQueued,
    onStarted,
    onFinished
}) {
    const replyAcknowledgement = ensureImmediateReply ?? ensureDeferredReply;
    const acknowledged = await acknowledgeMatchAction(interaction, matchAction, replyAcknowledgement, ensureDeferredUpdate);
    if (!acknowledged) {
        await onAckFailed?.();
        return true;
    }

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
    getMatchActionAckPayload,
    runMatchTransition
};
