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

    // Legacy WHR freshness: every (player, day) with a counted 1v1 result needs exactly one history row.
    const whrFreshness = await executeQuery(`
        WITH resultDays AS (
            SELECT GameType, Player1 AS Player, CAST(MatchDate AS date) AS MatchDay
            FROM dbo.Match WHERE FutureMatch = 0 AND P1Wins + P1Losses > 0
            UNION
            SELECT GameType, Player2, CAST(MatchDate AS date)
            FROM dbo.Match WHERE FutureMatch = 0 AND P1Wins + P1Losses > 0
        ),
        historyDays AS (
            SELECT GameType, Player, CAST(MatchDate AS date) AS MatchDay FROM dbo.WhrRatingHistory
        )
        SELECT games.GameType,
               (SELECT MAX(MatchDay) FROM resultDays r WHERE r.GameType = games.GameType) AS LastResultDay,
               (SELECT MAX(MatchDay) FROM historyDays h WHERE h.GameType = games.GameType) AS LastWhrDay,
               (SELECT COUNT(*) FROM resultDays r WHERE r.GameType = games.GameType
                   AND NOT EXISTS (SELECT 1 FROM historyDays h WHERE h.GameType = r.GameType AND h.Player = r.Player AND h.MatchDay = r.MatchDay)) AS ResultDaysWithoutWhr,
               (SELECT COUNT(*) FROM historyDays h WHERE h.GameType = games.GameType
                   AND NOT EXISTS (SELECT 1 FROM resultDays r WHERE r.GameType = h.GameType AND r.Player = h.Player AND r.MatchDay = h.MatchDay)) AS WhrDaysWithoutResult
        FROM (SELECT DISTINCT GameType FROM dbo.Match) games
        ORDER BY games.GameType
    `);

    const legacyStatsPending = await executeQuery(`
        SELECT ModeCode, COUNT(*) AS [Count]
        FROM ${q('CompetitiveWhrSync')}
        WHERE SyncStatus = 'synced'
          AND LegacyStatsAppliedAtUtc IS NULL
        GROUP BY ModeCode
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
        whrFreshness: whrFreshness.recordset,
        legacyStatsPending: legacyStatsPending.recordset,
        recentRows: recentRows.recordset
    }, null, 2));
}

main().catch(error => {
    console.error(`Competitive WHR/TST audit failed: ${error.message}`);
    process.exitCode = 1;
}).finally(closePool);
