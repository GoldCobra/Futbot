const { executeQuery, getPool, sql } = require('../sqlClient');
const { competitiveTable } = require('../../utils/competitiveConstants');

const T = {
    game: competitiveTable('CompetitiveGame'),
    season: competitiveTable('CompetitiveSeason'),
    ratedMatch: competitiveTable('RatedMatch'),
    ratedParticipant: competitiveTable('RatedMatchParticipant'),
    whrSync: competitiveTable('CompetitiveWhrSync')
};

function bindInputs(request, inputs = {}) {
    for (const [key, value] of Object.entries(inputs)) {
        if (Array.isArray(value)) {
            request.input(key, value[0], value[1]);
        } else {
            request.input(key, value);
        }
    }
    return request;
}

async function runRequest(runner, query, inputs = {}) {
    const request = bindInputs(runner.request(), inputs);
    return request.query(query);
}

function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function buildScore(team1Score, team2Score) {
    return `${toNumber(team1Score)}-${toNumber(team2Score)}`;
}

function buildMatchScore(teamScore, opponentScore) {
    if (toNumber(teamScore) > toNumber(opponentScore)) return 1.0;
    if (toNumber(teamScore) < toNumber(opponentScore)) return 0.0;
    return 0.5;
}

function buildLegacyChannel(match) {
    return `Competitive Rated ${match.GameCode} ${match.ModeCode} #${match.MatchNumber}`;
}

function normalizeSyncRow(row) {
    if (!row) return null;
    return {
        id: row.Id,
        ratedMatchId: row.RatedMatchId,
        seasonId: row.SeasonId,
        gameId: row.GameId,
        mode: row.ModeCode,
        matchNumber: row.MatchNumber,
        syncStatus: row.SyncStatus,
        legacyMatchId: row.LegacyMatchId ?? null,
        legacyMultiMatchId: row.LegacyMultiMatchId ?? null,
        whrRunnerStatus: row.WhrRunnerStatus,
        lastError: row.LastError ?? null,
        attemptCount: toNumber(row.AttemptCount)
    };
}

function normalizeRunnerPartition(row) {
    if (!row) return null;
    return {
        gameId: row.GameId,
        mode: row.ModeCode,
        syncIds: row.syncIds ?? [],
        count: toNumber(row.SyncCount)
    };
}

function buildSyncIdPredicate(syncIds, inputs) {
    const ids = [...new Set((syncIds ?? [])
        .map(value => Number(value))
        .filter(value => Number.isInteger(value) && value > 0))];

    if (!ids.length) {
        return { predicate: '1 = 0', inputs };
    }

    const placeholders = ids.map((id, index) => {
        const key = `syncId${index}`;
        inputs[key] = [sql.Int, id];
        return `@${key}`;
    });

    return {
        predicate: `Id IN (${placeholders.join(', ')})`,
        inputs
    };
}

function truncateError(value) {
    return String(value?.message ?? value ?? 'Unknown WHR/TST runner failure').slice(0, 1000);
}

class CompetitiveWhrSyncDao {
    async syncPendingCompletedMatches({ limit = 50 } = {}) {
        const pending = await executeQuery(
            `SELECT TOP (@limit) rm.Id AS RatedMatchId
             FROM ${T.ratedMatch} rm
             LEFT JOIN ${T.whrSync} sync
                ON sync.RatedMatchId = rm.Id
             WHERE rm.Status = 'completed'
               AND rm.CompletedAtUtc IS NOT NULL
               AND (
                    sync.Id IS NULL
                    OR sync.SyncStatus IN ('pending','failed')
               )
             ORDER BY rm.CompletedAtUtc ASC, rm.Id ASC`,
            { limit: [sql.Int, limit] }
        );

        const results = [];
        for (const row of pending.recordset) {
            try {
                const sync = await this.syncCompletedMatch({ ratedMatchId: row.RatedMatchId });
                results.push({ ratedMatchId: row.RatedMatchId, syncStatus: sync?.syncStatus ?? 'skipped' });
            } catch (error) {
                results.push({ ratedMatchId: row.RatedMatchId, syncStatus: 'failed', error: error.message });
            }
        }
        return results;
    }

    async getPendingRunnerPartitions({ limit = 50, includeFailed = false, includeNotConfigured = false } = {}) {
        const statuses = ['pending_external_runner'];
        if (includeFailed) statuses.push('failed');
        if (includeNotConfigured) statuses.push('not_configured');

        const statusInputs = {};
        const statusPlaceholders = statuses.map((status, index) => {
            const key = `runnerStatus${index}`;
            statusInputs[key] = [sql.VarChar(30), status];
            return `@${key}`;
        });

        const result = await executeQuery(
            `SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

             SELECT TOP (@limit)
                Id,
                GameId,
                ModeCode
             FROM ${T.whrSync} WITH (READPAST)
             WHERE SyncStatus IN ('synced','rolled_back')
               AND WhrRunnerStatus IN (${statusPlaceholders.join(', ')})
             ORDER BY UpdatedAtUtc ASC, Id ASC`,
            {
                limit: [sql.Int, limit],
                ...statusInputs
            }
        );

        const partitions = new Map();
        for (const row of result.recordset) {
            const key = `${row.GameId}:${row.ModeCode}`;
            if (!partitions.has(key)) {
                partitions.set(key, {
                    GameId: row.GameId,
                    ModeCode: row.ModeCode,
                    syncIds: [],
                    SyncCount: 0
                });
            }
            const partition = partitions.get(key);
            partition.syncIds.push(row.Id);
            partition.SyncCount += 1;
        }

        return [...partitions.values()].map(normalizeRunnerPartition).filter(Boolean);
    }

    async markRunnerRunning({ gameId, mode, syncIds }) {
        return this._updateRunnerStatus({
            gameId,
            mode,
            syncIds,
            whrRunnerStatus: 'running',
            clearError: true,
            expectedRunnerStatuses: ['pending_external_runner', 'failed', 'not_configured']
        });
    }

    async markRunnerComplete({ gameId, mode, syncIds }) {
        return this._updateRunnerStatus({
            gameId,
            mode,
            syncIds,
            whrRunnerStatus: 'complete',
            clearError: true,
            expectedRunnerStatuses: ['running']
        });
    }

    async markRunnerFailed({ gameId, mode, syncIds, error }) {
        return this._updateRunnerStatus({
            gameId,
            mode,
            syncIds,
            whrRunnerStatus: 'failed',
            lastError: truncateError(error),
            expectedRunnerStatuses: ['running', 'pending_external_runner']
        });
    }

    async markRunnerNotConfigured({ gameId, mode, syncIds, reason }) {
        return this._updateRunnerStatus({
            gameId,
            mode,
            syncIds,
            whrRunnerStatus: 'not_configured',
            lastError: truncateError(reason),
            expectedRunnerStatuses: ['pending_external_runner']
        });
    }

    async _updateRunnerStatus({
        gameId,
        mode,
        syncIds,
        whrRunnerStatus,
        lastError = null,
        clearError = false,
        expectedRunnerStatuses = []
    }) {
        const inputs = {
            gameId: [sql.TinyInt, gameId],
            modeCode: [sql.VarChar(10), mode],
            whrRunnerStatus: [sql.VarChar(30), whrRunnerStatus],
            lastError: [sql.NVarChar(1000), lastError]
        };
        const { predicate } = buildSyncIdPredicate(syncIds, inputs);
        const expectedStatuses = [...new Set(expectedRunnerStatuses.filter(Boolean))];
        const expectedStatusClause = expectedStatuses.length
            ? `AND WhrRunnerStatus IN (${expectedStatuses.map((status, index) => {
                const key = `expectedRunnerStatus${index}`;
                inputs[key] = [sql.VarChar(30), status];
                return `@${key}`;
            }).join(', ')})`
            : '';
        const lastErrorExpression = clearError ? 'NULL' : '@lastError';

        const result = await executeQuery(
            `UPDATE ${T.whrSync}
             SET WhrRunnerStatus = @whrRunnerStatus,
                 LastAttemptAtUtc = SYSUTCDATETIME(),
                 AttemptCount = AttemptCount + 1,
                 LastError = ${lastErrorExpression},
                 UpdatedAtUtc = SYSUTCDATETIME()
             WHERE GameId = @gameId
               AND ModeCode = @modeCode
               AND SyncStatus IN ('synced','rolled_back')
               ${expectedStatusClause}
               AND ${predicate}`,
            inputs
        );

        return {
            updatedRows: result.rowsAffected?.[0] ?? 0,
            whrRunnerStatus
        };
    }

    async syncCompletedMatch({ ratedMatchId }) {
        if (!ratedMatchId) return null;

        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            const match = await this._getCompletedMatchForUpdate(transaction, ratedMatchId);
            if (!match) {
                await transaction.commit();
                return null;
            }

            const existing = await this._getSyncForUpdate(transaction, ratedMatchId);
            if (existing?.SyncStatus === 'synced') {
                await transaction.commit();
                return normalizeSyncRow(existing);
            }
            if (existing?.SyncStatus === 'rolled_back') {
                await transaction.commit();
                return normalizeSyncRow(existing);
            }

            const participants = await this._getParticipants(transaction, ratedMatchId);
            this._assertParticipants(match, participants);

            let sync = existing;
            if (!sync) {
                sync = await this._insertPendingSync(transaction, match);
            }

            await this._ensurePlayerStats(transaction, participants, match.GameId);

            const legacyResult = match.ModeCode === '2v2'
                ? await this._mirrorDoublesMatch(transaction, match, participants)
                : await this._mirrorSinglesMatch(transaction, match, participants);

            const updated = await this._markSynced(transaction, {
                syncId: sync.Id,
                legacyMatchId: legacyResult.legacyMatchId ?? null,
                legacyMultiMatchId: legacyResult.legacyMultiMatchId ?? null
            });

            await transaction.commit();
            return normalizeSyncRow(updated);
        } catch (err) {
            await transaction.rollback().catch(() => {});
            await this._markFailed(ratedMatchId, err).catch(() => {});
            throw err;
        }
    }

    async linkExistingLegacyMirror({ ratedMatchId, legacyMatchId = null, legacyMultiMatchId = null }) {
        if (!ratedMatchId) return null;
        if (!legacyMatchId && !legacyMultiMatchId) {
            throw new Error(`Cannot link WHR/TST sync for RatedMatch ${ratedMatchId}: no legacy match id provided`);
        }

        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            const match = await this._getCompletedMatchForUpdate(transaction, ratedMatchId);
            if (!match) {
                await transaction.commit();
                return null;
            }

            let sync = await this._getSyncForUpdate(transaction, ratedMatchId);
            if (!sync) {
                sync = await this._insertPendingSync(transaction, match);
            }

            if (sync.SyncStatus === 'rolled_back') {
                await transaction.commit();
                return normalizeSyncRow(sync);
            }

            const result = await runRequest(
                transaction,
                `UPDATE ${T.whrSync}
                 SET SyncStatus = 'synced',
                     LegacyMatchId = COALESCE(LegacyMatchId, @legacyMatchId),
                     LegacyMultiMatchId = COALESCE(LegacyMultiMatchId, @legacyMultiMatchId),
                     WhrRunnerStatus = 'pending_external_runner',
                     WhrRunnerRequestedAtUtc = SYSUTCDATETIME(),
                     SyncedAtUtc = COALESCE(SyncedAtUtc, SYSUTCDATETIME()),
                     LastAttemptAtUtc = SYSUTCDATETIME(),
                     AttemptCount = AttemptCount + 1,
                     LastError = NULL,
                     UpdatedAtUtc = SYSUTCDATETIME()
                 OUTPUT INSERTED.*
                 WHERE Id = @syncId`,
                {
                    syncId: sync.Id,
                    legacyMatchId,
                    legacyMultiMatchId
                }
            );

            await transaction.commit();
            return normalizeSyncRow(result.recordset[0]);
        } catch (err) {
            await transaction.rollback().catch(() => {});
            await this._markFailed(ratedMatchId, err).catch(() => {});
            throw err;
        }
    }

    async markRolledBack({ ratedMatchId }) {
        if (!ratedMatchId) return null;

        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            const sync = await this._getSyncForUpdate(transaction, ratedMatchId);
            if (!sync) {
                await transaction.commit();
                return null;
            }

            if (sync.LegacyMatchId) {
                await runRequest(
                    transaction,
                    'DELETE FROM dbo.Match WHERE [Match] = @legacyMatchId',
                    { legacyMatchId: sync.LegacyMatchId }
                );
            }

            if (sync.LegacyMultiMatchId) {
                await runRequest(
                    transaction,
                    'DELETE FROM dbo.MultiMatch WHERE ID = @legacyMultiMatchId',
                    { legacyMultiMatchId: sync.LegacyMultiMatchId }
                );
            }

            const result = await runRequest(
                transaction,
                `UPDATE ${T.whrSync}
                 SET SyncStatus = 'rolled_back',
                     WhrRunnerStatus = 'pending_external_runner',
                     WhrRunnerRequestedAtUtc = SYSUTCDATETIME(),
                     RolledBackAtUtc = COALESCE(RolledBackAtUtc, SYSUTCDATETIME()),
                     LastAttemptAtUtc = SYSUTCDATETIME(),
                     AttemptCount = AttemptCount + 1,
                     LastError = NULL,
                     UpdatedAtUtc = SYSUTCDATETIME()
                 OUTPUT INSERTED.*
                 WHERE Id = @syncId`,
                { syncId: sync.Id }
            );

            await transaction.commit();
            return normalizeSyncRow(result.recordset[0]);
        } catch (err) {
            await transaction.rollback().catch(() => {});
            await this._markFailed(ratedMatchId, err).catch(() => {});
            throw err;
        }
    }

    async _getCompletedMatchForUpdate(transaction, ratedMatchId) {
        const result = await runRequest(
            transaction,
            `SELECT rm.*,
                    game.Code AS GameCode,
                    game.ShortName AS GameShortName,
                    season.DisplayName AS SeasonName
             FROM ${T.ratedMatch} rm WITH (UPDLOCK, HOLDLOCK)
             INNER JOIN ${T.game} game ON game.Id = rm.GameId
             INNER JOIN ${T.season} season ON season.Id = rm.SeasonId
             WHERE rm.Id = @ratedMatchId`,
            { ratedMatchId }
        );
        const match = result.recordset[0] ?? null;
        if (!match) return null;
        if (match.Status !== 'completed') {
            throw new Error(`Cannot sync WHR/TST for RatedMatch ${ratedMatchId}: status is '${match.Status}'`);
        }
        if (match.Team1Score == null || match.Team2Score == null || match.CompletedAtUtc == null) {
            throw new Error(`Cannot sync WHR/TST for RatedMatch ${ratedMatchId}: completion data is incomplete`);
        }
        return match;
    }

    async _getSyncForUpdate(transaction, ratedMatchId) {
        const result = await runRequest(
            transaction,
            `SELECT TOP 1 *
             FROM ${T.whrSync} WITH (UPDLOCK, HOLDLOCK)
             WHERE RatedMatchId = @ratedMatchId`,
            { ratedMatchId }
        );
        return result.recordset[0] ?? null;
    }

    async _getParticipants(transaction, ratedMatchId) {
        const result = await runRequest(
            transaction,
            `SELECT rmp.Id AS RatedMatchParticipantId,
                    rmp.PlayerId,
                    rmp.DiscordId,
                    rmp.TeamNumber,
                    rmp.IsRepresentative,
                    p.Name AS PlayerName
             FROM ${T.ratedParticipant} rmp
             INNER JOIN dbo.Player p ON p.Id = rmp.PlayerId
             WHERE rmp.RatedMatchId = @ratedMatchId
             ORDER BY rmp.TeamNumber ASC, rmp.IsRepresentative DESC, rmp.Id ASC`,
            { ratedMatchId }
        );
        return result.recordset;
    }

    _assertParticipants(match, participants) {
        const expected = match.ModeCode === '2v2' ? 4 : 2;
        if (participants.length !== expected) {
            throw new Error(`Cannot sync WHR/TST for ${match.MatchCode}: expected ${expected} participants, found ${participants.length}`);
        }
        for (const teamNumber of [1, 2]) {
            const teamSize = participants.filter(row => Number(row.TeamNumber) === teamNumber).length;
            const expectedTeamSize = match.ModeCode === '2v2' ? 2 : 1;
            if (teamSize !== expectedTeamSize) {
                throw new Error(`Cannot sync WHR/TST for ${match.MatchCode}: team ${teamNumber} has ${teamSize} participants`);
            }
        }
    }

    async _insertPendingSync(transaction, match) {
        const result = await runRequest(
            transaction,
            `INSERT INTO ${T.whrSync} (
                RatedMatchId, SeasonId, GameId, ModeCode, MatchNumber,
                SyncStatus, WhrRunnerStatus, WhrRunnerRequestedAtUtc
             )
             OUTPUT INSERTED.*
             VALUES (
                @ratedMatchId, @seasonId, @gameId, @modeCode, @matchNumber,
                'pending', 'pending_external_runner', SYSUTCDATETIME()
             )`,
            {
                ratedMatchId: match.Id,
                seasonId: match.SeasonId,
                gameId: match.GameId,
                modeCode: match.ModeCode,
                matchNumber: match.MatchNumber
            }
        );
        return result.recordset[0];
    }

    async _ensurePlayerStats(transaction, participants, gameId) {
        for (const participant of participants) {
            await runRequest(
                transaction,
                `INSERT INTO dbo.PlayerStats (Player, GameType)
                 SELECT @playerId, @gameId
                 WHERE NOT EXISTS (
                     SELECT 1
                     FROM dbo.PlayerStats
                     WHERE Player = @playerId AND GameType = @gameId
                 )`,
                { playerId: participant.PlayerId, gameId }
            );
        }
    }

    async _mirrorSinglesMatch(transaction, match, participants) {
        // Robotic Nightmare's head-to-head commands read the legacy match tables.
        const existing = await this._findExistingSinglesMirror(transaction, match, participants);
        if (existing) {
            return { legacyMatchId: existing };
        }

        const team1 = participants.find(row => Number(row.TeamNumber) === 1);
        const team2 = participants.find(row => Number(row.TeamNumber) === 2);
        const score = buildScore(match.Team1Score, match.Team2Score);
        const p1MatchScore = buildMatchScore(match.Team1Score, match.Team2Score);
        const p2MatchScore = Math.abs(p1MatchScore - 1.0);
        const channel = buildLegacyChannel(match);

        const result = await runRequest(
            transaction,
            `DECLARE @p1Elo NUMERIC(19,9) = 1000;
             DECLARE @p2Elo NUMERIC(19,9) = 1000;
             DECLARE @Inserted TABLE (LegacyMatchId INT);

             SELECT @p1Elo = COALESCE(Elo, 1000)
             FROM dbo.PlayerStats
             WHERE Player = @player1 AND GameType = @gameId;

             SELECT @p2Elo = COALESCE(Elo, 1000)
             FROM dbo.PlayerStats
             WHERE Player = @player2 AND GameType = @gameId;

             INSERT INTO dbo.Match (
                GameType, Player1, Player2, Score, P1Wins, P1Losses,
                MatchDate, P1MatchScore, P2MatchScore, Tournament, Stage,
                FutureMatch, Channel, ServerID, P1EloPre, P1EloPost,
                P2EloPre, P2EloPost, SetUri, Notes
             )
             OUTPUT INSERTED.[Match] INTO @Inserted
             VALUES (
                @gameId, @player1, @player2, @score, @team1Score, @team2Score,
                @matchDate, @p1MatchScore, @p2MatchScore, @tournament, @stage,
                0, @channel, @serverId, @p1Elo, @p1Elo,
                @p2Elo, @p2Elo, @threadUrl, @notes
             );

             SELECT TOP 1 LegacyMatchId FROM @Inserted`,
            {
                gameId: match.GameId,
                player1: team1.PlayerId,
                player2: team2.PlayerId,
                score,
                team1Score: match.Team1Score,
                team2Score: match.Team2Score,
                matchDate: match.CompletedAtUtc,
                p1MatchScore,
                p2MatchScore,
                tournament: 'Competitive Rated',
                stage: `${match.GameCode} ${match.ModeCode} #${match.MatchNumber}`,
                channel,
                serverId: match.GuildId ?? '',
                threadUrl: match.ThreadUrl ?? '',
                notes: `CompetitiveRatedMatch:${match.Id}`
            }
        );

        return { legacyMatchId: result.recordset[0]?.LegacyMatchId };
    }

    async _findExistingSinglesMirror(transaction, match, participants) {
        const team1 = participants.find(row => Number(row.TeamNumber) === 1);
        const team2 = participants.find(row => Number(row.TeamNumber) === 2);
        const result = await runRequest(
            transaction,
            `SELECT TOP 1 [Match] AS LegacyMatchId
             FROM dbo.Match WITH (UPDLOCK, HOLDLOCK)
             WHERE GameType = @gameId
               AND Player1 = @player1
               AND Player2 = @player2
               AND MatchDate = @matchDate
               AND Channel = @channel
               AND Notes = @notes
             ORDER BY [Match] DESC`,
            {
                gameId: match.GameId,
                player1: team1.PlayerId,
                player2: team2.PlayerId,
                matchDate: match.CompletedAtUtc,
                channel: buildLegacyChannel(match),
                notes: `CompetitiveRatedMatch:${match.Id}`
            }
        );
        return result.recordset[0]?.LegacyMatchId ?? null;
    }

    async _mirrorDoublesMatch(transaction, match, participants) {
        // Robotic Nightmare's head-to-head commands read the legacy match tables.
        const existing = await this._findExistingDoublesMirror(transaction, match, participants);
        if (existing) {
            return { legacyMultiMatchId: existing };
        }

        const team1 = participants.filter(row => Number(row.TeamNumber) === 1);
        const team2 = participants.filter(row => Number(row.TeamNumber) === 2);
        const score = buildScore(match.Team1Score, match.Team2Score);
        const team1MatchScore = buildMatchScore(match.Team1Score, match.Team2Score);
        const team2MatchScore = Math.abs(team1MatchScore - 1.0);
        const channel = buildLegacyChannel(match);

        const result = await runRequest(
            transaction,
            `DECLARE @p1Elo NUMERIC(19,9) = 1000;
             DECLARE @p2Elo NUMERIC(19,9) = 1000;
             DECLARE @p5Elo NUMERIC(19,9) = 1000;
             DECLARE @p6Elo NUMERIC(19,9) = 1000;
             DECLARE @Inserted TABLE (LegacyMultiMatchId INT);

             SELECT @p1Elo = COALESCE(Elo2, 1000) FROM dbo.PlayerStats WHERE Player = @player1 AND GameType = @gameId;
             SELECT @p2Elo = COALESCE(Elo2, 1000) FROM dbo.PlayerStats WHERE Player = @player2 AND GameType = @gameId;
             SELECT @p5Elo = COALESCE(Elo2, 1000) FROM dbo.PlayerStats WHERE Player = @player5 AND GameType = @gameId;
             SELECT @p6Elo = COALESCE(Elo2, 1000) FROM dbo.PlayerStats WHERE Player = @player6 AND GameType = @gameId;

             INSERT INTO dbo.MultiMatch (
                GameType, Player1, Player2, Player5, Player6, Score,
                Team1Wins, Team1Losses, MatchDate, Team1MatchScore, Team2MatchScore,
                Tournament, Stage, FutureMatch, Channel, ServerID,
                P1EloPre, P2EloPre, P5EloPre, P6EloPre,
                P1EloPost, P2EloPost, P5EloPost, P6EloPost
             )
             OUTPUT INSERTED.ID INTO @Inserted
             VALUES (
                @gameId, @player1, @player2, @player5, @player6, @score,
                @team1Score, @team2Score, @matchDate, @team1MatchScore, @team2MatchScore,
                @tournament, @stage, 0, @channel, @serverId,
                @p1Elo, @p2Elo, @p5Elo, @p6Elo,
                @p1Elo, @p2Elo, @p5Elo, @p6Elo
             );

             SELECT TOP 1 LegacyMultiMatchId FROM @Inserted`,
            {
                gameId: match.GameId,
                player1: team1[0].PlayerId,
                player2: team1[1].PlayerId,
                player5: team2[0].PlayerId,
                player6: team2[1].PlayerId,
                score,
                team1Score: match.Team1Score,
                team2Score: match.Team2Score,
                matchDate: match.CompletedAtUtc,
                team1MatchScore,
                team2MatchScore,
                tournament: 'Competitive Rated',
                stage: `${match.GameCode} ${match.ModeCode} #${match.MatchNumber}`,
                channel,
                serverId: match.GuildId ?? ''
            }
        );

        return { legacyMultiMatchId: result.recordset[0]?.LegacyMultiMatchId };
    }

    async _findExistingDoublesMirror(transaction, match, participants) {
        const team1 = participants.filter(row => Number(row.TeamNumber) === 1);
        const team2 = participants.filter(row => Number(row.TeamNumber) === 2);
        const result = await runRequest(
            transaction,
            `SELECT TOP 1 ID AS LegacyMultiMatchId
             FROM dbo.MultiMatch WITH (UPDLOCK, HOLDLOCK)
             WHERE GameType = @gameId
               AND Player1 = @player1
               AND Player2 = @player2
               AND Player5 = @player5
               AND Player6 = @player6
               AND MatchDate = @matchDate
               AND Channel = @channel
             ORDER BY ID DESC`,
            {
                gameId: match.GameId,
                player1: team1[0].PlayerId,
                player2: team1[1].PlayerId,
                player5: team2[0].PlayerId,
                player6: team2[1].PlayerId,
                matchDate: match.CompletedAtUtc,
                channel: buildLegacyChannel(match)
            }
        );
        return result.recordset[0]?.LegacyMultiMatchId ?? null;
    }

    async _markSynced(transaction, { syncId, legacyMatchId, legacyMultiMatchId }) {
        const result = await runRequest(
            transaction,
            `UPDATE ${T.whrSync}
             SET SyncStatus = 'synced',
                 LegacyMatchId = COALESCE(@legacyMatchId, LegacyMatchId),
                 LegacyMultiMatchId = COALESCE(@legacyMultiMatchId, LegacyMultiMatchId),
                 WhrRunnerStatus = 'pending_external_runner',
                 WhrRunnerRequestedAtUtc = SYSUTCDATETIME(),
                 SyncedAtUtc = COALESCE(SyncedAtUtc, SYSUTCDATETIME()),
                 LastAttemptAtUtc = SYSUTCDATETIME(),
                 AttemptCount = AttemptCount + 1,
                 LastError = NULL,
                 UpdatedAtUtc = SYSUTCDATETIME()
             OUTPUT INSERTED.*
             WHERE Id = @syncId`,
            { syncId, legacyMatchId, legacyMultiMatchId }
        );
        return result.recordset[0];
    }

    async _markFailed(ratedMatchId, error) {
        await executeQuery(
            `IF OBJECT_ID(N'${T.whrSync}', 'U') IS NOT NULL
             BEGIN
                 MERGE ${T.whrSync} AS target
                 USING (
                     SELECT Id, SeasonId, GameId, ModeCode, MatchNumber
                     FROM ${T.ratedMatch}
                     WHERE Id = @ratedMatchId
                 ) AS source
                 ON target.RatedMatchId = source.Id
                 WHEN MATCHED THEN
                     UPDATE SET SyncStatus = 'failed',
                                LastAttemptAtUtc = SYSUTCDATETIME(),
                                AttemptCount = target.AttemptCount + 1,
                                LastError = @lastError,
                                UpdatedAtUtc = SYSUTCDATETIME()
                 WHEN NOT MATCHED BY TARGET THEN
                     INSERT (
                        RatedMatchId, SeasonId, GameId, ModeCode, MatchNumber,
                        SyncStatus, LastAttemptAtUtc, AttemptCount, LastError
                     )
                     VALUES (
                        source.Id, source.SeasonId, source.GameId, source.ModeCode, source.MatchNumber,
                        'failed', SYSUTCDATETIME(), 1, @lastError
                     );
             END`,
            {
                ratedMatchId,
                lastError: String(error?.message ?? error ?? 'Unknown WHR/TST sync failure').slice(0, 1000)
            }
        );
    }
}

module.exports = CompetitiveWhrSyncDao;
