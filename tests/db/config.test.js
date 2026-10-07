// Pool defaults for the external server: fresh logins sometimes take over 15 s, and the one-minute
// queue tick must find an idle connection instead of logging in again.
describe('database config', () => {
    const KEYS = ['DB_CONNECTION_TIMEOUT_MS', 'DB_POOL_IDLE_TIMEOUT_MS'];
    let saved;

    beforeEach(() => {
        saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
        for (const key of KEYS) delete process.env[key];
        jest.resetModules();
        jest.doMock('dotenv', () => ({ config: () => ({}) }));
    });

    afterEach(() => {
        jest.dontMock('dotenv');
        for (const key of KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it('waits 30 s for a login and keeps idle connections for 10 minutes', () => {
        const { config } = require('../../src/db/config');
        expect(config.connectionTimeout).toBe(30000);
        expect(config.pool.idleTimeoutMillis).toBe(600000);
        expect(config.port).toBe(1433);
    });

    it('still honours the environment', () => {
        process.env.DB_CONNECTION_TIMEOUT_MS = '20000';
        process.env.DB_POOL_IDLE_TIMEOUT_MS = '120000';
        const { config } = require('../../src/db/config');
        expect(config.connectionTimeout).toBe(20000);
        expect(config.pool.idleTimeoutMillis).toBe(120000);
    });
});
