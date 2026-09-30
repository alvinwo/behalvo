type PopupStatus =
  { state: 'disconnected' | 'enrolling' | 'invalidated' } |
  { state: 'enrolled'; tabId: number; origin: string };

interface PopupResponse {
  ok: boolean;
  error?: 'bridge_enrollment_failed';
  status: PopupStatus;
}

declare const chrome: {
  runtime: {
    lastError?: { message?: string };
    sendMessage(value: unknown, callback: (response: unknown) => void): void;
  };
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('Bridge popup markup is invalid.');
  return element;
}

const enrollmentInput = requiredElement<HTMLInputElement>('#enrollment');
const connectButton = requiredElement<HTMLButtonElement>('#connect');
const statusText = requiredElement<HTMLElement>('#status');

function send(value: unknown): Promise<PopupResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(value, response => {
      if (chrome.runtime.lastError) { reject(new Error('Bridge popup request failed.')); return; }
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        reject(new Error('Bridge popup response is invalid.'));
        return;
      }
      resolve(response as PopupResponse);
    });
  });
}

function render(response: PopupResponse): void {
  if (!response.ok) {
    statusText.textContent = response.status.state === 'invalidated'
      ? 'Connection invalidated. Restart the synthetic browser run.'
      : 'Connection failed. Check the synthetic tab and enrollment value.';
    connectButton.disabled = response.status.state === 'invalidated';
    return;
  }
  if (response.status.state === 'enrolled') {
    statusText.textContent = 'Connected to the synthetic tab.';
    connectButton.disabled = true;
    enrollmentInput.value = '';
    return;
  }
  statusText.textContent = response.status.state === 'enrolling'
    ? 'Connecting…' : 'Not connected.';
}

connectButton.addEventListener('click', () => {
  const enrollment = enrollmentInput.value.trim();
  connectButton.disabled = true;
  statusText.textContent = 'Connecting…';
  void send({ kind: 'bridge.enroll.request', enrollment }).then(render, () => {
    statusText.textContent = 'Connection failed.';
    connectButton.disabled = false;
  });
});

void send({ kind: 'bridge.status.request' }).then(render, () => {
  statusText.textContent = 'Bridge status unavailable.';
});
