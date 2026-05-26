const fs = require('node:fs');
const path = require('node:path');
const MultiMap = require('multimap');

const gearsetsPath = path.resolve(__dirname, '..', '..', 'data', 'gearsets.json');
const charactersPath = path.resolve(__dirname, '..', '..', 'data', 'characters.json');

let cachedData = null;

const GEAR_RULES_TEXT = `The Basics

So, to start, you need to understand an important principle about gear: every single piece of gear from the base sets increases one stat by 2 and decreases 1 stat by 2. There are 5 main sets of gear, each set increases the same stat, and each piece in the set decreases a different stat. This means EVERY individual piece of gear that could exist under these restrictions, exists. The catch is that they're restricted to 1 gear type - you cant wear 2 helmets or 2 boots, so you have to get creative. This is all with the exception of the Bushido set, which increases one stat by 4 and decreases every other stat by 1, and more gear may be added in future updates that further deviates from this rule, but this will most likely be a rare occurrence. So to start creating a build, you'll need to first decide your stats. Just go through every stat and pick a number that you want to have. Of course, there are restrictions:

Main Rules

1. Your total should be 63. Every character's base stats total to 63, and gear adds the same points it subtracts, so you must have 63 total points.
2. Each stat's base value is either even or odd for each character, and since you can only change one by jumps of 2, it has to stay that way - yet again, the Bushido set and perhaps future sets added in updates may break this rule, but as most sets do not, breaking it yourself may result in far less possible gear combinations, but may also allow you to specifically find sets including a special set - make sure to take this into account when deciding your stats!
3. You should not change any one stat too far off from it's base value - trying to do so would usually require you to equip multiple pieces of the same set, which restricts you heavily by requiring your subtractions to be heavily spread out across every stat.

To construct a build, input the command /gear followed by your desired character and stats using Discord's UI.`;

function loadGearData() {
    if (cachedData) {
        return cachedData;
    }

    const gearsetsArray = JSON.parse(fs.readFileSync(gearsetsPath, 'utf-8'));
    const gearsetsMMap = new MultiMap();
    gearsetsArray.forEach(entry => {
        gearsetsMMap.set(entry.stats, entry.gear_selection);
    });

    const charactersArray = JSON.parse(fs.readFileSync(charactersPath, 'utf-8'));
    const charactersMap = new Map();
    charactersArray.forEach(entry => {
        charactersMap.set(entry.name, entry.stats);
    });

    cachedData = {
        gearsetsMMap,
        charactersMap
    };
    return cachedData;
}

function findGear(strength, speed, shooting, passing, technique, characterName) {
    const { gearsetsMMap, charactersMap } = loadGearData();
    const normalizedCharacterName = String(characterName ?? '').toUpperCase();
    const characterStats = charactersMap.get(normalizedCharacterName);
    if (!characterStats) {
        return null;
    }

    const deltaStatList = [
        strength - characterStats[0],
        speed - characterStats[1],
        shooting - characterStats[2],
        passing - characterStats[3],
        technique - characterStats[4]
    ].join(', ');

    return gearsetsMMap.get(deltaStatList);
}

function buildGearResponse(strength, speed, shooting, passing, technique, characterName) {
    const gearCombinations = findGear(strength, speed, shooting, passing, technique, characterName);
    if (gearCombinations === null) {
        return `${characterName} is not in the game... not yet anyways!`;
    }
    if (gearCombinations === undefined) {
        return 'No gear combination was found for the desired stats and character. You might have broken a rule - make sure to check the rules using /gearrules!';
    }
    if (gearCombinations.length === 1) {
        return `Your desired set is: ${gearCombinations[0]}`;
    }

    return gearCombinations
        .map((gearCombination, index) => `Set no. ${index + 1} is: ${gearCombination}`)
        .join('\n')
        .replace(/^/, 'There are multiple gear sets that fit your criteria!\n');
}

function getGearRulesText() {
    return GEAR_RULES_TEXT;
}

module.exports = {
    buildGearResponse,
    findGear,
    getGearRulesText
};
