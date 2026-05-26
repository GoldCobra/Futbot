const { MessageFlags } = require('discord.js');

function isInteractionAcknowledged(interaction) {
    return Boolean(interaction?.deferred || interaction?.replied || interaction?.__ratedAcknowledged);
}

async function ensureDeferredReply(interaction) {
    if (!interaction || isInteractionAcknowledged(interaction)) {
        return true;
    }

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        interaction.__ratedAcknowledged = true;
        if (!interaction.deferred && !interaction.replied) {
            interaction.deferred = true;
        }
        return true;
    } catch (error) {
        interaction.__ratedAckError = error;
        return isInteractionAcknowledged(interaction);
    }
}

async function ensureImmediateReply(interaction, payload = {}) {
    if (!interaction || isInteractionAcknowledged(interaction)) {
        return true;
    }

    if (typeof interaction.reply !== 'function') {
        return await ensureDeferredReply(interaction);
    }

    try {
        await interaction.reply({
            ...payload,
            flags: payload.flags ?? MessageFlags.Ephemeral
        });
        interaction.__ratedAcknowledged = true;
        interaction.__ratedPreferEditReply = true;
        if (!interaction.deferred && !interaction.replied) {
            interaction.replied = true;
        }
        return true;
    } catch (error) {
        interaction.__ratedAckError = error;
        return await ensureDeferredReply(interaction);
    }
}

async function ensureDeferredUpdate(interaction) {
    if (!interaction || isInteractionAcknowledged(interaction)) {
        return true;
    }

    try {
        await interaction.deferUpdate();
        interaction.__ratedAcknowledged = true;
        if (!interaction.deferred && !interaction.replied) {
            interaction.deferred = true;
        }
        return true;
    } catch (error) {
        interaction.__ratedAckError = error;
        return isInteractionAcknowledged(interaction);
    }
}

async function silentlyAcknowledgeInteraction(interaction, { deleteReply = false } = {}) {
    if (!interaction) {
        return false;
    }

    if (!isInteractionAcknowledged(interaction)) {
        const updated = await ensureDeferredUpdate(interaction);
        if (!updated) {
            const replied = await ensureDeferredReply(interaction);
            if (!replied) {
                return false;
            }
        }
    }

    if (deleteReply) {
        await interaction.deleteReply?.().catch(() => {});
    }

    return true;
}

module.exports = {
    ensureDeferredReply,
    ensureDeferredUpdate,
    ensureImmediateReply,
    isInteractionAcknowledged,
    silentlyAcknowledgeInteraction
};
