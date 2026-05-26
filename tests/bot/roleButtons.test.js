const { generalCommandButtonCallBacks } = require('../../src/bot/handlers/buttons');
const rolePanel = require('../../src/services/rolePanel');

describe('role button panel', () => {
    it('contains handlers for every Futbot role button', () => {
        expect(Object.keys(generalCommandButtonCallBacks)).toEqual(expect.arrayContaining([
            'msbl',
            'msc',
            'sms',
            'tournaments',
            'modding',
            'msbllfg',
            'msclfg',
            'mscrankedlfg',
            'smslfg',
            'smslfg2',
            'msl',
            'msblspectator',
            'mscspectator',
            'smsspectator',
            'blvoice',
            'mscvoice',
            'smsvoice',
            'mscstream',
            'smsstream'
        ]));
    });

    it('builds the full Futbot role panel message stack', () => {
        const messages = rolePanel.buildRolePanelMessages();

        expect(messages).toHaveLength(4);
        expect(messages[1].components[0].toJSON().components.map(component => component.custom_id))
            .toEqual(['msbllfg', 'msclfg', 'mscrankedlfg', 'smslfg', 'smslfg2']);
        expect(messages[3].components[0].toJSON().components.map(component => component.custom_id))
            .toEqual(['blvoice', 'mscvoice', 'smsvoice', 'mscstream', 'smsstream']);
    });
});
