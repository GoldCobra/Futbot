require('dotenv').config();


const VERSION = 'v2.1'; // silly way to keep track of which bot is running.

const ROLES = {
    ADMIN: '1070908166725967942',
    MSL_STAFF: '790896138827333652',
    MSL_STAFF_SMS: '1092215890835153026',
    MSL_STAFF_MSC: '790896138827333652',
    MSL_STAFF_MSBL: '1092443988948164638',
    DEVELOPER: '902508392227176489',
    MEGASTRIKER: '862990625540407316',
    LEGEND: '862992675384197120',
    SUPERSTAR: '910803745447747584',
    PROFESSIONAL: '910803654859173898',
    ROOKIE: '910803451678703616',
    SMS_LFG: '781487757176209428',
    SMS_LFG_2: '1390497838508802219',
    MSC_LFG: '680810288605298744',
    MSC_LFG_RANKED: '994241343775842415',
    MSC_FAN: '862237914863239198',
    SMS_FAN: '862237991635124244',
    MODDING: '862238264752996372',
    TOURNAMENT: '862238161395908628',
    MSBL: '944674641446858793',
    MSBL_LFG: '944150830972538923',
    MSBL_RATED_MATCH: '1174886703547289730',
    MSL: '944675093525692496',
    MSBL_SPECTATOR: '944675392839626824',
    MSC_SPECTATOR: '944675434216427601',
    SMS_SPECTATOR: '944675472170713128',
    SERVER_STAFF: '271233314252259330',
    MSBL_VOICE: '1020145196115177492',
    MSC_VOICE: '1020145464751960155',
    SMS_VOICE: '1020145775814135909',
    MSC_STREAM: '1020146143272914974',
    SMS_STREAM: '1020146658954195095',
    TEST_ROBO_CLIENT: '897771235004514304'
}
const PLAYER_ROLES = [ROLES.MEGASTRIKER, ROLES.LEGEND,ROLES.SUPERSTAR,ROLES.PROFESSIONAL,ROLES.ROOKIE]
const GUILD_ID = process.env.GUILD_ID ?? '268737069939949569'
const APPROVED_GUILDS = [
    '611726672269541406', // rocci's corner
    '1011717749749321819', // the arcade
    '1009633333090713640', // underground super mario strikers
    '1090741089830436877', // evo
    '925929973901053972', // loud pack
    '1120310638435110942', // sharp corner
    '151565292173131776', // cream
    GUILD_ID
]

const GAME_TO_STAFF = {
	MSBL: ROLES.MSL_STAFF_MSBL,
    SMS: ROLES.MSL_STAFF_SMS,
    MSC: ROLES.MSL_STAFF_MSC	
}

const CHANNELS = {
    DEBUG_CHANNEL: '910923586636771409',
    DEBUG_ERRORS: '1174699634891968553',
    //DEBUG_CHANNEL: '926549798839009380', // rocci's corner
    COMMAND_SANDBOX_CHANNEL: '897757084299431936',
    RULE_CHANNEL: '894852972117372988',
    SERVER_ROLES_CHANNEL: '896363013811097650',
    MSC_DOMINATION_DRAFT: '710462330369998908',
    GRUDGE_MATCH: '273005041877647371',
    CLUB_TRANSFERS_CHANNEL: '1014137924507406477',
    // CLUB_TRANSFERS_CHANNEL: '902508091680108574', // Bot-test-1
    RANKED_MSC_CHANNEL: '946823869300350986',
    //RANKED_MSC_CHANNEL: '896138179332149258', // rocci's corner
    RANKED_SMS_CHANNEL: '946823938112118824', 
    RANKED_SMS2_CHANNEL: '1390491483140001936',
    RANKED_MSBL_CHANNEL: '984493744915087451', 
    RANKED_MSBL_DOUBLES_CHANNEL: '986968470828761098',
    RANKED_SMS_DOUBLES_CHANNEL: '1014709016460546048',
    RANKED_SMS2_DOUBLES_CHANNEL: '1390493712873816214',
    RANKED_MSC_DOUBLES_CHANNEL: '1014863134625898527',
    // BOT TEST 1
    BOT_TEST_1: '902508091680108574'
}

const TOURNAMENT_CREATOR = {
    STARTER_CHANNEL: '1499114023470235779',
    FORUM_CHANNEL: '1499110700671307896',
    DEFAULT_TAG: '1499111555957002260',
    BUTTON_LABEL: 'CREATE YOUR TOURNAMENT',
    CUSTOM_IDS: {
        BUTTON: 'tourney:create:start',
        MODAL: 'tourney:create:modal',
        NAME_INPUT: 'tourney:create:name',
        DESCRIPTION_INPUT: 'tourney:create:description',
        TAG_SELECT: 'tourney:create:tags',
        CONFIRM_BUTTON: 'tourney:create:confirm'
    }
}

const COMPETITIVE_RATED_QUEUE = {
    PREFIX: 'rated:competitive',
    STATUS_RECONCILE_INTERVAL_MS: 60000,
    EXPIRING_SOON_MINUTES: 2,
    MATCH_START_TIMEOUT_MINUTES: 5,
    MATCH_SETUP_TIMEOUT_MINUTES: 10,
    MATCH_GAME_TIMEOUT_MINUTES: 20,
    PANEL_CHANNELS: [
        {
            channelId: '1501486517464600657',
            gameType: 'MSC',
            mode: 'competitive'
        },
        {
            channelId: '1504056016629927966',
            gameType: 'SMS',
            mode: 'competitive'
        },
        {
            channelId: '1502350088431992852',
            gameType: 'MSBL',
            mode: 'competitive'
        }
    ]
}

const MSBL_STATS = {
    'goals': {
        'channel': '1166950694947913729',
        'friendlyName': 'Goals'
    },
    'shotsongoal': {
        'channel': '1166950753844338769',
        'friendlyName': 'ShotsOnGoal'
    },
    'tackles': {
        'channel': '1166950788627705876',
        'friendlyName': 'Tackles'
    },

    'itemsused': {
        'channel': '1166950811365032066',
        'friendlyName': 'ItemsUsed'
    },
    'possession': {
        'channel': '1166950946513895434',
        'friendlyName': 'Possession'
    },
    'passes': {
        'channel': '1166951152001224724',
        'friendlyName': 'Passes'
    },

    'interceptions': {
        'channel': '1166951172981145640',
        'friendlyName': 'Interceptions'
    },
    'goaldifferential': {
        'channel': '1166951212378247188',
        'friendlyName': 'GoalDifferential'
    },
    'shotefficiency': {
        'channel': '1166951244066209862',
        'friendlyName': 'ShotEfficiency'
    },
    'passingefficiency': {
        'channel': '1166951275456372736',
        'friendlyName': 'PassingEfficiency'
    },
    'tackleefficiency': {
        'channel': '1166951308666880051',
        'friendlyName': 'TackleEfficiency'
    },
    'goalsallowed': {
        'channel': '1167104539950845982',
        'friendlyName': 'GoalsAllowed',
        'order': 'ASC'
    },
    'passesperpossession': {
        'channel': '1167104400725123192',
        'friendlyName': 'PassesPerPossession'
    },
    'reportedgames': {
        'channel': '1167109741512753233',
        'friendlyName': 'ReportedGames',
        'aggregationType': 'SUM'
    },
    'reportedopponents': {
        'channel': '1167109768876396654',
        'friendlyName': 'ReportedOpps',
        'aggregationType': 'SUM'
    },

}


const RESTRICTED_COMMANDS = [
    {
        commands: ['smsreport', 'mscreport', 'upsert', 'remove-command'],
        allowedRoles: [ROLES.ADMIN_ROLE, ROLES.DEVELOPER_ROLE]
    },
    ]
const MSC_SK = ['mscboo','mscdrybones', 'mscbirdo', 'mschammerbro', 'mscmonty', 'msckoopa', 'msctoad', 'mscshyguy'];
const MSC_CAPTAINS = ['mscwaluigi', 'mscdk', 'mscpetey', 'mscdaisy', 'mscwario', 'mscbowser', 'mscmario', 'mscluigi', 'mscpeach', 'mscyoshi', 'mscdiddy', 'mscbowserjr']
const MSC_ALL_STADIUMS = ['The Classroom', 'The Sand Tomb', 'The Palace', 'Thunder Island', 'Pipeline Central', 'Konga Coliseum', 'The Underground', 'The Wastelands',
'Crater Field', 'The Dump', 'The Vice', 'Crystal Canyon', 'The Battle Dome', 'The Lava Pit', 'Galactic Stadium', 'Bowser Stadium', 'Stormship Stadium'];
const MSC_COMP_STADIUMS = ['The Classroom', 'The Lava Pit', 'Cystal Canyon', 'Bowser Stadium'];
const SMS_ALL_STADIUMS = ['The Battle Dome', 'Bowser Stadium', 'Crater Field', 'Konga Coliseum', 'The Palace', 'Pipeline Central', 'The Underground'];
const SMS_COMP_STADIUMS = ['The Battle Dome', 'Bowser Stadium', 'Crater Field', 'Konga Coliseum', 'The Palace', 'Pipeline Central', 'The Underground'];
const BL_ALL_STADIUMS = ['Jungle Retreat', 'Spooky Mansion', 'Royal Castle', 'Lava Castle', 'Mushroom Hill', 'Desert Ruin', 'Planetoid', 'Urban Rooftop'];
const BL_ALL_PLAYERS = ['blwaluigi', 'bldk', 'blrosa', 'bldaisy', 'blwario', 'blbowser', 'blmario', 'blluigi', 'blpeach', 'blyoshi', 'bldiddy', 'blshyguy', 'blpauline', 'bltoad', 'blbirdo', 'blbowserjr'];
const BL_CAPTAINS = ['blpauline', 'blwaluigi'];
const BL_WINGERS = ['bltoad', 'bldiddy', 'blpeach', 'blbowserjr'];
const BL_SWEEPERS = ['bldk', 'blbowser'];
const BL_SK = ['bltoad', 'blyoshi', 'blshyguy'];
const SMS_SK = ['smstoad', 'smskoopa', 'smsbirdo', 'smshammerbro'];
const SMS_CAPTAIN = ['smswaluigi', 'smswario', 'smsdk', 'smspeach', 'smsdaisy', 'smsluigi', 'smsmario', 'smsyoshi'];
const EXTERNAL_BOT_COMMANDS = ['!flag', '!code', '!error', '!remindme', '!purge', '!ban', '!mute'];
const TIERLIST_COMMAND_URLS = Object.freeze({
    '!bltl': 'https://mariostrikers.gg/assets/tierlists/msbl-tierlist-current.png',
    '!msctl': 'https://mariostrikers.gg/assets/tierlists/msc-tierlist-current.png',
    '!smstl': 'https://mariostrikers.gg/assets/tierlists/sms-tierlist-current.png'
});
const FIXED_LINK_COMMAND_URLS = Object.freeze({
    '!clublist': 'https://mariostrikers.gg/msbl-striker-clubs',
    '!clubs': 'https://mariostrikers.gg/msbl-striker-clubs',
    '!mscrules': 'https://mariostrikers.gg/msc-competitiverules',
    '!smsrules': 'https://mariostrikers.gg/sms-competitiverules',
    '!blrules': 'https://mariostrikers.gg/msbl-competitiverules',
    '!mscmanual': 'https://csassets.nintendo.com/noaext/image/private/t_KA_PDF/Wii_Mario_Strikers_Charged?_a=DATAg1AAZAA0',
    '!msctutorial': 'https://mariostrikers.gg/msc-setup-guide'
});
const CODE_MANAGED_LINK_COMMAND_URLS = Object.freeze({
    ...TIERLIST_COMMAND_URLS,
    ...FIXED_LINK_COMMAND_URLS
});
const SQL_GAME_TYPE_TO_STRING = {
    1 : 'MSC',
    2 : 'SMS',
    3 : 'MSBL'
};
const SQL_GAME_TYPE_TO_NUMBER = {
    'MSC' : 1,
    'SMS' : 2,
    'MSBL': 3
};
const GAME_TYPES = {
    'MSC' : 'MSC',
    'SMS' : 'SMS',
    'MSBL': 'MSBL'
};
const TOURNEY_TYPES = {
    'MSL' : 'msl',
    'SIDE' : 'side'
};

const SQL_MSBL_CHAR_TO_NUMBER = {
    'MARIO' : 1,
    'LUIGI' : 2,
    'BOWSER':3,
    'PEACH':4,
    'ROSALINA':5,
    'TOAD':6,
    'YOSHI':7,
    'DK':8,
    'WARIO':9,
    'WALUIGI':10,
    'SHYGUY':11,
    'DAISY':12,
    'PAULINE':13,
    'DIDDY':14,
    'BOWSERJR':15,
    'BIRDO':16
};

const SQL_MSBL_NUMBER_TO_CHAR = new Map(Array.from(SQL_MSBL_CHAR_TO_NUMBER, a => a.reverse()));

const EMOJIS = {
    LETSGO: '<:letsgo:908736771578269747>',
    SHH: '🤫'
};

/// MESSAGES 
const QUEUE_AGAIN_MESSAGE = 
'Do you want to queue again? Click the button! ' + EMOJIS.LETSGO + '\n'+
'*(NOTE: this just puts you back in queue, does not garauntee a rematch)*';
/////////////

const START_GG_VIDEOGAME_IDS_TO_GAME = {
    '42285' : 'MSBL',
    '5764' : 'SMS',
    '5690' : 'MSC'
}

GAME_TYPE_TO_LFG_CHANNEL = {
    'MSBL' : {
        'SINGLES': CHANNELS.RANKED_MSBL_CHANNEL,
        'DOUBLES' : CHANNELS.RANKED_MSBL_DOUBLES_CHANNEL
    },
    'MSC' : {
        'SINGLES': CHANNELS.RANKED_MSC_CHANNEL,
        'DOUBLES' : CHANNELS.RANKED_MSC_DOUBLES_CHANNEL
    },
    'SMS' : {
        'SINGLES': CHANNELS.RANKED_SMS_CHANNEL,
        'DOUBLES' : CHANNELS.RANKED_SMS_DOUBLES_CHANNEL
    },
    'SMS2' : {
        'SINGLES': CHANNELS.RANKED_SMS2_CHANNEL,
        'DOUBLES' : CHANNELS.RANKED_SMS2_DOUBLES_CHANNEL
    }
}

GAME_TYPE_TO_LFG_PING = {
    'MSBL' : `<@&${ROLES.MSBL_RATED_MATCH}>`,
    'MSC' : `<@&${ROLES.MSC_LFG}>`,
    'SMS' : `<@&${ROLES.SMS_LFG}>`,
    'SMS2' : `<@&${ROLES.SMS_LFG_2}>`
};

// This points to the defualt google forms for submitting VODs to Media Staff maintained in the 
// staff Google Drive.
const VOD_SUBMISSION_LINK = 'https://forms.gle/ZEKNBdTi3JfsyAsE7';


const GAME_STATS_TYPES = {
    BASIC:'BASIC',
    ADVANCED:'ADVANCED'
};

const GAME_RATED_ACTIVITY_REQUIREMENT_IN_DAYS = {
    'MSBL': 90,
    'SMS': null,
    'MSC': null
};

// Index = rank number (0 = Unranked/placements, 1 = Bronze I, …, 19 = Strikers Titan)
const COMP_PLAYER_ROLES = [
    '1504569388056186901',  // Unranked       (rank 0)
    '1504566977182699620',  // Bronze I       (rank 1)
    '1504567059185537025',  // Bronze II      (rank 2)
    '1504567111177994320',  // Bronze III     (rank 3)
    '1504567155092357211',  // Silver I       (rank 4)
    '1504567186386194583',  // Silver II      (rank 5)
    '1504567235543437332',  // Silver III     (rank 6)
    '1504567266597933066',  // Gold I         (rank 7)
    '1504567296335675563',  // Gold II        (rank 8)
    '1504567325712580828',  // Gold III       (rank 9)
    '1504567357585096846',  // Platinum I     (rank 10)
    '1504567390565044407',  // Platinum II    (rank 11)
    '1504567428028567602',  // Platinum III   (rank 12)
    '1504567464191594597',  // Diamond I      (rank 13)
    '1504567511184834731',  // Diamond II     (rank 14)
    '1504567543430647849',  // Diamond III    (rank 15)
    '1504567579811905627',  // Master I       (rank 16)
    '1504567696266756257',  // Master II      (rank 17)
    '1504567725824151763',  // Master III     (rank 18)
    '1504567785311834112',  // Strikers Titan (rank 19)
];

module.exports = {
    GAME_TYPES,VOD_SUBMISSION_LINK, START_GG_VIDEOGAME_IDS_TO_GAME,GAME_TO_STAFF,ROLES,PLAYER_ROLES, GUILD_ID, CHANNELS, RESTRICTED_COMMANDS, 
    MSC_SK, MSC_CAPTAINS, MSC_ALL_STADIUMS, MSC_COMP_STADIUMS, SMS_ALL_STADIUMS, SMS_COMP_STADIUMS, SMS_SK, SMS_CAPTAIN, 
    BL_ALL_STADIUMS, BL_ALL_PLAYERS, BL_SK, BL_CAPTAINS, BL_WINGERS, BL_SWEEPERS,
    EXTERNAL_BOT_COMMANDS, TIERLIST_COMMAND_URLS, FIXED_LINK_COMMAND_URLS, CODE_MANAGED_LINK_COMMAND_URLS, APPROVED_GUILDS, SQL_GAME_TYPE_TO_STRING, SQL_GAME_TYPE_TO_NUMBER , TOURNEY_TYPES, QUEUE_AGAIN_MESSAGE,EMOJIS,
    GAME_TYPE_TO_LFG_PING, GAME_TYPE_TO_LFG_CHANNEL, GAME_STATS_TYPES, VERSION, MSBL_STATS,GAME_RATED_ACTIVITY_REQUIREMENT_IN_DAYS,
    TOURNAMENT_CREATOR, COMPETITIVE_RATED_QUEUE, COMP_PLAYER_ROLES};
