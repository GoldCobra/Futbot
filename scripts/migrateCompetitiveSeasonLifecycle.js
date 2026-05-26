/**
 * Adds automatic lifecycle state tracking to CompetitiveSeason.
 * This is additive and keeps existing season/match/rating data intact.
 */
const { executeQuery, closePool } = require('../src/db/sqlClient');
const { COMPETITIVE_DB_SCHEMA, competitiveTable } = require('../src/utils/competitiveConstants');

const SEASON_TABLE = competitiveTable('CompetitiveSeason');

async function migrate() {
    console.log(`Adding competitive season lifecycle support to schema '${COMPETITIVE_DB_SCHEMA}'...`);

    await executeQuery(`
        IF OBJECT_ID(N'${SEASON_TABLE}', 'U') IS NULL
            THROW 51000, 'CompetitiveSeason table is missing. Run migrateCompetitiveSchema.js first.', 1;

        IF COL_LENGTH(N'${SEASON_TABLE}', 'LifecycleStatus') IS NULL
            ALTER TABLE ${SEASON_TABLE}
            ADD LifecycleStatus VARCHAR(20) NOT NULL
                CONSTRAINT DF_CompetitiveSeason_LifecycleStatus DEFAULT ('scheduled') WITH VALUES;

        IF COL_LENGTH(N'${SEASON_TABLE}', 'EndingStartedAtUtc') IS NULL
            ALTER TABLE ${SEASON_TABLE} ADD EndingStartedAtUtc DATETIME2 NULL;

        IF COL_LENGTH(N'${SEASON_TABLE}', 'FinalizeAfterUtc') IS NULL
            ALTER TABLE ${SEASON_TABLE} ADD FinalizeAfterUtc DATETIME2 NULL;

        IF COL_LENGTH(N'${SEASON_TABLE}', 'FinalizedAtUtc') IS NULL
            ALTER TABLE ${SEASON_TABLE} ADD FinalizedAtUtc DATETIME2 NULL;

        IF COL_LENGTH(N'${SEASON_TABLE}', 'ActivatedAtUtc') IS NULL
            ALTER TABLE ${SEASON_TABLE} ADD ActivatedAtUtc DATETIME2 NULL;

        IF COL_LENGTH(N'${SEASON_TABLE}', 'TransitionLastAttemptAtUtc') IS NULL
            ALTER TABLE ${SEASON_TABLE} ADD TransitionLastAttemptAtUtc DATETIME2 NULL;

        IF COL_LENGTH(N'${SEASON_TABLE}', 'TransitionAttemptCount') IS NULL
            ALTER TABLE ${SEASON_TABLE}
            ADD TransitionAttemptCount INT NOT NULL
                CONSTRAINT DF_CompetitiveSeason_TransitionAttemptCount DEFAULT (0) WITH VALUES;

        IF COL_LENGTH(N'${SEASON_TABLE}', 'TransitionLastError') IS NULL
            ALTER TABLE ${SEASON_TABLE} ADD TransitionLastError NVARCHAR(1000) NULL;

        IF NOT EXISTS (
            SELECT 1
            FROM sys.check_constraints
            WHERE name = 'CK_CompetitiveSeason_LifecycleStatus'
              AND parent_object_id = OBJECT_ID(N'${SEASON_TABLE}')
        )
            ALTER TABLE ${SEASON_TABLE}
            ADD CONSTRAINT CK_CompetitiveSeason_LifecycleStatus
            CHECK (LifecycleStatus IN ('scheduled','active','ending','completed'));

        UPDATE ${SEASON_TABLE}
        SET LifecycleStatus = CASE
                WHEN IsCompleted = 1 THEN 'completed'
                WHEN IsActive = 1 THEN 'active'
                ELSE 'scheduled'
            END,
            ActivatedAtUtc = CASE
                WHEN IsActive = 1 AND ActivatedAtUtc IS NULL THEN StartDateUtc
                ELSE ActivatedAtUtc
            END,
            FinalizedAtUtc = CASE
                WHEN IsCompleted = 1 AND FinalizedAtUtc IS NULL THEN EndDateUtc
                ELSE FinalizedAtUtc
            END
        WHERE LifecycleStatus IS NULL
           OR (IsCompleted = 1 AND LifecycleStatus <> 'completed')
           OR (IsActive = 1 AND LifecycleStatus <> 'active')
           OR (IsActive = 0 AND IsCompleted = 0 AND LifecycleStatus NOT IN ('scheduled','ending'));
    `);

    const result = await executeQuery(`
        SELECT LifecycleStatus, COUNT(*) AS SeasonCount
        FROM ${SEASON_TABLE}
        GROUP BY LifecycleStatus
        ORDER BY LifecycleStatus;
    `);
    console.log(JSON.stringify(result.recordset, null, 2));
    console.log('Competitive season lifecycle migration complete.');
}

migrate().catch(error => {
    console.error('Competitive season lifecycle migration failed:', error.message);
    process.exitCode = 1;
}).finally(closePool);
