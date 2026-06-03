const CompetitiveWhrSyncDao = require('../db/daos/competitiveWhrSyncDao');
const { exec } = require('child_process');

const DEFAULT_NOT_CONFIGURED_REASON = [
    'WHR/TST runner is not configured.',
    'Competitive rated matches were mirrored to legacy match tables,',
    'but PlayerStats.RatingWHR/RatingTS was not recalculated.'
].join(' ');
const COMPETITIVE_WHR_TST_UNAVAILABLE_MESSAGE = 'Rated matches are temporarily unavailable while WHR/TST recalculation is being prepared.';
const DEFAULT_RUNNER_TIMEOUT_MS = 10 * 60 * 1000;

function getConfiguredRunnerCommand(env = process.env) {
    const command = String(env.COMPETITIVE_WHR_TST_RUNNER_COMMAND ?? '').trim();
    return command || null;
}

function isCompetitiveWhrRunnerConfigured(env = process.env) {
    return Boolean(getConfiguredRunnerCommand(env));
}

function runExternalCommand(command, { gameId, mode, syncIds, timeoutMs = DEFAULT_RUNNER_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        exec(command, {
            timeout: timeoutMs,
            env: {
                ...process.env,
                COMPETITIVE_WHR_GAME_ID: String(gameId),
                COMPETITIVE_WHR_MODE: String(mode),
                COMPETITIVE_WHR_SYNC_IDS: (syncIds ?? []).join(',')
            }
        }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

class CompetitiveWhrRunner {
    constructor({
        dao = new CompetitiveWhrSyncDao(),
        runnerCommand = getConfiguredRunnerCommand(),
        commandRunner = runExternalCommand,
        timeoutMs = Number(process.env.COMPETITIVE_WHR_TST_RUNNER_TIMEOUT_MS ?? DEFAULT_RUNNER_TIMEOUT_MS)
    } = {}) {
        this.dao = dao;
        this.runnerCommand = runnerCommand;
        this.commandRunner = commandRunner;
        this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_RUNNER_TIMEOUT_MS;
    }

    async runPending({ limit = 50, reason = DEFAULT_NOT_CONFIGURED_REASON } = {}) {
        const partitions = await this.dao.getPendingRunnerPartitions({ limit });
        const processed = [];

        for (const partition of partitions) {
            if (!this.runnerCommand) {
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
                continue;
            }

            const running = await this.dao.markRunnerRunning({
                gameId: partition.gameId,
                mode: partition.mode,
                syncIds: partition.syncIds
            });

            if (!running.updatedRows) {
                processed.push({
                    ...partition,
                    whrRunnerStatus: 'skipped',
                    updatedRows: 0
                });
                continue;
            }

            try {
                await this.commandRunner(this.runnerCommand, {
                    gameId: partition.gameId,
                    mode: partition.mode,
                    syncIds: partition.syncIds,
                    timeoutMs: this.timeoutMs
                });
                const complete = await this.dao.markRunnerComplete({
                    gameId: partition.gameId,
                    mode: partition.mode,
                    syncIds: partition.syncIds
                });
                processed.push({
                    ...partition,
                    whrRunnerStatus: 'complete',
                    updatedRows: complete.updatedRows ?? 0
                });
            } catch (error) {
                const failed = await this.dao.markRunnerFailed({
                    gameId: partition.gameId,
                    mode: partition.mode,
                    syncIds: partition.syncIds,
                    error
                });
                processed.push({
                    ...partition,
                    whrRunnerStatus: 'failed',
                    updatedRows: failed.updatedRows ?? 0,
                    error: error.message
                });
            }
        }

        const failed = processed.filter(partition => partition.whrRunnerStatus === 'failed');
        if (failed.length) {
            const detail = failed.map(partition => `${partition.gameId}:${partition.mode}`).join(', ');
            const error = new Error(`WHR/TST runner failed for ${detail}`);
            error.partitions = processed;
            throw error;
        }

        const status = processed.length
            ? this.runnerCommand ? 'complete' : 'not_configured'
            : 'idle';

        return {
            status,
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
    COMPETITIVE_WHR_TST_UNAVAILABLE_MESSAGE,
    DEFAULT_RUNNER_TIMEOUT_MS,
    DEFAULT_NOT_CONFIGURED_REASON,
    getConfiguredRunnerCommand,
    isCompetitiveWhrRunnerConfigured,
    runPendingCompetitiveWhrRunner
};
