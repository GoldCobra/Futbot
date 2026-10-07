// Contract: the slash command definitions Discord receives and the runtime
// dispatch map must stay exactly as registered in production. Regenerate the
// fixture only for an intended command change: UPDATE_CONTRACTS=1 npm test.
const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');
const { loadCommands, loadCommandsForRegistration } = require('../../src/commands/loader');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'slash-commands.json');

function describeDispatchMap(commands) {
    return [...commands.entries()].map(([name, handler]) => (
        handler instanceof Collection ? { name, subcommands: [...handler.keys()] } : { name }
    ));
}

function quietly(load) {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        return load();
    } finally {
        spy.mockRestore();
    }
}

test('registered slash commands and the dispatch map are unchanged', () => {
    const actual = {
        registration: quietly(() => loadCommandsForRegistration('futbot')),
        dispatch: describeDispatchMap(quietly(() => loadCommands('futbot')))
    };
    if (process.env.UPDATE_CONTRACTS === '1') {
        fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(actual).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
});
