const { closePool, executeQuery } = require('../src/db/sqlClient');
const { competitiveTable } = require('../src/utils/competitiveConstants');

const q = name => competitiveTable(name);

async function main() {
    const summary = await executeQuery(`
        SELECT 'completed_rated_matches' AS Metric, COUNT(*) AS [Count]
        FROM ${q('RatedMatch')}
        WHERE Status = 'completed'
          AND CompletedAtUtc IS NOT NULL

        UNION ALL

        SELECT 'whr_sync_rows' AS Metric, COUNT(*) AS [Count]
        FROM ${q('CompetitiveWhrSync')}

        UNION ALL

        SELECT 'completed_without_sync' AS Metric, COUNT(*) AS [Count]
        FROM ${q('RatedMatch')} rm
        LEFT JOIN ${q('CompetitiveWhrSync')} sync ON sync.RatedMatchId = rm.Id
        WHERE rm.Status = 'completed'
          AND rm.CompletedAtUtc IS NOT NULL
          AND sync.Id IS NULL
    `);

    const syncStatuses = await executeQuery(`
        SELECT SyncStatus, COUNT(*) AS [Count]
        FROM ${q('CompetitiveWhrSync')}
        GROUP BY SyncStatus
        ORDER BY SyncStatus
    `);

    const runnerStatuses = await executeQuery(`
        SELECT WhrRunnerStatus, COUNT(*) AS [Count]
        FROM ${q('CompetitiveWhrSync')}
        GROUP BY WhrRunnerStatus
        ORDER BY WhrRunnerStatus
    `);

    const recentRows = await executeQuery(`
        SELECT TOP 20
            Id,
            RatedMatchId,
            GameId,
            ModeCode,
            MatchNumber,
            SyncStatus,
            WhrRunnerStatus,
            AttemptCount,
            LastError,
            UpdatedAtUtc
        FROM ${q('CompetitiveWhrSync')}
        ORDER BY UpdatedAtUtc DESC, Id DESC
    `);

    console.log(JSON.stringify({
        summary: summary.recordset,
        syncStatuses: syncStatuses.recordset,
        runnerStatuses: runnerStatuses.recordset,
        recentRows: recentRows.recordset
    }, null, 2));
}

main().catch(error => {
    console.error(`Competitive WHR/TST audit failed: ${error.message}`);
    process.exitCode = 1;
}).finally(closePool);
