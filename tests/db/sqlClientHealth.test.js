// sqlClient feeds connectionHealth: a query that still fails after its retries because no
// connection could be opened records a failure; any successful query records a success.
const mockQuery = jest.fn();
jest.mock('mssql', () => ({
    connect: jest.fn(async () => ({ request: () => ({ input: jest.fn(), query: (...args) => mockQuery(...args) }) }))
}));

function connectionError() {
    return Object.assign(new Error('Failed to connect to yew.arvixe.com:1433 in 30000ms'), { name: 'ConnectionError', code: 'ETIMEOUT' });
}

describe('sqlClient connection health', () => {
    let executeQuery;
    let health;
    let events;

    beforeEach(() => {
        jest.resetModules();
        process.env.DB_TRANSIENT_RETRY_ATTEMPTS = '2';
        process.env.DB_TRANSIENT_RETRY_BASE_MS = '0';
        process.env.DB_CIRCUIT_MAX_WAIT_MS = '0';
        mockQuery.mockReset();
        ({ executeQuery } = require('../../src/db/sqlClient'));
        health = require('../../src/db/connectionHealth');
        events = [];
        health.onConnectionHealth(event => events.push(event.type));
    });

    afterEach(() => {
        delete process.env.DB_TRANSIENT_RETRY_ATTEMPTS;
        delete process.env.DB_TRANSIENT_RETRY_BASE_MS;
        delete process.env.DB_CIRCUIT_MAX_WAIT_MS;
        health.resetConnectionHealthForTests();
    });

    it('records nothing when a retry succeeds, a failure when all retries fail, and the recovery', async () => {
        mockQuery.mockRejectedValueOnce(connectionError()).mockResolvedValueOnce({ recordset: [] });
        await executeQuery('SELECT 1');
        expect(events).toEqual([]);

        mockQuery.mockRejectedValueOnce(connectionError()).mockRejectedValueOnce(connectionError());
        await expect(executeQuery('SELECT 1')).rejects.toThrow('Failed to connect');
        expect(events).toEqual(['failed']);

        mockQuery.mockResolvedValueOnce({ recordset: [] });
        await executeQuery('SELECT 1');
        expect(events).toEqual(['failed', 'recovered']);
    });

    it('does not treat SQL errors as an outage', async () => {
        mockQuery.mockRejectedValueOnce(Object.assign(new Error('Invalid column name x'), { name: 'RequestError', number: 207 }));
        await expect(executeQuery('SELECT x')).rejects.toThrow('Invalid column');
        expect(events).toEqual([]);
    });
});
