require('dotenv').config();

const CONSTANTS = require('../src/utils/constants');
const { registerCommands } = require('../src/commands/loader');

async function main() {
    if (!process.env.FUTBOT_TOKEN || !process.env.FUTBOT_ID) {
        throw new Error('FUTBOT_TOKEN and FUTBOT_ID must be configured to register Futbot commands.');
    }

    console.log('Registering Futbot slash commands...');
    await registerCommands(process.env.FUTBOT_TOKEN, process.env.FUTBOT_ID, CONSTANTS.GUILD_ID, 'futbot');
    console.log('Futbot slash command registration finished.');
}

main().catch(error => {
    console.error('Futbot command registration failed.');
    console.error(error);
    process.exitCode = 1;
});
