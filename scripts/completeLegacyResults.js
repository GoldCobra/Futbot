/**
 * One-time completion of the legacy 1v1 result base (dbo.Match) that WHR is calculated from.
 *
 *   node scripts/completeLegacyResults.js            dry run: shows what would be added and removed
 *   node scripts/completeLegacyResults.js --apply    writes it (one transaction, hard caps)
 *   node scripts/completeLegacyResults.js --report   prints the review list (cases left for a human decision)
 *
 * A1: completed matches of the old ranked queue (dbo.RankedMatch) that never reached dbo.Match are added.
 *     The game is taken from the players' activity; unclear cases only go to the review list.
 * A2: rows that are identical down to the second (same players, order, score and time) are counted once.
 *     Rows on a full hour (manual entries such as "2020-11-21 00:00") are never treated as sure duplicates.
 */
const { closePool, executeQuery, getPool, sql } = require('../src/db/sqlClient');
const { buildStatsDeltaUpdate } = require('../src/db/daos/competitiveWhrSyncDao');
const { competitiveTable } = require('../src/utils/competitiveConstants');

const MAX_QUEUE_BACKFILL = 70;
const MAX_SURE_DUPLICATES = 3;
const GAME_TYPE_WINDOW_DAYS = 60;
const PAIR_WINDOW_DAYS = 2;
const RAPID_REREPORT_SECONDS = 60;
const BACKFILL_TOURNAMENT = 'Ranked Queue (backfill)';

// dbo.Match rows that belong to a ranked-queue lobby: the channel ("MSBL Rated Match 9636 - momjea") names a
// RankedMatch of the same two players. Such a row is that lobby's result and never explains another lobby.
const OWNED_BY_QUEUE_CTE = `queueChannel AS (
    SELECT m.[Match] AS MatchId, m.Player1, m.Player2,
           TRY_CAST(SUBSTRING(m.Channel, PATINDEX('%Rated Match [0-9]%', m.Channel) + 12,
               PATINDEX('%[^0-9]%', SUBSTRING(m.Channel, PATINDEX('%Rated Match [0-9]%', m.Channel) + 12, 20) + 'x') - 1) AS INT) AS RankedMatchId
    FROM dbo.Match m
    WHERE m.Channel LIKE '%Rated Match [0-9]%'
),
owned AS (
    SELECT qc.MatchId, qc.RankedMatchId
    FROM queueChannel qc
    INNER JOIN dbo.RankedMatch r ON r.ID = qc.RankedMatchId
    WHERE (r.Player1 = qc.Player1 AND r.Player2 = qc.Player2) OR (r.Player1 = qc.Player2 AND r.Player2 = qc.Player1)
)`;

// Rows of the same pair around the lobby date that belong to no queue lobby (e.g. reported by hand).
const UNOWNED_NEARBY = `
    FROM dbo.Match m
    WHERE ((m.Player1 = r.Player1 AND m.Player2 = r.Player2) OR (m.Player1 = r.Player2 AND m.Player2 = r.Player1))
      AND m.MatchDate BETWEEN DATEADD(day, -${PAIR_WINDOW_DAYS}, r.LobbyDate) AND DATEADD(day, ${PAIR_WINDOW_DAYS}, r.LobbyDate)
      AND NOT EXISTS (SELECT 1 FROM owned o WHERE o.MatchId = m.[Match])`;

const QUEUE_CANDIDATES_QUERY = `
WITH ${OWNED_BY_QUEUE_CTE},
candidates AS (
    SELECT r.ID, r.Player1, r.Player2, r.P1Wins, r.P2Wins, r.FirstTo, r.LobbyDate,
           CASE WHEN EXISTS (SELECT 1 ${UNOWNED_NEARBY}) THEN 1 ELSE 0 END AS PairReportedNearby
    FROM dbo.RankedMatch r
    WHERE r.Status = '9'
      AND r.Player3 IS NULL
      AND r.P1Wins + r.P2Wins > 0
      AND r.Player1 <> r.Player2
      AND NOT EXISTS (SELECT 1 FROM owned o WHERE o.RankedMatchId = r.ID)
      AND NOT EXISTS (SELECT 1 FROM dbo.Match m WHERE m.Notes = CONCAT('RankedMatch:', r.ID))
      -- reported by hand with the same result: already part of dbo.Match
      AND NOT EXISTS (
          SELECT 1 ${UNOWNED_NEARBY}
            AND ((m.Player1 = r.Player1 AND m.P1Wins = r.P1Wins AND m.P1Losses = r.P2Wins)
              OR (m.Player1 = r.Player2 AND m.P1Wins = r.P2Wins AND m.P1Losses = r.P1Wins))
      )
)
SELECT c.ID, c.Player1, c.Player2, c.P1Wins, c.P2Wins, c.FirstTo, c.LobbyDate, c.PairReportedNearby,
       p1.Name AS Player1Name, p2.Name AS Player2Name, g.GameType
FROM candidates c
LEFT JOIN dbo.Player p1 ON p1.ID = c.Player1
LEFT JOIN dbo.Player p2 ON p2.ID = c.Player2
OUTER APPLY (
    -- games both players played within the window
    SELECT played.GameType
    FROM (
        SELECT DISTINCT m.GameType
        FROM dbo.Match m
        WHERE m.MatchDate BETWEEN DATEADD(day, -${GAME_TYPE_WINDOW_DAYS}, c.LobbyDate) AND DATEADD(day, ${GAME_TYPE_WINDOW_DAYS}, c.LobbyDate)
          AND (m.Player1 = c.Player1 OR m.Player2 = c.Player1)
    ) played
    WHERE EXISTS (
        SELECT 1
        FROM dbo.Match m
        WHERE m.GameType = played.GameType
          AND m.MatchDate BETWEEN DATEADD(day, -${GAME_TYPE_WINDOW_DAYS}, c.LobbyDate) AND DATEADD(day, ${GAME_TYPE_WINDOW_DAYS}, c.LobbyDate)
          AND (m.Player1 = c.Player2 OR m.Player2 = c.Player2)
    )
) g
ORDER BY c.LobbyDate, c.ID`;

// Sure duplicates: identical key down to the second, and not on a full hour.
const SURE_DUPLICATES_QUERY = `
WITH ranked AS (
    SELECT m.[Match] AS MatchId, m.GameType, m.Player1, m.Player2, m.P1Wins, m.P1Losses, m.MatchDate, m.Channel,
           ROW_NUMBER() OVER (PARTITION BY m.GameType, m.Player1, m.Player2, m.P1Wins, m.P1Losses, m.MatchDate ORDER BY m.[Match]) AS CopyNumber
    FROM dbo.Match m
    WHERE m.FutureMatch = 0
      AND (DATEPART(minute, m.MatchDate) <> 0 OR DATEPART(second, m.MatchDate) <> 0)
)
SELECT r.MatchId, r.GameType, r.Player1, r.Player2, r.P1Wins, r.P1Losses, r.MatchDate, r.Channel,
       p1.Name AS Player1Name, p2.Name AS Player2Name
FROM ranked r
LEFT JOIN dbo.Player p1 ON p1.ID = r.Player1
LEFT JOIN dbo.Player p2 ON p2.ID = r.Player2
WHERE r.CopyNumber > 1
ORDER BY r.MatchDate, r.MatchId`;

function classifyQueueCandidates(rows) {
    const byId = new Map();
    for (const row of rows) {
        let candidate = byId.get(row.ID);
        if (!candidate) {
            candidate = {
                rankedMatchId: row.ID,
                player1: row.Player1,
                player2: row.Player2,
                player1Name: row.Player1Name ?? null,
                player2Name: row.Player2Name ?? null,
                p1Wins: Number(row.P1Wins),
                p2Wins: Number(row.P2Wins),
                firstTo: row.FirstTo == null ? null : Number(row.FirstTo),
                lobbyDate: row.LobbyDate,
                pairReportedNearby: Boolean(row.PairReportedNearby),
                gameTypes: []
            };
            byId.set(row.ID, candidate);
        }
        if (row.GameType != null && !candidate.gameTypes.includes(Number(row.GameType))) {
            candidate.gameTypes.push(Number(row.GameType));
        }
    }

    const insert = [];
    const review = [];
    for (const candidate of byId.values()) {
        const decided = candidate.firstTo > 0 && Math.max(candidate.p1Wins, candidate.p2Wins) >= candidate.firstTo;
        let reason = null;
        if (candidate.pairReportedNearby) reason = 'pair reported by hand within 2 days with a different result';
        else if (!decided) reason = `not decided (${candidate.p1Wins}-${candidate.p2Wins}, first to ${candidate.firstTo ?? '?'})`;
        else if (candidate.gameTypes.length === 0) reason = 'game unknown (no activity of both players within 60 days)';
        else if (candidate.gameTypes.length > 1) reason = `game ambiguous (${candidate.gameTypes.join('/')})`;

        if (reason) review.push({ ...candidate, reason });
        else insert.push({ ...candidate, gameType: candidate.gameTypes[0] });
    }
    return { insert, review };
}

function buildApplySql() {
    const statsFromBackfill = buildStatsDeltaUpdate(`
        SELECT b.GameType, r.Player1 AS Player, r.P1Wins AS GamesWon, r.P2Wins AS GamesLost
        FROM #QueueBackfill b INNER JOIN dbo.RankedMatch r ON r.ID = b.RankedMatchId
        UNION ALL
        SELECT b.GameType, r.Player2, r.P2Wins, r.P1Wins
        FROM #QueueBackfill b INNER JOIN dbo.RankedMatch r ON r.ID = b.RankedMatchId`);
    const statsFromDuplicates = buildStatsDeltaUpdate(`
        SELECT m.GameType, m.Player1 AS Player, m.P1Wins AS GamesWon, m.P1Losses AS GamesLost
        FROM #SureDuplicates d INNER JOIN dbo.Match m ON m.[Match] = d.MatchId
        UNION ALL
        SELECT m.GameType, m.Player2, m.P1Losses, m.P1Wins
        FROM #SureDuplicates d INNER JOIN dbo.Match m ON m.[Match] = d.MatchId`, { sign: -1 });

    return `
        SET XACT_ABORT ON;
        DECLARE @backfilled INT = 0, @duplicatesRemoved INT = 0;

        CREATE TABLE #QueueBackfill (RankedMatchId INT NOT NULL PRIMARY KEY, GameType INT NOT NULL);
        INSERT INTO #QueueBackfill (RankedMatchId, GameType)
        SELECT b.RankedMatchId, b.GameType
        FROM OPENJSON(@backfill) WITH (RankedMatchId INT '$[0]', GameType INT '$[1]') b
        INNER JOIN dbo.RankedMatch r ON r.ID = b.RankedMatchId
        WHERE r.Status = '9'
          AND r.Player3 IS NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.Match m WHERE m.Notes = CONCAT('RankedMatch:', b.RankedMatchId));
        IF (SELECT COUNT(*) FROM #QueueBackfill) > ${MAX_QUEUE_BACKFILL}
            THROW 51000, 'Queue backfill exceeds its safety cap.', 1;

        CREATE TABLE #SureDuplicates (MatchId INT NOT NULL PRIMARY KEY);
        INSERT INTO #SureDuplicates (MatchId)
        SELECT d.MatchId FROM OPENJSON(@duplicates) WITH (MatchId INT '$') d
        WHERE EXISTS (SELECT 1 FROM dbo.Match m WHERE m.[Match] = d.MatchId);
        IF (SELECT COUNT(*) FROM #SureDuplicates) > ${MAX_SURE_DUPLICATES}
            THROW 51000, 'Duplicate removal exceeds its safety cap.', 1;
        IF EXISTS (
            SELECT 1 FROM ${competitiveTable('CompetitiveWhrSync')} s
            INNER JOIN #SureDuplicates d ON d.MatchId = s.LegacyMatchId
        )
            THROW 51000, 'A duplicate is linked to a competitive rated match; nothing was changed.', 1;

        INSERT INTO dbo.PlayerStats (Player, GameType)
        SELECT DISTINCT player.Id, b.GameType
        FROM #QueueBackfill b
        INNER JOIN dbo.RankedMatch r ON r.ID = b.RankedMatchId
        CROSS APPLY (VALUES (r.Player1), (r.Player2)) player(Id)
        WHERE NOT EXISTS (SELECT 1 FROM dbo.PlayerStats ps WHERE ps.Player = player.Id AND ps.GameType = b.GameType);

        -- tr_SetAsActive_AfterMatch would mark players active for a match from years ago.
        SELECT DISTINCT ps.Player, ps.GameType, ps.IsActive
        INTO #ActiveBefore
        FROM dbo.PlayerStats ps
        INNER JOIN #QueueBackfill b ON b.GameType = ps.GameType
        INNER JOIN dbo.RankedMatch r ON r.ID = b.RankedMatchId
        WHERE ps.Player IN (r.Player1, r.Player2);

        INSERT INTO dbo.Match (
            GameType, Player1, Player2, Score, P1Wins, P1Losses, MatchDate, P1MatchScore, P2MatchScore,
            Tournament, Stage, FutureMatch, Channel, ServerID, Notes,
            P1EloPre, P1EloPost, P2EloPre, P2EloPost, SetUri
        )
        SELECT b.GameType, r.Player1, r.Player2, CONCAT(r.P1Wins, '-', r.P2Wins), r.P1Wins, r.P2Wins, r.LobbyDate,
               CASE WHEN r.P1Wins > r.P2Wins THEN 1.0 WHEN r.P1Wins < r.P2Wins THEN 0.0 ELSE 0.5 END,
               CASE WHEN r.P1Wins > r.P2Wins THEN 0.0 WHEN r.P1Wins < r.P2Wins THEN 1.0 ELSE 0.5 END,
               N'${BACKFILL_TOURNAMENT}', N'', 0, CONCAT(N'Rated Match ', r.ID, N' - backfill'), N'',
               CONCAT(N'RankedMatch:', r.ID),
               ISNULL(ps1.Elo, 1000), ISNULL(ps1.Elo, 1000), ISNULL(ps2.Elo, 1000), ISNULL(ps2.Elo, 1000), N''
        FROM #QueueBackfill b
        INNER JOIN dbo.RankedMatch r ON r.ID = b.RankedMatchId
        LEFT JOIN dbo.PlayerStats ps1 ON ps1.Player = r.Player1 AND ps1.GameType = b.GameType
        LEFT JOIN dbo.PlayerStats ps2 ON ps2.Player = r.Player2 AND ps2.GameType = b.GameType;
        SET @backfilled = @@ROWCOUNT;

        ${statsFromBackfill}

        UPDATE ps
        SET IsActive = a.IsActive
        FROM dbo.PlayerStats ps
        INNER JOIN #ActiveBefore a ON a.Player = ps.Player AND a.GameType = ps.GameType
        WHERE ps.IsActive <> a.IsActive;

        ${statsFromDuplicates}

        DELETE m FROM dbo.Match m INNER JOIN #SureDuplicates d ON d.MatchId = m.[Match];
        SET @duplicatesRemoved = @@ROWCOUNT;

        SELECT @backfilled AS Backfilled, @duplicatesRemoved AS DuplicatesRemoved;`;
}

async function applyChanges({ insert, duplicates }) {
    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
        const request = transaction.request();
        request.input('backfill', sql.NVarChar(sql.MAX), JSON.stringify(insert.map(row => [row.rankedMatchId, row.gameType])));
        request.input('duplicates', sql.NVarChar(sql.MAX), JSON.stringify(duplicates.map(row => row.MatchId)));
        const result = await request.query(buildApplySql());
        await transaction.commit();
        return result.recordset?.[0] ?? {};
    } catch (error) {
        await transaction.rollback().catch(() => {});
        throw error;
    }
}

async function printReviewList(review) {
    console.log('\n## Review list (nothing below is changed automatically)');

    console.log('\n### Ranked-queue matches not added');
    console.table(review.map(row => ({
        rankedMatchId: row.rankedMatchId,
        date: row.lobbyDate?.toISOString?.().slice(0, 16) ?? row.lobbyDate,
        players: `${row.player1Name ?? row.player1} vs ${row.player2Name ?? row.player2}`,
        score: `${row.p1Wins}-${row.p2Wins}`,
        reason: row.reason
    })));

    const rapid = await executeQuery(`
        WITH m AS (
            SELECT [Match] AS MatchId, GameType, Player1, Player2, P1Wins, P1Losses, MatchDate, Channel,
                   CASE WHEN Player1 < Player2 THEN Player1 ELSE Player2 END AS PlayerA,
                   CASE WHEN Player1 < Player2 THEN Player2 ELSE Player1 END AS PlayerB
            FROM dbo.Match
            WHERE FutureMatch = 0 AND ISNULL(Channel, N'') <> N''
        )
        SELECT a.MatchId AS FirstId, b.MatchId AS SecondId, a.GameType, a.Channel,
               CONCAT(pa.Name, N' vs ', pb.Name) AS Players,
               CONCAT(a.Player1, N':', a.P1Wins, N'-', a.P1Losses, N':', a.Player2) AS FirstResult,
               CONCAT(b.Player1, N':', b.P1Wins, N'-', b.P1Losses, N':', b.Player2) AS SecondResult,
               DATEDIFF(second, a.MatchDate, b.MatchDate) AS SecondsApart, a.MatchDate
        FROM m a
        INNER JOIN m b ON b.GameType = a.GameType AND b.PlayerA = a.PlayerA AND b.PlayerB = a.PlayerB
                      AND b.Channel = a.Channel AND b.MatchId > a.MatchId
                      AND DATEDIFF(second, a.MatchDate, b.MatchDate) BETWEEN 0 AND ${RAPID_REREPORT_SECONDS}
        LEFT JOIN dbo.Player pa ON pa.ID = a.PlayerA
        LEFT JOIN dbo.Player pb ON pb.ID = a.PlayerB
        WHERE NOT (a.Player1 = b.Player1 AND a.P1Wins = b.P1Wins AND a.P1Losses = b.P1Losses AND a.MatchDate = b.MatchDate
                   AND (DATEPART(minute, a.MatchDate) <> 0 OR DATEPART(second, a.MatchDate) <> 0))
        ORDER BY a.MatchDate`);
    console.log(`\n### Rapid re-reports: same pair in the same thread within ${RAPID_REREPORT_SECONDS} s (${rapid.recordset.length})`);
    console.table(rapid.recordset.map(row => ({ ...row, MatchDate: row.MatchDate?.toISOString?.().slice(0, 19) })));

    const fullHour = await executeQuery(`
        SELECT m.GameType, CONCAT(p1.Name, N' vs ', p2.Name) AS Players, CONCAT(m.P1Wins, N'-', m.P1Losses) AS Score,
               m.MatchDate, m.Tournament, m.Channel, COUNT(*) AS Copies, MIN(m.[Match]) AS FirstId, MAX(m.[Match]) AS LastId
        FROM dbo.Match m
        LEFT JOIN dbo.Player p1 ON p1.ID = m.Player1
        LEFT JOIN dbo.Player p2 ON p2.ID = m.Player2
        WHERE m.FutureMatch = 0 AND DATEPART(minute, m.MatchDate) = 0 AND DATEPART(second, m.MatchDate) = 0
        GROUP BY m.GameType, m.Player1, m.Player2, p1.Name, p2.Name, m.P1Wins, m.P1Losses, m.MatchDate, m.Tournament, m.Channel
        HAVING COUNT(*) > 1
        ORDER BY m.MatchDate`);
    console.log(`\n### Identical entries on a full hour, typical for manual entries (${fullHour.recordset.length})`);
    console.table(fullHour.recordset.map(row => ({ ...row, MatchDate: row.MatchDate?.toISOString?.().slice(0, 19) })));
}

async function main() {
    const apply = process.argv.includes('--apply');
    const report = process.argv.includes('--report');

    const candidates = await executeQuery(QUEUE_CANDIDATES_QUERY);
    const { insert, review } = classifyQueueCandidates(candidates.recordset);
    const duplicates = (await executeQuery(SURE_DUPLICATES_QUERY)).recordset;

    console.log(`A1 ranked-queue matches to add: ${insert.length} (cap ${MAX_QUEUE_BACKFILL}); to review: ${review.length}`);
    console.table(insert.map(row => ({
        rankedMatchId: row.rankedMatchId,
        gameType: row.gameType,
        date: row.lobbyDate?.toISOString?.().slice(0, 16) ?? row.lobbyDate,
        players: `${row.player1Name ?? row.player1} vs ${row.player2Name ?? row.player2}`,
        score: `${row.p1Wins}-${row.p2Wins}`
    })));
    console.log(`A2 sure duplicates to remove: ${duplicates.length} (cap ${MAX_SURE_DUPLICATES})`);
    console.table(duplicates.map(row => ({
        matchId: row.MatchId,
        gameType: row.GameType,
        players: `${row.Player1Name ?? row.Player1} vs ${row.Player2Name ?? row.Player2}`,
        score: `${row.P1Wins}-${row.P1Losses}`,
        date: row.MatchDate?.toISOString?.().slice(0, 19),
        channel: row.Channel
    })));

    if (report) await printReviewList(review);

    if (insert.length > MAX_QUEUE_BACKFILL || duplicates.length > MAX_SURE_DUPLICATES) {
        throw new Error('Selection exceeds the safety caps; nothing was changed.');
    }
    if (!apply) {
        console.log('\nDry run. Re-run with --apply to write, with --report for the review list.');
        return;
    }
    const result = await applyChanges({ insert, duplicates });
    console.log('\nApplied:', result);
}

if (require.main === module) {
    main().catch(error => {
        console.error(`Completing legacy results failed: ${error.message}`);
        process.exitCode = 1;
    }).finally(closePool);
}

module.exports = {
    QUEUE_CANDIDATES_QUERY,
    classifyQueueCandidates,
    buildApplySql,
    MAX_QUEUE_BACKFILL,
    MAX_SURE_DUPLICATES
};
