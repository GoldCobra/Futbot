const CONSTANTS = require('./constants');
const EMOJIS = require('./emoji');
const discord = require('./discord');
const helpers = require('./helpers');
const { PermissionsBitField } = require('discord.js');

function normalizeError(err) {
    if (err instanceof Error) return err;
    const message = err && err.message ? err.message : String(err);
    const normalized = new Error(message);
    if (err && err.stack) normalized.stack = err.stack;
    if (err && err.code) normalized.code = err.code;
    return normalized;
}

const errorHandler = (err, client = undefined, msg = false, location = "internal") => {
    err = normalizeError(err);

	if (msg) {
		discord.safeSend(msg.channel, `>>> Sorry, we got lost completing your request ${EMOJIS.mscwariodizzy}\n\nSupport for this bot can be reached through pinging *@Developer*`);
	} else {
		msg = { content: 'Internal Command' }
	}

    if (typeof client !== 'undefined') {
        (async () => {
            const debugChannel = await discord.fetchChannel(client, CONSTANTS.CHANNELS.DEBUG_ERRORS);
            if (!debugChannel) {
                console.error(`Error Message: ${err.message}\nCommand: ${msg.content}\nDate: ${new Date().toISOString()}\nLocation: ${location}\n\nStack Trace: ${err.stack}`);
                return;
            }
            const debugMessage = `----------\nError Message: ${err.message}\nCommand: ${msg.content}\nDate: ${new Date().toISOString()}\nLocation: ${location}\n\nStack Trace: ${err.stack}`;
            if (!canSendToChannel(debugChannel, client)) {
                console.error(debugMessage);
                return;
            }
            await helpers.sendSplitMessages(async part => await discord.safeSend(debugChannel, part), debugMessage, false);
        })().catch((sendErr) => {
            console.error(sendErr && sendErr.message ? sendErr.message : JSON.stringify(sendErr));
        });
    }
    else {
        console.error(err.stack ?? err.message);
    }
};

function canSendToChannel(channel, client) {
    const permissions = channel?.permissionsFor?.(channel.guild?.members?.me ?? client?.user);
    return permissions ? permissions.has(PermissionsBitField.Flags.SendMessages) : true;
}

module.exports.handle = errorHandler;
