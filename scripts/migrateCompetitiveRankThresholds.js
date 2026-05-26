/**
 * Updates only competitive rank thresholds and recalculates current rating ranks.
 * Rating formula, K-factors, placement behavior, and historical change rows stay unchanged.
 */
const { executeQuery, closePool } = require('../src/db/sqlClient');
const { COMPETITIVE_DB_SCHEMA, competitiveTable } = require('../src/utils/competitiveConstants');

const thresholds = [
    { RankNumber: 0,  MinElo: 500,  Name: 'Unranked' },
    { RankNumber: 1,  MinElo: 500,  Name: 'Bronze I' },
    { RankNumber: 2,  MinElo: 570,  Name: 'Bronze II' },
    { RankNumber: 3,  MinElo: 640,  Name: 'Bronze III' },
    { RankNumber: 4,  MinElo: 715,  Name: 'Silver I' },
    { RankNumber: 5,  MinElo: 790,  Name: 'Silver II' },
    { RankNumber: 6,  MinElo: 865,  Name: 'Silver III' },
    { RankNumber: 7,  MinElo: 945,  Name: 'Gold I' },
    { RankNumber: 8,  MinElo: 1025, Name: 'Gold II' },
    { RankNumber: 9,  MinElo: 1105, Name: 'Gold III' },
    { RankNumber: 10, MinElo: 1190, Name: 'Platinum I' },
    { RankNumber: 11, MinElo: 1275, Name: 'Platinum II' },
    { RankNumber: 12, MinElo: 1360, Name: 'Platinum III' },
    { RankNumber: 13, MinElo: 1450, Name: 'Diamond I' },
    { RankNumber: 14, MinElo: 1540, Name: 'Diamond II' },
    { RankNumber: 15, MinElo: 1630, Name: 'Diamond III' },
    { RankNumber: 16, MinElo: 1725, Name: 'Master I' },
    { RankNumber: 17, MinElo: 1820, Name: 'Master II' },
    { RankNumber: 18, MinElo: 1915, Name: 'Master III' },
    { RankNumber: 19, MinElo: 2015, Name: 'Strikers Titan' }
];

function buildThresholdValues() {
    const params = {};
    const values = thresholds.map((threshold, index) => {
        params[`rank${index}`] = threshold.RankNumber;
        params[`elo${index}`] = threshold.MinElo;
        params[`name${index}`] = threshold.Name;
        return `(@rank${index}, @elo${index}, @name${index})`;
    });
    return { params, sql: values.join(',\n') };
}

async function migrate() {
    console.log(`Updating competitive rank thresholds in schema '${COMPETITIVE_DB_SCHEMA}'...`);

    const thresholdValues = buildThresholdValues();
    await executeQuery(`
        IF OBJECT_ID(N'${competitiveTable('CompetitiveRankThreshold')}', 'U') IS NULL
            THROW 51000, 'CompetitiveRankThreshold table is missing. Run migrateCompetitiveSchema.js first.', 1;

        WITH NewThresholds (RankNumber, MinElo, Name) AS (
            SELECT *
            FROM (VALUES
                ${thresholdValues.sql}
            ) v (RankNumber, MinElo, Name)
        )
        UPDATE thresholdTable
        SET MinElo = newThreshold.MinElo
        FROM ${competitiveTable('CompetitiveRankThreshold')} thresholdTable
        INNER JOIN NewThresholds newThreshold
            ON newThreshold.RankNumber = thresholdTable.RankNumber
           AND newThreshold.Name = thresholdTable.Name;

        IF OBJECT_ID(N'${competitiveTable('CompetitivePlayerRating')}', 'U') IS NOT NULL
        BEGIN
            UPDATE rating
            SET RankNumber = CASE
                    WHEN rating.PlacementComplete = 0 THEN 0
                    ELSE ISNULL((
                        SELECT MAX(thresholdTable.RankNumber)
                        FROM ${competitiveTable('CompetitiveRankThreshold')} thresholdTable
                        WHERE thresholdTable.IsActive = 1
                          AND thresholdTable.RankNumber > 0
                          AND thresholdTable.MinElo <= rating.Elo
                    ), 1)
                END,
                PeakRankNumber = CASE
                    WHEN rating.PlacementComplete = 0 THEN 0
                    ELSE ISNULL((
                        SELECT MAX(thresholdTable.RankNumber)
                        FROM ${competitiveTable('CompetitiveRankThreshold')} thresholdTable
                        WHERE thresholdTable.IsActive = 1
                          AND thresholdTable.RankNumber > 0
                          AND thresholdTable.MinElo <= rating.PeakElo
                    ), 1)
                END,
                UpdatedAtUtc = SYSUTCDATETIME()
            FROM ${competitiveTable('CompetitivePlayerRating')} rating;
        END;
    `, thresholdValues.params);

    const result = await executeQuery(`
        SELECT RankNumber, MinElo, Name
        FROM ${competitiveTable('CompetitiveRankThreshold')}
        ORDER BY RankNumber;

        SELECT
            SUM(CASE WHEN RankNumber = 18 AND MinElo = 1915 THEN 1 ELSE 0 END) AS MasterThreeOk,
            SUM(CASE WHEN RankNumber = 19 AND MinElo = 2015 THEN 1 ELSE 0 END) AS TitanOk,
            COUNT(*) AS ThresholdRows
        FROM ${competitiveTable('CompetitiveRankThreshold')};
    `);

    console.log(JSON.stringify(result.recordsets, null, 2));
    console.log('Competitive rank threshold migration complete.');
}

migrate().catch(err => {
    console.error('Competitive rank threshold migration failed:', err.message);
    process.exitCode = 1;
}).finally(closePool);
