const { executeQuery, getPool, sql } = require('../sqlClient');
const { competitiveTable } = require('../../utils/competitiveConstants');

const T = {
    game: competitiveTable('CompetitiveGame'),
    ratedMatch: competitiveTable('RatedMatch'),
    ratedParticipant: competitiveTable('RatedMatchParticipant'),
    ratedGame: competitiveTable('RatedMatchGame'),
    matchSequence: competitiveTable('CompetitiveMatchSequence'),
    seasonMatchSequence: competitiveTable('CompetitiveSeasonMatchSequence')
};

function bindInputs(request, inputs = {}) {
    for (const [key, value] of Object.entries(inputs)) {
        request.input(key, value);
    }
    return request;
}

async function runRequest(runner, query, inputs = {}) {
    const request = bindInputs(runner.request(), inputs);
    return request.query(query);
}

class RatedMatchDao {
    async _getPlayerId(discordId, runner = null) {
        const query = 'SELECT Id FROM dbo.Player WHERE DiscordID = @discordId';
        const params = { discordId };
        const result = runner
            ? await runRequest(runner, query, params)
            : await executeQuery(query, params);
        return result.recordset[0]?.Id ?? null;
    }

    async _getParticipantId(matchId, discordId) {
        if (!matchId || !discordId) return null;
        const result = await executeQuery(
            `SELECT TOP 1 Id
             FROM ${T.ratedParticipant}
             WHERE RatedMatchId = @matchId AND DiscordId = @discordId`,
            { matchId, discordId }
        );
        return result.recordset[0]?.Id ?? null;
    }

    async createMatchHeader({
        matchCode,
        gameId,
        modeCode,
        firstTo,
        seasonId,
        homeTeamNumber,
        awayTeamNumber,
        guildId
    }) {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            const existing = await runRequest(
                transaction,
                `SELECT TOP 1 Id, MatchNumber, SeasonMatchNumber
                 FROM ${T.ratedMatch}
                 WHERE MatchCode = @matchCode`,
                { matchCode }
            );
            if (existing.recordset[0]) {
                await transaction.commit();
                return {
                    id: existing.recordset[0].Id,
                    matchNumber: existing.recordset[0].MatchNumber,
                    seasonMatchNumber: existing.recordset[0].SeasonMatchNumber,
                    seasonId
                };
            }

            const matchNumberResult = await runRequest(
                transaction,
                `
                DECLARE @MatchNumber INT;

                UPDATE ${T.matchSequence} WITH (UPDLOCK, HOLDLOCK)
                SET @MatchNumber = NextMatchNumber,
                    NextMatchNumber = NextMatchNumber + 1,
                    UpdatedAtUtc = SYSUTCDATETIME()
                WHERE GameId = @gameId AND ModeCode = @modeCode;

                IF @MatchNumber IS NULL
                BEGIN
                    INSERT INTO ${T.matchSequence} (GameId, ModeCode, NextMatchNumber)
                    VALUES (@gameId, @modeCode, 2);
                    SET @MatchNumber = 1;
                END

                SELECT @MatchNumber AS MatchNumber;
                `,
                { gameId, modeCode }
            );

            const seasonMatchNumberResult = await runRequest(
                transaction,
                `
                DECLARE @SeasonMatchNumber INT;

                UPDATE ${T.seasonMatchSequence} WITH (UPDLOCK, HOLDLOCK)
                SET @SeasonMatchNumber = NextSeasonMatchNumber,
                    NextSeasonMatchNumber = NextSeasonMatchNumber + 1,
                    UpdatedAtUtc = SYSUTCDATETIME()
                WHERE SeasonId = @seasonId AND GameId = @gameId AND ModeCode = @modeCode;

                IF @SeasonMatchNumber IS NULL
                BEGIN
                    INSERT INTO ${T.seasonMatchSequence} (SeasonId, GameId, ModeCode, NextSeasonMatchNumber)
                    VALUES (@seasonId, @gameId, @modeCode, 2);
                    SET @SeasonMatchNumber = 1;
                END

                SELECT @SeasonMatchNumber AS SeasonMatchNumber;
                `,
                { seasonId, gameId, modeCode }
            );

            const matchNumber = matchNumberResult.recordset[0]?.MatchNumber;
            const seasonMatchNumber = seasonMatchNumberResult.recordset[0]?.SeasonMatchNumber;
            if (!matchNumber || !seasonMatchNumber) {
                throw new Error(`Failed to allocate match number for ${matchCode}`);
            }

            const insertResult = await runRequest(
                transaction,
                `INSERT INTO ${T.ratedMatch} (
                    MatchCode, GameId, ModeCode, MatchNumber, SeasonId, SeasonMatchNumber,
                    FirstTo, Status, HomeTeamNumber, AwayTeamNumber, GuildId
                 )
                 OUTPUT INSERTED.Id
                 VALUES (
                    @matchCode, @gameId, @modeCode, @matchNumber, @seasonId, @seasonMatchNumber,
                    @firstTo, 'creating', @homeTeamNumber, @awayTeamNumber, @guildId
                 )`,
                {
                    matchCode,
                    gameId,
                    modeCode,
                    matchNumber,
                    seasonId,
                    seasonMatchNumber,
                    firstTo,
                    homeTeamNumber,
                    awayTeamNumber,
                    guildId: guildId ?? null
                }
            );

            const matchId = insertResult.recordset[0]?.Id;
            if (!matchId) {
                throw new Error(`RatedMatch header insert did not return an Id for ${matchCode}`);
            }

            await transaction.commit();
            return {
                id: matchId,
                matchNumber,
                seasonMatchNumber,
                seasonId
            };
        } catch (err) {
            await transaction.rollback().catch(() => {});
            throw err;
        }
    }

    async activateMatch({
        matchId,
        panelChannelId,
        threadId,
        threadUrl,
        participants
    }) {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

        try {
            await runRequest(
                transaction,
                `UPDATE ${T.ratedMatch}
                 SET Status = 'active',
                     PanelChannelId = @panelChannelId,
                     ThreadId = @threadId,
                     ThreadUrl = @threadUrl,
                     ActivatedAtUtc = SYSUTCDATETIME(),
                     CancelledAtUtc = NULL,
                     CancelReason = NULL
                 WHERE Id = @matchId`,
                {
                    matchId,
                    panelChannelId: panelChannelId ?? null,
                    threadId: threadId ?? null,
                    threadUrl: threadUrl ?? null
                }
            );

            const insertedParticipants = [];
            for (const participant of participants) {
                const playerId = participant.playerId
                    ?? await this._getPlayerId(participant.discordId, transaction);
                if (!playerId) {
                    throw new Error(`No Player row found for Discord ID ${participant.discordId}`);
                }

                const inserted = await runRequest(
                    transaction,
                    `INSERT INTO ${T.ratedParticipant} (
                        RatedMatchId, PlayerId, DiscordId, TeamNumber, IsRepresentative
                     )
                     OUTPUT INSERTED.Id, INSERTED.PlayerId, INSERTED.DiscordId, INSERTED.TeamNumber, INSERTED.IsRepresentative
                     VALUES (
                        @matchId, @playerId, @discordId, @teamNumber, @isRepresentative
                     )`,
                    {
                        matchId,
                        playerId,
                        discordId: participant.discordId,
                        teamNumber: participant.teamNumber,
                        isRepresentative: participant.isRepresentative ? 1 : 0
                    }
                );
                if (inserted.recordset[0]) {
                    insertedParticipants.push(inserted.recordset[0]);
                }
            }

            await transaction.commit();
            return insertedParticipants;
        } catch (err) {
            await transaction.rollback().catch(() => {});
            throw err;
        }
    }

    async createMatch({
        matchCode,
        gameType,
        gameId,
        mode,
        modeCode,
        firstTo,
        seasonId,
        homeTeamNumber,
        awayTeamNumber,
        participants,
        guildId,
        panelChannelId,
        threadId,
        threadUrl
    }) {
        const header = await this.createMatchHeader({
            matchCode,
            gameId: gameId ?? gameType,
            modeCode: modeCode ?? mode,
            firstTo,
            seasonId,
            homeTeamNumber,
            awayTeamNumber,
            guildId
        });
        await this.activateMatch({
            matchId: header.id,
            panelChannelId,
            threadId,
            threadUrl,
            participants
        });
        return header.id;
    }

    async recordGame({
        matchId,
        gameNumber,
        winnerTeamNumber,
        homeTeamNumber,
        stadiumCode,
        captainCode,
        reportedByParticipantId = null,
        confirmedByParticipantId = null,
        reportedByDiscordId,
        confirmedByDiscordId
    }) {
        const [resolvedReportedByParticipantId, resolvedConfirmedByParticipantId] = await Promise.all([
            reportedByParticipantId != null
                ? reportedByParticipantId
                : this._getParticipantId(matchId, reportedByDiscordId),
            confirmedByParticipantId != null
                ? confirmedByParticipantId
                : this._getParticipantId(matchId, confirmedByDiscordId)
        ]);

        await executeQuery(
            `INSERT INTO ${T.ratedGame} (
                RatedMatchId, GameNumber, WinnerTeamNumber, HomeTeamNumber,
                StadiumCode, CaptainCode, ReportedByParticipantId, ConfirmedByParticipantId,
                ReportedAtUtc, ConfirmedAtUtc
             )
             VALUES (
                @matchId, @gameNumber, @winnerTeamNumber, @homeTeamNumber,
                @stadiumCode, @captainCode, @reportedByParticipantId, @confirmedByParticipantId,
                SYSUTCDATETIME(), SYSUTCDATETIME()
             )`,
            {
                matchId,
                gameNumber,
                winnerTeamNumber,
                homeTeamNumber,
                stadiumCode: stadiumCode ?? null,
                captainCode: captainCode ?? null,
                reportedByParticipantId: resolvedReportedByParticipantId ?? null,
                confirmedByParticipantId: resolvedConfirmedByParticipantId ?? null
            }
        );
    }

    async completeMatch({ matchCode, team1Score, team2Score, winnerTeamNumber, homeTeamNumber, awayTeamNumber }) {
        await executeQuery(
            `UPDATE ${T.ratedMatch}
             SET Status = 'completed',
                 Team1Score = @team1Score,
                 Team2Score = @team2Score,
                 WinnerTeamNumber = @winnerTeamNumber,
                 HomeTeamNumber = @homeTeamNumber,
                 AwayTeamNumber = @awayTeamNumber,
                 CompletedAtUtc = SYSUTCDATETIME(),
                 CancelledAtUtc = NULL,
                 CancelReason = NULL
             WHERE MatchCode = @matchCode`,
            { matchCode, team1Score, team2Score, winnerTeamNumber, homeTeamNumber, awayTeamNumber }
        );
    }

    async cancelMatch({ matchCode, cancelReason }) {
        await executeQuery(
            `UPDATE ${T.ratedMatch}
             SET Status = 'cancelled',
                 CancelReason = @cancelReason,
                 CancelledAtUtc = SYSUTCDATETIME()
             WHERE MatchCode = @matchCode AND Status <> 'completed'`,
            { matchCode, cancelReason: cancelReason ?? null }
        );
    }

    async cancelMatchById({ matchId, cancelReason }) {
        await executeQuery(
            `UPDATE ${T.ratedMatch}
             SET Status = 'cancelled',
                 CancelReason = @cancelReason,
                 CancelledAtUtc = SYSUTCDATETIME()
             WHERE Id = @matchId AND Status <> 'completed'`,
            { matchId, cancelReason: cancelReason ?? null }
        );
    }

    async getPendingCompletedThreadFinalizations() {
        const result = await executeQuery(
            `SELECT TOP 100
                    rm.Id,
                    rm.MatchCode,
                    rm.GameId,
                    game.Code AS GameType,
                    rm.ModeCode,
                    rm.MatchNumber,
                    rm.SeasonMatchNumber,
                    rm.ThreadId,
                    rm.ThreadUrl,
                    rm.Team1Score,
                    rm.Team2Score,
                    rm.CompletedAtUtc,
                    rm.ThreadFinalizeAttemptCount,
                    rm.ThreadFinalizeLastAttemptAtUtc,
                    rm.ThreadFinalizeLastError
             FROM ${T.ratedMatch} rm
             INNER JOIN ${T.game} game
                ON rm.GameId = game.Id
             WHERE rm.Status = 'completed'
               AND rm.ThreadId IS NOT NULL
               AND rm.CompletedAtUtc IS NOT NULL
               AND rm.ThreadFinalizedAtUtc IS NULL
             ORDER BY rm.CompletedAtUtc ASC`
        );
        return result.recordset;
    }

    async markThreadFinalizationSucceeded({ ratedMatchId }) {
        if (!ratedMatchId) return;
        await executeQuery(
            `UPDATE ${T.ratedMatch}
             SET ThreadFinalizedAtUtc = COALESCE(ThreadFinalizedAtUtc, SYSUTCDATETIME()),
                 ThreadFinalizeLastAttemptAtUtc = SYSUTCDATETIME(),
                 ThreadFinalizeAttemptCount = ThreadFinalizeAttemptCount + 1,
                 ThreadFinalizeLastError = NULL
             WHERE Id = @ratedMatchId`,
            { ratedMatchId }
        );
    }

    async markThreadFinalizationFailed({ ratedMatchId, error }) {
        if (!ratedMatchId) return;
        await executeQuery(
            `UPDATE ${T.ratedMatch}
             SET ThreadFinalizeLastAttemptAtUtc = SYSUTCDATETIME(),
                 ThreadFinalizeAttemptCount = ThreadFinalizeAttemptCount + 1,
                 ThreadFinalizeLastError = @error
             WHERE Id = @ratedMatchId
               AND ThreadFinalizedAtUtc IS NULL`,
            {
                ratedMatchId,
                error: String(error ?? 'Unknown thread finalization failure').slice(0, 1000)
            }
        );
    }
}

module.exports = RatedMatchDao;
