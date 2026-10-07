const net = require('net');

describe('test isolation', () => {
    test('credentials from a local .env never reach the tests', () => {
        expect(process.env.DB_USER).toBe('');
        expect(process.env.DB_PASS).toBe('');
    });

    test('sockets to non-loopback hosts fail before any traffic', async () => {
        const error = await new Promise(resolve => {
            const socket = net.connect({ host: 'yew.arvixe.com', port: 1433 });
            socket.on('error', resolve);
            socket.on('connect', () => resolve(null));
        });
        expect(error?.code).toBe('ETESTNETWORK');
    });

    test('the database client cannot connect', async () => {
        const { executeQuery } = require('../src/db/sqlClient');
        await expect(executeQuery('SELECT 1')).rejects.toThrow();
    });
});
