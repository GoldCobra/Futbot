const { safeFollowUp } = require('../../utils/discord');
const { isInteractionAcknowledged } = require('./interactions');
const { logRatedError, logRatedWarn } = require('./runtimeLogger');

function getPrivatePromptHandles(match) {
    if (!match.privatePromptHandles) {
        match.privatePromptHandles = {};
    }
    return match.privatePromptHandles;
}

async function deliverPrivateInteractionPayload(interaction, payload, contextLabel) {
    if (!interaction) {
        return null;
    }

    if (!isInteractionAcknowledged(interaction)) {
        logRatedWarn(interaction.client, { all: true }, 'private_delivery.skipped_unacknowledged_interaction', {
            context: contextLabel,
            user: interaction.user?.id,
            error: interaction.__ratedAckError?.message
        });
        return null;
    }

    let editError = null;
    const edited = await interaction.editReply(payload).catch(err => {
        editError = err;
        return null;
    });
    if (edited) {
        return edited;
    }

    const followUpPayload = {
        ...payload,
        ephemeral: true
    };
    const followUpMessage = await safeFollowUp(interaction, followUpPayload);
    if (!followUpMessage) {
        logRatedError(interaction.client, { all: true }, 'private_delivery.failed', editError ?? new Error('followUp failed'), {
            context: contextLabel,
            user: interaction.user?.id
        });
        console.error(`[RatedQueue] ${contextLabel} followUp failed.`);
        return null;
    }
    logRatedWarn(interaction.client, { all: true }, 'private_delivery.edit_recovered_by_followup', {
        context: contextLabel,
        user: interaction.user?.id,
        error: editError?.message
    });

    return followUpMessage;
}

function rememberWinnerWaitingPrompt(match, interaction, message) {
    getPrivatePromptHandles(match).winnerWaiting = {
        interaction,
        message
    };
}

async function clearWinnerWaitingPrompt(match) {
    const handle = match?.privatePromptHandles?.winnerWaiting;
    await handle?.message?.delete?.().catch(() => {});
    await handle?.interaction?.deleteReply?.().catch(() => {});
    if (match?.privatePromptHandles) {
        match.privatePromptHandles.winnerWaiting = null;
    }
}

async function replaceWinnerWaitingPrompt(match, payload, contextLabel) {
    const handle = match?.privatePromptHandles?.winnerWaiting;
    if (!handle?.interaction) return null;
    const prompt = await deliverPrivateInteractionPayload(handle.interaction, payload, contextLabel);
    if (prompt) {
        handle.message = prompt;
    }
    return prompt;
}

module.exports = {
    clearWinnerWaitingPrompt,
    deliverPrivateInteractionPayload,
    rememberWinnerWaitingPrompt,
    replaceWinnerWaitingPrompt
};
