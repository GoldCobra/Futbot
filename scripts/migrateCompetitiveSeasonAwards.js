/**
 * Adds DB tables for final season-end competitive awards.
 */
const { executeQuery, closePool } = require('../src/db/sqlClient');
const { competitiveTable } = require('../src/utils/competitiveConstants');

const q = competitiveTable;

async function migrate() {
    await executeQuery(`
        IF OBJECT_ID(N'${q('CompetitiveSeasonAwardResult')}', 'U') IS NULL
        BEGIN
            CREATE TABLE ${q('CompetitiveSeasonAwardResult')} (
                Id              INT IDENTITY(1,1) NOT NULL,
                SeasonId        INT NOT NULL,
                GameId          TINYINT NOT NULL,
                ModeCode        VARCHAR(10) NOT NULL,
                AwardCode       VARCHAR(40) NOT NULL,
                AwardName       NVARCHAR(80) NOT NULL,
                RankPosition    INT NOT NULL,
                MetricValue     DECIMAL(19,4) NOT NULL,
                MetricLabel     NVARCHAR(100) NULL,
                RatedMatchId    INT NULL,
                CreatedAtUtc    DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveSeasonAwardResult_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
                CONSTRAINT PK_CompetitiveSeasonAwardResult PRIMARY KEY (Id),
                CONSTRAINT FK_CompetitiveSeasonAwardResult_CompetitiveSeason FOREIGN KEY (SeasonId) REFERENCES ${q('CompetitiveSeason')}(Id),
                CONSTRAINT FK_CompetitiveSeasonAwardResult_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
                CONSTRAINT FK_CompetitiveSeasonAwardResult_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code),
                CONSTRAINT FK_CompetitiveSeasonAwardResult_RatedMatch FOREIGN KEY (RatedMatchId) REFERENCES ${q('RatedMatch')}(Id),
                CONSTRAINT CK_CompetitiveSeasonAwardResult_RankPosition CHECK (RankPosition >= 1)
            );
        END

        IF OBJECT_ID(N'${q('CompetitiveSeasonAwardResultPlayer')}', 'U') IS NULL
        BEGIN
            CREATE TABLE ${q('CompetitiveSeasonAwardResultPlayer')} (
                Id              INT IDENTITY(1,1) NOT NULL,
                AwardResultId   INT NOT NULL,
                PlayerId        INT NOT NULL,
                SlotNumber      TINYINT NOT NULL,
                CONSTRAINT PK_CompetitiveSeasonAwardResultPlayer PRIMARY KEY (Id),
                CONSTRAINT UQ_CompetitiveSeasonAwardResultPlayer_Result_Player UNIQUE (AwardResultId, PlayerId),
                CONSTRAINT UQ_CompetitiveSeasonAwardResultPlayer_Result_Slot UNIQUE (AwardResultId, SlotNumber),
                CONSTRAINT FK_CompetitiveSeasonAwardResultPlayer_AwardResult FOREIGN KEY (AwardResultId) REFERENCES ${q('CompetitiveSeasonAwardResult')}(Id) ON DELETE CASCADE,
                CONSTRAINT FK_CompetitiveSeasonAwardResultPlayer_Player FOREIGN KEY (PlayerId) REFERENCES dbo.Player(Id),
                CONSTRAINT CK_CompetitiveSeasonAwardResultPlayer_SlotNumber CHECK (SlotNumber BETWEEN 1 AND 4)
            );
        END

        IF NOT EXISTS (
            SELECT 1 FROM sys.indexes
            WHERE name = 'IX_CompetitiveSeasonAwardResult_Partition'
              AND object_id = OBJECT_ID(N'${q('CompetitiveSeasonAwardResult')}')
        )
        BEGIN
            CREATE INDEX IX_CompetitiveSeasonAwardResult_Partition
            ON ${q('CompetitiveSeasonAwardResult')} (SeasonId, GameId, ModeCode, AwardCode, RankPosition);
        END

        IF NOT EXISTS (
            SELECT 1 FROM sys.indexes
            WHERE name = 'IX_CompetitiveSeasonAwardResultPlayer_Player'
              AND object_id = OBJECT_ID(N'${q('CompetitiveSeasonAwardResultPlayer')}')
        )
        BEGIN
            CREATE INDEX IX_CompetitiveSeasonAwardResultPlayer_Player
            ON ${q('CompetitiveSeasonAwardResultPlayer')} (PlayerId, AwardResultId);
        END
    `);

    const result = await executeQuery(`
        SELECT 'CompetitiveSeasonAwardResult' AS TableName, COUNT(*) AS [Rows]
        FROM ${q('CompetitiveSeasonAwardResult')}
        UNION ALL
        SELECT 'CompetitiveSeasonAwardResultPlayer', COUNT(*)
        FROM ${q('CompetitiveSeasonAwardResultPlayer')}
    `);
    console.log(JSON.stringify(result.recordset, null, 2));
    console.log('Competitive season award migration complete.');
}

migrate().catch(err => {
    console.error('Competitive season award migration failed:', err.message);
    process.exitCode = 1;
}).finally(closePool);
