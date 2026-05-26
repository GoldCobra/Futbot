const { buildThreadTextPayload, quoteThreadPayload } = require('./formatting');

async function fetchThreadMessage(thread, messageId) {
    if (!messageId || !thread?.messages?.fetch) {
        return null;
    }

    return await thread.messages.fetch(messageId, { cache: false }).catch(() => null);
}

async function editOrSendThreadMessage(thread, messageId, payload) {
    const threadPayload = quoteThreadPayload(payload);
    const existingMessage = await fetchThreadMessage(thread, messageId);
    if (existingMessage) {
        try {
            await existingMessage.edit(threadPayload);
            return existingMessage;
        } catch { /* fall through to send */ }
    }

    return await thread.send(threadPayload);
}

async function deleteSetupMessageAndPostConfirmation(thread, setupMessageId, confirmationMessageId, payload) {
    const threadPayload = quoteThreadPayload(payload);
    if (confirmationMessageId) {
        return await editOrSendThreadMessage(thread, confirmationMessageId, threadPayload);
    }

    const setupMessage = await fetchThreadMessage(thread, setupMessageId);
    if (setupMessage) {
        try {
            await setupMessage.delete();
        } catch {
            await setupMessage.edit(threadPayload).catch(() => {});
            return setupMessage;
        }
        return await thread.send(threadPayload);
    }

    return await thread.send(threadPayload);
}

async function clearSetupMessageComponents(thread, messageId) {
    const message = await fetchThreadMessage(thread, messageId);
    await message?.edit?.({ components: [] }).catch(() => {});
}

async function deleteThreadMessage(thread, messageId) {
    if (!thread?.send || !messageId) return;
    const msg = await fetchThreadMessage(thread, messageId);
    if (msg) await msg.delete().catch(() => {});
}

async function clearCurrentControlMessage(match, client, content, thread = null, components = []) {
    thread ??= await client.channels.fetch(match.threadId).catch(() => null);
    if (!thread?.send) {
        match.controlMessageId = null;
        return null;
    }

    let rendered = false;
    let renderedMessage = null;
    const contentPayload = content
        ? buildThreadTextPayload(content, 'line', { components })
        : { content, components };
    if (match.controlMessageId) {
        const controlMessage = await fetchThreadMessage(thread, match.controlMessageId);
        if (controlMessage) {
            try {
                await controlMessage.delete();
                if (content) {
                    renderedMessage = await thread.send(contentPayload);
                    rendered = true;
                }
            } catch {
                try {
                    renderedMessage = await controlMessage.edit(contentPayload);
                    rendered = true;
                } catch {
                    rendered = false;
                }
            }
        }
    }

    if (!rendered && content) {
        renderedMessage = await thread.send(contentPayload).catch(err => {
            console.warn(`[RatedQueue] Failed to send control message to thread ${thread.id}: ${err.message}`);
            return null;
        });
    }
    match.controlMessageId = null;
    return renderedMessage;
}

module.exports = {
    clearCurrentControlMessage,
    clearSetupMessageComponents,
    deleteSetupMessageAndPostConfirmation,
    deleteThreadMessage,
    editOrSendThreadMessage,
    fetchThreadMessage
};
