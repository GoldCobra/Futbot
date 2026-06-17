const service = require('../../src/services/competitiveRatedQueue/service');

const postInitialGameSetup = service.__postInitialGameSetupForTests;

describe('postInitialGameSetup re-entrancy guard', () => {
    it('bails immediately when an initial setup is already in flight (prevents duplicate welcome+rules)', async () => {
        const fetch = jest.fn();
        const client = { channels: { fetch } };
        const match = { id: 'm1', threadId: 'thread-1', initialGameSetupInFlight: true };

        await postInitialGameSetup(match, client);

        // The guard must short-circuit before any Discord work (no thread fetch/send),
        // so a concurrent reconcile-watchdog run cannot re-post the welcome+rules.
        expect(fetch).not.toHaveBeenCalled();
        // The flag is owned by the in-flight caller and must be left untouched.
        expect(match.initialGameSetupInFlight).toBe(true);
    });
});
