const path = require('node:path');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionsBitField
} = require('discord.js');

const { fetchChannel } = require('../../utils/discord');
const { CONFIG, PANEL_BYPASS_ROLES, PLAYER_COUNT_EMOJI } = require('./constants');
const { panelJoinCustomId } = require('./customIds');
const { buildPanelImageMessage, getPanelImagePath } = require('./messages');
const { logRatedInfo, logRatedWarn, logRatedError } = require('./runtimeLogger');
const { state } = require('./state');

const LFG_ROLE_ID_BY_GAME_TYPE = {
    MSBL: '944150830972538923',
    MSC: '680810288605298744',
    SMS: '781487757176209428'
};

function scheduleUnreffedTimeout(callback, delayMs) {
    const timer = setTimeout(callback, Math.max(delayMs, 0));
    timer.unref?.();
    return timer;
}

function getPanelConfigByChannelId(channelId) {
    return CONFIG.PANEL_CHANNELS.find(panel => panel.channelId === channelId) ?? null;
}

function getPanelConfigByGameType(gameType) {
    return CONFIG.PANEL_CHANNELS.find(panel => panel.gameType === gameType) ?? null;
}

function isManagedPanelChannel(channelId) {
    return Boolean(getPanelConfigByChannelId(channelId));
}

function getLfgRoleIdForPanel(channelId) {
    const panelConfig = getPanelConfigByChannelId(channelId);
    return panelConfig ? LFG_ROLE_ID_BY_GAME_TYPE[panelConfig.gameType] ?? null : null;
}

function buildPanelMessage(channelId = CONFIG.PANEL_CHANNELS[0].channelId) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(panelJoinCustomId(channelId, '1v1'))
            .setLabel('Search 1vs1')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(panelJoinCustomId(channelId, '2v2'))
            .setLabel('Search 2vs2')
            .setStyle(ButtonStyle.Primary)
    );

    return {
        components: [row]
    };
}

function buildStatusMessageContent(counts, channelId = null) {
    const lines = [];
    const hasSingles = (counts['1v1'] ?? 0) > 0;
    const hasDoubles = (counts['2v2'] ?? 0) > 0;

    if (hasSingles || hasDoubles) {
        const roleId = getLfgRoleIdForPanel(channelId);
        if (roleId) {
            lines.push(`<@&${roleId}>`);
        }
    }

    if (hasSingles) {
        lines.push(`Players in 1vs1 Pool: **${PLAYER_COUNT_EMOJI} ${counts['1v1']}**`);
    }

    if (hasDoubles) {
        lines.push(`Players in 2vs2 Pool: **👥 ${counts['2v2']}**`);
    }

    return lines.join('\n');
}

function buildStatusMessagePayload(panelConfig, counts) {
    const roleId = LFG_ROLE_ID_BY_GAME_TYPE[panelConfig?.gameType];
    const payload = {
        content: buildStatusMessageContent(counts, panelConfig?.channelId),
        components: [],
        allowedMentions: { parse: [] }
    };
    if (roleId) {
        payload.allowedMentions.roles = [roleId];
    }
    return payload;
}

function createPanelMeta(channelId) {
    return {
        channelId,
        imageMessageId: null,
        panelMessageId: null,
        statusMessageId: null,
        channelLockApplied: false,
        availabilityKey: 'active'
    };
}

function getOrCreatePanelMeta(channelId) {
    if (!state.panelMetaByChannelId.has(channelId)) {
        state.panelMetaByChannelId.set(channelId, createPanelMeta(channelId));
    }
    return state.panelMetaByChannelId.get(channelId);
}

function hasBypassRole(member) {
    if (!member?.roles?.cache) {
        return false;
    }

    if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) {
        return true;
    }

    return member.roles.cache.some(role => PANEL_BYPASS_ROLES.has(role.id));
}

function buildSearchCounts(channelId) {
    const counts = {
        '1v1': 0,
        '2v2': 0
    };

    for (const search of state.activeSearchesById.values()) {
        if (search.channelId !== channelId) {
            continue;
        }
        counts[search.mode] += 1;
    }

    return counts;
}

function schedulePanelStatusRefresh(channelId, client) {
    if (!channelId || state.panelStatusRefreshTimersByChannelId.has(channelId)) {
        return;
    }

    const timer = scheduleUnreffedTimeout(() => {
        state.panelStatusRefreshTimersByChannelId.delete(channelId);
        refreshPanelStatus(channelId, client).catch(error => {
            const panelConfig = getPanelConfigByChannelId(channelId);
            logRatedError(client, panelConfig ?? { channel: channelId }, 'panel.status.refresh_failed', error, {
                channel: channelId
            });
        });
    }, 500);
    state.panelStatusRefreshTimersByChannelId.set(channelId, timer);
}

async function reconcilePanelChannel(client, panelConfig) {
    const channel = await fetchChannel(client, panelConfig.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
        console.warn(`[RatedQueue] Panel channel ${panelConfig.channelId} not found or not a text channel. Bot may not be in the correct guild.`);
        logRatedWarn(client, panelConfig, 'panel.channel_missing', { channel: panelConfig.channelId });
        return;
    }
    const panelMeta = getOrCreatePanelMeta(channel.id);

    if (!panelMeta.channelLockApplied) {
        await applyChannelLock(channel, panelConfig.gameType);
        panelMeta.channelLockApplied = true;
    }

    const counts = buildSearchCounts(channel.id);
    const hasAnySearches = counts['1v1'] > 0 || counts['2v2'] > 0;
    const panelIsBootstrapped = panelMeta.imageMessageId && panelMeta.panelMessageId;
    const needsFullReconcile = !panelIsBootstrapped || hasAnySearches || panelMeta.statusMessageId != null;
    const existingMessages = needsFullReconcile ? await fetchRecentMessages(channel, 100) : [];
    const deletedMessageIds = new Set();

    const panelImagePayload = buildPanelImageMessage(panelConfig);
    let panelImageMessage = findPanelImageMessage(existingMessages, client.user?.id, panelConfig);
    if (panelImagePayload) {
        if (panelImageMessage) {
            panelMeta.imageMessageId = panelImageMessage.id;
        } else if (!panelMeta.imageMessageId) {
            try {
                const createdPanelImageMessage = await channel.send(panelImagePayload);
                panelMeta.imageMessageId = createdPanelImageMessage.id;
                panelImageMessage = createdPanelImageMessage;
                console.log('[RatedQueue] Panel image sent.');
                logRatedInfo(client, panelConfig, 'panel.image.created', {
                    channel: channel.id,
                    message: createdPanelImageMessage.id
                });
            } catch (err) {
                console.error(`[RatedQueue] Failed to send panel image: ${err.message}. Check bot permissions (SendMessages) in channel ${channel.id}.`);
                logRatedError(client, panelConfig, 'panel.image.create_failed', err, { channel: channel.id });
                return;
            }
        }
    }

    const panelPayload = buildPanelMessage(channel.id);
    let panelMessage = findPanelMessage(existingMessages, client.user?.id, channel.id);
    const shouldRecreatePanelMessage = Boolean(
        panelMessage
            && panelImageMessage
            && panelMessage.createdTimestamp < panelImageMessage.createdTimestamp
    ) || panelMessageNeedsRecreate(panelMessage);
    if (shouldRecreatePanelMessage) {
        await panelMessage.delete().catch(() => {});
        deletedMessageIds.add(panelMessage.id);
        panelMessage = null;
        panelMeta.panelMessageId = null;
    }

    if (panelMessage) {
        panelMeta.panelMessageId = panelMessage.id;
    } else if (!panelMeta.panelMessageId) {
        try {
            const createdPanelMessage = await channel.send(panelPayload);
            panelMeta.panelMessageId = createdPanelMessage.id;
            console.log('[RatedQueue] Panel buttons sent.');
            logRatedInfo(client, panelConfig, 'panel.controls.created', {
                channel: channel.id,
                message: createdPanelMessage.id
            });
        } catch (err) {
            console.error(`[RatedQueue] Failed to send panel buttons: ${err.message}. Check bot permissions (SendMessages) in channel ${channel.id}.`);
            logRatedError(client, panelConfig, 'panel.controls.create_failed', err, { channel: channel.id });
            return;
        }
    }
    panelMeta.availabilityKey = 'static';

    const statusMessage = findStatusMessage(existingMessages, client.user?.id);
    if (hasAnySearches) {
        const statusPayload = buildStatusMessagePayload(panelConfig, counts);
        if (statusMessage) {
            panelMeta.statusMessageId = statusMessage.id;
            await statusMessage.edit(statusPayload).catch(err =>
                {
                    console.warn(`[RatedQueue] Failed to edit status message in ${channel.id}: ${err.message}`);
                    logRatedWarn(client, panelConfig, 'panel.status.edit_failed', { channel: channel.id, error: err.message });
                }
            );
        } else {
            const createdStatusMessage = await channel.send(statusPayload);
            panelMeta.statusMessageId = createdStatusMessage.id;
            logRatedInfo(client, panelConfig, 'panel.status.created', {
                channel: channel.id,
                message: createdStatusMessage.id
            });
        }
    } else if (statusMessage) {
        panelMeta.statusMessageId = null;
        await statusMessage.delete().catch(err =>
            {
                console.warn(`[RatedQueue] Failed to delete status message in ${channel.id}: ${err.message}`);
                logRatedWarn(client, panelConfig, 'panel.status.delete_failed', { channel: channel.id, error: err.message });
            }
        );
    }

    await prunePanelChannelMessages(existingMessages, panelMeta, deletedMessageIds);
}

async function fetchPanelMessageById(channel, messageId) {
    if (!messageId || typeof channel.messages?.fetch !== 'function') {
        return null;
    }

    return await channel.messages.fetch(messageId).catch(() => null);
}

async function refreshPanelStatus(channelId, client) {
    const panelConfig = getPanelConfigByChannelId(channelId);
    if (!panelConfig) {
        return;
    }

    const channel = await fetchChannel(client, panelConfig.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
        logRatedWarn(client, panelConfig, 'panel.status.channel_missing', { channel: panelConfig.channelId });
        return;
    }

    const panelMeta = getOrCreatePanelMeta(channel.id);
    const counts = buildSearchCounts(channel.id);
    const hasAnySearches = counts['1v1'] > 0 || counts['2v2'] > 0;
    let statusMessage = await fetchPanelMessageById(channel, panelMeta.statusMessageId);
    let existingStatusMessages = [];

    if (!statusMessage) {
        const recentMessages = await fetchRecentMessages(channel, 100);
        existingStatusMessages = findStatusMessages(recentMessages, client.user?.id);
        statusMessage = existingStatusMessages[0] ?? null;
        panelMeta.statusMessageId = statusMessage?.id ?? null;
    }

    if (hasAnySearches) {
        const statusPayload = buildStatusMessagePayload(panelConfig, counts);

        if (statusMessage) {
            if (existingStatusMessages.length === 0) {
                const recentMessages = await fetchRecentMessages(channel, 100);
                existingStatusMessages = findStatusMessages(recentMessages, client.user?.id);
            }
            await statusMessage.edit(statusPayload).catch(err => {
                console.warn(`[RatedQueue] Failed to edit status message in ${channel.id}: ${err.message}`);
                logRatedWarn(client, panelConfig, 'panel.status.edit_failed', { channel: channel.id, error: err.message });
            });
            panelMeta.statusMessageId = statusMessage.id;
            await deleteDuplicateStatusMessages(existingStatusMessages, statusMessage.id, panelConfig, channel, client);
            return;
        }

        const createdStatusMessage = await channel.send(statusPayload);
        panelMeta.statusMessageId = createdStatusMessage.id;
        logRatedInfo(client, panelConfig, 'panel.status.created', {
            channel: channel.id,
            message: createdStatusMessage.id,
            mode: 'fast_refresh'
        });
        return;
    }

    const deletedStatusMessageIds = new Set();
    if (statusMessage && existingStatusMessages.length === 0) {
        const recentMessages = await fetchRecentMessages(channel, 100);
        existingStatusMessages = findStatusMessages(recentMessages, client.user?.id);
    }
    if (statusMessage) {
        await statusMessage.delete().catch(err => {
            console.warn(`[RatedQueue] Failed to delete status message in ${channel.id}: ${err.message}`);
            logRatedWarn(client, panelConfig, 'panel.status.delete_failed', { channel: channel.id, error: err.message });
        });
        deletedStatusMessageIds.add(statusMessage.id);
    }
    await deleteDuplicateStatusMessages(existingStatusMessages, null, panelConfig, channel, client, deletedStatusMessageIds);
    panelMeta.statusMessageId = null;
}

async function prunePanelChannelMessages(messages, panelMeta, skipMessageIds = new Set()) {
    const keepMessageIds = new Set([
        panelMeta.imageMessageId,
        panelMeta.panelMessageId,
        panelMeta.statusMessageId
    ].filter(Boolean));

    for (const message of messages) {
        if (keepMessageIds.has(message.id) || skipMessageIds.has(message.id)) {
            continue;
        }

        await message.delete().catch(() => {});
    }
}

async function fetchRecentMessages(channel, limit) {
    try {
        if (typeof channel.messages?.fetch !== 'function') {
            return [];
        }
        const collection = await channel.messages.fetch({ limit, cache: false });
        return [...collection.values()];
    } catch {
        return [];
    }
}

function findPanelMessage(messages, botUserId, channelId) {
    const joinPrefix = `${CONFIG.PREFIX}:join:${channelId}:`;
    return messages.find(message => {
        if (message.author?.id !== botUserId) {
            return false;
        }

        return (message.components ?? []).some(row =>
            (row.components ?? []).some(component =>
                (component.customId?.startsWith?.(joinPrefix) ?? false)
                    || (component.data?.custom_id?.startsWith?.(joinPrefix) ?? false)
            )
        );
    }) ?? null;
}

function componentIsDisabled(component) {
    return component?.disabled === true || component?.data?.disabled === true;
}

function panelMessageNeedsRecreate(message) {
    if (!message) {
        return false;
    }

    if (typeof message.content === 'string' && message.content.trim().length > 0) {
        return true;
    }

    return (message.components ?? []).some(row =>
        (row.components ?? []).some(component => componentIsDisabled(component))
    );
}

function findPanelImageMessage(messages, botUserId, panelConfig) {
    const imagePath = getPanelImagePath(panelConfig);
    const imageName = imagePath ? path.basename(imagePath) : null;
    if (!imageName) {
        return null;
    }

    return messages.find(message => {
        if (message.author?.id !== botUserId) {
            return false;
        }

        if (!message.attachments) {
            return false;
        }

        if (typeof message.attachments.some === 'function') {
            return message.attachments.some(attachment => attachment?.name === imageName);
        }

        return false;
    }) ?? null;
}

function findStatusMessage(messages, botUserId) {
    return messages.find(message =>
        message.author?.id === botUserId
            && typeof message.content === 'string'
            && message.content.includes('Players in ')
    ) ?? null;
}

function findStatusMessages(messages, botUserId) {
    return messages.filter(message =>
        message.author?.id === botUserId
            && typeof message.content === 'string'
            && message.content.includes('Players in ')
    );
}

async function deleteDuplicateStatusMessages(statusMessages, keepMessageId, panelConfig, channel, client, skipMessageIds = new Set()) {
    for (const message of statusMessages) {
        if (message.id === keepMessageId || skipMessageIds.has(message.id)) {
            continue;
        }

        await message.delete().catch(err => {
            console.warn(`[RatedQueue] Failed to delete duplicate status message in ${channel.id}: ${err.message}`);
            logRatedWarn(client, panelConfig, 'panel.status.duplicate_delete_failed', {
                channel: channel.id,
                message: message.id,
                error: err.message
            });
        });
    }
}

async function applyChannelLock(channel, gameType) {
    try {
        const botMemberId = channel.guild.members.me?.id ?? channel.client.user?.id;
        if (botMemberId) {
            await channel.permissionOverwrites.edit(botMemberId, {
                ViewChannel: true,
                SendMessages: true,
                SendMessagesInThreads: true,
                CreatePublicThreads: true,
                ManageMessages: true,
                ManageThreads: true,
                ReadMessageHistory: true
            }, { reason: `Allow the ${gameType} Competitive Rated queue to manage its panel.` });
        }

        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
            SendMessages: false
        }, { reason: `Managed by the ${gameType} Competitive Rated queue.` });
    } catch (error) {
        console.error(`Failed to apply competitive panel channel lock: ${error.message}`);
        logRatedError(channel.client, { gameType }, 'panel.lock_failed', error, { channel: channel.id });
    }
}

async function enforcePanelMessagePolicy(message) {
    if (!message?.guild || message.author?.bot || !isManagedPanelChannel(message.channel?.id)) {
        return false;
    }

    if (hasBypassRole(message?.member)) {
        return false;
    }

    await message.delete().catch(() => {});
    return true;
}

module.exports = {
    LFG_ROLE_ID_BY_GAME_TYPE,
    buildPanelMessage,
    buildStatusMessageContent,
    enforcePanelMessagePolicy,
    getPanelConfigByChannelId,
    getPanelConfigByGameType,
    isManagedPanelChannel,
    reconcilePanelChannel,
    schedulePanelStatusRefresh
};
