const { CONFIG } = require('./constants');

function joinParts(parts) {
    return parts.filter(part => part != null).join(':');
}

function panelJoinCustomId(channelId, mode) {
    return `${CONFIG.PREFIX}:join:${channelId}:${mode}`;
}

function cancelSearchCustomId(searchId) {
    return `${CONFIG.PREFIX}:search:cancel:${searchId}`;
}

function extendSearchCustomId(searchId, durationMinutes, token = null) {
    return joinParts([CONFIG.PREFIX, 'search', 'extend', searchId, durationMinutes, token]);
}

function stadiumButtonCustomId(matchId, optionValue, gameNumber = null) {
    return joinParts([CONFIG.PREFIX, 'match', 'stadium', matchId, encodeURIComponent(String(optionValue)), gameNumber]);
}

function captainButtonCustomId(matchId, optionValue, gameNumber = null) {
    return joinParts([CONFIG.PREFIX, 'match', 'captain', matchId, encodeURIComponent(String(optionValue)), gameNumber]);
}

function winnerButtonCustomId(matchId, gameNumber = null) {
    return joinParts([CONFIG.PREFIX, 'match', 'winner', matchId, gameNumber]);
}

function loserConfirmCustomId(matchId, gameNumber = null) {
    return joinParts([CONFIG.PREFIX, 'match', 'loser_confirm', matchId, gameNumber]);
}

function loserAdvantageCustomId(matchId, choice, gameNumber = null) {
    return joinParts([CONFIG.PREFIX, 'match', 'loser_advantage', matchId, choice, gameNumber]);
}

function reportIssueCustomId(matchId) {
    return `${CONFIG.PREFIX}:match:report_issue:${matchId}`;
}

function startSetupCustomId(matchId, gameNumber = null) {
    return joinParts([CONFIG.PREFIX, 'match', 'start', matchId, gameNumber]);
}

function parseChannelIdFromCustomId(customId) {
    return customId.split(':')[3];
}

function parseModeFromCustomId(customId) {
    return customId.split(':')[4];
}

function parseIdFromCustomId(customId) {
    return customId.split(':')[4];
}

function parseOptionValueFromCustomId(customId) {
    const encodedValue = customId.split(':')[5];
    return decodeURIComponent(encodedValue ?? '');
}

function parseLoserChoiceFromCustomId(customId) {
    return customId.split(':')[5];
}

function parseActionTokenFromCustomId(customId) {
    const parts = customId.split(':');
    if (parts[2] === 'match') {
        if (['stadium', 'captain', 'loser_advantage'].includes(parts[3])) {
            return parts[6] ?? null;
        }
        return parts[5] ?? null;
    }
    if (parts[2] === 'search' && parts[3] === 'extend') {
        return parts[6] ?? null;
    }

    return null;
}

function actionTokenMatches(customId, expectedToken) {
    const token = parseActionTokenFromCustomId(customId);
    return token == null || expectedToken == null || String(token) === String(expectedToken);
}

module.exports = {
    actionTokenMatches,
    cancelSearchCustomId,
    captainButtonCustomId,
    extendSearchCustomId,
    loserAdvantageCustomId,
    loserConfirmCustomId,
    panelJoinCustomId,
    parseActionTokenFromCustomId,
    parseChannelIdFromCustomId,
    parseIdFromCustomId,
    parseLoserChoiceFromCustomId,
    parseModeFromCustomId,
    parseOptionValueFromCustomId,
    reportIssueCustomId,
    stadiumButtonCustomId,
    startSetupCustomId,
    winnerButtonCustomId
};
