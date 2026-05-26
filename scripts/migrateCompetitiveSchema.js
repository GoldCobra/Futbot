/**
 * Creates the final competitive live schema in the isolated competitive schema.
 * This does not touch legacy dbo.RankedMatch, dbo.PlayerStats, dbo.Queue, or other old live tables.
 */
const { executeQuery, closePool } = require('../src/db/sqlClient');
const { COMPETITIVE_DB_SCHEMA, competitiveTable } = require('../src/utils/competitiveConstants');
const { buildDefaultCompetitiveSeasons } = require('../src/utils/competitiveSeasonSeeds');

function quoteSqlIdentifier(identifier) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(`Invalid SQL identifier: ${identifier}`);
    }
    return `[${identifier}]`;
}

const schema = quoteSqlIdentifier(COMPETITIVE_DB_SCHEMA);
const q = name => competitiveTable(name);
const proc = name => `${schema}.${quoteSqlIdentifier(name)}`;

const DEFAULT_GAMES = [
    { Id: 1, Code: 'MSC',  DisplayName: 'Mario Strikers Charged', ShortName: 'MSC',  SortOrder: 1 },
    { Id: 2, Code: 'SMS',  DisplayName: 'Super Mario Strikers',   ShortName: 'SMS',  SortOrder: 2 },
    { Id: 3, Code: 'MSBL', DisplayName: 'Mario Strikers: Battle League', ShortName: 'MSBL', SortOrder: 3 }
];

const DEFAULT_MODES = [
    { Code: '1v1', DisplayName: '1v1', TeamCount: 2, PlayersPerTeam: 1, TotalPlayers: 2, SortOrder: 1 },
    { Code: '2v2', DisplayName: '2v2', TeamCount: 2, PlayersPerTeam: 2, TotalPlayers: 4, SortOrder: 2 }
];

const DEFAULT_RANKS = [
    { RankNumber: 0,  MinElo: 500,  Name: 'Unranked',       Tier: 'Unranked', SubRank: null, DiscordRoleId: '1504569388056186901' },
    { RankNumber: 1,  MinElo: 500,  Name: 'Bronze I',       Tier: 'Bronze',   SubRank: 1,    DiscordRoleId: '1504566977182699620' },
    { RankNumber: 2,  MinElo: 570,  Name: 'Bronze II',      Tier: 'Bronze',   SubRank: 2,    DiscordRoleId: '1504567059185537025' },
    { RankNumber: 3,  MinElo: 640,  Name: 'Bronze III',     Tier: 'Bronze',   SubRank: 3,    DiscordRoleId: '1504567111177994320' },
    { RankNumber: 4,  MinElo: 715,  Name: 'Silver I',       Tier: 'Silver',   SubRank: 1,    DiscordRoleId: '1504567155092357211' },
    { RankNumber: 5,  MinElo: 790,  Name: 'Silver II',      Tier: 'Silver',   SubRank: 2,    DiscordRoleId: '1504567186386194583' },
    { RankNumber: 6,  MinElo: 865,  Name: 'Silver III',     Tier: 'Silver',   SubRank: 3,    DiscordRoleId: '1504567235543437332' },
    { RankNumber: 7,  MinElo: 945,  Name: 'Gold I',         Tier: 'Gold',     SubRank: 1,    DiscordRoleId: '1504567266597933066' },
    { RankNumber: 8,  MinElo: 1025, Name: 'Gold II',        Tier: 'Gold',     SubRank: 2,    DiscordRoleId: '1504567296335675563' },
    { RankNumber: 9,  MinElo: 1105, Name: 'Gold III',       Tier: 'Gold',     SubRank: 3,    DiscordRoleId: '1504567325712580828' },
    { RankNumber: 10, MinElo: 1190, Name: 'Platinum I',     Tier: 'Platinum', SubRank: 1,    DiscordRoleId: '1504567357585096846' },
    { RankNumber: 11, MinElo: 1275, Name: 'Platinum II',    Tier: 'Platinum', SubRank: 2,    DiscordRoleId: '1504567390565044407' },
    { RankNumber: 12, MinElo: 1360, Name: 'Platinum III',   Tier: 'Platinum', SubRank: 3,    DiscordRoleId: '1504567428028567602' },
    { RankNumber: 13, MinElo: 1450, Name: 'Diamond I',      Tier: 'Diamond',  SubRank: 1,    DiscordRoleId: '1504567464191594597' },
    { RankNumber: 14, MinElo: 1540, Name: 'Diamond II',     Tier: 'Diamond',  SubRank: 2,    DiscordRoleId: '1504567511184834731' },
    { RankNumber: 15, MinElo: 1630, Name: 'Diamond III',    Tier: 'Diamond',  SubRank: 3,    DiscordRoleId: '1504567543430647849' },
    { RankNumber: 16, MinElo: 1725, Name: 'Master I',       Tier: 'Master',   SubRank: 1,    DiscordRoleId: '1504567579811905627' },
    { RankNumber: 17, MinElo: 1820, Name: 'Master II',      Tier: 'Master',   SubRank: 2,    DiscordRoleId: '1504567696266756257' },
    { RankNumber: 18, MinElo: 1915, Name: 'Master III',     Tier: 'Master',   SubRank: 3,    DiscordRoleId: '1504567725824151763' },
    { RankNumber: 19, MinElo: 2015, Name: 'Strikers Titan', Tier: 'Titan',    SubRank: null, DiscordRoleId: '1504567785311834112' }
];
const DEFAULT_COMPETITIVE_RATING = DEFAULT_RANKS.find(rank => rank.RankNumber === 0).MinElo;

const DEFAULT_SEASONS = buildDefaultCompetitiveSeasons();

async function scalar(sql, columnName) {
    const result = await executeQuery(sql);
    return result.recordset[0]?.[columnName];
}

async function objectExists(objectName, type) {
    return Boolean(await scalar(`SELECT OBJECT_ID(N'${q(objectName)}', '${type}') AS ObjectId`, 'ObjectId'));
}

async function tableExists(tableName) {
    return objectExists(tableName, 'U');
}

async function readRowsIfExists(tableName, query) {
    if (!await tableExists(tableName)) return [];
    const result = await executeQuery(query);
    return result.recordset;
}

async function getTableColumns(tableName) {
    if (!await tableExists(tableName)) return new Set();
    const result = await executeQuery(`
        SELECT name
        FROM sys.columns
        WHERE object_id = OBJECT_ID(N'${q(tableName)}', 'U')
    `);
    return new Set(result.recordset.map(row => String(row.name).toLowerCase()));
}

function toBit(value) {
    return value ? 1 : 0;
}

function buildParameterizedValues(rows, columns, prefix) {
    const params = {};
    const values = rows.map((row, rowIndex) => {
        const placeholders = columns.map(column => {
            const key = `${prefix}${rowIndex}_${column.param}`;
            params[key] = row[column.source];
            return `@${key}`;
        });
        return `(${placeholders.join(', ')})`;
    });

    return { params, sql: values.join(',\n') };
}

async function createSchemaIfMissing() {
    await executeQuery(`
        IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = @schemaName)
            EXEC(N'CREATE SCHEMA ${schema}')
    `, { schemaName: COMPETITIVE_DB_SCHEMA });
}

async function readSeedData() {
    const seasons = await readRowsIfExists('CompetitiveSeason', `
        SELECT Id, SeasonNumber, DisplayName, StartDateUtc, EndDateUtc,
               IsActive, IsCompleted, SoftResetFactor
        FROM ${q('CompetitiveSeason')}
        ORDER BY SeasonNumber
    `);
    const legacyCompSeasonColumns = await getTableColumns('CompSeason');
    const legacySeasons = seasons.length || !legacyCompSeasonColumns.size
        ? []
        : await readRowsIfExists('CompSeason', `
            SELECT Id,
                   ${legacyCompSeasonColumns.has('seasonnumber')
                       ? 'SeasonNumber'
                       : 'ROW_NUMBER() OVER (ORDER BY StartDate ASC, Id ASC) AS SeasonNumber'},
                   ${legacyCompSeasonColumns.has('displayname')
                       ? 'DisplayName'
                       : 'Name AS DisplayName'},
                   ${legacyCompSeasonColumns.has('startdateutc')
                       ? 'StartDateUtc'
                       : 'StartDate AS StartDateUtc'},
                   ${legacyCompSeasonColumns.has('enddateutc')
                       ? 'EndDateUtc'
                       : 'EndDate AS EndDateUtc'},
                   IsActive,
                   ${legacyCompSeasonColumns.has('iscompleted') ? 'IsCompleted' : 'CAST(0 AS bit) AS IsCompleted'},
                   ${legacyCompSeasonColumns.has('softresetfactor') ? 'SoftResetFactor' : 'CAST(0.70 AS decimal(4,2)) AS SoftResetFactor'}
            FROM ${q('CompSeason')}
            ORDER BY ${legacyCompSeasonColumns.has('seasonnumber') ? 'SeasonNumber' : 'StartDate'}
        `);
    const ranks = await readRowsIfExists('CompetitiveRankThreshold', `
        SELECT RankNumber, MinElo, Name, Tier, SubRank, DiscordRoleId, IsActive
        FROM ${q('CompetitiveRankThreshold')}
        ORDER BY RankNumber
    `);

    return {
        seasons: seasons.length ? seasons : (legacySeasons.length ? legacySeasons : DEFAULT_SEASONS),
        ranks: ranks.length ? ranks : DEFAULT_RANKS.map(rank => ({ ...rank, IsActive: true }))
    };
}

async function dropCompetitiveObjects() {
    await executeQuery(`
        DROP VIEW IF EXISTS ${q('CompetitiveLeaderboard')};

        DROP PROCEDURE IF EXISTS ${proc('sp_CompetitiveSeasonActivate')};
        DROP PROCEDURE IF EXISTS ${proc('sp_CompetitiveSeasonClose')};
        DROP PROCEDURE IF EXISTS ${proc('sp_CompGetLeaderboard')};
        DROP PROCEDURE IF EXISTS ${proc('sp_CompRollbackMatch')};
        DROP PROCEDURE IF EXISTS ${proc('sp_CompSeasonClose')};
        DROP PROCEDURE IF EXISTS ${proc('sp_CompActivateSeason')};
        DROP PROCEDURE IF EXISTS ${proc('sp_CompSeasonEnd')};

        DROP TABLE IF EXISTS ${q('CompetitiveWhrSync')};
        DROP TABLE IF EXISTS ${q('CompetitiveSeasonAwardResultPlayer')};
        DROP TABLE IF EXISTS ${q('CompetitiveSeasonAwardResult')};
        DROP TABLE IF EXISTS ${q('CompetitiveSeasonRewardEarned')};
        DROP TABLE IF EXISTS ${q('CompetitiveSeasonRewardProgress')};
        DROP TABLE IF EXISTS ${q('CompetitiveMatchRollbackChangeSnapshot')};
        DROP TABLE IF EXISTS ${q('CompetitiveMatchRollback')};
        DROP TABLE IF EXISTS ${q('CompetitiveRatingChange')};
        DROP TABLE IF EXISTS ${q('RatedMatchGame')};
        DROP TABLE IF EXISTS ${q('RatedMatchParticipant')};
        DROP TABLE IF EXISTS ${q('CompetitivePlayerRating')};
        DROP TABLE IF EXISTS ${q('CompetitiveSeasonSnapshot')};
        DROP TABLE IF EXISTS ${q('CompetitiveSeasonMatchSequence')};
        DROP TABLE IF EXISTS ${q('CompetitiveMatchSequence')};
        DROP TABLE IF EXISTS ${q('RatedMatch')};
        DROP TABLE IF EXISTS ${q('CompetitiveRankThreshold')};
        DROP TABLE IF EXISTS ${q('CompetitiveMode')};
        DROP TABLE IF EXISTS ${q('CompetitiveGame')};
        DROP TABLE IF EXISTS ${q('CompetitiveSeason')};

        DROP TABLE IF EXISTS ${q('CompMatch')};
        DROP TABLE IF EXISTS ${q('CompRating')};
        DROP TABLE IF EXISTS ${q('CompSeasonHistory')};
        DROP TABLE IF EXISTS ${q('CompRankThreshold')};
        DROP TABLE IF EXISTS ${q('CompSeason')};
    `);
}

async function createReferenceTables() {
    await executeQuery(`
        CREATE TABLE ${q('CompetitiveGame')} (
            Id            TINYINT NOT NULL,
            Code          VARCHAR(10) NOT NULL,
            DisplayName   NVARCHAR(80) NOT NULL,
            ShortName     NVARCHAR(20) NOT NULL,
            IsActive      BIT NOT NULL CONSTRAINT DF_CompetitiveGame_IsActive DEFAULT (1),
            SortOrder     INT NOT NULL CONSTRAINT DF_CompetitiveGame_SortOrder DEFAULT (0),
            CreatedAtUtc  DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveGame_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_CompetitiveGame PRIMARY KEY (Id),
            CONSTRAINT UQ_CompetitiveGame_Code UNIQUE (Code)
        );

        CREATE TABLE ${q('CompetitiveMode')} (
            Code           VARCHAR(10) NOT NULL,
            DisplayName    NVARCHAR(20) NOT NULL,
            TeamCount      TINYINT NOT NULL,
            PlayersPerTeam TINYINT NOT NULL,
            TotalPlayers   TINYINT NOT NULL,
            IsActive       BIT NOT NULL CONSTRAINT DF_CompetitiveMode_IsActive DEFAULT (1),
            SortOrder      INT NOT NULL CONSTRAINT DF_CompetitiveMode_SortOrder DEFAULT (0),
            CreatedAtUtc   DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveMode_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_CompetitiveMode PRIMARY KEY (Code),
            CONSTRAINT CK_CompetitiveMode_TeamCount CHECK (TeamCount >= 2),
            CONSTRAINT CK_CompetitiveMode_PlayersPerTeam CHECK (PlayersPerTeam >= 1),
            CONSTRAINT CK_CompetitiveMode_TotalPlayers CHECK (TotalPlayers = TeamCount * PlayersPerTeam)
        );

        CREATE TABLE ${q('CompetitiveSeason')} (
            Id              INT IDENTITY(1,1) NOT NULL,
            SeasonNumber    INT NOT NULL,
            DisplayName     NVARCHAR(50) NOT NULL,
            StartDateUtc    DATETIME2 NOT NULL,
            EndDateUtc      DATETIME2 NOT NULL,
            IsActive        BIT NOT NULL CONSTRAINT DF_CompetitiveSeason_IsActive DEFAULT (0),
            IsCompleted     BIT NOT NULL CONSTRAINT DF_CompetitiveSeason_IsCompleted DEFAULT (0),
            LifecycleStatus VARCHAR(20) NOT NULL CONSTRAINT DF_CompetitiveSeason_LifecycleStatus DEFAULT ('scheduled'),
            EndingStartedAtUtc DATETIME2 NULL,
            FinalizeAfterUtc DATETIME2 NULL,
            FinalizedAtUtc   DATETIME2 NULL,
            ActivatedAtUtc   DATETIME2 NULL,
            TransitionLastAttemptAtUtc DATETIME2 NULL,
            TransitionAttemptCount INT NOT NULL CONSTRAINT DF_CompetitiveSeason_TransitionAttemptCount DEFAULT (0),
            TransitionLastError NVARCHAR(1000) NULL,
            SoftResetFactor DECIMAL(4,2) NOT NULL CONSTRAINT DF_CompetitiveSeason_SoftResetFactor DEFAULT (0.70),
            CreatedAtUtc    DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveSeason_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_CompetitiveSeason PRIMARY KEY (Id),
            CONSTRAINT UQ_CompetitiveSeason_SeasonNumber UNIQUE (SeasonNumber),
            CONSTRAINT CK_CompetitiveSeason_Dates CHECK (EndDateUtc > StartDateUtc),
            CONSTRAINT CK_CompetitiveSeason_LifecycleStatus CHECK (LifecycleStatus IN ('scheduled','active','ending','completed')),
            CONSTRAINT CK_CompetitiveSeason_SoftResetFactor CHECK (SoftResetFactor >= 0 AND SoftResetFactor <= 1)
        );

        CREATE UNIQUE INDEX UX_CompetitiveSeason_OneActive
        ON ${q('CompetitiveSeason')} (IsActive)
        WHERE IsActive = 1;

        CREATE TABLE ${q('CompetitiveRankThreshold')} (
            RankNumber    TINYINT NOT NULL,
            MinElo        DECIMAL(10,4) NOT NULL,
            Name          NVARCHAR(30) NOT NULL,
            Tier          NVARCHAR(20) NOT NULL,
            SubRank       TINYINT NULL,
            DiscordRoleId NVARCHAR(30) NOT NULL CONSTRAINT DF_CompetitiveRankThreshold_DiscordRoleId DEFAULT (''),
            IsActive      BIT NOT NULL CONSTRAINT DF_CompetitiveRankThreshold_IsActive DEFAULT (1),
            CONSTRAINT PK_CompetitiveRankThreshold PRIMARY KEY (RankNumber),
            CONSTRAINT CK_CompetitiveRankThreshold_RankNumber CHECK (RankNumber BETWEEN 0 AND 19),
            CONSTRAINT CK_CompetitiveRankThreshold_MinElo CHECK (MinElo >= 0)
        );
    `);
}

async function seedReferenceTables({ seasons, ranks }) {
    for (const game of DEFAULT_GAMES) {
        await executeQuery(`
            INSERT INTO ${q('CompetitiveGame')} (Id, Code, DisplayName, ShortName, SortOrder)
            VALUES (@id, @code, @displayName, @shortName, @sortOrder)
        `, {
            id: game.Id,
            code: game.Code,
            displayName: game.DisplayName,
            shortName: game.ShortName,
            sortOrder: game.SortOrder
        });
    }

    for (const mode of DEFAULT_MODES) {
        await executeQuery(`
            INSERT INTO ${q('CompetitiveMode')} (
                Code, DisplayName, TeamCount, PlayersPerTeam, TotalPlayers, SortOrder
            )
            VALUES (
                @code, @displayName, @teamCount, @playersPerTeam, @totalPlayers, @sortOrder
            )
        `, {
            code: mode.Code,
            displayName: mode.DisplayName,
            teamCount: mode.TeamCount,
            playersPerTeam: mode.PlayersPerTeam,
            totalPlayers: mode.TotalPlayers,
            sortOrder: mode.SortOrder
        });
    }

    if (seasons.length) {
        const seasonRows = seasons.map(seasonRow => ({
            Id: seasonRow.Id,
            SeasonNumber: seasonRow.SeasonNumber,
            DisplayName: seasonRow.DisplayName,
            StartDateUtc: seasonRow.StartDateUtc,
            EndDateUtc: seasonRow.EndDateUtc,
            IsActive: toBit(seasonRow.IsActive),
            IsCompleted: toBit(seasonRow.IsCompleted),
            LifecycleStatus: toBit(seasonRow.IsCompleted)
                ? 'completed'
                : toBit(seasonRow.IsActive)
                    ? 'active'
                    : 'scheduled',
            ActivatedAtUtc: toBit(seasonRow.IsActive) ? seasonRow.StartDateUtc : null,
            FinalizedAtUtc: toBit(seasonRow.IsCompleted) ? seasonRow.EndDateUtc : null,
            SoftResetFactor: seasonRow.SoftResetFactor ?? 0.70
        }));
        const seasonValues = buildParameterizedValues(seasonRows, [
            { source: 'Id', param: 'id' },
            { source: 'SeasonNumber', param: 'seasonNumber' },
            { source: 'DisplayName', param: 'displayName' },
            { source: 'StartDateUtc', param: 'startDateUtc' },
            { source: 'EndDateUtc', param: 'endDateUtc' },
            { source: 'IsActive', param: 'isActive' },
            { source: 'IsCompleted', param: 'isCompleted' },
            { source: 'LifecycleStatus', param: 'lifecycleStatus' },
            { source: 'ActivatedAtUtc', param: 'activatedAtUtc' },
            { source: 'FinalizedAtUtc', param: 'finalizedAtUtc' },
            { source: 'SoftResetFactor', param: 'softResetFactor' }
        ], 'season');

        await executeQuery(`
            SET IDENTITY_INSERT ${q('CompetitiveSeason')} ON;
            INSERT INTO ${q('CompetitiveSeason')} (
                Id, SeasonNumber, DisplayName, StartDateUtc, EndDateUtc,
                IsActive, IsCompleted, LifecycleStatus, ActivatedAtUtc, FinalizedAtUtc, SoftResetFactor
            )
            VALUES ${seasonValues.sql};
            SET IDENTITY_INSERT ${q('CompetitiveSeason')} OFF;
        `, seasonValues.params);
    }

    for (const rank of ranks) {
        await executeQuery(`
            INSERT INTO ${q('CompetitiveRankThreshold')} (
                RankNumber, MinElo, Name, Tier, SubRank, DiscordRoleId, IsActive
            )
            VALUES (
                @rankNumber, @minElo, @name, @tier, @subRank, @discordRoleId, @isActive
            )
        `, {
            rankNumber: rank.RankNumber,
            minElo: rank.MinElo,
            name: rank.Name,
            tier: rank.Tier,
            subRank: rank.SubRank ?? null,
            discordRoleId: rank.DiscordRoleId ?? '',
            isActive: rank.IsActive == null ? 1 : toBit(rank.IsActive)
        });
    }
}

async function createRuntimeTables() {
    await executeQuery(`
        CREATE TABLE ${q('CompetitiveMatchSequence')} (
            GameId          TINYINT NOT NULL,
            ModeCode        VARCHAR(10) NOT NULL,
            NextMatchNumber INT NOT NULL CONSTRAINT DF_CompetitiveMatchSequence_NextMatchNumber DEFAULT (1),
            UpdatedAtUtc    DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveMatchSequence_UpdatedAtUtc DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_CompetitiveMatchSequence PRIMARY KEY (GameId, ModeCode),
            CONSTRAINT FK_CompetitiveMatchSequence_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
            CONSTRAINT FK_CompetitiveMatchSequence_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code),
            CONSTRAINT CK_CompetitiveMatchSequence_NextMatchNumber CHECK (NextMatchNumber >= 1)
        );

        CREATE TABLE ${q('CompetitiveSeasonMatchSequence')} (
            SeasonId              INT NOT NULL,
            GameId                TINYINT NOT NULL,
            ModeCode              VARCHAR(10) NOT NULL,
            NextSeasonMatchNumber INT NOT NULL CONSTRAINT DF_CompetitiveSeasonMatchSequence_NextSeasonMatchNumber DEFAULT (1),
            UpdatedAtUtc          DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveSeasonMatchSequence_UpdatedAtUtc DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_CompetitiveSeasonMatchSequence PRIMARY KEY (SeasonId, GameId, ModeCode),
            CONSTRAINT FK_CompetitiveSeasonMatchSequence_CompetitiveSeason FOREIGN KEY (SeasonId) REFERENCES ${q('CompetitiveSeason')}(Id),
            CONSTRAINT FK_CompetitiveSeasonMatchSequence_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
            CONSTRAINT FK_CompetitiveSeasonMatchSequence_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code),
            CONSTRAINT CK_CompetitiveSeasonMatchSequence_NextSeasonMatchNumber CHECK (NextSeasonMatchNumber >= 1)
        );

        CREATE TABLE ${q('RatedMatch')} (
            Id                  INT IDENTITY(1,1) NOT NULL,
            MatchCode           NVARCHAR(24) NOT NULL,
            GameId              TINYINT NOT NULL,
            ModeCode            VARCHAR(10) NOT NULL,
            MatchNumber         INT NOT NULL,
            SeasonId            INT NOT NULL,
            SeasonMatchNumber   INT NOT NULL,
            FirstTo             TINYINT NOT NULL,
            Status              VARCHAR(12) NOT NULL CONSTRAINT DF_RatedMatch_Status DEFAULT ('creating'),
            Team1Score          TINYINT NULL,
            Team2Score          TINYINT NULL,
            HomeTeamNumber      TINYINT NOT NULL,
            AwayTeamNumber      TINYINT NOT NULL,
            WinnerTeamNumber    TINYINT NULL,
            GuildId             NVARCHAR(24) NULL,
            PanelChannelId      NVARCHAR(24) NULL,
            ThreadId            NVARCHAR(24) NULL,
            ThreadUrl           NVARCHAR(200) NULL,
            CreatedAtUtc        DATETIME2 NOT NULL CONSTRAINT DF_RatedMatch_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
            ActivatedAtUtc      DATETIME2 NULL,
            CompletedAtUtc      DATETIME2 NULL,
            CancelledAtUtc      DATETIME2 NULL,
            CancelReason        VARCHAR(50) NULL,
            ThreadFinalizedAtUtc DATETIME2 NULL,
            ThreadFinalizeLastAttemptAtUtc DATETIME2 NULL,
            ThreadFinalizeAttemptCount INT NOT NULL CONSTRAINT DF_RatedMatch_ThreadFinalizeAttemptCount DEFAULT (0),
            ThreadFinalizeLastError NVARCHAR(1000) NULL,
            CONSTRAINT PK_RatedMatch PRIMARY KEY (Id),
            CONSTRAINT UQ_RatedMatch_MatchCode UNIQUE (MatchCode),
            CONSTRAINT UQ_RatedMatch_Game_Mode_MatchNumber UNIQUE (GameId, ModeCode, MatchNumber),
            CONSTRAINT UQ_RatedMatch_Season_Game_Mode_SeasonMatchNumber UNIQUE (SeasonId, GameId, ModeCode, SeasonMatchNumber),
            CONSTRAINT FK_RatedMatch_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
            CONSTRAINT FK_RatedMatch_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code),
            CONSTRAINT FK_RatedMatch_CompetitiveSeason FOREIGN KEY (SeasonId) REFERENCES ${q('CompetitiveSeason')}(Id),
            CONSTRAINT CK_RatedMatch_Status CHECK (Status IN ('creating','active','completed','cancelled','rolled_back')),
            CONSTRAINT CK_RatedMatch_FirstTo CHECK (FirstTo >= 1),
            CONSTRAINT CK_RatedMatch_HomeTeamNumber CHECK (HomeTeamNumber IN (1,2)),
            CONSTRAINT CK_RatedMatch_AwayTeamNumber CHECK (AwayTeamNumber IN (1,2)),
            CONSTRAINT CK_RatedMatch_HomeAwayDifferent CHECK (HomeTeamNumber <> AwayTeamNumber),
            CONSTRAINT CK_RatedMatch_WinnerTeamNumber CHECK (WinnerTeamNumber IS NULL OR WinnerTeamNumber IN (1,2)),
            CONSTRAINT CK_RatedMatch_MatchNumber CHECK (MatchNumber >= 1),
            CONSTRAINT CK_RatedMatch_SeasonMatchNumber CHECK (SeasonMatchNumber >= 1)
        );

        CREATE TABLE ${q('RatedMatchParticipant')} (
            Id               INT IDENTITY(1,1) NOT NULL,
            RatedMatchId     INT NOT NULL,
            PlayerId         INT NOT NULL,
            DiscordId        NVARCHAR(50) NOT NULL,
            TeamNumber       TINYINT NOT NULL,
            IsRepresentative BIT NOT NULL CONSTRAINT DF_RatedMatchParticipant_IsRepresentative DEFAULT (0),
            CONSTRAINT PK_RatedMatchParticipant PRIMARY KEY (Id),
            CONSTRAINT UQ_RatedMatchParticipant_Match_Player UNIQUE (RatedMatchId, PlayerId),
            CONSTRAINT FK_RatedMatchParticipant_RatedMatch FOREIGN KEY (RatedMatchId) REFERENCES ${q('RatedMatch')}(Id) ON DELETE CASCADE,
            CONSTRAINT FK_RatedMatchParticipant_Player FOREIGN KEY (PlayerId) REFERENCES dbo.Player(Id),
            CONSTRAINT CK_RatedMatchParticipant_TeamNumber CHECK (TeamNumber IN (1,2))
        );

        CREATE TABLE ${q('RatedMatchGame')} (
            Id                       INT IDENTITY(1,1) NOT NULL,
            RatedMatchId             INT NOT NULL,
            GameNumber               TINYINT NOT NULL,
            WinnerTeamNumber         TINYINT NOT NULL,
            HomeTeamNumber           TINYINT NOT NULL,
            StadiumCode              NVARCHAR(100) NULL,
            CaptainCode              NVARCHAR(100) NULL,
            ReportedByParticipantId  INT NULL,
            ConfirmedByParticipantId INT NULL,
            ReportedAtUtc            DATETIME2 NOT NULL CONSTRAINT DF_RatedMatchGame_ReportedAtUtc DEFAULT SYSUTCDATETIME(),
            ConfirmedAtUtc           DATETIME2 NULL,
            CONSTRAINT PK_RatedMatchGame PRIMARY KEY (Id),
            CONSTRAINT UQ_RatedMatchGame_Match_Game UNIQUE (RatedMatchId, GameNumber),
            CONSTRAINT FK_RatedMatchGame_RatedMatch FOREIGN KEY (RatedMatchId) REFERENCES ${q('RatedMatch')}(Id) ON DELETE CASCADE,
            CONSTRAINT FK_RatedMatchGame_ReportedBy FOREIGN KEY (ReportedByParticipantId) REFERENCES ${q('RatedMatchParticipant')}(Id),
            CONSTRAINT FK_RatedMatchGame_ConfirmedBy FOREIGN KEY (ConfirmedByParticipantId) REFERENCES ${q('RatedMatchParticipant')}(Id),
            CONSTRAINT CK_RatedMatchGame_GameNumber CHECK (GameNumber >= 1),
            CONSTRAINT CK_RatedMatchGame_WinnerTeamNumber CHECK (WinnerTeamNumber IN (1,2)),
            CONSTRAINT CK_RatedMatchGame_HomeTeamNumber CHECK (HomeTeamNumber IN (1,2))
        );

        CREATE TABLE ${q('CompetitivePlayerRating')} (
            Id                  INT IDENTITY(1,1) NOT NULL,
            SeasonId            INT NOT NULL,
            PlayerId            INT NOT NULL,
            GameId              TINYINT NOT NULL,
            ModeCode            VARCHAR(10) NOT NULL,
            Elo                 DECIMAL(10,4) NOT NULL CONSTRAINT DF_CompetitivePlayerRating_Elo DEFAULT (${DEFAULT_COMPETITIVE_RATING}),
            RankNumber          TINYINT NOT NULL CONSTRAINT DF_CompetitivePlayerRating_RankNumber DEFAULT (0),
            MatchWins           INT NOT NULL CONSTRAINT DF_CompetitivePlayerRating_MatchWins DEFAULT (0),
            MatchLosses         INT NOT NULL CONSTRAINT DF_CompetitivePlayerRating_MatchLosses DEFAULT (0),
            PlacementPlayed     TINYINT NOT NULL CONSTRAINT DF_CompetitivePlayerRating_PlacementPlayed DEFAULT (0),
            PlacementComplete   BIT NOT NULL CONSTRAINT DF_CompetitivePlayerRating_PlacementComplete DEFAULT (0),
            PeakElo             DECIMAL(10,4) NOT NULL CONSTRAINT DF_CompetitivePlayerRating_PeakElo DEFAULT (${DEFAULT_COMPETITIVE_RATING}),
            PeakRankNumber      TINYINT NOT NULL CONSTRAINT DF_CompetitivePlayerRating_PeakRankNumber DEFAULT (0),
            UpdatedAtUtc        DATETIME2 NOT NULL CONSTRAINT DF_CompetitivePlayerRating_UpdatedAtUtc DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_CompetitivePlayerRating PRIMARY KEY (Id),
            CONSTRAINT UQ_CompetitivePlayerRating_Season_Player_Game_Mode UNIQUE (SeasonId, PlayerId, GameId, ModeCode),
            CONSTRAINT FK_CompetitivePlayerRating_CompetitiveSeason FOREIGN KEY (SeasonId) REFERENCES ${q('CompetitiveSeason')}(Id),
            CONSTRAINT FK_CompetitivePlayerRating_Player FOREIGN KEY (PlayerId) REFERENCES dbo.Player(Id),
            CONSTRAINT FK_CompetitivePlayerRating_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
            CONSTRAINT FK_CompetitivePlayerRating_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code),
            CONSTRAINT CK_CompetitivePlayerRating_Elo CHECK (Elo >= 0),
            CONSTRAINT CK_CompetitivePlayerRating_RankNumber CHECK (RankNumber BETWEEN 0 AND 19),
            CONSTRAINT CK_CompetitivePlayerRating_PeakRankNumber CHECK (PeakRankNumber BETWEEN 0 AND 19)
        );

        CREATE TABLE ${q('CompetitiveRatingChange')} (
            Id                       INT IDENTITY(1,1) NOT NULL,
            RatedMatchId             INT NOT NULL,
            RatedMatchParticipantId  INT NOT NULL,
            SeasonId                 INT NOT NULL,
            PlayerId                 INT NOT NULL,
            GameId                   TINYINT NOT NULL,
            ModeCode                 VARCHAR(10) NOT NULL,
            TeamNumber               TINYINT NOT NULL,
            Outcome                  VARCHAR(4) NOT NULL,
            EloBefore                DECIMAL(10,4) NOT NULL,
            EloAfter                 DECIMAL(10,4) NOT NULL,
            EloDelta                 DECIMAL(10,4) NOT NULL,
            RankBefore               TINYINT NOT NULL,
            RankAfter                TINYINT NOT NULL,
            PlacementBefore          TINYINT NOT NULL,
            PlacementAfter           TINYINT NOT NULL,
            CreatedAtUtc             DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveRatingChange_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_CompetitiveRatingChange PRIMARY KEY (Id),
            CONSTRAINT UQ_CompetitiveRatingChange_Match_Player UNIQUE (RatedMatchId, PlayerId),
            CONSTRAINT FK_CompetitiveRatingChange_RatedMatch FOREIGN KEY (RatedMatchId) REFERENCES ${q('RatedMatch')}(Id),
            CONSTRAINT FK_CompetitiveRatingChange_RatedMatchParticipant FOREIGN KEY (RatedMatchParticipantId) REFERENCES ${q('RatedMatchParticipant')}(Id),
            CONSTRAINT FK_CompetitiveRatingChange_CompetitiveSeason FOREIGN KEY (SeasonId) REFERENCES ${q('CompetitiveSeason')}(Id),
            CONSTRAINT FK_CompetitiveRatingChange_Player FOREIGN KEY (PlayerId) REFERENCES dbo.Player(Id),
            CONSTRAINT FK_CompetitiveRatingChange_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
            CONSTRAINT FK_CompetitiveRatingChange_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code),
            CONSTRAINT CK_CompetitiveRatingChange_TeamNumber CHECK (TeamNumber IN (1,2)),
            CONSTRAINT CK_CompetitiveRatingChange_Outcome CHECK (Outcome IN ('win','loss')),
            CONSTRAINT CK_CompetitiveRatingChange_RankBefore CHECK (RankBefore BETWEEN 0 AND 19),
            CONSTRAINT CK_CompetitiveRatingChange_RankAfter CHECK (RankAfter BETWEEN 0 AND 19)
        );

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

        CREATE TABLE ${q('CompetitiveSeasonSnapshot')} (
            Id                 INT IDENTITY(1,1) NOT NULL,
            SeasonId           INT NOT NULL,
            PlayerId           INT NOT NULL,
            GameId             TINYINT NOT NULL,
            ModeCode           VARCHAR(10) NOT NULL,
            FinalElo           DECIMAL(10,4) NOT NULL,
            FinalRankNumber    TINYINT NOT NULL,
            PeakElo            DECIMAL(10,4) NOT NULL,
            PeakRankNumber     TINYINT NOT NULL,
            TotalWins          INT NOT NULL,
            TotalLosses        INT NOT NULL,
            ArchivedAtUtc      DATETIME2 NOT NULL CONSTRAINT DF_CompetitiveSeasonSnapshot_ArchivedAtUtc DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_CompetitiveSeasonSnapshot PRIMARY KEY (Id),
            CONSTRAINT UQ_CompetitiveSeasonSnapshot_Season_Player_Game_Mode UNIQUE (SeasonId, PlayerId, GameId, ModeCode),
            CONSTRAINT FK_CompetitiveSeasonSnapshot_CompetitiveSeason FOREIGN KEY (SeasonId) REFERENCES ${q('CompetitiveSeason')}(Id),
            CONSTRAINT FK_CompetitiveSeasonSnapshot_Player FOREIGN KEY (PlayerId) REFERENCES dbo.Player(Id),
            CONSTRAINT FK_CompetitiveSeasonSnapshot_CompetitiveGame FOREIGN KEY (GameId) REFERENCES ${q('CompetitiveGame')}(Id),
            CONSTRAINT FK_CompetitiveSeasonSnapshot_CompetitiveMode FOREIGN KEY (ModeCode) REFERENCES ${q('CompetitiveMode')}(Code)
        );
    `);

    await executeQuery(`
        INSERT INTO ${q('CompetitiveMatchSequence')} (GameId, ModeCode, NextMatchNumber)
        SELECT game.Id, mode.Code, 1
        FROM ${q('CompetitiveGame')} game
        CROSS JOIN ${q('CompetitiveMode')} mode
        WHERE game.IsActive = 1 AND mode.IsActive = 1;

        INSERT INTO ${q('CompetitiveSeasonMatchSequence')} (SeasonId, GameId, ModeCode, NextSeasonMatchNumber)
        SELECT season.Id, game.Id, mode.Code, 1
        FROM ${q('CompetitiveSeason')} season
        CROSS JOIN ${q('CompetitiveGame')} game
        CROSS JOIN ${q('CompetitiveMode')} mode
        WHERE game.IsActive = 1 AND mode.IsActive = 1;

        CREATE INDEX IX_RatedMatch_Game_Mode_Number
        ON ${q('RatedMatch')} (GameId, ModeCode, MatchNumber);

        CREATE INDEX IX_RatedMatch_Status
        ON ${q('RatedMatch')} (Status, CreatedAtUtc);

        CREATE INDEX IX_RatedMatch_ThreadFinalization
        ON ${q('RatedMatch')} (Status, ThreadFinalizedAtUtc, CompletedAtUtc)
        INCLUDE (ThreadId, MatchCode, GameId, ModeCode, MatchNumber, Team1Score, Team2Score);

        CREATE INDEX IX_RatedMatchParticipant_Match_DiscordId
        ON ${q('RatedMatchParticipant')} (RatedMatchId, DiscordId);

        CREATE INDEX IX_CompetitivePlayerRating_Leaderboard
        ON ${q('CompetitivePlayerRating')} (SeasonId, GameId, ModeCode, Elo DESC)
        INCLUDE (
            PlayerId, RankNumber, MatchWins, MatchLosses,
            PlacementPlayed, PlacementComplete, PeakElo,
            PeakRankNumber, UpdatedAtUtc
        );

        CREATE INDEX IX_CompetitiveMatchRollback_Game_Mode_Number
        ON ${q('CompetitiveMatchRollback')} (GameId, ModeCode, MatchNumber);

        CREATE INDEX IX_CompetitiveWhrSync_Status
        ON ${q('CompetitiveWhrSync')} (SyncStatus, WhrRunnerStatus, UpdatedAtUtc)
        INCLUDE (RatedMatchId, GameId, ModeCode, MatchNumber, LegacyMatchId, LegacyMultiMatchId);

        CREATE INDEX IX_CompetitiveSeasonRewardProgress_Player
        ON ${q('CompetitiveSeasonRewardProgress')} (PlayerId, SeasonId, GameId, ModeCode);

        CREATE INDEX IX_CompetitiveSeasonRewardEarned_Player
        ON ${q('CompetitiveSeasonRewardEarned')} (PlayerId, SeasonId, GameId, ModeCode, TierOrder);

        CREATE INDEX IX_CompetitiveSeasonAwardResult_Partition
        ON ${q('CompetitiveSeasonAwardResult')} (SeasonId, GameId, ModeCode, AwardCode, RankPosition);

        CREATE INDEX IX_CompetitiveSeasonAwardResultPlayer_Player
        ON ${q('CompetitiveSeasonAwardResultPlayer')} (PlayerId, AwardResultId);
    `);
}

async function createLeaderboardObjects() {
    await executeQuery(`
        CREATE OR ALTER VIEW ${q('CompetitiveLeaderboard')} AS
        SELECT
            rating.SeasonId,
            rating.GameId AS GameType,
            game.Code AS GameCode,
            game.DisplayName AS GameName,
            rating.ModeCode AS Mode,
            ROW_NUMBER() OVER (
                PARTITION BY rating.SeasonId, rating.GameId, rating.ModeCode
                ORDER BY
                    rating.Elo DESC,
                    rating.MatchWins DESC,
                    rating.MatchLosses ASC,
                    rating.UpdatedAtUtc ASC,
                    rating.PlayerId ASC
            ) AS Position,
            rating.PlayerId,
            player.DiscordID AS DiscordId,
            player.Name AS PlayerName,
            rating.Elo,
            rating.RankNumber,
            threshold.Name AS RankName,
            threshold.Tier AS RankTier,
            rating.MatchWins,
            rating.MatchLosses,
            rating.MatchWins + rating.MatchLosses AS TotalMatches,
            rating.PlacementPlayed,
            rating.PlacementComplete,
            rating.PeakElo,
            rating.PeakRankNumber,
            rating.UpdatedAtUtc
        FROM ${q('CompetitivePlayerRating')} rating
        INNER JOIN dbo.Player player
            ON player.Id = rating.PlayerId
        INNER JOIN ${q('CompetitiveGame')} game
            ON game.Id = rating.GameId
        LEFT JOIN ${q('CompetitiveRankThreshold')} threshold
            ON threshold.RankNumber = rating.RankNumber
           AND threshold.IsActive = 1
        WHERE (rating.MatchWins + rating.MatchLosses) > 0
          AND player.HideStats = 0
          AND game.IsActive = 1
    `);
}

async function createProcedures() {
    await executeQuery(`
        CREATE OR ALTER PROCEDURE ${proc('sp_CompetitiveSeasonClose')} @SeasonId INT
        AS
        BEGIN
            SET NOCOUNT ON;
            INSERT INTO ${q('CompetitiveSeasonSnapshot')} (
                SeasonId, PlayerId, GameId, ModeCode, FinalElo, FinalRankNumber,
                PeakElo, PeakRankNumber, TotalWins, TotalLosses
            )
            SELECT SeasonId, PlayerId, GameId, ModeCode, Elo, RankNumber,
                   PeakElo, PeakRankNumber, MatchWins, MatchLosses
            FROM ${q('CompetitivePlayerRating')} rating
            WHERE SeasonId = @SeasonId
              AND NOT EXISTS (
                  SELECT 1 FROM ${q('CompetitiveSeasonSnapshot')} existing
                  WHERE existing.SeasonId = rating.SeasonId
                    AND existing.PlayerId = rating.PlayerId
                    AND existing.GameId = rating.GameId
                    AND existing.ModeCode = rating.ModeCode
              );

            UPDATE ${q('CompetitiveSeason')}
            SET IsActive = 0,
                IsCompleted = 1,
                LifecycleStatus = 'completed',
                FinalizedAtUtc = COALESCE(FinalizedAtUtc, SYSUTCDATETIME()),
                TransitionLastAttemptAtUtc = SYSUTCDATETIME(),
                TransitionAttemptCount = TransitionAttemptCount + 1,
                TransitionLastError = NULL
            WHERE Id = @SeasonId;

            SELECT @SeasonId AS ClosedSeasonId;
        END
    `);

    await executeQuery(`
        CREATE OR ALTER PROCEDURE ${proc('sp_CompetitiveSeasonActivate')} @NewSeasonId INT
        AS
        BEGIN
            SET NOCOUNT ON;

            DECLARE @OldSeasonId INT;
            SELECT TOP 1 @OldSeasonId = Id
            FROM ${q('CompetitiveSeason')}
            WHERE IsActive = 0 AND IsCompleted = 1
            ORDER BY EndDateUtc DESC;

            DECLARE @SoftResetFactor DECIMAL(4,2);
            SELECT @SoftResetFactor = SoftResetFactor
            FROM ${q('CompetitiveSeason')}
            WHERE Id = @NewSeasonId;

            IF @OldSeasonId IS NOT NULL
            BEGIN
                INSERT INTO ${q('CompetitivePlayerRating')} (
                    SeasonId, PlayerId, GameId, ModeCode, Elo, RankNumber,
                    PlacementPlayed, PlacementComplete, PeakElo, PeakRankNumber
                )
                SELECT @NewSeasonId, PlayerId, GameId, ModeCode,
                       ${DEFAULT_COMPETITIVE_RATING} + (Elo - ${DEFAULT_COMPETITIVE_RATING}) * @SoftResetFactor, 0,
                       0, 0,
                       ${DEFAULT_COMPETITIVE_RATING} + (Elo - ${DEFAULT_COMPETITIVE_RATING}) * @SoftResetFactor, 0
                FROM ${q('CompetitivePlayerRating')} oldRating
                WHERE SeasonId = @OldSeasonId
                  AND NOT EXISTS (
                      SELECT 1 FROM ${q('CompetitivePlayerRating')} newRating
                      WHERE newRating.SeasonId = @NewSeasonId
                        AND newRating.PlayerId = oldRating.PlayerId
                        AND newRating.GameId = oldRating.GameId
                        AND newRating.ModeCode = oldRating.ModeCode
                  );
            END

            INSERT INTO ${q('CompetitiveSeasonMatchSequence')} (SeasonId, GameId, ModeCode, NextSeasonMatchNumber)
            SELECT @NewSeasonId, game.Id, mode.Code, 1
            FROM ${q('CompetitiveGame')} game
            CROSS JOIN ${q('CompetitiveMode')} mode
            WHERE game.IsActive = 1
              AND mode.IsActive = 1
              AND NOT EXISTS (
                  SELECT 1
                  FROM ${q('CompetitiveSeasonMatchSequence')} existing
                  WHERE existing.SeasonId = @NewSeasonId
                    AND existing.GameId = game.Id
                    AND existing.ModeCode = mode.Code
              );

            UPDATE ${q('CompetitiveSeason')}
            SET IsActive = 1,
                IsCompleted = 0,
                LifecycleStatus = 'active',
                ActivatedAtUtc = COALESCE(ActivatedAtUtc, SYSUTCDATETIME()),
                TransitionLastAttemptAtUtc = SYSUTCDATETIME(),
                TransitionAttemptCount = TransitionAttemptCount + 1,
                TransitionLastError = NULL
            WHERE Id = @NewSeasonId;

            SELECT @NewSeasonId AS ActivatedSeasonId;
        END
    `);
}

async function migrate() {
    console.log(`Hard rebuilding competitive schema '${COMPETITIVE_DB_SCHEMA}'...`);
    await createSchemaIfMissing();

    const seedData = await readSeedData();
    await dropCompetitiveObjects();
    await createReferenceTables();
    await seedReferenceTables(seedData);
    await createRuntimeTables();
    await createLeaderboardObjects();
    await createProcedures();

    const summary = await executeQuery(`
        SELECT t.name AS TableName, SUM(p.rows) AS [Rows]
        FROM sys.tables t
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
        WHERE s.name = @schema
          AND t.name IN (
              'CompetitiveGame', 'CompetitiveMode', 'CompetitiveSeason',
              'CompetitiveRankThreshold', 'CompetitiveMatchSequence',
              'CompetitiveSeasonMatchSequence', 'CompetitivePlayerRating',
              'CompetitiveRatingChange', 'CompetitiveSeasonSnapshot',
              'CompetitiveMatchRollback', 'CompetitiveMatchRollbackChangeSnapshot',
              'CompetitiveWhrSync',
              'CompetitiveSeasonRewardProgress', 'CompetitiveSeasonRewardEarned',
              'CompetitiveSeasonAwardResult', 'CompetitiveSeasonAwardResultPlayer',
              'RatedMatch', 'RatedMatchParticipant', 'RatedMatchGame'
          )
        GROUP BY t.name
        ORDER BY t.name
    `, { schema: COMPETITIVE_DB_SCHEMA });
    console.log(JSON.stringify(summary.recordset, null, 2));
    console.log('Competitive schema hard rebuild complete.');
}

migrate().catch(err => {
    console.error('Competitive schema migration failed:', err.message);
    process.exitCode = 1;
}).finally(closePool);
