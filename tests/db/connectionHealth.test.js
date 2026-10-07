// Database reachability from query outcomes: an outage starts with the first query that could not
// get a connection after its retries and ends with the next query that works.
const health = require('../../src/db/connectionHealth');

function connectionError(message = 'Failed to connect to yew.arvixe.com:1433 in 30000ms') {
    return Object.assign(new Error(message), { name: 'ConnectionError', code: 'ETIMEOUT' });
}

describe('connectionHealth', () => {
    afterEach(() => health.resetConnectionHealthForTests());

    it('recognises connection failures only', () => {
        expect(health.isConnectionFailure(connectionError())).toBe(true);
        expect(health.isConnectionFailure(Object.assign(new Error('socket'), { code: 'ESOCKET' }))).toBe(true);
        expect(health.isConnectionFailure(Object.assign(new Error('closed'), { code: 'ECONNCLOSED' }))).toBe(true);
        expect(health.isConnectionFailure(Object.assign(new Error('Timeout: Request failed to complete in 30000ms'), { name: 'RequestError', code: 'ETIMEOUT' }))).toBe(false);
        expect(health.isConnectionFailure(Object.assign(new Error('Invalid object name x'), { name: 'RequestError', number: 208 }))).toBe(false);
        expect(health.isConnectionFailure(null)).toBe(false);
    });

    it('reports every failed query of an outage and its end once', () => {
        const events = [];
        health.onConnectionHealth(event => events.push(event));

        health.recordQuerySuccess(1000);
        health.recordQueryFailure(connectionError(), 2000);
        health.recordQueryFailure(connectionError(), 62000);
        health.recordQuerySuccess(122000);
        health.recordQuerySuccess(123000);

        expect(events.map(({ type, since, failures, at }) => ({ type, since, failures, at }))).toEqual([
            { type: 'failed', since: 2000, failures: 1, at: 2000 },
            { type: 'failed', since: 2000, failures: 2, at: 62000 },
            { type: 'recovered', since: 2000, failures: 2, at: 122000 }
        ]);
        expect(health.currentOutage()).toBeNull();
    });

    it('ignores errors that say nothing about reachability', () => {
        const listener = jest.fn();
        health.onConnectionHealth(listener);
        health.recordQueryFailure(Object.assign(new Error('Deadlock'), { name: 'RequestError', number: 1205 }));
        expect(listener).not.toHaveBeenCalled();
        expect(health.currentOutage()).toBeNull();
    });

    it('keeps notifying the other listeners when one throws', () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        const second = jest.fn();
        health.onConnectionHealth(() => { throw new Error('boom'); });
        health.onConnectionHealth(second);
        health.recordQueryFailure(connectionError());
        expect(second).toHaveBeenCalledTimes(1);
        consoleError.mockRestore();
    });
});
