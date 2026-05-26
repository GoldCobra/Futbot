const  { Table } = require('embed-table');

function cleanDiscordId(discordId) {
	return discordId.replace("<", "").replace(">", "").replace("@", "").replace("!", "").replace("#", "");
}

function getUnixTime(time) {
  return `<t:${Math.floor(time.getTime() / 1000)}>`;
}

function convertJsonListToCsv(jsonList, columnOrder, headerRow=null) {
  let res = jsonList.map(jsonObj => {
    let res = [];
    columnOrder.forEach(columnName => {
      res.push(jsonObj[columnName]);
    });
    return res;
  });

  if(headerRow) {
    res.unshift(headerRow)
  }
  return res;
}

// Helper function to generate a formatted table
function generateTable(data) {
  const columnWidths = data[0].map((_, colIndex) => {
    return Math.max(...data.map(row => String(row[colIndex]).length));
  });

  const header = data[0].map((value, colIndex) => {
    return value.toString().padEnd(columnWidths[colIndex]);
  });

  const separator = columnWidths.map(width => '-'.repeat(width));

  const rows = data.slice(1).map(row => {
    return row.map((value, colIndex) => {
      return value.toString().padEnd(columnWidths[colIndex]);
    });
  });

  return [header.join(' | '), separator.join('-+-'), ...rows.map(row => row.join(' | '))].join('\n');
}

function splitAndConcatenate(str, byLine) {
  if(byLine) {
    const lines = str.split('\n');
    const result = [];
    let currentChunk = '';
  
    for (const line of lines) {
      if (currentChunk.length + line.length <= 2000) {
        currentChunk += line + '\n';
      } else {
        result.push(currentChunk.trim());
        currentChunk = line + '\n';
      }
    }
  
    if (currentChunk.trim() !== '') {
      result.push(currentChunk.trim());
    }
  
    return result;
  }
  else { // by word
    const result = [];
    let currentValue = 0;
    const MAX_LENGTH = 2000;
    str = str.trim();
    while(currentValue < str.length) {
      //trim the string to the maximum length
      let endIndex = str.substr(currentValue, MAX_LENGTH).lastIndexOf(" ");
      if(currentValue + MAX_LENGTH > str.length) {
        endIndex = str.length;
      } else if (endIndex <= 0) {
        endIndex = currentValue + MAX_LENGTH;
      } else {
        endIndex = currentValue + endIndex;
      }

      //re-trim if we are in the middle of a word
      result.push(str.substring(currentValue, endIndex).trim())
      currentValue = endIndex;
    }  
    return result;
  }
}

function isSubset(subset, superset) {
  for (const element of subset) {
    if (!superset.has(element)) {
      return false;
    }
  }
  return true;
}

async function sendSplitMessages(sendMessageLogic, message, byLine=true) {
    let firstMsg = null;
    let messages = splitAndConcatenate(message, byLine);
    for (const msg of messages) {
      if (!msg || !msg.trim()) {
        continue;
      } 
      const response = await sendMessageLogic(msg);
      if(!firstMsg) {
          firstMsg = response;
      }
    }

    return firstMsg;
}

function parseInputAsUTC(input) {
  // Parse the input string as UTC time
  const utcDate = new Date(Date.parse(input));

  // Check if the parsing was successful
  if (isNaN(utcDate.getTime())) {
    console.error('Invalid date format');
    return null;
  }

  return utcDate;
}

function getTableAsString(jsonList, titles=null, fillInNulls='N/A') {
  if(!titles) {
    titles = Object.keys(jsonList[0]);
  }

  let val= 0;
  let indices = [];
  let LENGTH_CAP = 15;
  for(const i in titles) {
    if(i == 0) {
      indices.push(val);
      continue;
    }
    indices.push(indices.at(-1) + titles[i].length + 6);
  }
  const table = new Table({
    titles: titles,
    titleIndexes: indices,
    columnIndexes: indices,
    start: '`',
    end: '`',
    padEnd: 3
    });
   
  jsonList.forEach(d => {
    let row = [];
    titles.forEach(t => {
      let val = d[t] ? d[t].toString() : fillInNulls;
      if(val.length >= LENGTH_CAP) {
        val = `${val.slice(0,LENGTH_CAP-3)}...`;
      }
      row.push(val);
    });
    table.addRow(row);
  });

  return table.toString();
}

module.exports.cleanDiscordId = cleanDiscordId;
module.exports.sendSplitMessages = sendSplitMessages;
module.exports.getUnixTime = getUnixTime ;
module.exports.generateTable = generateTable;
module.exports.isSubset = isSubset;
module.exports.convertJsonListToCsv = convertJsonListToCsv;
module.exports.parseInputAsUTC = parseInputAsUTC;
module.exports.getTableAsString = getTableAsString;
