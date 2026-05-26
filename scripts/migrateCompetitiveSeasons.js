/**
 * Restores the standard competitive season schedule without touching runtime match/rating data.
 */
const { executeQuery, closePool } = require('../src/db/sqlClient');
const { COMPETITIVE_DB_SCHEMA, competitiveTable } = require('../src/utils/competitiveConstants');
const { buildDefaultCompetitiveSeasons } = require('../src/utils/competitiveSeasonSeeds');

const SEASON_TABLE = competitiveTable('CompetitiveSeason');
const SEASON_SEQUENCE_TABLE = competitiveTable('CompetitiveSeasonMatchSequence');
const GAME_TABLE = competitiveTable('CompetitiveGame');
const MODE_TABLE = competitiveTable('CompetitiveMode');

function buildValues(rows) {
    const params = {};
    const sql = rows.map((season, index) => {
        params[`seasonNumber${index}`] = season.SeasonNumber;
        params[`displayName${index}`] = season.DisplayName;
        params[`startDateUtc${index}`] = season.StartDateUtc;
        params[`endDateUtc${index}`] = season.EndDateUtc;
        params[`isActive${index}`] = season.IsActive ? 1 : 0;
        params[`isCompleted${index}`] = season.IsCompleted ? 1 : 0;
        params[`lifecycleStatus${index}`] = season.IsCompleted
            ? 'completed'
            : season.IsActive
                ? 'active'
                : 'scheduled';
        params[`softResetFactor${index}`] = season.SoftResetFactor;
        return `(@seasonNumber${index}, @displayName${index}, @startDateUtc${index}, @endDateUtc${index}, @isActive${index}, @isCompleted${index}, @lifecycleStatus${index}, @softResetFactor${index})`;
    }).join(',\n');
    return { params, sql };
}

async function migrate() {
    const seasons = buildDefaultCompetitiveSeasons();
    const values = buildValues(seasons);

    await executeQuery(`
        IF OBJECT_ID(N'${SEASON_TABLE}', 'U') IS NULL
            THROW 51000, 'CompetitiveSeason table is missing. Run migrateCompetitiveSchema.js first.', 1;

        WITH SeedSeasons (
            SeasonNumber, DisplayName, StartDateUtc, EndDateUtc,
            IsActive, IsCompleted, LifecycleStatus, SoftResetFactor
        ) AS (
            SELECT *
            FROM (VALUES
                ${values.sql}
            ) seed (
                SeasonNumber, DisplayName, StartDateUtc, EndDateUtc,
                IsActive, IsCompleted, LifecycleStatus, SoftResetFactor
            )
        )
        MERGE ${SEASON_TABLE} AS target
        USING SeedSeasons AS source
           ON target.SeasonNumber = source.SeasonNumber
        WHEN MATCHED THEN UPDATE
            SET DisplayName = source.DisplayName,
                StartDateUtc = source.StartDateUtc,
                EndDateUtc = source.EndDateUtc,
                SoftResetFactor = source.SoftResetFactor
        WHEN NOT MATCHED BY TARGET THEN INSERT (
            SeasonNumber, DisplayName, StartDateUtc, EndDateUtc,
            IsActive, IsCompleted, LifecycleStatus, ActivatedAtUtc, FinalizedAtUtc, SoftResetFactor
        ) VALUES (
            source.SeasonNumber, source.DisplayName, source.StartDateUtc, source.EndDateUtc,
            source.IsActive, source.IsCompleted, source.LifecycleStatus,
            CASE WHEN source.IsActive = 1 THEN source.StartDateUtc ELSE NULL END,
            CASE WHEN source.IsCompleted = 1 THEN source.EndDateUtc ELSE NULL END,
            source.SoftResetFactor
        );

        INSERT INTO ${SEASON_SEQUENCE_TABLE} (SeasonId, GameId, ModeCode, NextSeasonMatchNumber)
        SELECT season.Id, game.Id, mode.Code, 1
        FROM ${SEASON_TABLE} season
        CROSS JOIN ${GAME_TABLE} game
        CROSS JOIN ${MODE_TABLE} mode
        WHERE game.IsActive = 1
          AND mode.IsActive = 1
          AND NOT EXISTS (
              SELECT 1
              FROM ${SEASON_SEQUENCE_TABLE} existing
              WHERE existing.SeasonId = season.Id
                AND existing.GameId = game.Id
                AND existing.ModeCode = mode.Code
          );
    `, values.params);

    const result = await executeQuery(`
        SELECT COUNT(*) AS SeasonCount,
               MIN(StartDateUtc) AS FirstStartDateUtc,
               MAX(EndDateUtc) AS LastEndDateUtc
        FROM ${SEASON_TABLE};

        SELECT TOP 5 Id, SeasonNumber, DisplayName, StartDateUtc, EndDateUtc, IsActive, IsCompleted
        FROM ${SEASON_TABLE}
        ORDER BY SeasonNumber ASC;

        SELECT TOP 5 Id, SeasonNumber, DisplayName, StartDateUtc, EndDateUtc, IsActive, IsCompleted
        FROM ${SEASON_TABLE}
        ORDER BY SeasonNumber DESC;
    `);

    console.log(`Competitive seasons migrated in schema '${COMPETITIVE_DB_SCHEMA}'.`);
    console.log(JSON.stringify(result.recordsets, null, 2));
}

migrate().catch(error => {
    console.error('Competitive season migration failed:', error.message);
    process.exitCode = 1;
}).finally(closePool);
