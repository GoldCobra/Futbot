const CONSTANTS = require('./constants');
const EMOJIS = require('./emoji');
const helpers = require('./helpers');
const discord = require('./discord');
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
            await discord.safeSend(debugChannel, debugMessage);
        })().catch((sendErr) => {
            console.error(sendErr && sendErr.message ? sendErr.message : JSON.stringify(sendErr));
        });
    }
    else {
        console.error(err.message);
    }
};

 async function handleErrorWithInteraction (err, interaction, followUp = false, additionalText='') {
    err = normalizeError(err);
    const client = interaction.client;
    const guild = interaction.guild || await discord.fetchGuild(client, CONSTANTS.GUILD_ID);
    const channel = guild ? await discord.fetchChannel(guild, CONSTANTS.CHANNELS.DEBUG_ERRORS) : await discord.fetchChannel(client, CONSTANTS.CHANNELS.DEBUG_ERRORS);
    const subcommand = interaction.options && typeof interaction.options.getSubcommand === 'function'
        ? interaction.options.getSubcommand(false)
        : interaction.options?._subcommand;

    const debugMessage =
`**Command exception**
**Time** <t:${Math.floor(new Date().getTime() / 1000)}>
**Command name:** ${interaction.commandName} ${subcommand ?? ''}
**Message:** ${interaction.message}
**Executed by:** ${interaction.user.toString()}
**Error Message:** ${err.message}
**Stack trace:**
${err.stack}`;

    if (channel && canSendToChannel(channel, client)) {
        await helpers.sendSplitMessages(async msg => await discord.safeSend(channel, msg), debugMessage, false);
    } else {
        console.error(debugMessage);
    }

    await discord.safeFollowUp(interaction, { content: `There was an error while executing this command! ${additionalText}`, ephemeral: true });
}

const errorHandlerWithContext = (context, err, client = undefined, msg = false, location = "internal") => {
    err = normalizeError(err);
    const newErr = new Error(context ? `${context} ${err.message}` : err.message);
    newErr.stack = err.stack;
    if (err.code) {
        newErr.code = err.code;
    }
    errorHandler(newErr, client, msg, location);
};

const logErrorWithContext = (context) => {
    return (err) => {
        if (err) {
            console.error(`${context} throws error: "${err.message ? err.message : JSON.stringify(err)}"`);
        }
    }
};

function canSendToChannel(channel, client) {
    const permissions = channel?.permissionsFor?.(channel.guild?.members?.me ?? client?.user);
    return permissions ? permissions.has(PermissionsBitField.Flags.SendMessages) : true;
}

module.exports.handle = errorHandler;
module.exports.handleWithContext = errorHandlerWithContext;
module.exports.log = logErrorWithContext;
module.exports.handleErrorWithInteraction = handleErrorWithInteraction;
module.exports.normalizeError = normalizeError;
