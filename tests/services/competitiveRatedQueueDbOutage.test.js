// Database outages in the rated log: one warning once an outage lasts long enough, one note when it
// ends, nothing for short blips; other background job errors stay errors.
const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
jest.mock('../../src/services/competitiveRatedQueue/runtimeLogger', () => ({
    logRatedError: (...args) => mockLog.error(...args),
    logRatedWarn: (...args) => mockLog.warn(...args),
    logRatedInfo: (...args) => mockLog.info(...args)
}));

const health = require('../../src/db/connectionHealth');
const { logBackgroundJobError, startDbOutageLog, stopDbOutageLog } = require('../../src/services/competitiveRatedQueue/dbOutage');

const MINUTE = 60_000;
const client = { id: 'client' };

function connectionError() {
    return Object.assign(new Error('Failed to connect to yew.arvixe.com:1433 in 30000ms'), { name: 'ConnectionError', code: 'ETIMEOUT' });
}

describe('rated log database outages', () => {
    let consoleLog;
    let consoleWarn;

    beforeEach(() => {
        jest.clearAllMocks();
        consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
        consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        startDbOutageLog(client);
    });

    afterEach(() => {
        stopDbOutageLog();
        health.resetConnectionHealthForTests();
        consoleLog.mockRestore();
        consoleWarn.mockRestore();
    });

    it('stays quiet for a short blip', () => {
        health.recordQueryFailure(connectionError(), 0);
        health.recordQueryFailure(connectionError(), 2 * MINUTE);
        health.recordQuerySuccess(3 * MINUTE);

        expect(mockLog.warn).not.toHaveBeenCalled();
        expect(mockLog.info).not.toHaveBeenCalled();
        expect(mockLog.error).not.toHaveBeenCalled();
        expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('database reachable again after 3m (2 failed queries)'));
    });

    it('warns once after five minutes and notes the recovery once', () => {
        for (let minute = 0; minute <= 9; minute += 1) {
            health.recordQueryFailure(connectionError(), minute * MINUTE);
        }
        health.recordQuerySuccess(10 * MINUTE);
        health.recordQuerySuccess(11 * MINUTE);

        expect(mockLog.warn).toHaveBeenCalledTimes(1);
        expect(mockLog.warn).toHaveBeenCalledWith(client, { all: true }, 'db.unreachable', expect.objectContaining({
            since: new Date(0).toISOString(),
            failedQueries: 6,
            error: 'Failed to connect to yew.arvixe.com:1433 in 30000ms'
        }));
        expect(mockLog.info).toHaveBeenCalledTimes(1);
        expect(mockLog.info).toHaveBeenCalledWith(client, { all: true }, 'db.reachable_again', { downFor: '10m', failedQueries: 10 });
    });

    it('honours DB_OUTAGE_WARN_AFTER_MS', () => {
        process.env.DB_OUTAGE_WARN_AFTER_MS = '0';
        try {
            health.recordQueryFailure(connectionError(), 0);
            expect(mockLog.warn).toHaveBeenCalledTimes(1);
        } finally {
            delete process.env.DB_OUTAGE_WARN_AFTER_MS;
        }
    });

    it('logs no connection failure of a background job as an error, everything else as one', () => {
        logBackgroundJobError(client, 'season.transition_failed', connectionError());
        expect(mockLog.error).not.toHaveBeenCalled();
        expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('season.transition_failed: database unreachable'));

        const sqlError = Object.assign(new Error('Invalid object name x'), { name: 'RequestError' });
        logBackgroundJobError(client, 'season.transition_failed', sqlError);
        expect(mockLog.error).toHaveBeenCalledWith(client, { all: true }, 'season.transition_failed', sqlError);
    });

    it('stops listening on shutdown', () => {
        stopDbOutageLog();
        for (let minute = 0; minute <= 9; minute += 1) health.recordQueryFailure(connectionError(), minute * MINUTE);
        expect(mockLog.warn).not.toHaveBeenCalled();
    });
});
