import { StringDecoder } from 'node:string_decoder';
import { basename, isAbsolute, relative, win32 } from 'node:path';

export const PROGRESS_PREFIX = '@@workflow-gate-progress ';
export const MAX_TEST_LABEL_LENGTH = 160;
const MAX_PROGRESS_LINE_LENGTH = 2048;
const TEST_EVENTS = new Set(['test:start', 'test:pass', 'test:fail']);

function safeLabel(value) {
  if (typeof value !== 'string') return null;
  // Progress labels must not emit terminal escapes or raw control characters.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, MAX_TEST_LABEL_LENGTH) : null;
}

function safeFile(value, cwd) {
  if (typeof value !== 'string' || !value) return null;
  const normalizedValue = value.replaceAll('\\', '/');
  let file = relative(cwd, value).replaceAll('\\', '/');
  const foreignWindowsAbsolute = win32.isAbsolute(value) && !isAbsolute(value);
  if (!file || file === '..' || file.startsWith('../') || isAbsolute(file) || foreignWindowsAbsolute) file = basename(normalizedValue);
  return safeLabel(file);
}

export function gateTestProgressLine(type, name, file, cwd = process.cwd()) {
  const test = safeLabel(name);
  if (!TEST_EVENTS.has(type) || !test) return null;
  return `${PROGRESS_PREFIX}${JSON.stringify({ type, test, file: safeFile(file, cwd) })}\n`;
}

export function createGateProgressParser() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;
  let ended = false;

  const parseLine = line => {
    if (!line.startsWith(PROGRESS_PREFIX)) return null;
    let value;
    try { value = JSON.parse(line.slice(PROGRESS_PREFIX.length)); }
    catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !TEST_EVENTS.has(value.type)) return null;
    const currentTest = safeLabel(value.test);
    if (!currentTest) return null;
    return { testEvent: value.type, currentTest, currentFile: safeLabel(value.file) };
  };

  const consume = (text, flush = false) => {
    const events = [];
    for (const character of text) {
      if (character === '\n') {
        if (!dropping) {
          const event = parseLine(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
          if (event) events.push(event);
        }
        pending = '';
        dropping = false;
      } else if (!dropping) {
        if (pending.length >= MAX_PROGRESS_LINE_LENGTH) { pending = ''; dropping = true; }
        else pending += character;
      }
    }
    if (flush && !dropping && pending) {
      const event = parseLine(pending);
      if (event) events.push(event);
    }
    if (flush) pending = '';
    return events;
  };

  return {
    write(chunk) {
      if (ended) return [];
      return consume(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk));
    },
    end() {
      if (ended) return [];
      ended = true;
      return consume(decoder.end(), true);
    },
  };
}
