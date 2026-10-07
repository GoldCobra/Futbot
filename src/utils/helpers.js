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

module.exports.sendSplitMessages = sendSplitMessages;
module.exports.isSubset = isSubset;
