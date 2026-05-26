const { PLACEMENT_GAMES_REQUIRED } = require('./competitiveConstants');

const SEASON_REWARD_REQUIRED_WINS = 5;

const SEASON_REWARD_TIERS = Object.freeze([
    { order: 1, tier: 'Bronze', thresholdTiers: ['Bronze'] },
    { order: 2, tier: 'Silver', thresholdTiers: ['Silver'] },
    { order: 3, tier: 'Gold', thresholdTiers: ['Gold'] },
    { order: 4, tier: 'Platinum', thresholdTiers: ['Platinum'] },
    { order: 5, tier: 'Diamond', thresholdTiers: ['Diamond'] },
    { order: 6, tier: 'Master', thresholdTiers: ['Master'] },
    { order: 7, tier: 'Strikers Titan', thresholdTiers: ['Titan', 'Strikers Titan'] }
]);

const REWARD_TIER_BY_ORDER = new Map(SEASON_REWARD_TIERS.map(tier => [tier.order, tier]));
const REWARD_ORDER_BY_TIER = new Map(
    SEASON_REWARD_TIERS.flatMap(tier => [
        [tier.tier.toLowerCase(), tier.order],
        ...tier.thresholdTiers.map(thresholdTier => [thresholdTier.toLowerCase(), tier.order])
    ])
);

function getRewardTierByOrder(order) {
    return REWARD_TIER_BY_ORDER.get(Number(order)) ?? null;
}

function getRewardOrderForTier(tier) {
    if (!tier) return null;
    return REWARD_ORDER_BY_TIER.get(String(tier).toLowerCase()) ?? null;
}

function getRewardTierForRank(rankNumber, thresholds) {
    const rank = thresholds.find(row => Number(row.RankNumber) === Number(rankNumber));
    const order = getRewardOrderForTier(rank?.Tier);
    return order ? getRewardTierByOrder(order) : null;
}

function createInitialRewardProgress() {
    const firstTier = getRewardTierByOrder(1);
    return {
        highestEarnedTier: null,
        highestEarnedTierOrder: 0,
        currentTargetTier: firstTier.tier,
        currentTargetTierOrder: firstTier.order,
        currentTargetWins: 0,
        requiredWins: SEASON_REWARD_REQUIRED_WINS
    };
}

function normalizeRewardProgress(progress) {
    if (!progress) return createInitialRewardProgress();
    const highestEarnedTierOrder = Number(progress.HighestEarnedTierOrder ?? progress.highestEarnedTierOrder ?? 0);
    const currentTargetTierOrder = progress.CurrentTargetTierOrder ?? progress.currentTargetTierOrder;
    return {
        highestEarnedTier: progress.HighestEarnedTier ?? progress.highestEarnedTier ?? null,
        highestEarnedTierOrder: Number.isFinite(highestEarnedTierOrder) ? highestEarnedTierOrder : 0,
        currentTargetTier: progress.CurrentTargetTier ?? progress.currentTargetTier ?? null,
        currentTargetTierOrder: currentTargetTierOrder == null ? null : Number(currentTargetTierOrder),
        currentTargetWins: Number(progress.CurrentTargetWins ?? progress.currentTargetWins ?? 0),
        requiredWins: Number(progress.RequiredWins ?? progress.requiredWins ?? SEASON_REWARD_REQUIRED_WINS)
    };
}

function shouldEnsureRewardProgress(change) {
    return Number(change.PlacementAfter ?? change.placementAfter ?? 0) >= PLACEMENT_GAMES_REQUIRED;
}

function shouldCountRewardWin(change) {
    return String(change.Outcome ?? change.outcome ?? '').toLowerCase() === 'win'
        && Number(change.PlacementBefore ?? change.placementBefore ?? 0) >= PLACEMENT_GAMES_REQUIRED;
}

function advanceRewardProgress(progress, qualifyingTierOrder) {
    const state = normalizeRewardProgress(progress);
    const rankOrder = Number(qualifyingTierOrder);
    if (!state.currentTargetTierOrder || !Number.isFinite(rankOrder) || rankOrder < state.currentTargetTierOrder) {
        return { progress: state, earnedTier: null, counted: false };
    }

    const currentTarget = getRewardTierByOrder(state.currentTargetTierOrder);
    const nextWins = state.currentTargetWins + 1;
    if (nextWins < state.requiredWins) {
        return {
            progress: {
                ...state,
                currentTargetWins: nextWins
            },
            earnedTier: null,
            counted: true
        };
    }

    const nextTarget = getRewardTierByOrder(state.currentTargetTierOrder + 1);
    return {
        progress: {
            highestEarnedTier: currentTarget.tier,
            highestEarnedTierOrder: currentTarget.order,
            currentTargetTier: nextTarget?.tier ?? null,
            currentTargetTierOrder: nextTarget?.order ?? null,
            currentTargetWins: 0,
            requiredWins: state.requiredWins
        },
        earnedTier: currentTarget,
        counted: true
    };
}

module.exports = {
    SEASON_REWARD_REQUIRED_WINS,
    SEASON_REWARD_TIERS,
    getRewardTierByOrder,
    getRewardOrderForTier,
    getRewardTierForRank,
    createInitialRewardProgress,
    normalizeRewardProgress,
    shouldEnsureRewardProgress,
    shouldCountRewardWin,
    advanceRewardProgress
};
