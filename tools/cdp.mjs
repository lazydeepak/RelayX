/**
 * Minimal CDP driver for the live RelayX Electron renderer.
 *
 * Usage:
 *   node tools/cdp.mjs eval "<js expression>"
 *   node tools/cdp.mjs shot <outfile.png>
 *   node tools/cdp.mjs script <file.mjs>      # file default-exports async (page) => {}
 */
import WebSocket from 'ws';
import fs from 'node:fs';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('localhost:3000')) || list[0];
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
let nextId = 1;
const pending = new Map();
const consoleLog = [];

await new Promise((res, rej) => {
  ws.once('open', res);
  ws.once('error', rej);
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLog.push({
      type: msg.params.type,
      text: msg.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '),
    });
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleLog.push({ type: 'exception', text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text });
  }
  if (msg.method === 'Log.entryAdded') {
    consoleLog.push({ type: msg.params.entry.level, text: msg.params.entry.text });
  }
  if (
    msg.method === 'Page.frameNavigated' ||
    msg.method === 'Page.loadEventFired' ||
    msg.method === 'Page.frameStartedLoading' ||
    msg.method === 'Page.frameStoppedLoading' ||
    msg.method === 'Page.navigatedWithinDocument' ||
    msg.method === 'Page.frameRequestedNavigation' ||
    msg.method === 'Page.lifecycleEvent' ||
    msg.method === 'Inspector.targetCrashed' ||
    msg.method === 'Runtime.executionContextsCleared' ||
    (msg.method === 'Network.requestWillBeSent' && msg.params.type === 'Document') ||
    msg.method === 'Log.entryAdded'
  ) {
    const evs = (globalThis.__cdpEvents ||= []);
    let p = '';
    if (msg.method === 'Page.frameNavigated') p = msg.params.frame.url;
    else if (msg.method === 'Network.requestWillBeSent') p = msg.params.request.url + ' type=' + msg.params.type;
    else if (msg.method === 'Page.frameRequestedNavigation') p = 'url=' + msg.params.url + ' reason=' + msg.params.reason;
    else if (msg.method === 'Page.lifecycleEvent') p = msg.params.name;
    else if (msg.method === 'Log.entryAdded') p = msg.params.entry.level + ': ' + msg.params.entry.text;
    else if (msg.method === 'Inspector.targetCrashed') p = 'CRASH';
    else p = '';
    evs.push({ t: Date.now(), method: msg.method, params: p });
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');
await send('Inspector.enable').catch(() => {});

const pageObj = {
  send,
  consoleLog,
  async evaluate(expression) {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlocklistedAPI: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        'eval error: ' +
          (r.exceptionDetails.exception?.description || r.exceptionDetails.text) +
          (r.exceptionDetails.exception?.value ? ' :: ' + r.exceptionDetails.exception.value : ''),
      );
    }
    return r.result?.value;
  },
  async shot(file) {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  },
};

const [, , cmd, arg] = process.argv;
try {
  if (cmd === 'eval') {
    const out = await pageObj.evaluate(arg);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } else if (cmd === 'shot') {
    console.log(await pageObj.shot(arg));
  } else if (cmd === 'script') {
    const mod = await import(new URL(arg, `file://${process.cwd()}/`).href);
    await mod.default(pageObj);
  } else {
    console.log('usage: eval|shot|script');
  }
} finally {
  if (consoleLog.length) console.error('--- console ---\n' + consoleLog.map((l) => `[${l.type}] ${l.text}`).join('\n'));
  ws.close();
}
