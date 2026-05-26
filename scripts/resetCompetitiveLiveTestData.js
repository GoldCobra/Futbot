/**
 * Clears only competitive live-test runtime data.
 * Keeps CompetitiveGame, CompetitiveMode, CompetitiveSeason, and CompetitiveRankThreshold intact.
 */
const { executeQuery, closePool } = require('../src/db/sqlClient');
const { competitiveTable } = require('../src/utils/competitiveConstants');

async function reset() {
    await executeQuery(`
        DELETE legacyMatch
        FROM dbo.Match legacyMatch
        INNER JOIN ${competitiveTable('CompetitiveWhrSync')} sync
            ON sync.LegacyMatchId = legacyMatch.[Match];

        DELETE legacyMultiMatch
        FROM dbo.MultiMatch legacyMultiMatch
        INNER JOIN ${competitiveTable('CompetitiveWhrSync')} sync
            ON sync.LegacyMultiMatchId = legacyMultiMatch.ID;

        DELETE FROM ${competitiveTable('CompetitiveWhrSync')};
        DELETE FROM ${competitiveTable('CompetitiveSeasonAwardResultPlayer')};
        DELETE FROM ${competitiveTable('CompetitiveSeasonAwardResult')};
        DELETE FROM ${competitiveTable('CompetitiveSeasonRewardEarned')};
        DELETE FROM ${competitiveTable('CompetitiveSeasonRewardProgress')};
        DELETE FROM ${competitiveTable('CompetitiveMatchRollbackChangeSnapshot')};
        DELETE FROM ${competitiveTable('CompetitiveMatchRollback')};
        DELETE FROM ${competitiveTable('CompetitiveRatingChange')};
        DELETE FROM ${competitiveTable('RatedMatchGame')};
        DELETE FROM ${competitiveTable('RatedMatchParticipant')};
        DELETE FROM ${competitiveTable('RatedMatch')};
        DELETE FROM ${competitiveTable('CompetitivePlayerRating')};
        DELETE FROM ${competitiveTable('CompetitiveSeasonSnapshot')};

        UPDATE ${competitiveTable('CompetitiveMatchSequence')}
        SET NextMatchNumber = 1,
            UpdatedAtUtc = SYSUTCDATETIME();

        UPDATE ${competitiveTable('CompetitiveSeasonMatchSequence')}
        SET NextSeasonMatchNumber = 1,
            UpdatedAtUtc = SYSUTCDATETIME();
    `);

    const result = await executeQuery(`
        SELECT 'CompetitiveRatingChange' AS TableName, COUNT(*) AS [Rows] FROM ${competitiveTable('CompetitiveRatingChange')}
        UNION ALL SELECT 'CompetitiveWhrSync', COUNT(*) FROM ${competitiveTable('CompetitiveWhrSync')}
        UNION ALL SELECT 'CompetitiveSeasonAwardResultPlayer', COUNT(*) FROM ${competitiveTable('CompetitiveSeasonAwardResultPlayer')}
        UNION ALL SELECT 'CompetitiveSeasonAwardResult', COUNT(*) FROM ${competitiveTable('CompetitiveSeasonAwardResult')}
        UNION ALL SELECT 'CompetitiveSeasonRewardEarned', COUNT(*) FROM ${competitiveTable('CompetitiveSeasonRewardEarned')}
        UNION ALL SELECT 'CompetitiveSeasonRewardProgress', COUNT(*) FROM ${competitiveTable('CompetitiveSeasonRewardProgress')}
        UNION ALL SELECT 'CompetitiveMatchRollback', COUNT(*) FROM ${competitiveTable('CompetitiveMatchRollback')}
        UNION ALL SELECT 'CompetitiveMatchRollbackChangeSnapshot', COUNT(*) FROM ${competitiveTable('CompetitiveMatchRollbackChangeSnapshot')}
        UNION ALL SELECT 'RatedMatchGame', COUNT(*) FROM ${competitiveTable('RatedMatchGame')}
        UNION ALL SELECT 'RatedMatchParticipant', COUNT(*) FROM ${competitiveTable('RatedMatchParticipant')}
        UNION ALL SELECT 'RatedMatch', COUNT(*) FROM ${competitiveTable('RatedMatch')}
        UNION ALL SELECT 'CompetitivePlayerRating', COUNT(*) FROM ${competitiveTable('CompetitivePlayerRating')}
        UNION ALL SELECT 'CompetitiveSeasonSnapshot', COUNT(*) FROM ${competitiveTable('CompetitiveSeasonSnapshot')}
        UNION ALL SELECT 'CompetitiveMatchSequence', COUNT(*) FROM ${competitiveTable('CompetitiveMatchSequence')}
        UNION ALL SELECT 'CompetitiveSeasonMatchSequence', COUNT(*) FROM ${competitiveTable('CompetitiveSeasonMatchSequence')}
    `);
    console.log(JSON.stringify(result.recordset, null, 2));
}

reset().catch(err => {
    console.error('Competitive live-test reset failed:', err.message);
    process.exitCode = 1;
}).finally(closePool);
