const {
    ALLOWED_STAGE_TRANSITIONS,
    MATCH_STAGES,
    isAllowedStageTransition,
    isTerminalStage,
    transitionMatchStage
} = require('../../src/services/competitiveRatedQueue/matchTransitions');

describe('rated match stage transitions', () => {
    test.each([
        ['awaiting_start', 'awaiting_winner'],
        ['awaiting_start', 'cancelled'],
        ['awaiting_winner', 'awaiting_loser_confirmation'],
        ['awaiting_winner', 'cancelled'],
        ['awaiting_loser_confirmation', 'awaiting_start'],
        ['awaiting_loser_confirmation', 'awaiting_winner'],
        ['awaiting_loser_confirmation', 'complete'],
        ['awaiting_loser_confirmation', 'cancelled'],
        ['awaiting_winner', 'awaiting_winner']
    ])('allows %s -> %s', (from, to) => {
        expect(isAllowedStageTransition(from, to)).toBe(true);
    });

    test.each([
        ['awaiting_winner', 'complete'],
        ['awaiting_start', 'awaiting_loser_confirmation'],
        ['complete', 'cancelled'],
        ['cancelled', 'awaiting_winner'],
        ['complete', 'awaiting_start'],
        [undefined, 'awaiting_winner']
    ])('rejects %s -> %s', (from, to) => {
        expect(isAllowedStageTransition(from, to)).toBe(false);
    });

    test('terminal stages have no way out', () => {
        expect(isTerminalStage(MATCH_STAGES.COMPLETE)).toBe(true);
        expect(isTerminalStage(MATCH_STAGES.CANCELLED)).toBe(true);
        expect(isTerminalStage(MATCH_STAGES.AWAITING_WINNER)).toBe(false);
        expect(ALLOWED_STAGE_TRANSITIONS.complete).toEqual([]);
        expect(ALLOWED_STAGE_TRANSITIONS.cancelled).toEqual([]);
    });

    test('an unexpected transition throws under test and is reported (but applied) in production', () => {
        expect(() => transitionMatchStage({ stage: 'complete' }, 'awaiting_winner')).toThrow(/complete -> awaiting_winner/);

        const match = { stage: 'cancelled' };
        const onInvalid = jest.fn();
        expect(transitionMatchStage(match, 'awaiting_winner', { strict: false, onInvalid })).toBe('cancelled');
        expect(onInvalid).toHaveBeenCalledWith('cancelled', 'awaiting_winner');
        expect(match.stage).toBe('awaiting_winner');
    });

    test('an allowed transition reports nothing', () => {
        const match = { stage: 'awaiting_winner' };
        const onInvalid = jest.fn();
        transitionMatchStage(match, 'awaiting_loser_confirmation', { strict: false, onInvalid });
        expect(onInvalid).not.toHaveBeenCalled();
        expect(match.stage).toBe('awaiting_loser_confirmation');
    });
});
