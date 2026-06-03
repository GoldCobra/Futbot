const {
    CompetitiveWhrRunner,
    DEFAULT_NOT_CONFIGURED_REASON,
    isCompetitiveWhrRunnerConfigured
} = require('../../src/services/competitiveWhrRunner');

describe('competitiveWhrRunner', () => {
    it('marks pending WHR/TST runner partitions as not configured', async () => {
        const dao = {
            getPendingRunnerPartitions: jest.fn(async () => [
                { gameId: 1, mode: '1v1', syncIds: [11, 12], count: 2 },
                { gameId: 2, mode: '2v2', syncIds: [21], count: 1 }
            ]),
            markRunnerNotConfigured: jest.fn(async ({ syncIds }) => ({ updatedRows: syncIds.length }))
        };
        const runner = new CompetitiveWhrRunner({ dao });

        const result = await runner.runPending();

        expect(dao.getPendingRunnerPartitions).toHaveBeenCalledWith({
            limit: 50,
            includeFailed: false,
            includeNotConfigured: false
        });
        expect(dao.markRunnerNotConfigured).toHaveBeenNthCalledWith(1, {
            gameId: 1,
            mode: '1v1',
            syncIds: [11, 12],
            reason: DEFAULT_NOT_CONFIGURED_REASON
        });
        expect(dao.markRunnerNotConfigured).toHaveBeenNthCalledWith(2, {
            gameId: 2,
            mode: '2v2',
            syncIds: [21],
            reason: DEFAULT_NOT_CONFIGURED_REASON
        });
        expect(result).toEqual({
            status: 'not_configured',
            partitions: [
                { gameId: 1, mode: '1v1', syncIds: [11, 12], count: 2, whrRunnerStatus: 'not_configured', updatedRows: 2 },
                { gameId: 2, mode: '2v2', syncIds: [21], count: 1, whrRunnerStatus: 'not_configured', updatedRows: 1 }
            ],
            updatedRows: 3
        });
    });

    it('returns idle when there are no pending runner partitions', async () => {
        const dao = {
            getPendingRunnerPartitions: jest.fn(async () => []),
            markRunnerNotConfigured: jest.fn()
        };
        const runner = new CompetitiveWhrRunner({ dao });

        const result = await runner.runPending({ limit: 10 });

        expect(dao.getPendingRunnerPartitions).toHaveBeenCalledWith({
            limit: 10,
            includeFailed: false,
            includeNotConfigured: false
        });
        expect(dao.markRunnerNotConfigured).not.toHaveBeenCalled();
        expect(result).toEqual({
            status: 'idle',
            partitions: [],
            updatedRows: 0
        });
    });

    it('passes a custom not-configured reason through to the DAO', async () => {
        const dao = {
            getPendingRunnerPartitions: jest.fn(async () => [
                { gameId: 3, mode: '1v1', syncIds: [31], count: 1 }
            ]),
            markRunnerNotConfigured: jest.fn(async () => ({ updatedRows: 1 }))
        };
        const runner = new CompetitiveWhrRunner({ dao });

        await runner.runPending({ reason: 'custom block reason' });

        expect(dao.markRunnerNotConfigured).toHaveBeenCalledWith({
            gameId: 3,
            mode: '1v1',
            syncIds: [31],
            reason: 'custom block reason'
        });
    });

    it('detects runner configuration from the external command env var', () => {
        expect(isCompetitiveWhrRunnerConfigured({})).toBe(false);
        expect(isCompetitiveWhrRunnerConfigured({ COMPETITIVE_WHR_TST_RUNNER_COMMAND: '   ' })).toBe(false);
        expect(isCompetitiveWhrRunnerConfigured({ COMPETITIVE_WHR_TST_RUNNER_COMMAND: 'node scripts/rebuild-whr.js' })).toBe(true);
    });

    it('runs a configured external runner and marks the partition complete', async () => {
        const dao = {
            getPendingRunnerPartitions: jest.fn(async () => [
                { gameId: 1, mode: '1v1', syncIds: [11, 12], count: 2 }
            ]),
            markRunnerRunning: jest.fn(async () => ({ updatedRows: 2 })),
            markRunnerComplete: jest.fn(async () => ({ updatedRows: 2 })),
            markRunnerFailed: jest.fn()
        };
        const commandRunner = jest.fn(async () => ({ stdout: '', stderr: '' }));
        const runner = new CompetitiveWhrRunner({
            dao,
            runnerCommand: 'node scripts/rebuild-whr.js',
            commandRunner,
            timeoutMs: 1234
        });

        const result = await runner.runPending();

        expect(dao.getPendingRunnerPartitions).toHaveBeenCalledWith({
            limit: 50,
            includeFailed: true,
            includeNotConfigured: true
        });
        expect(dao.markRunnerRunning).toHaveBeenCalledWith({
            gameId: 1,
            mode: '1v1',
            syncIds: [11, 12]
        });
        expect(commandRunner).toHaveBeenCalledWith('node scripts/rebuild-whr.js', {
            gameId: 1,
            mode: '1v1',
            syncIds: [11, 12],
            timeoutMs: 1234
        });
        expect(dao.markRunnerComplete).toHaveBeenCalledWith({
            gameId: 1,
            mode: '1v1',
            syncIds: [11, 12]
        });
        expect(dao.markRunnerFailed).not.toHaveBeenCalled();
        expect(result).toEqual({
            status: 'complete',
            partitions: [
                { gameId: 1, mode: '1v1', syncIds: [11, 12], count: 2, whrRunnerStatus: 'complete', updatedRows: 2 }
            ],
            updatedRows: 2
        });
    });

    it('marks configured runner failures and throws for recovery logging', async () => {
        const failure = new Error('runner failed');
        const dao = {
            getPendingRunnerPartitions: jest.fn(async () => [
                { gameId: 2, mode: '2v2', syncIds: [21], count: 1 }
            ]),
            markRunnerRunning: jest.fn(async () => ({ updatedRows: 1 })),
            markRunnerComplete: jest.fn(),
            markRunnerFailed: jest.fn(async () => ({ updatedRows: 1 }))
        };
        const runner = new CompetitiveWhrRunner({
            dao,
            runnerCommand: 'node scripts/rebuild-tst.js',
            commandRunner: jest.fn(async () => { throw failure; })
        });

        await expect(runner.runPending()).rejects.toMatchObject({
            message: 'WHR/TST runner failed for 2:2v2'
        });

        expect(dao.markRunnerFailed).toHaveBeenCalledWith({
            gameId: 2,
            mode: '2v2',
            syncIds: [21],
            error: failure
        });
        expect(dao.markRunnerComplete).not.toHaveBeenCalled();
    });

    it('includes not-configured backlog when a runner is configured later', async () => {
        const dao = {
            getPendingRunnerPartitions: jest.fn(async () => [
                { gameId: 3, mode: '1v1', syncIds: [31], count: 1 }
            ]),
            markRunnerRunning: jest.fn(async () => ({ updatedRows: 1 })),
            markRunnerComplete: jest.fn(async () => ({ updatedRows: 1 })),
            markRunnerFailed: jest.fn()
        };
        const commandRunner = jest.fn(async () => ({ stdout: '', stderr: '' }));
        const runner = new CompetitiveWhrRunner({
            dao,
            runnerCommand: 'node scripts/rebuild-whr.js',
            commandRunner
        });

        const result = await runner.runPending({ limit: 25 });

        expect(dao.getPendingRunnerPartitions).toHaveBeenCalledWith({
            limit: 25,
            includeFailed: true,
            includeNotConfigured: true
        });
        expect(result).toEqual({
            status: 'complete',
            partitions: [
                { gameId: 3, mode: '1v1', syncIds: [31], count: 1, whrRunnerStatus: 'complete', updatedRows: 1 }
            ],
            updatedRows: 1
        });
    });
});
