// The pending Competitive write queue: results that hit a transient DB error wait here and are
// written later. These tests pin how it retries, when it gives up and where it logs.
const mockRatedMatchDao = {
    recordGame: jest.fn(async () => ({ Id: 1, Inserted: true })),
    cancelMatchById: jest.fn(async () => {})
};
const mockRecordCompetitiveResult = jest.fn(async () => ({
    changes: [{ discordId: 'home-user', outcome: 'win', teamNumber: 1, eloDelta: 50, eloAfter: 550, rankAfter: 0 }]
}));

jest.mock('../../src/db/daos/ratedMatchDao', () => jest.fn().mockImplementation(() => mockRatedMatchDao));
jest.mock('../../src/services/competitiveRating', () => ({
    recordCompetitiveResult: (...args) => mockRecordCompetitiveResult(...args)
}));

const { RatedMatchStateError } = require('../../src/db/errors');
const { state } = require('../../src/services/competitiveRatedQueue/state');
const { flushRuntimeLogs } = require('../../src/services/competitiveRatedQueue/runtimeLogger');
const { enqueueCompetitiveDbOp, runPendingCompetitiveDbOps } = require('../../src/services/competitiveRatedQueue/dbOps');

const MSC_1V1_LOG_THREAD = '1503758199638196255';
const SMS_1V1_LOG_THREAD = '1503758084550426766';

function createClient() {
    const threads = new Map();
    const getThread = id => {
        if (!threads.has(id)) {
            threads.set(id, {
                id,
                send: jest.fn(async payload => ({ id: `${id}-message`, payload, content: payload.content }))
            });
        }
        return threads.get(id);
    };
    return {
        threads,
        getThread,
        channels: { fetch: jest.fn(async id => getThread(id)) }
    };
}

function createMatch(overrides = {}) {
    return { id: 'match-1', threadId: 'match-thread', gameType: 'MSC', mode: '1v1', ...overrides };
}

function recordGamePayload(overrides = {}) {
    return { ratedMatchId: 500, matchCode: 'match-1', threadId: 'match-thread', gameNumber: 2, winnerTeamNumber: 1, ...overrides };
}

function completePayload(overrides = {}) {
    return { ratedMatchId: 500, matchCode: 'match-1', threadId: 'match-thread', seasonId: 3, gameType: 1, mode: '1v1', winnerTeamNumber: 1, ...overrides };
}

async function logLines(client, threadId) {
    await flushRuntimeLogs();
    const thread = client.threads.get(threadId);
    return (thread?.send.mock.calls ?? []).map(([payload]) => payload.content).join('\n');
}

function transientError() {
    const error = new Error('Failed to connect to yew.arvixe.com:1433');
    error.code = 'ESOCKET';
    return error;
}

describe('pending Competitive DB writes', () => {
    beforeEach(() => {
        state.pendingCompetitiveDbOpsByKey.clear();
        state.runtimeLogBuffersByThreadId.clear();
        state.runtimeLogQueuesByThreadId.clear();
        mockRatedMatchDao.recordGame.mockReset().mockResolvedValue({ Id: 1, Inserted: true });
        mockRatedMatchDao.cancelMatchById.mockReset().mockResolvedValue(undefined);
        mockRecordCompetitiveResult.mockClear();
    });

    test('writes queued ops in order and announces the synced ratings in the match thread', async () => {
        const client = createClient();
        const match = createMatch();
        enqueueCompetitiveDbOp('record_game', recordGamePayload(), match, client, 'test');
        enqueueCompetitiveDbOp('complete_competitive', completePayload(), match, client, 'test');

        await runPendingCompetitiveDbOps(client);

        expect(mockRatedMatchDao.recordGame).toHaveBeenCalledTimes(1);
        expect(mockRecordCompetitiveResult).toHaveBeenCalledTimes(1);
        expect(mockRatedMatchDao.recordGame.mock.invocationCallOrder[0])
            .toBeLessThan(mockRecordCompetitiveResult.mock.invocationCallOrder[0]);
        expect(state.pendingCompetitiveDbOpsByKey.size).toBe(0);
        const notice = client.getThread('match-thread').send.mock.calls[0][0].content;
        expect(notice).toContain('**Competitive DB sync completed.**');
        expect(await logLines(client, MSC_1V1_LOG_THREAD)).toContain('competitive_db.op_completed');
    });

    test('keeps a transiently failing op for a later retry with back-off', async () => {
        const client = createClient();
        mockRatedMatchDao.recordGame.mockRejectedValue(transientError());
        enqueueCompetitiveDbOp('record_game', recordGamePayload(), createMatch(), client, 'test');
        const before = Date.now();

        await runPendingCompetitiveDbOps(client);

        const [op] = [...state.pendingCompetitiveDbOpsByKey.values()];
        expect(op.attempts).toBe(1);
        expect(op.nextRetryAt).toBeGreaterThanOrEqual(before + 5000);
        expect(await logLines(client, MSC_1V1_LOG_THREAD)).toContain('competitive_db.op_retry_scheduled');

        await runPendingCompetitiveDbOps(client);
        expect(mockRatedMatchDao.recordGame).toHaveBeenCalledTimes(1);
    });

    test('does not rate a match while one of its games still waits to be written', async () => {
        const client = createClient();
        const match = createMatch();
        mockRatedMatchDao.recordGame.mockRejectedValue(transientError());
        enqueueCompetitiveDbOp('record_game', recordGamePayload(), match, client, 'test');
        enqueueCompetitiveDbOp('complete_competitive', completePayload(), match, client, 'test');

        await runPendingCompetitiveDbOps(client);

        expect(mockRecordCompetitiveResult).not.toHaveBeenCalled();
        expect(state.pendingCompetitiveDbOpsByKey.size).toBe(2);
    });

    test('drops a result for a match the DB cancelled meanwhile and logs it as an error', async () => {
        const client = createClient();
        mockRecordCompetitiveResult.mockRejectedValueOnce(new RatedMatchStateError('RatedMatch 500 is cancelled; its result is not rated'));
        enqueueCompetitiveDbOp('complete_competitive', completePayload(), createMatch(), client, 'test');

        await runPendingCompetitiveDbOps(client);

        expect(state.pendingCompetitiveDbOpsByKey.size).toBe(0);
        expect(client.getThread('match-thread').send).not.toHaveBeenCalled();
        const logs = await logLines(client, MSC_1V1_LOG_THREAD);
        expect(logs).toContain('competitive_db.op_dropped');
        expect(logs).toContain('RatedMatch 500 is cancelled');
    });

    test('drops a game write that contradicts the stored game instead of retrying it forever', async () => {
        const client = createClient();
        const conflict = new Error('RatedMatchGame already exists with different result data.');
        conflict.number = 51020;
        mockRatedMatchDao.recordGame.mockRejectedValue(conflict);
        enqueueCompetitiveDbOp('record_game', recordGamePayload(), createMatch(), client, 'test');

        await runPendingCompetitiveDbOps(client);

        expect(state.pendingCompetitiveDbOpsByKey.size).toBe(0);
        expect(await logLines(client, MSC_1V1_LOG_THREAD)).toContain('competitive_db.op_dropped');
    });

    test('retries a cancelled match in the DB with its original reason', async () => {
        const client = createClient();
        enqueueCompetitiveDbOp('cancel_match', { ratedMatchId: 500, matchCode: 'match-1', threadId: 'match-thread', cancelReason: 'player_vote' }, createMatch(), client, 'test');

        await runPendingCompetitiveDbOps(client);

        expect(mockRatedMatchDao.cancelMatchById).toHaveBeenCalledWith({ matchId: 500, cancelReason: 'player_vote' });
        expect(state.pendingCompetitiveDbOpsByKey.size).toBe(0);
    });

    test('joins a running pass instead of writing the same ops twice', async () => {
        const client = createClient();
        let release;
        mockRatedMatchDao.recordGame.mockImplementation(() => new Promise(resolve => {
            release = resolve;
        }));
        enqueueCompetitiveDbOp('record_game', recordGamePayload(), createMatch(), client, 'test');

        const first = runPendingCompetitiveDbOps(client);
        const second = runPendingCompetitiveDbOps(client);
        await new Promise(resolve => setImmediate(resolve));
        release({ Id: 1, Inserted: true });
        await Promise.all([first, second]);

        expect(mockRatedMatchDao.recordGame).toHaveBeenCalledTimes(1);
    });

    test('routes logs of ops saved by older versions (no game type stored) through the payload', async () => {
        const client = createClient();
        state.pendingCompetitiveDbOpsByKey.set('complete_competitive:600', {
            key: 'complete_competitive:600',
            type: 'complete_competitive',
            payload: completePayload({ ratedMatchId: 600, gameType: 2, threadId: 'old-thread' }),
            matchId: 'match-old',
            threadId: 'old-thread',
            createdAt: 1,
            attempts: 0,
            nextRetryAt: 0
        });

        await runPendingCompetitiveDbOps(client);

        expect(await logLines(client, SMS_1V1_LOG_THREAD)).toContain('competitive_db.op_completed');
    });
});
