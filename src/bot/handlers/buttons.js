const {ROLES} = require('../../utils/constants')
const {safeReply} = require('../../utils/discord')


const generalCommandButtonCallBacks = {
    'msc': async(interaction) => {
        await roleHelper(interaction, ROLES.MSC_FAN);
    },
    'msclfg': async(interaction) => {
        await roleHelper(interaction, ROLES.MSC_LFG);
    },
    'mscrankedlfg': async(interaction) => {
        await roleHelper(interaction, ROLES.MSC_LFG_RANKED);
    },
    'sms': async(interaction) => {
        await roleHelper(interaction, ROLES.SMS_FAN);
    },
    'smslfg': async(interaction) => {
        await roleHelper(interaction, ROLES.SMS_LFG);
    },
    'smslfg2': async(interaction) => {
        await roleHelper(interaction, ROLES.SMS_LFG_2);
    },
    'tournaments': async(interaction) => {
        await roleHelper(interaction, ROLES.TOURNAMENT);
    },
    'modding': async(interaction) => {
        await roleHelper(interaction, ROLES.MODDING);
    },
    'msbl': async(interaction) => {
        await roleHelper(interaction, ROLES.MSBL);
    },
    'msbllfg': async(interaction) => {
        await roleHelper(interaction, ROLES.MSBL_LFG);
    },
    'smsspectator': async(interaction) => {
        await roleHelper(interaction,ROLES.SMS_SPECTATOR);
    },
    'mscspectator': async(interaction) => {
        await roleHelper(interaction,ROLES.MSC_SPECTATOR);
    },
    'msblspectator': async(interaction) => {
        await roleHelper(interaction, ROLES.MSBL_SPECTATOR);
    },
    'blvoice': async(interaction) => {
        await roleHelper(interaction, ROLES.MSBL_VOICE);
    },
    'mscvoice': async(interaction) => {
        await roleHelper(interaction, ROLES.MSC_VOICE);
    },
    'smsvoice': async(interaction) => {
        await roleHelper(interaction, ROLES.SMS_VOICE);
    },
    'mscstream': async(interaction) => {
        await roleHelper(interaction, ROLES.MSC_STREAM);
    },
    'smsstream': async(interaction) => {
        await roleHelper(interaction, ROLES.SMS_STREAM);
    },
    'msl': async(interaction) => {
        await roleHelper(interaction, ROLES.MSL);
    }
}

const roleHelper = async (interaction, role) => {
    const user = interaction.member;
    try {
        if (!user || !user.roles) {
            await safeReply(interaction, {content: 'Role was not updated :(', ephemeral: true});
            return;
        }

        const hasRole = user.roles.cache ? user.roles.cache.has(role) : (user._roles || []).includes(role);
        if (hasRole) {
            await user.roles.remove(role);
            await safeReply(interaction, {content: `We succesfully removed <@&${role}>`, ephemeral: true});
        } else {
            await user.roles.add(role);
            await safeReply(interaction, {content: `We succesfully added <@&${role}>`, ephemeral:true});
        }
    } catch (err) {
        console.error(`Button handler error: ${err.message}\n${err.stack}`);
        await safeReply(interaction, {content: 'Role was not updated :(', ephemeral: true});
    }
}

module.exports = {generalCommandButtonCallBacks}
