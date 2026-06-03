const fs = require('node:fs');
const path = require('node:path');
const {
    Collection,
    MessageFlags,
    PermissionsBitField,
    REST,
    Routes,
    SlashCommandBuilder
} = require('discord.js');
const CONSTANTS = require('../utils/constants');
const {safeFollowUp} = require('../utils/discord');

const STAFF_COMMAND_NAMES = new Set(['mslstaff']);
const STAFF_COMMAND_ROLE_IDS = new Set([
    CONSTANTS.ROLES.ADMIN,
    CONSTANTS.ROLES.DEVELOPER,
    CONSTANTS.ROLES.MSL_STAFF,
    CONSTANTS.ROLES.MSL_STAFF_MSC,
    CONSTANTS.ROLES.MSL_STAFF_SMS,
    CONSTANTS.ROLES.MSL_STAFF_MSBL
]);

const COMMAND_PROFILES = {
futbot: [
    {
        'name': 'general',
        'description': 'futbot general commands',
        'directories': [
            {
                'name': 'general',
                'include': ['gear', 'gearrules', 'ratedreset', 'ratedsetup']
            }
        ],
        'areTopLevelCommands': true
    },
    {
        'name': 'mslstaff',
        'description': 'futbot staff commands',
        'directories': [
            {
                'name': 'mslstaff',
                'include': ['compSeason', 'rollbackratedmatch']
            }
        ]
    }
]
};

function getCommandsForProfile(profile = 'futbot') {
    const commands = COMMAND_PROFILES[profile];
    if (!commands) {
        throw new Error(`Unknown command profile '${profile}'. Expected one of: ${Object.keys(COMMAND_PROFILES).join(', ')}`);
    }
    return commands;
}

function commandFileIsIncluded(file, directory) {
    const commandName = path.basename(file, '.js');
    if (directory.include && !directory.include.includes(commandName)) {
        return false;
    }
    if (directory.exclude && directory.exclude.includes(commandName)) {
        return false;
    }
    return true;
}

function memberHasAnyRole(member, roleIds) {
    const roleCache = member?.roles?.cache;
    if (roleCache && typeof roleCache.some === 'function') {
        return roleCache.some(role => roleIds.has(role.id));
    }

    const roles = member?.roles;
    if (Array.isArray(roles)) {
        return roles.some(role => roleIds.has(typeof role === 'string' ? role : role?.id));
    }

    return false;
}

function canUseStaffCommand(interaction) {
    if (interaction?.memberPermissions?.has?.(PermissionsBitField.Flags.Administrator)) {
        return true;
    }

    return memberHasAnyRole(interaction?.member, STAFF_COMMAND_ROLE_IDS);
}

async function denyStaffCommand(interaction) {
    await safeFollowUp(interaction, {
        content: 'You do not have permission to use MSL staff commands.',
        flags: MessageFlags.Ephemeral
    });
}

function loadSubCommands(subCommandFiles, adjustedExecution=null, directory={}) {
    const commandFiles = subCommandFiles.filter(file => file.endsWith('.js') && commandFileIsIncluded(file, directory));

    let subCommands = new Collection();

    if(!adjustedExecution) {
        adjustedExecution = (subcommand)=> { return async (interaction) => await subcommand.execute(interaction)};
    }

    for (const file of commandFiles) {
        const subCommand = require(file);
        // Set a new item in the Collection with the key as the command name and the value as the exported module
        if ('data' in subCommand && 'execute' in subCommand) {
            subCommands.set(subCommand.data.name, adjustedExecution(subCommand) );
        } else {
            console.log(`[WARNING] The command at ${file} is missing a required "data" or "execute" property.`);
        }
    }
    return subCommands;
}

function loadSubCommandsRegistration(subCommandFiles, directory={}) {
    const commandFiles = subCommandFiles.filter(file => file.endsWith('.js') && commandFileIsIncluded(file, directory));

    let subCommands = [];

    for (const file of commandFiles) {
        const subCommand = require(file);
        // Set a new item in the Collection with the key as the command name and the value as the exported module
        if ('data' in subCommand && 'execute' in subCommand) {
            subCommands.push(subCommand.data);
        } else {
            console.log(`[WARNING] The command at ${file} is missing a required "data" or "execute" property.`);
        }
    }
    return subCommands;
}

function loadCommandsForRegistration(profile = 'futbot') {
    const commands = [];
    for(const command of getCommandsForProfile(profile)) {
        console.log(`Loading '${command.name}' - '${command.description}'`);
        if(command.areTopLevelCommands) {
            for(const directory of command.directories) {
                let files = fs.readdirSync(path.join(__dirname, directory.name)).filter(file => file.endsWith('.js'))
                files = files.map(s => path.join(__dirname, directory.name, s));
                files = files.filter(file => commandFileIsIncluded(file, directory));
                for(const file of files) {
                    const _command = require(file);
                    if ('data' in _command && 'execute' in _command) {
                        commands.push(_command.data.toJSON());
                    } else {
                        console.log(`[WARNING] The command at ${file} is missing a required "data" or "execute" property.`);
                    }
                }
            }
            continue;
        }

        let newCommand = new SlashCommandBuilder()
            .setName(command.name)
            .setDescription(command.description)
        ;
        let subCommands = [];
        for(const directory of command.directories) {
            let subCommandFiles = fs.readdirSync(path.join(__dirname, directory.name)).filter(file => file.endsWith('.js'));
            subCommandFiles = subCommandFiles.map(s => path.join(__dirname, directory.name, s));
            subCommands = subCommands.concat(loadSubCommandsRegistration(subCommandFiles, directory));
        }
        subCommands.forEach(s => newCommand.addSubcommand(s));
        commands.push(newCommand.toJSON());
    }
    return commands
}

function loadCommands(profile = 'futbot') {
    let commands = new Collection();
    for(const command of getCommandsForProfile(profile)) {
        if(command.areTopLevelCommands) {
            for(const directory of command.directories) {
                let files = fs.readdirSync(path.join(__dirname, directory.name)).filter(file => file.endsWith('.js'))
                files = files.map(s => path.join(__dirname, directory.name, s));
                files = files.filter(file => commandFileIsIncluded(file, directory));
                for(const file of files) {
                    const _command = require(file);
                    if ('data' in _command && 'execute' in _command) {
                        commands.set(_command.data.name, async(interaction) => await _command.execute(interaction));
                    } else {
                        console.log(`[WARNING] The command at ${file} is missing a required "data" or "execute" property.`);
                    }
                }
            }
            continue;
        }

        let subCommands = new Collection();


        for(const directory of command.directories) {
            let subCommandFiles = fs.readdirSync(path.join(__dirname, directory.name)).filter(file => file.endsWith('.js'));
            subCommandFiles = subCommandFiles.map(s => path.join(__dirname, directory.name, s));
            subCommands = subCommands.concat(loadSubCommands(subCommandFiles, directory.adjustedExecution, directory));
        }
        commands.set(command.name, subCommands);
    }

    return commands;
}

async function execute(interaction) {
	let topLevelCommand = interaction.client.commands.get(interaction.commandName);
    let command = topLevelCommand;

    if (topLevelCommand instanceof Collection) {
        if (STAFF_COMMAND_NAMES.has(interaction.commandName) && !canUseStaffCommand(interaction)) {
            await denyStaffCommand(interaction);
            return;
        }

        const subcommand = typeof interaction.options.getSubcommand === 'function'
            ? interaction.options.getSubcommand(false)
            : interaction.options._subcommand;
        command = topLevelCommand.get(subcommand);
    } 

    if (!command) {
        await safeFollowUp(interaction, { content: `Unknown command: ${interaction.commandName}`, ephemeral: true });
        return;
    }

    try {
		await command(interaction);
	} catch (error) {
		console.error('ERROR:\n', error);
		await safeFollowUp(interaction, { content: 'There was an error while executing this command!', ephemeral: true });
	}
}

async function registerCommands(token, clientId, guildId, profile = 'futbot') {
    // Construct and prepare an instance of the REST module
    const rest = new REST({ version: '10', timeout: 20000 }).setToken(token);

    const commands = loadCommandsForRegistration(profile);

	const maxAttempts = 4;
	const retryDelaysMs = [10000, 20000, 30000];
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			console.log(`Started refreshing ${commands.length} application (/) commands.`);
			const data = await rest.put(
				Routes.applicationGuildCommands(clientId, guildId),
				{ body: commands },
			);
			console.log(`Successfully reloaded ${data.length} application (/) commands.`);
			return;
		} catch (error) {
			const isRetryable = !error.status || error.status >= 500;
			if (isRetryable && attempt < maxAttempts) {
				const delayMs = retryDelaysMs[attempt - 1] ?? 30000;
				console.warn(`Command registration failed (${error.status}), retrying in ${delayMs / 1000}s... (attempt ${attempt}/${maxAttempts})`);
				await new Promise(resolve => setTimeout(resolve, delayMs));
			} else {
				console.error(`Command registration failed after ${attempt} attempt(s):`);
				console.error(error);
				throw error;
			}
		}
	}
}

async function unregisterCommands(token, clientId, guildId) {
    const rest = new REST({ version: '10' }).setToken(token);

    // for guild-based commands
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
    console.log('Successfully deleted all guild commands');
}

module.exports = {
    unregisterCommands,
    registerCommands,
    loadCommandsForRegistration,
    loadCommands,
    execute,
    __private: {
        canUseStaffCommand,
        memberHasAnyRole
    }
}
