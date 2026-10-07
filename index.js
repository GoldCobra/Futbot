require('dotenv').config();

const FUTBOT_TOKEN = process.env.FUTBOT_TOKEN;
const FUTBOT_ID = process.env.FUTBOT_ID;

if (FUTBOT_ID) {
    process.env.CLIENT_ID = FUTBOT_ID;
}

const {
    ActivityType,
    Client,
    GatewayIntentBits,
    Partials
} = require('discord.js');

const CONSTANTS = require('./src/utils/constants');
const errors = require('./src/utils/errors');
const commandLoader = require('./src/commands/loader');
const competitiveRatedQueue = require('./src/services/competitiveRatedQueue');
const { closePool } = require('./src/db/sqlClient');
const { fetchChannel, safeFollowUp, safeSend } = require('./src/utils/discord');
const { sendSplitMessages } = require('./src/utils/helpers');

const ACTIVITY_REFRESH_INTERVAL_MS = 10 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const stadiums = [...CONSTANTS.MSC_ALL_STADIUMS, ...CONSTANTS.BL_ALL_STADIUMS];

process.on('unhandledRejection', reason => {
    errors.handle(reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', err => {
    errors.handle(err instanceof Error ? err : new Error(String(err)));
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel]
});

client.commands = commandLoader.loadCommands('futbot');

client.on('error', err => {
    console.error('[Futbot] Discord client error:', err.message ?? err);
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            return await commandLoader.execute(interaction);
        }

        if (competitiveRatedQueue.isCompetitiveRatedInteraction(interaction)) {
            return await competitiveRatedQueue.handleInteraction(interaction);
        }

    } catch (thrown) {
        const err = thrown instanceof Error ? thrown : new Error(String(thrown));
        console.error('[Futbot] Interaction error:', err);
        const debugChannel = await fetchChannel(interaction.guild, CONSTANTS.CHANNELS.DEBUG_ERRORS)
            || await fetchChannel(client, CONSTANTS.CHANNELS.DEBUG_ERRORS);
        if (debugChannel) {
            await sendSplitMessages(part => safeSend(debugChannel, part),
`**Futbot exception**
**Time** <t:${Math.floor(new Date().getTime() / 1000)}>
**Command name:** ${interaction.commandName ?? interaction.customId ?? 'unknown'}
**Executed by:** ${interaction.user?.toString?.() ?? interaction.user?.id ?? 'unknown'}
**Error Message:** ${err.message}
**Stack trace:**
${err.stack}`,
                false
            );
        }
        await safeFollowUp(interaction, {
            content: `:x: There was an error while executing this interaction. ${err.message}`,
            ephemeral: true
        });
    }
});

client.once('clientReady', async () => {
    console.log(`[Futbot] Logged in as ${client.user.tag} (${client.user.id})`);
    try {
        await competitiveRatedQueue.ensureCompetitiveRatedQueue(client);
        console.log('[Futbot] Competitive rated queue panel initialised.');
    } catch (err) {
        console.error('[Futbot] Panel initialisation error:', err.message);
        errors.handle(err, client);
    }
    refreshActivityLoop();
});

function refreshActivityLoop() {
    const rando = Math.floor(Math.random() * stadiums.length);
    client.user.setActivity('at ' + stadiums[rando], { type: ActivityType.Playing });

    const timer = setTimeout(refreshActivityLoop, ACTIVITY_REFRESH_INTERVAL_MS);
    timer.unref?.();
}

client.on('messageCreate', messageManager);

async function messageManager(msg) {
    if (msg.author.bot) return;
    if (!msg.guild) return;
    if (!CONSTANTS.APPROVED_GUILDS.includes(msg.guild.id)) return;

    try {
        await competitiveRatedQueue.enforcePanelMessagePolicy(msg);
    } catch (err) {
        errors.handle(err, client, msg);
    }
}

async function loginWithRetry(token, attempt = 0) {
    const BASE_DELAY_MS = 5000;
    try {
        await client.login(token);
    } catch (err) {
        if (attempt >= LOGIN_MAX_ATTEMPTS) {
            // Exit instead of idling logged out: the container's restart policy starts over.
            console.error(`[Futbot] Login failed after ${LOGIN_MAX_ATTEMPTS} attempts: ${err.message}`);
            process.exit(1);
        }
        const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 300000);
        console.error(`[Futbot] Login failed (attempt ${attempt + 1}): ${err.message}. Retrying in ${Math.round(delayMs / 1000)}s...`);
        setTimeout(() => loginWithRetry(token, attempt + 1), delayMs);
    }
}

let shuttingDown = false;

// docker compose stops and recreates the container with SIGTERM: save the rated queue's runtime
// state, leave the gateway and close the DB pool before exiting.
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Futbot] ${signal} received, shutting down.`);
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    try {
        await competitiveRatedQueue.stopCompetitiveRatedQueue();
        await client.destroy();
        await closePool();
    } catch (err) {
        console.error('[Futbot] Shutdown failed:', err);
    }
    process.exit(0);
}

function start() {
    if (!FUTBOT_TOKEN || !FUTBOT_ID) {
        console.error('Futbot runtime disabled: FUTBOT_TOKEN and FUTBOT_ID must be configured.');
        process.exit(1);
    }

    console.log('Starting Futbot...');
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
    loginWithRetry(FUTBOT_TOKEN);
}

if (require.main === module) {
    start();
}

module.exports = {
    client,
    messageManager,
    start
};
