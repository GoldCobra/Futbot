const { Collection, PermissionsBitField } = require('discord.js');

const CONSTANTS = require('../../src/utils/constants');
const { STAFF_ROLE_IDS, isStaffInteraction, isStaffMember, memberHasAnyRole } = require('../../src/utils/permissions');

function roleCache(ids) {
    return new Collection(ids.map(id => [id, { id }]));
}

function interaction({ roles = [], admin = false } = {}) {
    return {
        member: { roles: { cache: roleCache(roles) } },
        memberPermissions: { has: flag => admin && flag === PermissionsBitField.Flags.Administrator }
    };
}

describe('staff permissions', () => {
    test('one staff set: admins, developers and the MSL staff of every game', () => {
        expect([...STAFF_ROLE_IDS].sort()).toEqual([...new Set([
            CONSTANTS.ROLES.ADMIN,
            CONSTANTS.ROLES.DEVELOPER,
            CONSTANTS.ROLES.MSL_STAFF,
            CONSTANTS.ROLES.MSL_STAFF_MSC,
            CONSTANTS.ROLES.MSL_STAFF_SMS,
            CONSTANTS.ROLES.MSL_STAFF_MSBL
        ])].sort());
    });

    test.each([
        ['MSBL staff', { roles: [CONSTANTS.ROLES.MSL_STAFF_MSBL] }, true],
        ['developer', { roles: [CONSTANTS.ROLES.DEVELOPER] }, true],
        ['server administrator without a staff role', { admin: true }, true],
        ['regular member', { roles: ['some-other-role'] }, false]
    ])('interaction from a %s', (label, options, expected) => {
        expect(isStaffInteraction(interaction(options))).toBe(expected);
    });

    test('role-only checks ignore the administrator permission', () => {
        expect(memberHasAnyRole(interaction({ admin: true }).member)).toBe(false);
        expect(memberHasAnyRole({ roles: [CONSTANTS.ROLES.MSL_STAFF_SMS] })).toBe(true);
    });

    test('panel members: administrator permission or a staff role, nothing without a role cache', () => {
        expect(isStaffMember({ roles: { cache: roleCache([]) }, permissions: { has: () => true } })).toBe(true);
        expect(isStaffMember({ roles: { cache: roleCache([CONSTANTS.ROLES.ADMIN]) } })).toBe(true);
        expect(isStaffMember({ roles: { cache: roleCache(['x']) } })).toBe(false);
        expect(isStaffMember({ permissions: { has: () => true } })).toBe(false);
    });
});
