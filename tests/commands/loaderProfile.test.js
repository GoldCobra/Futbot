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

    it('registers report commands with required game choices', () => {
        const commands = commandLoader.loadCommandsForRegistration('futbot');
        const report1v1 = commands.find(command => command.name === 'report1v1');
        const report2v2 = commands.find(command => command.name === 'report2v2');

        for (const command of [report1v1, report2v2]) {
            const gameOption = command.options.find(option => option.name === 'game');
            expect(gameOption).toEqual(expect.objectContaining({
                required: true,
                choices: [
                    { name: 'MSBL', value: 'MSBL' },
                    { name: 'MSC', value: 'MSC' },
                    { name: 'SMS', value: 'SMS' }
                ]
            }));
        }
    });
});
