// Inputs are { name: value } or { name: [sqlType, value] } for an explicitly typed parameter.
function bindInputs(request, inputs = {}) {
    for (const [key, value] of Object.entries(inputs)) {
        if (Array.isArray(value)) {
            request.input(key, value[0], value[1]);
        } else {
            request.input(key, value);
        }
    }
    return request;
}

// Runs a query on a pool or an open transaction (anything with request()).
async function runRequest(runner, query, inputs = {}) {
    return bindInputs(runner.request(), inputs).query(query);
}

module.exports = {
    bindInputs,
    runRequest
};
