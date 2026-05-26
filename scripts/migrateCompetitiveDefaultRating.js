/**
 * Aligns CompetitivePlayerRating DB defaults with the rank-0 threshold.
 * This is additive for existing live-test databases and does not reset runtime data.
 */
const { executeQuery, closePool } = require('../src/db/sqlClient');
const { competitiveTable } = require('../src/utils/competitiveConstants');

const RATING_TABLE = competitiveTable('CompetitivePlayerRating');
const THRESHOLD_TABLE = competitiveTable('CompetitiveRankThreshold');

async function getDefaultCompetitiveRating() {
    const result = await executeQuery(`
        SELECT TOP 1 MinElo
        FROM ${THRESHOLD_TABLE}
        WHERE IsActive = 1 AND RankNumber = 0
    `);
    const defaultRating = Number(result.recordset[0]?.MinElo);
    if (!Number.isFinite(defaultRating)) {
        throw new Error('CompetitiveRankThreshold rank 0 is missing; cannot migrate CompetitivePlayerRating defaults');
    }
    return defaultRating;
}

async function replaceDefaultConstraint({ columnName, constraintName, defaultRating }) {
    await executeQuery(`
        IF OBJECT_ID(N'${RATING_TABLE}', 'U') IS NULL
        BEGIN
            THROW 51000, 'CompetitivePlayerRating table does not exist', 1;
        END

        DECLARE @ExistingConstraint sysname;
        SELECT @ExistingConstraint = dc.name
        FROM sys.default_constraints dc
        INNER JOIN sys.columns c
            ON c.object_id = dc.parent_object_id
           AND c.column_id = dc.parent_column_id
        WHERE dc.parent_object_id = OBJECT_ID(N'${RATING_TABLE}', 'U')
          AND c.name = '${columnName}';

        IF @ExistingConstraint IS NOT NULL
        BEGIN
            DECLARE @DropSql nvarchar(max) =
                N'ALTER TABLE ${RATING_TABLE} DROP CONSTRAINT ' + QUOTENAME(@ExistingConstraint);
            EXEC sys.sp_executesql @DropSql;
        END

        ALTER TABLE ${RATING_TABLE}
        ADD CONSTRAINT ${constraintName} DEFAULT (${defaultRating}) FOR ${columnName};
    `);
}

async function migrate() {
    const defaultRating = await getDefaultCompetitiveRating();
    await replaceDefaultConstraint({
        columnName: 'Elo',
        constraintName: 'DF_CompetitivePlayerRating_Elo',
        defaultRating
    });
    await replaceDefaultConstraint({
        columnName: 'PeakElo',
        constraintName: 'DF_CompetitivePlayerRating_PeakElo',
        defaultRating
    });

    const verification = await executeQuery(`
        SELECT c.name AS ColumnName, dc.name AS ConstraintName, dc.definition
        FROM sys.default_constraints dc
        INNER JOIN sys.columns c
            ON c.object_id = dc.parent_object_id
           AND c.column_id = dc.parent_column_id
        WHERE dc.parent_object_id = OBJECT_ID(N'${RATING_TABLE}', 'U')
          AND c.name IN ('Elo', 'PeakElo')
        ORDER BY c.name;
    `);

    console.log(`Competitive default rating migrated to ${defaultRating}.`);
    console.log(JSON.stringify(verification.recordset, null, 2));
}

migrate().catch(error => {
    console.error('Competitive default rating migration failed:', error.message);
    process.exitCode = 1;
}).finally(closePool);
