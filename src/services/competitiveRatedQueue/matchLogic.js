function computeFirstTo(minBestOf, maxBestOf, opponentMinBestOf, opponentMaxBestOf) {
    if ([minBestOf, maxBestOf, opponentMinBestOf, opponentMaxBestOf].some(value => value == null)) {
        return 2;
    }

    return Math.ceil(Math.min(maxBestOf, opponentMaxBestOf) / 2);
}

function rangesOverlap(leftMin, leftMax, rightMin, rightMax) {
    return Math.max(leftMin, rightMin) <= Math.min(leftMax, rightMax);
}

function areSinglesSearchesCompatible(leftSearch, rightSearch) {
    if (!rangesOverlap(
        leftSearch.options.minBestOf,
        leftSearch.options.maxBestOf,
        rightSearch.options.minBestOf,
        rightSearch.options.maxBestOf
    )) {
        return false;
    }

    const ratingDifference = Math.abs(leftSearch.ratingProfile.elo - rightSearch.ratingProfile.elo);
    if (leftSearch.options.threshold != null && ratingDifference > leftSearch.options.threshold) {
        return false;
    }
    if (rightSearch.options.threshold != null && ratingDifference > rightSearch.options.threshold) {
        return false;
    }

    return true;
}

function applyLoserChoice(homeTeamIndex, loserTeamIndex, choice) {
    if (choice === 'home') {
        return {
            homeTeamIndex: loserTeamIndex,
            awayTeamIndex: loserTeamIndex === 1 ? 2 : 1
        };
    }

    return {
        homeTeamIndex: loserTeamIndex === 1 ? 2 : 1,
        awayTeamIndex: loserTeamIndex
    };
}

function buildBalancedDoublesTeams(searches) {
    const players = searches.map(search => ({
        search,
        rating: search.ratingProfile.ratingTs,
        clubId: search.ratingProfile.clubId
    }));

    const clubCounts = new Map();
    for (const player of players) {
        clubCounts.set(player.clubId, (clubCounts.get(player.clubId) ?? 0) + 1);
    }

    let oddsTeamPlayers = [];
    const duplicateClub = [...clubCounts.entries()].find(([, count]) => count > 1)?.[0] ?? null;
    if (duplicateClub !== null) {
        oddsTeamPlayers = players
            .filter(player => player.clubId === duplicateClub)
            .sort((left, right) => left.rating - right.rating)
            .slice(0, 2);
    } else {
        oddsTeamPlayers = getBestRatingBalancedDoublesTeam(players);
    }

    const oddsIds = new Set(oddsTeamPlayers.map(player => player.search.id));
    const evensTeamPlayers = players.filter(player => !oddsIds.has(player.search.id));

    const oddsSortedHighToLow = [...oddsTeamPlayers].sort((left, right) => right.rating - left.rating);
    const evensSortedHighToLow = [...evensTeamPlayers].sort((left, right) => right.rating - left.rating);

    return [
        [oddsSortedHighToLow[0].search, oddsSortedHighToLow[1].search],
        [evensSortedHighToLow[0].search, evensSortedHighToLow[1].search]
    ];
}

function comparePlayersByRatingDesc(left, right) {
    if (right.rating === left.rating) {
        return left.search.ratingProfile.playerId - right.search.ratingProfile.playerId;
    }
    return right.rating - left.rating;
}

function comparePlayersByStableId(left, right) {
    return left.search.ratingProfile.playerId - right.search.ratingProfile.playerId;
}

function sortTeamHighToLow(players) {
    return [...players].sort(comparePlayersByRatingDesc);
}

function getTeamRatingSum(players) {
    return players.reduce((total, player) => total + Number(player.rating), 0);
}

function getBestRatingBalancedDoublesTeam(players) {
    const byRating = [...players].sort(comparePlayersByRatingDesc);
    const topPlayer = byRating[0];
    const secondPlayer = byRating[1];
    const secondPlayerId = secondPlayer.search.id;
    const topPlayerTeamCandidates = byRating
        .slice(1)
        .filter(player => player.search.id !== secondPlayerId)
        .map(player => {
            const teamOne = sortTeamHighToLow([topPlayer, player]);
            const teamOneIds = new Set(teamOne.map(teamPlayer => teamPlayer.search.id));
            const teamTwo = sortTeamHighToLow(players.filter(teamPlayer => !teamOneIds.has(teamPlayer.search.id)));
            return {
                teamOne,
                difference: Math.abs(getTeamRatingSum(teamOne) - getTeamRatingSum(teamTwo)),
                secondPlayerRating: player.rating,
                secondPlayerId: player.search.ratingProfile.playerId
            };
        });

    topPlayerTeamCandidates.sort((left, right) => {
        if (left.difference !== right.difference) {
            return left.difference - right.difference;
        }
        if (left.secondPlayerRating !== right.secondPlayerRating) {
            return left.secondPlayerRating - right.secondPlayerRating;
        }
        return left.secondPlayerId - right.secondPlayerId;
    });

    return topPlayerTeamCandidates[0]?.teamOne
        ?? [...players].sort(comparePlayersByStableId).slice(0, 2);
}

function createTeam(searches, teamIndex) {
    const members = searches.map(search => ({
        id: search.userId,
        mention: search.mention,
        username: search.username,
        ratingProfile: {
            ...search.ratingProfile
        }
    }));

    return {
        teamIndex,
        members,
        memberIds: members.map(member => member.id),
        repUserId: members[0].id,
        repMention: members[0].mention
    };
}

function buildSinglesTeams(searches) {
    return [
        createTeam([searches[0]], 1),
        createTeam([searches[1]], 2)
    ];
}

function buildDoublesTeams(searches) {
    const [teamOneSearches, teamTwoSearches] = buildBalancedDoublesTeams(searches);
    return [
        createTeam(teamOneSearches, 1),
        createTeam(teamTwoSearches, 2)
    ];
}

module.exports = {
    applyLoserChoice,
    areSinglesSearchesCompatible,
    buildBalancedDoublesTeams,
    buildDoublesTeams,
    buildSinglesTeams,
    computeFirstTo
};
