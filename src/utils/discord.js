const { MessageFlags } = require('discord.js');

function normalizeInteractionPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  if (!Object.prototype.hasOwnProperty.call(payload, 'ephemeral')) {
    return payload;
  }

  const normalized = { ...payload };
  if (normalized.ephemeral === true) {
    normalized.flags = normalized.flags == null
      ? MessageFlags.Ephemeral
      : [normalized.flags, MessageFlags.Ephemeral];
  }
  delete normalized.ephemeral;
  return normalized;
}

async function safeReply(interaction, payload) {
  if (!interaction) return null;

  try {
    const normalizedPayload = normalizeInteractionPayload(payload);
    const acknowledged = interaction.replied || interaction.deferred || interaction.__ratedAcknowledged;
    if (interaction.__ratedPreferEditReply && acknowledged && typeof interaction.editReply === 'function') {
      return await interaction.editReply(normalizedPayload);
    }
    if (interaction.replied) {
      return await interaction.followUp(normalizedPayload);
    }
    if (acknowledged) {
      return await interaction.editReply(normalizedPayload);
    }
    return await interaction.reply(normalizedPayload);
  } catch (err) {
    if (isExpiredInteractionError(err)) {
      return null;
    }
    console.error(`safeReply failed: ${err.message ? err.message : JSON.stringify(err)}`);
    return null;
  }
}

async function safeFollowUp(interaction, payload) {
  if (!interaction) return null;

  try {
    const normalizedPayload = normalizeInteractionPayload(payload);
    if (interaction.replied || interaction.deferred || interaction.__ratedAcknowledged) {
      return await interaction.followUp(normalizedPayload);
    }
    return await interaction.reply(normalizedPayload);
  } catch (err) {
    if (isExpiredInteractionError(err)) {
      return null;
    }
    console.error(`safeFollowUp failed: ${err.message ? err.message : JSON.stringify(err)}`);
    return null;
  }
}

async function safeSend(channel, payload) {
  if (!channel || typeof channel.send !== 'function') return null;

  try {
    return await channel.send(payload);
  } catch (err) {
    console.error(`safeSend failed: ${err.message ? err.message : JSON.stringify(err)}`);
    return null;
  }
}

async function fetchChannel(clientOrGuild, channelId) {
  if (!clientOrGuild || !channelId) return null;

  const cached = clientOrGuild.channels?.cache?.get(channelId);
  if (cached) return cached;

  if (typeof clientOrGuild.channels?.fetch === 'function') {
    try {
      return await clientOrGuild.channels.fetch(channelId);
    } catch (err) {
      console.error(`fetchChannel(${channelId}) failed: ${err.message ? err.message : JSON.stringify(err)}`);
    }
  }

  return null;
}

async function fetchGuild(client, guildId) {
  if (!client || !guildId) return null;

  const cached = client.guilds?.cache?.get(guildId);
  if (cached) return cached;

  if (typeof client.guilds?.fetch === 'function') {
    try {
      return await client.guilds.fetch(guildId);
    } catch (err) {
      console.error(`fetchGuild(${guildId}) failed: ${err.message ? err.message : JSON.stringify(err)}`);
    }
  }

  return null;
}

function isExpiredInteractionError(err) {
  return err?.code === 10062
    || err?.code === 10015
    || /Unknown interaction/i.test(err?.message ?? '')
    || /Unknown Webhook/i.test(err?.message ?? '');
}

module.exports = {
  safeReply,
  safeFollowUp,
  safeSend,
  normalizeInteractionPayload,
  fetchChannel,
  fetchGuild,
  isExpiredInteractionError
};
