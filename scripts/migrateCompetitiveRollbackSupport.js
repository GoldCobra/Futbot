/**
 * Adds rollback audit support to an existing competitive live-test schema.
 * This is additive and does not rebuild or clear runtime tables.
 */
const { executeQuery, closePool } = require('../src/db/sqlClient');
const { COMPETITIVE_DB_SCHEMA, competitiveTable } = require('../src/utils/competitiveConstants');

const q = name => competitiveTable(name);

async function migrate() {
    console.log(`Adding competitive rollback support to schema '${COMPETITIVE_DB_SCHEMA}'...`);

    await executeQuery(`
        IF OBJECT_ID(N'${q('RatedMatch')}', 'U') IS NULL
            THROW 51000, 'RatedMatch table is missing. Run migrateCompetitiveSchema.js first.', 1;

        IF OBJECT_ID(N'${q('CompetitiveRatingChange')}', 'U') IS NULL
            THROW 51000, 'CompetitiveRatingChange table is missing. Run migrateCompetitiveSchema.js first.', 1;

        IF EXISTS (
            SELECT 1
            FROM sys.check_constraints
            WHERE name = 'CK_RatedMatch_Status'
              AND parent_object_id = OBJECT_ID(N'${q('RatedMatch')}', 'U')
        )
            ALTER TABLE ${q('RatedMatch')} DROP CONSTRAINT CK_RatedMatch_Status;

        ALTER TABLE ${q('RatedMatch')} ALTER COLUMN Status VARCHAR(12) NOT NULL;

        IF NOT EXISTS (
            SELECT 1
            FROM sys.check_constraints
            WHERE name = 'CK_RatedMatch_Status'
              AND parent_object_id = OBJECT_ID(N'${q('RatedMatch')}', 'U')
        )
            ALTER TABLE ${q('RatedMatch')} ADD CONSTRAINT CK_RatedMatch_Status
                CHECK (Status IN ('creating','active','completed','cancelled','rolled_back'));

        IF OBJECT_ID(N'${q('CompetitiveMatchRollback')}', 'U') IS NULL
        BEGIN
            CREATE TABLE ${q('CompetitiveMatchRollback')} (
                Id                    INT IDENTITY(1,1) NOT NULL,
                RatedMatchId          INT NOT NULL,
                SeasonId              INT NOT NULL,
                GameId                TINYINT NOT NULL,
                ModeCode              VARCHAR(10) NOT NULL,
                MatchNumber           INT NOT NULL,
                RolledBackByDiscordId NVARCHAR(50) NOT NULL,
                Reason                NVARCHAR(500) NOT NULL,
                CreatedAtUtc          DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveMatchRollback_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
                ThreadNoticeMessageId NVARCHAR(24) NULL,
                ThreadFinalizeStatus  NVARCHAR(30) NOT NULL CONSTRAINT DF_CompetitiveMatchRollback_ThreadFinalizeStatus DEFAULT ('pending'),
                CONSTRAINT PK_CompetitiveMatchRollback PRIMARY KEY (Id),
                CONSTRAINT UQ_CompetitiveMatchRollback_RatedMatch UNIQUE (RatedMatchId),
                CONSTRAINT FK_CompetitiveMatchRollback_RatedMatch FOREIGN KEY (RatedMatchId) REFERENCES ${q('RatedMatch')}(Id),
                CONSTRAINT FK_CompetitiveMatchRollback_CompetitiveSeason FOREIGN KEY (SeasonId) REFERENCES ${q('CompetitiveSeason')}(Id),
                CONSTRAINT FK_CompetitiveMatchRollback_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
                CONSTRAINT FK_CompetitiveMatchRollback_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code),
                CONSTRAINT CK_CompetitiveMatchRollback_MatchNumber CHECK (MatchNumber >= 1),
                CONSTRAINT CK_CompetitiveMatchRollback_ThreadFinalizeStatus CHECK (ThreadFinalizeStatus IN ('pending','posted','missing','failed'))
            );

            CREATE INDEX IX_CompetitiveMatchRollback_Game_Mode_Number
            ON ${q('CompetitiveMatchRollback')} (GameId, ModeCode, MatchNumber);
        END;

        IF OBJECT_ID(N'${q('CompetitiveMatchRollbackChangeSnapshot')}', 'U') IS NULL
        BEGIN
            CREATE TABLE ${q('CompetitiveMatchRollbackChangeSnapshot')} (
                Id                          INT IDENTITY(1,1) NOT NULL,
                RollbackId                  INT NOT NULL,
                CompetitiveRatingChangeId   INT NOT NULL,
                RatedMatchId                INT NOT NULL,
                RatedMatchParticipantId     INT NOT NULL,
                SeasonId                    INT NOT NULL,
                PlayerId                    INT NOT NULL,
                GameId                      TINYINT NOT NULL,
                ModeCode                    VARCHAR(10) NOT NULL,
                TeamNumber                  TINYINT NOT NULL,
                Outcome                     VARCHAR(4) NOT NULL,
                EloBefore                   DECIMAL(10,4) NOT NULL,
                EloAfter                    DECIMAL(10,4) NOT NULL,
                EloDelta                    DECIMAL(10,4) NOT NULL,
                RankBefore                  TINYINT NOT NULL,
                RankAfter                   TINYINT NOT NULL,
                PlacementBefore             TINYINT NOT NULL,
                PlacementAfter              TINYINT NOT NULL,
                OriginalCreatedAtUtc        DATETIME2 NOT NULL,
                SnapshotAtUtc               DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveMatchRollbackChangeSnapshot_SnapshotAtUtc DEFAULT SYSUTCDATETIME(),
                CONSTRAINT PK_CompetitiveMatchRollbackChangeSnapshot PRIMARY KEY (Id),
                CONSTRAINT UQ_CompetitiveMatchRollbackChangeSnapshot_Rollback_Change UNIQUE (RollbackId, CompetitiveRatingChangeId),
                CONSTRAINT FK_CompetitiveMatchRollbackChangeSnapshot_Rollback FOREIGN KEY (RollbackId) REFERENCES ${q('CompetitiveMatchRollback')}(Id),
                CONSTRAINT FK_CompetitiveMatchRollbackChangeSnapshot_Change FOREIGN KEY (CompetitiveRatingChangeId) REFERENCES ${q('CompetitiveRatingChange')}(Id)
            );
        END;
    `);

    const result = await executeQuery(`
        SELECT t.name AS TableName, SUM(p.rows) AS [Rows]
        FROM sys.tables t
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
        WHERE s.name = @schema
          AND t.name IN ('CompetitiveMatchRollback', 'CompetitiveMatchRollbackChangeSnapshot')
        GROUP BY t.name
        ORDER BY t.name
    `, { schema: COMPETITIVE_DB_SCHEMA });
    console.log(JSON.stringify(result.recordset, null, 2));
    console.log('Competitive rollback support migration complete.');
}

migrate().catch(err => {
    console.error('Competitive rollback support migration failed:', err.message);
    process.exitCode = 1;
}).finally(closePool);
