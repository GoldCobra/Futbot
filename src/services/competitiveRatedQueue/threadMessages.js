const { buildThreadTextPayload, quoteThreadPayload } = require('./formatting');

const REQUIRED_THREAD_OP_ATTEMPTS = 3;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelayMs(attempt) {
    if (process.env.NODE_ENV === 'test') return 0;
    return Math.min(250 * attempt, 1000);
}

function isRetryableDiscordError(error) {
    if (!error) return false;
    if ([500, 502, 503, 504, 520, 522, 524].includes(Number(error.status))) return true;
    if ([50001, 50013, 10003, 10008].includes(Number(error.code))) return false;
    if ([500, 502, 503, 504].includes(Number(error.code))) return true;
    const message = `${error.message ?? ''} ${error.stack ?? ''}`;
    return [
        'ECONNRESET',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'rate limit',
        'Request timed out',
        'socket hang up'
    ].some(pattern => message.includes(pattern));
}

async function runRequiredThreadOperation(operation, { attempts = REQUIRED_THREAD_OP_ATTEMPTS } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation(attempt);
        } catch (error) {
            lastError = error;
            if (!isRetryableDiscordError(error) || attempt >= attempts) {
                throw error;
            }
            await sleep(getRetryDelayMs(attempt));
        }
    }
    throw lastError;
}

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

async function sendRequiredThreadMessage(thread, payload, options = {}) {
    const threadPayload = quoteThreadPayload(payload);
    if (!thread?.send) {
        throw new Error('Thread is not available for required send');
    }
    return await runRequiredThreadOperation(() => thread.send(threadPayload), options);
}

async function editOrSendRequiredThreadMessage(thread, messageId, payload, options = {}) {
    const threadPayload = quoteThreadPayload(payload);
    if (!thread?.send) {
        throw new Error('Thread is not available for required edit/send');
    }

    const existingMessage = await fetchThreadMessage(thread, messageId);
    if (existingMessage) {
        try {
            await runRequiredThreadOperation(() => existingMessage.edit(threadPayload), options);
            return existingMessage;
        } catch (error) {
            if (Number(error?.code) !== 10008 && !isRetryableDiscordError(error)) {
                throw error;
            }
        }
    }

    return await sendRequiredThreadMessage(thread, payload, options);
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
    if (thread?.messages?.delete) {
        const deleted = await thread.messages.delete(messageId).then(() => true).catch(() => false);
        if (deleted) return;
    }
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
    editOrSendRequiredThreadMessage,
    sendRequiredThreadMessage,
    fetchThreadMessage
};
