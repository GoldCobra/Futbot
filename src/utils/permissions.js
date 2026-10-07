const { PermissionsBitField } = require('discord.js');

const CONSTANTS = require('./constants');

// futbot's staff: admins, developers and the MSL staff roles of every game. One set for the
// /mslstaff commands, /ratedreset and /ratedsetup, pre-approved start.gg reports and the
// rated panel's message policy.
const STAFF_ROLE_IDS = new Set([
    CONSTANTS.ROLES.ADMIN,
    CONSTANTS.ROLES.DEVELOPER,
    CONSTANTS.ROLES.MSL_STAFF,
    CONSTANTS.ROLES.MSL_STAFF_MSC,
    CONSTANTS.ROLES.MSL_STAFF_SMS,
    CONSTANTS.ROLES.MSL_STAFF_MSBL
]);

function memberHasAnyRole(member, roleIds = STAFF_ROLE_IDS) {
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

// Server administrators always count as staff.
function isStaffInteraction(interaction) {
    if (interaction?.memberPermissions?.has?.(PermissionsBitField.Flags.Administrator)) {
        return true;
    }
    return memberHasAnyRole(interaction?.member);
}

function isStaffMember(member) {
    if (!member?.roles?.cache) {
        return false;
    }
    if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) {
        return true;
    }
    return memberHasAnyRole(member);
}

module.exports = {
    STAFF_ROLE_IDS,
    isStaffInteraction,
    isStaffMember,
    memberHasAnyRole
};
