/**
 * Adds WHR/TST sync audit support to an existing competitive schema.
 * This is additive and does not rebuild or clear runtime tables.
 */
const { executeQuery, closePool } = require('../src/db/sqlClient');
const { COMPETITIVE_DB_SCHEMA, competitiveTable } = require('../src/utils/competitiveConstants');

const q = name => competitiveTable(name);

async function migrate() {
    console.log(`Adding competitive WHR/TST sync support to schema '${COMPETITIVE_DB_SCHEMA}'...`);

    await executeQuery(`
        IF OBJECT_ID(N'${q('RatedMatch')}', 'U') IS NULL
            THROW 51000, 'RatedMatch table is missing. Run migrateCompetitiveSchema.js first.', 1;

        IF OBJECT_ID(N'${q('CompetitiveWhrSync')}', 'U') IS NULL
        BEGIN
            CREATE TABLE ${q('CompetitiveWhrSync')} (
                Id                         INT IDENTITY(1,1) NOT NULL,
                RatedMatchId               INT NOT NULL,
                SeasonId                   INT NOT NULL,
                GameId                     TINYINT NOT NULL,
                ModeCode                   VARCHAR(10) NOT NULL,
                MatchNumber                INT NOT NULL,
                SyncStatus                 VARCHAR(20) NOT NULL CONSTRAINT DF_CompetitiveWhrSync_SyncStatus DEFAULT ('pending'),
                LegacyMatchId              INT NULL,
                LegacyMultiMatchId         INT NULL,
                WhrRunnerStatus            VARCHAR(30) NOT NULL CONSTRAINT DF_CompetitiveWhrSync_WhrRunnerStatus DEFAULT ('pending_external_runner'),
                WhrRunnerRequestedAtUtc    DATETIME2 NULL,
                SyncedAtUtc                DATETIME2 NULL,
                RolledBackAtUtc            DATETIME2 NULL,
                LastAttemptAtUtc           DATETIME2 NULL,
                AttemptCount               INT NOT NULL CONSTRAINT DF_CompetitiveWhrSync_AttemptCount DEFAULT (0),
                LastError                  NVARCHAR(1000) NULL,
                CreatedAtUtc               DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveWhrSync_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
                UpdatedAtUtc               DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveWhrSync_UpdatedAtUtc DEFAULT SYSUTCDATETIME(),
                CONSTRAINT PK_CompetitiveWhrSync PRIMARY KEY (Id),
                CONSTRAINT UQ_CompetitiveWhrSync_RatedMatch UNIQUE (RatedMatchId),
                CONSTRAINT FK_CompetitiveWhrSync_RatedMatch FOREIGN KEY (RatedMatchId) REFERENCES ${q('RatedMatch')}(Id),
                CONSTRAINT FK_CompetitiveWhrSync_CompetitiveSeason FOREIGN KEY (SeasonId) REFERENCES ${q('CompetitiveSeason')}(Id),
                CONSTRAINT FK_CompetitiveWhrSync_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
                CONSTRAINT FK_CompetitiveWhrSync_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code),
                CONSTRAINT CK_CompetitiveWhrSync_MatchNumber CHECK (MatchNumber >= 1),
                CONSTRAINT CK_CompetitiveWhrSync_SyncStatus CHECK (SyncStatus IN ('pending','synced','failed','rolled_back')),
                CONSTRAINT CK_CompetitiveWhrSync_RunnerStatus CHECK (WhrRunnerStatus IN ('pending_external_runner','running','complete','failed','not_configured')),
                CONSTRAINT CK_CompetitiveWhrSync_LegacyTarget CHECK (
                    (ModeCode = '1v1' AND LegacyMultiMatchId IS NULL)
                    OR (ModeCode = '2v2' AND LegacyMatchId IS NULL)
                )
            );
        END;

        IF NOT EXISTS (
            SELECT 1
            FROM sys.indexes
            WHERE name = 'IX_CompetitiveWhrSync_Status'
              AND object_id = OBJECT_ID(N'${q('CompetitiveWhrSync')}', 'U')
        )
            CREATE INDEX IX_CompetitiveWhrSync_Status
            ON ${q('CompetitiveWhrSync')} (SyncStatus, WhrRunnerStatus, UpdatedAtUtc)
            INCLUDE (RatedMatchId, GameId, ModeCode, MatchNumber, LegacyMatchId, LegacyMultiMatchId);
    `);

    const result = await executeQuery(`
        SELECT t.name AS TableName, SUM(p.rows) AS [Rows]
        FROM sys.tables t
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
        WHERE s.name = @schema
          AND t.name = 'CompetitiveWhrSync'
        GROUP BY t.name
    `, { schema: COMPETITIVE_DB_SCHEMA });
    console.log(JSON.stringify(result.recordset, null, 2));
    console.log('Competitive WHR/TST sync support migration complete.');
}

migrate().catch(err => {
    console.error('Competitive WHR/TST sync migration failed:', err.message);
    process.exitCode = 1;
}).finally(closePool);
