// Routes every rated-queue button and select to its handler. Match buttons run under the
// match lock (runMatchTransition); clicks that arrive while the runtime file is still being
// restored wait for it briefly.
const { safeReply } = require('../../utils/discord');
const { CONFIG, CONTROL_EXPIRY_MESSAGE } = require('./constants');
const { parseIdFromCustomId, parseLoserChoiceFromCustomId } = require('./customIds');
const { state, withInteractionLock } = require('./state');
const {
    ensureDeferredUpdate,
    ensureImmediateReply,
    silentlyAcknowledgeInteraction
} = require('./interactions');
const { rememberPrivateDeliveryInteraction } = require('./matchState');
const { logRatedInfo, logRatedWarn } = require('./runtimeLogger');
const { runMatchTransition } = require('./matchTransitions');
const { getMatchLogDetails, scheduleRuntimeStatePersist } = require('./core');
const {
    cancelMatchForInactivity,
    handleCancelMatchButton,
    handleCaptainSelection,
    handleLoserAdvantage,
    handleLoserConfirm,
    handleOpenPrivatePick,
    handleStadiumSelection,
    handleStartSetupButton,
    handleWinnerSelection
} = require('./matchFlow');
const {
    handleCancelSearch,
    handleExtendSearch,
    handleJoinButton
} = require('./matchmaking');
const { handleRematchInteraction, handleReportIssueInteraction } = require('./finishedMatch');

// Match buttons clicked right after a restart can arrive before the runtime file is restored.
// They wait briefly (inside Discord's 3-second acknowledgement window) instead of finding no
// match and being dropped.
const RUNTIME_RECOVERY_CLICK_WAIT_MS = 2000;

async function waitForRuntimeRecovery() {
    if (!state.runtimeRecoveryInFlight) {
        return;
    }
    let timer = null;
    await Promise.race([
        state.runtimeRecoveryInFlight,
        new Promise(resolve => {
            timer = setTimeout(resolve, RUNTIME_RECOVERY_CLICK_WAIT_MS);
        })
    ]);
    clearTimeout(timer);
}

async function handleMatchInteraction(interaction) {
    const matchId = parseIdFromCustomId(interaction.customId);
    const matchAction = interaction.customId.split(':')[3];
    if (matchAction === 'report_issue') {
        return await handleReportIssueInteraction(interaction);
    }
    if (matchAction === 'rematch') {
        return await handleRematchInteraction(interaction);
    }

    let match = state.activeMatchesById.get(matchId);
    if (!match && state.runtimeRecoveryInFlight) {
        await waitForRuntimeRecovery();
        match = state.activeMatchesById.get(matchId);
    }
    if (!match) {
        await silentlyAcknowledgeInteraction(interaction);
        return true;
    }

    const lockKey = `match:${match.id}`;
    const interactionReceivedAt = Date.now();

    return await runMatchTransition({
        interaction,
        match,
        matchAction,
        lockKey,
        ensureImmediateReply,
        ensureDeferredUpdate,
        rememberPrivateDeliveryInteraction,
        withInteractionLock,
        handleExpiredMatch: async () => {
            if (
                match.timeoutPhase
                && !['loser_confirmation', 'loser_advantage'].includes(match.timeoutPhase)
                && Date.now() >= match.timeoutDeadlineAt
            ) {
                await ensureDeferredUpdate(interaction);
                await cancelMatchForInactivity(match, match.timeoutPhase, interaction.client);
                return true;
            }
            return false;
        },
        onReceived: async () => {
            logRatedInfo(interaction.client, match, 'match.transition.interaction_received', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id
            }));
        },
        onAckFailed: async () => {
            logRatedWarn(interaction.client, match, 'match.transition.ack_failed', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id,
                error: interaction.__ratedAckError?.message
            }));
        },
        onAcked: async () => {
            logRatedInfo(interaction.client, match, 'match.transition.ack_done', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id,
                ackMs: Date.now() - interactionReceivedAt
            }));
        },
        onQueued: async () => {
            logRatedInfo(interaction.client, match, 'match.transition.queued', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id
            }));
        },
        onStarted: async () => {
            logRatedInfo(interaction.client, match, 'match.transition.started', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id
            }));
        },
        onFinished: async () => {
            logRatedInfo(interaction.client, match, 'match.transition.finished', getMatchLogDetails(match, {
                action: matchAction,
                user: interaction.user.id
            }));
            scheduleRuntimeStatePersist(`interaction:${matchAction}`);
        },
        transition: async () => {
            if (interaction.customId.includes(':match:start:')) {
                await handleStartSetupButton(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:cancel:')) {
                await handleCancelMatchButton(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:openpick:')) {
                await handleOpenPrivatePick(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:stadium:')) {
                await handleStadiumSelection(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:captain:')) {
                await handleCaptainSelection(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:winner:')) {
                await handleWinnerSelection(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:loser_confirm:')) {
                await handleLoserConfirm(interaction, match);
                return true;
            }
            if (interaction.customId.includes(':match:loser_advantage:')) {
                await handleLoserAdvantage(interaction, match, parseLoserChoiceFromCustomId(interaction.customId));
                return true;
            }

            return false;
        }
    });
}

function isCompetitiveRatedInteraction(interaction) {
    return interaction?.customId?.startsWith?.(CONFIG.PREFIX) ?? false;
}

async function handleInteraction(interaction) {
    if (!isCompetitiveRatedInteraction(interaction)) {
        return false;
    }

    if (interaction.isModalSubmit && interaction.isModalSubmit()) {
        await safeReply(interaction, { content: CONTROL_EXPIRY_MESSAGE, ephemeral: true });
        return true;
    }

    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
        return await handleMatchInteraction(interaction);
    }

    if (!interaction.isButton || !interaction.isButton()) {
        return false;
    }

    if (interaction.customId.includes(':join:')) {
        return await handleJoinButton(interaction);
    }
    if (interaction.customId.includes(':search:cancel:')) {
        return await handleCancelSearch(interaction);
    }
    if (interaction.customId.includes(':search:extend:')) {
        return await handleExtendSearch(interaction);
    }
    if (interaction.customId.includes(':match:')) {
        return await handleMatchInteraction(interaction);
    }

    return false;
}

module.exports = {
    handleInteraction,
    isCompetitiveRatedInteraction
};
