const commandLoader = require('../../src/commands/loader');

describe('futbot command loader profile', () => {
    it('registers top-level report commands', () => {
        const commands = commandLoader.loadCommandsForRegistration('futbot');
        const names = commands.map(command => command.name);

        expect(names).toEqual(expect.arrayContaining([
            'report1v1',
            'report2v2'
        ]));
    });
});
