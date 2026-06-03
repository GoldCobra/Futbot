const CompetitiveWhrSyncDao = require('../db/daos/competitiveWhrSyncDao');

const DEFAULT_NOT_CONFIGURED_REASON = [
    'WHR/TST runner is not configured.',
    'Competitive rated matches were mirrored to legacy match tables,',
    'but PlayerStats.RatingWHR/RatingTS was not recalculated.'
].join(' ');

class CompetitiveWhrRunner {
    constructor({ dao = new CompetitiveWhrSyncDao() } = {}) {
        this.dao = dao;
    }

    async runPending({ limit = 50, reason = DEFAULT_NOT_CONFIGURED_REASON } = {}) {
        const partitions = await this.dao.getPendingRunnerPartitions({ limit });
        const processed = [];

        for (const partition of partitions) {
            const result = await this.dao.markRunnerNotConfigured({
                gameId: partition.gameId,
                mode: partition.mode,
                syncIds: partition.syncIds,
                reason
            });

            processed.push({
                ...partition,
                whrRunnerStatus: 'not_configured',
                updatedRows: result.updatedRows ?? 0
            });
        }

        return {
            status: processed.length ? 'not_configured' : 'idle',
            partitions: processed,
            updatedRows: processed.reduce((sum, partition) => sum + partition.updatedRows, 0)
        };
    }
}

const runner = new CompetitiveWhrRunner();

async function runPendingCompetitiveWhrRunner(options) {
    return runner.runPending(options);
}

module.exports = {
    CompetitiveWhrRunner,
    DEFAULT_NOT_CONFIGURED_REASON,
    runPendingCompetitiveWhrRunner
};
