// Contract: intents, partials and gateway listeners of the bot client. A
// listener registered twice (or inside a reconnecting event) shows up here.
const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'client-wiring.json');
const PROCESS_EVENTS = ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT'];

let addedProcessListeners = [];

afterAll(() => {
    for (const [event, listener] of addedProcessListeners) {
        process.removeListener(event, listener);
    }
});

test('client intents, partials and listeners are unchanged', () => {
    const before = new Map(PROCESS_EVENTS.map(event => [event, process.listeners(event)]));
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { client } = require('../../index');
    spy.mockRestore();
    addedProcessListeners = PROCESS_EVENTS.flatMap(event => process.listeners(event)
        .filter(listener => !before.get(event).includes(listener))
        .map(listener => [event, listener]));

    const actual = {
        intents: client.options.intents.toArray().sort(),
        partials: [...client.options.partials].sort(),
        listeners: Object.fromEntries(client.eventNames()
            .filter(name => typeof name === 'string')
            .sort()
            .map(name => [name, client.listenerCount(name)])),
        processListeners: Object.fromEntries(PROCESS_EVENTS
            .map(event => [event, addedProcessListeners.filter(([name]) => name === event).length])
            .filter(([, count]) => count > 0))
    };
    if (process.env.UPDATE_CONTRACTS === '1') {
        fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(actual).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
});
