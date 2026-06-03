const {
    CompetitiveWhrRunner,
    DEFAULT_NOT_CONFIGURED_REASON
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

        expect(dao.getPendingRunnerPartitions).toHaveBeenCalledWith({ limit: 50 });
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

        expect(dao.getPendingRunnerPartitions).toHaveBeenCalledWith({ limit: 10 });
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
});
