/**
 * Adds Rocket-League-style competitive season reward progress tables.
 */
const { executeQuery, closePool } = require('../src/db/sqlClient');
const { competitiveTable } = require('../src/utils/competitiveConstants');

const q = competitiveTable;

async function migrate() {
    await executeQuery(`
        IF OBJECT_ID(N'${q('CompetitiveSeasonRewardProgress')}', 'U') IS NULL
        BEGIN
            CREATE TABLE ${q('CompetitiveSeasonRewardProgress')} (
                Id                         INT IDENTITY(1,1) NOT NULL,
                SeasonId                   INT NOT NULL,
                PlayerId                   INT NOT NULL,
                GameId                     TINYINT NOT NULL,
                ModeCode                   VARCHAR(10) NOT NULL,
                HighestEarnedTier          NVARCHAR(20) NULL,
                HighestEarnedTierOrder     TINYINT NOT NULL CONSTRAINT DF_CompetitiveSeasonRewardProgress_HighestEarnedTierOrder DEFAULT (0),
                CurrentTargetTier          NVARCHAR(20) NULL,
                CurrentTargetTierOrder     TINYINT NULL,
                CurrentTargetWins          TINYINT NOT NULL CONSTRAINT DF_CompetitiveSeasonRewardProgress_CurrentTargetWins DEFAULT (0),
                RequiredWins               TINYINT NOT NULL CONSTRAINT DF_CompetitiveSeasonRewardProgress_RequiredWins DEFAULT (5),
                UpdatedAtUtc               DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveSeasonRewardProgress_UpdatedAtUtc DEFAULT SYSUTCDATETIME(),
                CONSTRAINT PK_CompetitiveSeasonRewardProgress PRIMARY KEY (Id),
                CONSTRAINT UQ_CompetitiveSeasonRewardProgress_Season_Player_Game_Mode UNIQUE (SeasonId, PlayerId, GameId, ModeCode),
                CONSTRAINT FK_CompetitiveSeasonRewardProgress_CompetitiveSeason FOREIGN KEY (SeasonId) REFERENCES ${q('CompetitiveSeason')}(Id),
                CONSTRAINT FK_CompetitiveSeasonRewardProgress_Player FOREIGN KEY (PlayerId) REFERENCES dbo.Player(Id),
                CONSTRAINT FK_CompetitiveSeasonRewardProgress_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
                CONSTRAINT FK_CompetitiveSeasonRewardProgress_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code),
                CONSTRAINT CK_CompetitiveSeasonRewardProgress_HighestOrder CHECK (HighestEarnedTierOrder BETWEEN 0 AND 7),
                CONSTRAINT CK_CompetitiveSeasonRewardProgress_TargetOrder CHECK (CurrentTargetTierOrder IS NULL OR CurrentTargetTierOrder BETWEEN 1 AND 7),
                CONSTRAINT CK_CompetitiveSeasonRewardProgress_Wins CHECK (CurrentTargetWins BETWEEN 0 AND 5),
                CONSTRAINT CK_CompetitiveSeasonRewardProgress_RequiredWins CHECK (RequiredWins = 5)
            );
        END

        IF OBJECT_ID(N'${q('CompetitiveSeasonRewardEarned')}', 'U') IS NULL
        BEGIN
            CREATE TABLE ${q('CompetitiveSeasonRewardEarned')} (
                Id                 INT IDENTITY(1,1) NOT NULL,
                SeasonId           INT NOT NULL,
                PlayerId           INT NOT NULL,
                GameId             TINYINT NOT NULL,
                ModeCode           VARCHAR(10) NOT NULL,
                Tier               NVARCHAR(20) NOT NULL,
                TierOrder          TINYINT NOT NULL,
                EarnedAtUtc        DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveSeasonRewardEarned_EarnedAtUtc DEFAULT SYSUTCDATETIME(),
                RatedMatchId       INT NOT NULL,
                RankAfter          TINYINT NOT NULL,
                EloAfter           DECIMAL(10,4) NOT NULL,
                CONSTRAINT PK_CompetitiveSeasonRewardEarned PRIMARY KEY (Id),
                CONSTRAINT UQ_CompetitiveSeasonRewardEarned_Season_Player_Game_Mode_Tier UNIQUE (SeasonId, PlayerId, GameId, ModeCode, Tier),
                CONSTRAINT FK_CompetitiveSeasonRewardEarned_CompetitiveSeason FOREIGN KEY (SeasonId) REFERENCES ${q('CompetitiveSeason')}(Id),
                CONSTRAINT FK_CompetitiveSeasonRewardEarned_Player FOREIGN KEY (PlayerId) REFERENCES dbo.Player(Id),
                CONSTRAINT FK_CompetitiveSeasonRewardEarned_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
                CONSTRAINT FK_CompetitiveSeasonRewardEarned_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code),
                CONSTRAINT FK_CompetitiveSeasonRewardEarned_RatedMatch FOREIGN KEY (RatedMatchId) REFERENCES ${q('RatedMatch')}(Id),
                CONSTRAINT CK_CompetitiveSeasonRewardEarned_TierOrder CHECK (TierOrder BETWEEN 1 AND 7),
                CONSTRAINT CK_CompetitiveSeasonRewardEarned_RankAfter CHECK (RankAfter BETWEEN 1 AND 19)
            );
        END

        IF NOT EXISTS (
            SELECT 1 FROM sys.indexes
            WHERE name = 'IX_CompetitiveSeasonRewardProgress_Player'
              AND object_id = OBJECT_ID(N'${q('CompetitiveSeasonRewardProgress')}')
        )
        BEGIN
            CREATE INDEX IX_CompetitiveSeasonRewardProgress_Player
            ON ${q('CompetitiveSeasonRewardProgress')} (PlayerId, SeasonId, GameId, ModeCode);
        END

        IF NOT EXISTS (
            SELECT 1 FROM sys.indexes
            WHERE name = 'IX_CompetitiveSeasonRewardEarned_Player'
              AND object_id = OBJECT_ID(N'${q('CompetitiveSeasonRewardEarned')}')
        )
        BEGIN
            CREATE INDEX IX_CompetitiveSeasonRewardEarned_Player
            ON ${q('CompetitiveSeasonRewardEarned')} (PlayerId, SeasonId, GameId, ModeCode, TierOrder);
        END
    `);

    const result = await executeQuery(`
        SELECT 'CompetitiveSeasonRewardProgress' AS TableName, COUNT(*) AS [Rows]
        FROM ${q('CompetitiveSeasonRewardProgress')}
        UNION ALL
        SELECT 'CompetitiveSeasonRewardEarned', COUNT(*)
        FROM ${q('CompetitiveSeasonRewardEarned')}
    `);
    console.log(JSON.stringify(result.recordset, null, 2));
    console.log('Competitive season reward migration complete.');
}

migrate().catch(err => {
    console.error('Competitive season reward migration failed:', err.message);
    process.exitCode = 1;
}).finally(closePool);
