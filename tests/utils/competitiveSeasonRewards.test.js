const {
    SEASON_REWARD_REQUIRED_WINS,
    advanceRewardProgress,
    createInitialRewardProgress,
    getRewardTierForRank,
    shouldCountRewardWin
} = require('../../src/utils/competitiveSeasonRewards');

const thresholds = [
    { RankNumber: 0, Tier: 'Unranked' },
    { RankNumber: 1, Tier: 'Bronze' },
    { RankNumber: 4, Tier: 'Silver' },
    { RankNumber: 7, Tier: 'Gold' },
    { RankNumber: 10, Tier: 'Platinum' },
    { RankNumber: 13, Tier: 'Diamond' },
    { RankNumber: 16, Tier: 'Master' },
    { RankNumber: 19, Tier: 'Titan' }
];

function applyWins(progress, tierOrder, count) {
    let state = progress;
    let earned = [];
    for (let i = 0; i < count; i += 1) {
        const result = advanceRewardProgress(state, tierOrder);
        state = result.progress;
        if (result.earnedTier) {
            earned.push(result.earnedTier.tier);
        }
    }
    return { progress: state, earned };
}

describe('competitive season rewards', () => {
    it('maps exact rank numbers to major reward tiers', () => {
        expect(getRewardTierForRank(0, thresholds)).toBeNull();
        expect(getRewardTierForRank(1, thresholds).tier).toBe('Bronze');
        expect(getRewardTierForRank(4, thresholds).tier).toBe('Silver');
        expect(getRewardTierForRank(16, thresholds).tier).toBe('Master');
        expect(getRewardTierForRank(19, thresholds).tier).toBe('Strikers Titan');
    });

    it('requires sequential reward unlocks even for a high ranked player', () => {
        const result = applyWins(createInitialRewardProgress(), 6, SEASON_REWARD_REQUIRED_WINS);

        expect(result.earned).toEqual(['Bronze']);
        expect(result.progress.highestEarnedTier).toBe('Bronze');
        expect(result.progress.currentTargetTier).toBe('Silver');
        expect(result.progress.currentTargetWins).toBe(0);
    });

    it('requires 35 qualifying titan wins to unlock titan from zero progress', () => {
        let state = createInitialRewardProgress();
        const earned = [];

        for (let i = 0; i < SEASON_REWARD_REQUIRED_WINS * 7; i += 1) {
            const result = advanceRewardProgress(state, 7);
            state = result.progress;
            if (result.earnedTier) {
                earned.push(result.earnedTier.tier);
            }
        }

        expect(earned).toEqual([
            'Bronze',
            'Silver',
            'Gold',
            'Platinum',
            'Diamond',
            'Master',
            'Strikers Titan'
        ]);
        expect(state.currentTargetTier).toBeNull();
        expect(state.highestEarnedTier).toBe('Strikers Titan');
    });

    it('does not count placement wins or wins below the current target tier', () => {
        expect(shouldCountRewardWin({ outcome: 'win', placementBefore: 4 })).toBe(false);
        expect(shouldCountRewardWin({ outcome: 'win', placementBefore: 5 })).toBe(true);

        const bronzeComplete = applyWins(createInitialRewardProgress(), 1, SEASON_REWARD_REQUIRED_WINS).progress;
        const silverAttempt = advanceRewardProgress(bronzeComplete, 1);

        expect(silverAttempt.counted).toBe(false);
        expect(silverAttempt.progress.currentTargetTier).toBe('Silver');
        expect(silverAttempt.progress.currentTargetWins).toBe(0);
    });

    it('counts a promotion win by rankAfter for the current target tier', () => {
        const bronzeComplete = applyWins(createInitialRewardProgress(), 1, SEASON_REWARD_REQUIRED_WINS).progress;
        const silverProgress = advanceRewardProgress(bronzeComplete, 2);

        expect(silverProgress.counted).toBe(true);
        expect(silverProgress.progress.currentTargetTier).toBe('Silver');
        expect(silverProgress.progress.currentTargetWins).toBe(1);
    });
});
