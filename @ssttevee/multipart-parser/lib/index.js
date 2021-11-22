import { ReadableStreamSearch, StreamSearch, MATCH } from '@ssttevee/streamsearch';
import { arraysEqual, stringToArray, arrayToString, mergeArrays } from '@ssttevee/u8-utils';
const mergeArrays2 = Function.prototype.apply.bind(mergeArrays, undefined);
const dash = stringToArray('--');
const CRLF = stringToArray('\r\n');
function splitSemis(str) {
    const result = [];
    let staged = '';
    let quoted = false;
    let escaped = false;
    for (const char of str) {
        if (!escaped) {
            if (char === '"') {
                quoted = !quoted;
            }
            else if (char === '\\' && quoted) {
                escaped = true;
            }
            else if (char === ';' && !quoted) {
                result.push(staged);
                staged = '';
                continue;
            }
        }
        else {
            escaped = false;
        }
        staged += char;
    }
    result.push(staged);
    return result;
}
function parseKeyValue(str) {
    const equals = str.indexOf('=');
    if (equals < 0) {
        throw new Error('malformed key-value string: missing value in `' + str + '`');
    }
    const key = str.slice(0, equals);
    const rawValue = str.slice(equals + 1);
    let value = '';
    if (rawValue.startsWith('"')) {
        if (!rawValue.endsWith('"')) {
            throw new Error('malformed key-value string: mismatched quotations in `' + rawValue + '`');
        }
        let escaped = false;
        for (const char of rawValue.slice(1, rawValue.length - 1)) {
            if (char === '\\' && !escaped) {
                escaped = true;
                continue;
            }
            if (escaped) {
                escaped = false;
            }
            value += char;
        }
    }
    else {
        value = rawValue;
    }
    return [key, value];
}
function parseContentDisposition(header) {
    const parts = splitSemis(header).map((part) => part.trim());
    if (parts.shift() !== 'form-data') {
        throw new Error('malformed content-disposition header: missing "form-data" in `' + JSON.stringify(parts) + '`');
    }
    const out = {};
    for (const part of parts) {
        const [name, value] = parseKeyValue(part);
        out[name] = value;
    }
    if (!out.name) {
        throw new Error('malformed content-disposition header: missing field name in `' + header + '`');
    }
    return out;
}
function parsePartHeaders(lines) {
    const entries = [];
    let disposition = false;
    let line;
    while (typeof (line = lines.shift()) !== 'undefined') {
        const colon = line.indexOf(':');
        if (colon === -1) {
            throw new Error('malformed multipart-form header: missing colon');
        }
        const header = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        switch (header) {
            case 'content-disposition':
                disposition = true;
                entries.push(...Object.entries(parseContentDisposition(value)));
                break;
            case 'content-type':
                entries.push(['contentType', value]);
        }
    }
    if (!disposition) {
        throw new Error('malformed multipart-form header: missing content-disposition');
    }
    return Object.fromEntries(entries);
}
async function readHeaderLines(it, needle) {
    let firstChunk = true;
    let lastTokenWasMatch = false;
    const headerLines = [[]];
    const crlfSearch = new StreamSearch(CRLF);
    for (;;) {
        const result = await it.next();
        if (result.done) {
            throw new Error('malformed multipart-form data: unexpected end of stream');
        }
        if (firstChunk && result.value !== MATCH && arraysEqual(result.value.slice(0, 2), dash)) {
            // end of multipart payload, beginning of epilogue
            return [undefined, new Uint8Array()];
        }
        let chunk;
        if (result.value !== MATCH) {
            chunk = result.value;
        }
        else if (!lastTokenWasMatch) {
            chunk = needle;
        }
        else {
            throw new Error('malformed multipart-form data: unexpected boundary');
        }
        if (!chunk.length) {
            continue;
        }
        if (firstChunk) {
            firstChunk = false;
        }
        const tokens = crlfSearch.feed(chunk);
        for (const [i, token] of tokens.entries()) {
            const isMatch = token === MATCH;
            if (!isMatch && !token.length) {
                continue;
            }
            if (lastTokenWasMatch && isMatch) {
                tokens.push(crlfSearch.end());
                return [
                    headerLines.filter((chunks) => chunks.length).map(mergeArrays2).map(arrayToString),
                    mergeArrays(...tokens.slice(i + 1).map((token) => token === MATCH ? CRLF : token)),
                ];
            }
            if (lastTokenWasMatch = isMatch) {
                headerLines.push([]);
            }
            else {
                headerLines[headerLines.length - 1].push(token);
            }
        }
    }
}
export async function* streamMultipart(body, boundary) {
    const needle = mergeArrays(dash, stringToArray(boundary));
    const it = new ReadableStreamSearch(needle, body)[Symbol.asyncIterator]();
    // discard prologue
    for (;;) {
        const result = await it.next();
        if (result.done) {
            // EOF
            return;
        }
        if (result.value === MATCH) {
            break;
        }
    }
    const crlfSearch = new StreamSearch(CRLF);
    for (;;) {
        const [headerLines, tail] = await readHeaderLines(it, needle);
        if (!headerLines) {
            return;
        }
        async function nextToken() {
            const result = await it.next();
            if (result.done) {
                throw new Error('malformed multipart-form data: unexpected end of stream');
            }
            return result;
        }
        let trailingCRLF = false;
        function feedChunk(chunk) {
            const chunks = [];
            for (const token of crlfSearch.feed(chunk)) {
                if (trailingCRLF) {
                    chunks.push(CRLF);
                }
                if (!(trailingCRLF = token === MATCH)) {
                    chunks.push(token);
                }
            }
            return mergeArrays(...chunks);
        }
        let done = false;
        async function nextChunk() {
            const result = await nextToken();
            let chunk;
            if (result.value !== MATCH) {
                chunk = result.value;
            }
            else if (!trailingCRLF) {
                chunk = CRLF;
            }
            else {
                done = true;
                return { value: crlfSearch.end() };
            }
            return { value: feedChunk(chunk) };
        }
        const bufferedChunks = [{ value: feedChunk(tail) }];
        yield {
            ...parsePartHeaders(headerLines),
            data: {
                [Symbol.asyncIterator]() {
                    return this;
                },
                async next() {
                    for (;;) {
                        const result = bufferedChunks.shift();
                        if (!result) {
                            break;
                        }
                        if (result.value.length > 0) {
                            return result;
                        }
                    }
                    for (;;) {
                        if (done) {
                            return { done, value: undefined };
                        }
                        const result = await nextChunk();
                        if (result.value.length > 0) {
                            return result;
                        }
                    }
                },
            },
        };
        while (!done) {
            bufferedChunks.push(await nextChunk());
        }
    }
}
export async function* iterateMultipart(body, boundary) {
    for await (const part of streamMultipart(body, boundary)) {
        const chunks = [];
        for await (const chunk of part.data) {
            chunks.push(chunk);
        }
        yield {
            ...part,
            data: mergeArrays(...chunks),
        };
    }
}
export async function parseMultipart(body, boundary) {
    const parts = [];
    for await (const part of iterateMultipart(body, boundary)) {
        parts.push(part);
    }
    return parts;
}
//# sourceMappingURL=index.js.map