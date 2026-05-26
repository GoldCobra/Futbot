const { parseActionTokenFromCustomId } = require('./customIds');

function requiresSetup(gameType) {
    return gameType === 'MSC' || gameType === 'SMS';
}

function getNextGameNumber(match) {
    return match.score.team1 + match.score.team2 + (match.stage === 'complete' ? 0 : 1);
}

function getPendingResultWinnerTeam(match) {
    const loserTeamIndex = match?.pendingResult?.loserTeamIndex ?? match?.loserTeamIndex;
    if (!loserTeamIndex) {
        return null;
    }

    return match.teams[loserTeamIndex === 1 ? 1 : 0];
}

function getPendingResultGameNumber(match) {
    return match?.pendingResult?.gameNumber ?? match?.pendingResultGameNumber;
}

function getPendingResultLoserTeamIndex(match) {
    return match?.pendingResult?.loserTeamIndex ?? match?.loserTeamIndex;
}

function getPendingResultWinnerMention(match, describeTeam) {
    if (match?.pendingResult?.winnerMention) {
        return match.pendingResult.winnerMention;
    }

    const winnerTeam = getPendingResultWinnerTeam(match);
    return winnerTeam && describeTeam ? describeTeam(winnerTeam) : 'The winner';
}

function getMatchActionToken(match, gameNumber = getNextGameNumber(match)) {
    return `${gameNumber}.${match?.controlVersion ?? 0}`;
}

function matchActionTokenMatches(match, customId, gameNumber = getNextGameNumber(match)) {
    const token = parseActionTokenFromCustomId(customId);
    if (token == null) {
        return true;
    }

    return String(token) === String(getMatchActionToken(match, gameNumber))
        || String(token) === String(gameNumber);
}

function setPendingResult(match, {
    gameNumber,
    winnerTeamIndex,
    winnerMention,
    loserTeamIndex,
    reporterDiscordId = null,
    homeTeamNumber = null,
    stadiumCode = null,
    captainCode = null
}) {
    const loserTeam = match.teams[loserTeamIndex - 1];
    match.pendingResult = {
        gameNumber,
        winnerTeamIndex,
        winnerMention,
        loserTeamIndex,
        loserRepMention: loserTeam?.repMention ?? null,
        reporterDiscordId,
        homeTeamNumber,
        stadiumCode,
        captainCode
    };
    match.pendingResultGameNumber = gameNumber;
    match.loserTeamIndex = loserTeamIndex;
    match.loserRepMention = loserTeam?.repMention ?? null;
}

function clearPendingResult(match) {
    match.pendingResult = null;
    match.pendingResultGameNumber = null;
    match.loserTeamIndex = null;
    match.loserRepMention = null;
}

function rememberPrivateDeliveryInteraction(match, interaction) {
    if (!match || !interaction?.user?.id) {
        return;
    }

    if (!match.privateDeliveryInteractionsByUserId) {
        match.privateDeliveryInteractionsByUserId = new Map();
    }
    match.privateDeliveryInteractionsByUserId.set(interaction.user.id, interaction);
}

function getPrivateDeliveryInteraction(match, userId) {
    return match?.privateDeliveryInteractionsByUserId?.get(userId)
        ?? match?.notificationInteractions?.get?.(userId)
        ?? null;
}

module.exports = {
    clearPendingResult,
    getMatchActionToken,
    getNextGameNumber,
    getPendingResultGameNumber,
    getPendingResultLoserTeamIndex,
    getPendingResultWinnerMention,
    getPendingResultWinnerTeam,
    getPrivateDeliveryInteraction,
    matchActionTokenMatches,
    rememberPrivateDeliveryInteraction,
    requiresSetup,
    setPendingResult
};
