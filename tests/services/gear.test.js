const gear = require('../../src/services/gear');

describe('gear service', () => {
    it('keeps the Futbot gear rules text available', () => {
        expect(gear.getGearRulesText()).toContain('Main Rules');
        expect(gear.getGearRulesText()).toContain('/gear');
    });

    it('matches known gear combinations from Futbot data', () => {
        const combinations = gear.findGear(11, 12, 14, 10, 16, 'Mario');

        expect(combinations).toEqual(expect.arrayContaining([
            'No Helmet, No Gloves, No Chest, No Boots'
        ]));
    });

    it('builds the same unknown-character response as the old Futbot command', () => {
        expect(gear.buildGearResponse(1, 1, 1, 1, 1, 'Goomba'))
            .toBe('Goomba is not in the game... not yet anyways!');
    });
});
