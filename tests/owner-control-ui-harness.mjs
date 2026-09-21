import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const APP_PATH = new URL('../src/control/web/app.js', import.meta.url);

class TestElement {
  #text = '';
  #listeners = new Map();

  constructor(tagName, id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.files = [];
    this.value = '';
    this.className = '';
    this.type = '';
  }

  get textContent() {
    return this.#text + this.children.map(child => child.textContent).join('');
  }

  set textContent(value) {
    this.#text = String(value);
    this.children = [];
  }

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  append(...children) {
    this.children.push(...children);
  }

  dispatch(type, options = {}) {
    if (type === 'click' && this.disabled && !options.force) return Promise.resolve([]);
    const event = Object.freeze({ currentTarget: this, target: this, type });
    const results = (this.#listeners.get(type) ?? []).map(listener => listener(event));
    return Promise.allSettled(results.map(result => Promise.resolve(result)));
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    }
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function createOwnerControlUi(options = {}) {
  const origin = options.origin ?? 'http://127.0.0.1:43127';
  let now = options.now ?? Date.parse('2026-09-14T12:00:00.000Z');
  let nextTimerId = 1;
  const timers = new Map();
  const fetchPlans = [];
  const fetchCalls = [];
  const consoleCalls = [];
  const storageCalls = [];
  const ids = [
    'pairing', 'console', 'bootstrap-file', 'status', 'actions', 'review-panel',
    'review', 'pair', 'refresh', 'service-refresh', 'sign-out', 'approve', 'cancel',
    'service-dashboard', 'service-lifecycle', 'service-limits', 'service-barriers',
    'chat-thread', 'chat-work', 'chat-text', 'send-chat', 'jobs', 'job-result', 'refresh-jobs', 'reminders',
    'reminder-work', 'reminder-due', 'create-reminder', 'execute', 'readback'
  ];
  const elements = new Map(ids.map(id => [id, new TestElement('div', id)]));
  elements.get('pairing').hidden = false;
  elements.get('console').hidden = true;
  elements.get('review-panel').hidden = true;
  elements.get('service-dashboard').hidden = true;

  class ClockDate extends Date {
    static now() {
      return now;
    }
  }

  const document = {
    getElementById(id) {
      return elements.get(id) ?? null;
    },
    createElement(tagName) {
      return new TestElement(tagName);
    }
  };

  const storage = new Proxy({}, {
    get(_target, property) {
      storageCalls.push(String(property));
      throw new Error('Persistent browser storage must not be accessed.');
    }
  });

  const context = vm.createContext({
    console: new Proxy({}, {
      get(_target, property) {
        return (...values) => consoleCalls.push([String(property), ...values]);
      }
    }),
    Date: ClockDate,
    document,
    fetch: async (path, init = {}) => {
      fetchCalls.push({ path, init: structuredClone(init) });
      const plan = fetchPlans.shift();
      if (plan === undefined) throw new Error(`Unexpected fetch: ${path}`);
      if (typeof plan === 'function') return plan(path, init);
      return plan;
    },
    location: Object.freeze({ origin }),
    localStorage: storage,
    sessionStorage: storage,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, deadline: now + Number(delay) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    structuredClone
  });

  vm.runInContext(readFileSync(APP_PATH, 'utf8'), context, { filename: APP_PATH.pathname });

  return {
    origin,
    fetchCalls,
    consoleCalls,
    storageCalls,
    element(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`Unknown test element: ${id}`);
      return element;
    },
    queueJson(status, body) {
      fetchPlans.push(jsonResponse(status, body));
    },
    queueFetch(plan) {
      fetchPlans.push(plan);
    },
    selectFile(text, size = Buffer.byteLength(text, 'utf8')) {
      elements.get('bootstrap-file').files = [{ size, async text() { return text; } }];
      elements.get('bootstrap-file').value = 'selected';
    },
    async click(id) {
      return elements.get(id).dispatch('click');
    },
    async dispatch(id, type) {
      return elements.get(id).dispatch(type, { force: true });
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    async advanceTo(timestamp) {
      now = timestamp;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.deadline <= now)
        .sort((left, right) => left[1].deadline - right[1].deadline);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
        await this.flush();
      }
    },
    allText() {
      return [...elements.values()].map(element => element.textContent).join('\n');
    }
  };
}

export function response(status, body) {
  return jsonResponse(status, body);
}
