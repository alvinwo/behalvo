import { EXTENSION_ALLOWED_ORIGIN, EXTENSION_NATIVE_HOST, validateExtensionRequest,
  validateExtensionCancellationResponse, validateExtensionControlResponse, validateExtensionNativeMessage, validateExtensionResponse,
  validateExtensionSnapshot, type ExtensionGestureCommit, type ExtensionRequest,
  type ExtensionGestureCancel, type ExtensionSessionControl } from './protocol.js';

interface MessageSender { origin?: string; tab?: { id?: number; url?: string } }
interface NativePort {
  postMessage(value: unknown): void;
  disconnect(): void;
  onMessage: { addListener(callback: (value: unknown) => void): void };
}

class SupersededNativeMessageError extends Error {
  constructor() { super('Browser request was superseded.'); this.name = 'SupersededNativeMessageError'; }
}

export async function dispatchNativePortMessage(boundary: (value: unknown) => Promise<unknown>,
  port: Pick<NativePort, 'postMessage' | 'disconnect'>, value: unknown): Promise<void> {
  try { port.postMessage(await boundary(value)); }
  catch (error) { if (!(error instanceof SupersededNativeMessageError)) port.disconnect(); }
}

export function createBackgroundBoundary(sendNative: (value: unknown) => Promise<unknown>) {
  return async (value: unknown, sender: MessageSender): Promise<unknown> => {
    const request = validateExtensionRequest(value);
    if (sender.origin !== EXTENSION_ALLOWED_ORIGIN || sender.tab?.id !== request.tabId ||
        !sender.tab.url?.startsWith(`${EXTENSION_ALLOWED_ORIGIN}/`) || request.origin !== sender.origin)
      throw new Error('Browser sender binding is invalid.');
    const response = validateExtensionResponse(await sendNative(request));
    validateResponseBinding(request, response);
    return response;
  };
}

export function createNativeRequestBoundary(
  sendContent: (tabId: number, request: unknown) => Promise<unknown>) {
  let active: ExtensionSessionControl | undefined;
  let activeDocumentId: string | undefined;
  let lastSequence = 0;
  let pending: PendingBrowserOperation | undefined;
  const settledOperations = new Map<string, PendingBrowserOperation>();
  const retiredBindings = new Map<string, ExtensionSessionControl>();
  const controls = new Set<string>();
  return async (value: unknown): Promise<unknown> => {
    const message = validateExtensionNativeMessage(value);
    if (message.kind === 'session.activate') {
      useControl(controls, message.controlId);
      if (active || pending) bindingError();
      await announceRetiredBindings(sendContent, retiredBindings, message.tabId);
      const contentResponse = validateContentControlResponse(await sendContent(message.tabId, message), message,
        'session.activated');
      const response = validateExtensionControlResponse(stripDocumentId(contentResponse));
      assertControlResponse(message, response, 'session.activated');
      active = { ...message }; activeDocumentId = contentResponse.documentId; lastSequence = 0;
      return response;
    }
    if (message.kind === 'session.revoke') {
      useControl(controls, message.controlId);
      if (!active || !sameBinding(active, message)) bindingError();
      rememberRetiredBinding(retiredBindings, message);
      if (pending) pending.state = 'cancelled';
      active = undefined; activeDocumentId = undefined; pending = undefined;
      const contentResponse = validateContentControlResponse(await sendContent(message.tabId, message), message,
        'session.revoked');
      const response = validateExtensionControlResponse(stripDocumentId(contentResponse));
      assertControlResponse(message, response, 'session.revoked');
      return response;
    }
    if (message.kind === 'gesture.cancel') {
      useControl(controls, message.controlId);
      const operation = pending;
      if (!active || !sameBinding(active, message)) bindingError();
      if (!operation) {
        const settled = settledOperations.get(message.operationId);
        if (!settled || !sameOperation(settled, message)) bindingError();
        return validateExtensionCancellationResponse({ ...message, kind: 'gesture.settled' });
      }
      if (!sameOperation(operation, message)) bindingError();
      if (operation.state === 'binding' || operation.state === 'preparing') {
        operation.state = 'cancelled'; operation.cancellation = { ...message }; pending = undefined;
        return validateExtensionCancellationResponse({ ...message, kind: 'gesture.cancelled' });
      }
      if (!operation.documentId || operation.state === 'cancelled') bindingError();
      if (activeDocumentId !== operation.documentId) bindingError();
      operation.cancellation = { ...message };
      const contentMessage = { ...message, documentId: operation.documentId };
      operation.cancellationCompletion = (async () => {
        const response = validateExtensionCancellationResponse(stripDocumentId(
          validateContentCancellationResponse(await sendContent(message.tabId, contentMessage), contentMessage)));
        if (response.controlId !== message.controlId || response.requestId !== message.requestId ||
            response.sequence !== message.sequence || response.operationId !== message.operationId ||
            !sameBinding(response, message)) bindingError();
        operation.state = response.kind === 'gesture.cancelled' ? 'cancelled' : 'settled';
        if (response.kind === 'gesture.settled') rememberSettled(settledOperations, operation);
        if (pending === operation) pending = undefined;
        return response;
      })();
      return operation.cancellationCompletion;
    }
    if (message.kind === 'gesture.commit') {
      useControl(controls, message.controlId);
      const operation = pending;
      if (!active || !operation || operation.state !== 'prepared' || !operation.documentId ||
          activeDocumentId !== operation.documentId || !sameBinding(active, message) ||
          operation.request.requestId !== message.requestId || operation.request.sequence !== message.sequence ||
          operation.operationId !== message.operationId) bindingError();
      remainingOperationTime(operation.expiresAt);
      operation.state = 'committing';
      const raw = await sendContent(message.tabId, { ...message, documentId: operation.documentId });
      // Content can reject an already-cancelled commit before its cancellation
      // acknowledgement arrives. Only that validated outcome can supersede it.
      await operation.cancellationCompletion;
      if (operationWasCancelled(operation)) supersededMessage();
      const snapshot = validateExtensionSnapshot(raw);
      operation.state = 'settled'; rememberSettled(settledOperations, operation);
      if (pending === operation) pending = undefined;
      return responseFor(operation.request, snapshot, 'result');
    }
    const request = validateExtensionRequest(message);
    if (!active || !sameBinding(active, request) || request.sequence !== lastSequence + 1) bindingError();
    const operationBinding = active;
    let operation: NonNullable<typeof pending> | undefined;
    if (request.kind === 'gesture') {
      if (pending) bindingError();
      operation = { request, operationId: request.operationId!,
        expiresAt: request.operationExpiresAt!, state: 'binding' };
      remainingOperationTime(operation.expiresAt);
      pending = operation;
    }
    const documentId = await bindContentDocument(sendContent, operationBinding, request, lastSequence);
    if (active !== operationBinding || (operation && pending !== operation)) {
      await retireStaleDocument(sendContent, operationBinding, documentId);
      if (operation && operationWasCancelled(operation)) supersededMessage();
      bindingError();
    }
    activeDocumentId = documentId;
    lastSequence = request.sequence;
    if (request.kind === 'gesture') {
      if (!operation || pending !== operation) bindingError();
      operation.documentId = documentId;
      operation.state = 'preparing';
      try {
        remainingOperationTime(operation.expiresAt);
        const contentRequest = { ...request, documentId };
        const snapshot = validateExtensionSnapshot(await sendContent(request.tabId, contentRequest));
        if (operationWasCancelled(operation)) {
          await cleanupCancelledPreparation(sendContent, operation);
          supersededMessage();
        }
        if (active !== operationBinding || pending !== operation) bindingError();
        remainingOperationTime(operation.expiresAt);
        operation.state = 'prepared';
        return responseFor(request, snapshot, 'gesture.prepared');
      } catch (error) { if (pending === operation) pending = undefined; throw error; }
    }
    const snapshot = validateExtensionSnapshot(await sendContent(request.tabId, { ...request, documentId }));
    if (active !== operationBinding) bindingError();
    return responseFor(request, snapshot, 'result');
  };
}

function responseFor(request: ExtensionRequest, snapshot: Record<string, unknown>,
  kind: 'result' | 'gesture.prepared'): unknown {
  const response = { protocolVersion: request.protocolVersion, kind, requestId: request.requestId,
    profileId: request.profileId, connectionGeneration: request.connectionGeneration, epoch: request.epoch,
    serviceGeneration: request.serviceGeneration, origin: request.origin, tabId: request.tabId,
    sequence: request.sequence, pageState: snapshot.state, snapshot };
  return kind === 'result' ? validateExtensionResponse(response) : response;
}

interface ExtensionBindingLike {
  profileId: string; connectionGeneration: number; epoch: string; serviceGeneration: string;
  origin: string; tabId: number;
}

interface PendingBrowserOperation {
  request: ExtensionRequest;
  operationId: string;
  expiresAt: number;
  documentId?: string;
  state: 'binding' | 'preparing' | 'prepared' | 'committing' | 'cancelled' | 'settled';
  cancellation?: ExtensionGestureCancel;
  cancellationCompletion?: Promise<ReturnType<typeof validateExtensionCancellationResponse>>;
}

function sameOperation(operation: PendingBrowserOperation,
  message: ExtensionGestureCommit | ExtensionGestureCancel): boolean {
  return operation.request.requestId === message.requestId && operation.request.sequence === message.sequence &&
    operation.operationId === message.operationId && sameBinding(operation.request, message);
}

function rememberSettled(settled: Map<string, PendingBrowserOperation>, operation: PendingBrowserOperation): void {
  settled.set(operation.operationId, operation);
  if (settled.size > 1_000) settled.delete(settled.keys().next().value!);
}

function bindingKey(binding: ExtensionBindingLike): string {
  return [binding.profileId, binding.connectionGeneration, binding.epoch, binding.serviceGeneration,
    binding.origin, binding.tabId].join('\0');
}

function rememberRetiredBinding(retired: Map<string, ExtensionSessionControl>,
  binding: ExtensionSessionControl): void {
  retired.set(bindingKey(binding), { ...binding, kind: 'session.revoke' });
  if (retired.size > 1_000) retired.delete(retired.keys().next().value!);
}

async function announceRetiredBindings(sendContent: (tabId: number, request: unknown) => Promise<unknown>,
  retired: Map<string, ExtensionSessionControl>, tabId: number): Promise<void> {
  for (const binding of retired.values()) {
    if (binding.tabId !== tabId) continue;
    const control: ExtensionSessionControl = { ...binding, kind: 'session.revoke',
      controlId: globalThis.crypto.randomUUID() };
    try { validateContentControlResponse(await sendContent(tabId, control), control, 'session.revoked'); }
    catch { /* this document already retired the binding or owns a different current epoch */ }
  }
}

function operationWasCancelled(operation: PendingBrowserOperation): boolean {
  return operation.state === 'cancelled';
}

async function cleanupCancelledPreparation(sendContent: (tabId: number, request: unknown) => Promise<unknown>,
  operation: PendingBrowserOperation): Promise<void> {
  if (!operation.cancellation || !operation.documentId) return;
  const message = { ...operation.cancellation, documentId: operation.documentId };
  try { validateContentCancellationResponse(await sendContent(message.tabId, message), message); }
  catch { /* the preparation never installed mutation authority */ }
}

async function retireStaleDocument(sendContent: (tabId: number, request: unknown) => Promise<unknown>,
  binding: ExtensionSessionControl, documentId: string): Promise<void> {
  const control: ExtensionSessionControl = { ...binding, kind: 'session.revoke',
    controlId: globalThis.crypto.randomUUID() };
  try {
    const response = validateContentControlResponse(await sendContent(control.tabId, control), control,
      'session.revoked');
    if (response.documentId !== documentId) bindingError();
  } catch { /* already retired or replaced again; no stale authority is accepted by background */ }
}

function sameBinding(left: ExtensionBindingLike, right: ExtensionBindingLike): boolean {
  return left.profileId === right.profileId && left.connectionGeneration === right.connectionGeneration &&
    left.epoch === right.epoch && left.serviceGeneration === right.serviceGeneration &&
    left.origin === right.origin && left.tabId === right.tabId;
}

function useControl(controls: Set<string>, controlId: string): void {
  if (controls.has(controlId)) bindingError();
  controls.add(controlId);
  if (controls.size > 1_000) controls.delete(controls.values().next().value!);
}

function assertControlResponse(request: ExtensionSessionControl | ExtensionGestureCommit,
  response: ReturnType<typeof validateExtensionControlResponse>, kind: 'session.activated' | 'session.revoked'): void {
  if (response.kind !== kind || response.controlId !== request.controlId || !sameBinding(response, request))
    bindingError();
}

function bindingError(): never { throw new Error('Browser message binding or replay is invalid.'); }
function supersededMessage(): never { throw new SupersededNativeMessageError(); }

function monotonicBackgroundNow(): number { return performance.timeOrigin + performance.now(); }

function remainingOperationTime(expiresAt: number): number {
  const remaining = Math.ceil(expiresAt - monotonicBackgroundNow());
  if (remaining < 1 || remaining > 60_000) bindingError();
  return remaining;
}

async function bindContentDocument(sendContent: (tabId: number, request: unknown) => Promise<unknown>,
  active: ExtensionSessionControl, request: ExtensionRequest, lastSequence: number): Promise<string> {
  const control = { protocolVersion: 1, kind: 'document.bind', controlId: request.requestId,
    profileId: active.profileId, connectionGeneration: active.connectionGeneration, epoch: active.epoch,
    serviceGeneration: active.serviceGeneration, origin: active.origin, tabId: active.tabId, lastSequence };
  const raw = await sendContent(active.tabId, control);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bindingError();
  const response = raw as Record<string, unknown>;
  const keys = ['protocolVersion', 'kind', 'controlId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId', 'lastSequence', 'documentId'].sort();
  if (Object.keys(response).sort().join('\0') !== keys.join('\0') || response.kind !== 'document.bound' ||
      response.protocolVersion !== 1 || response.controlId !== control.controlId || response.lastSequence !== lastSequence ||
      !sameBinding(active, response as unknown as ExtensionBindingLike)) bindingError();
  return extensionIdentifier(response.documentId);
}

interface ContentControlResponse extends ExtensionBindingLike {
  protocolVersion: 1; kind: 'session.activated' | 'session.revoked'; controlId: string; documentId: string;
}

function validateContentControlResponse(value: unknown, request: ExtensionSessionControl,
  kind: ContentControlResponse['kind']): ContentControlResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bindingError();
  const response = value as Record<string, unknown>;
  const keys = ['protocolVersion', 'kind', 'controlId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId', 'documentId'].sort();
  if (Object.keys(response).sort().join('\0') !== keys.join('\0') || response.protocolVersion !== 1 ||
      response.kind !== kind || response.controlId !== request.controlId ||
      !sameBinding(request, response as unknown as ExtensionBindingLike)) bindingError();
  return structuredClone({ ...response, documentId: extensionIdentifier(response.documentId) }) as ContentControlResponse;
}

function validateContentCancellationResponse(value: unknown,
  request: ExtensionBindingLike & { kind: 'gesture.cancel'; controlId: string; requestId: string;
    sequence: number; operationId: string; documentId: string }): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bindingError();
  const response = value as Record<string, unknown>;
  const keys = ['protocolVersion', 'kind', 'controlId', 'profileId', 'connectionGeneration', 'epoch',
    'serviceGeneration', 'origin', 'tabId', 'requestId', 'sequence', 'operationId', 'documentId'].sort();
  if (Object.keys(response).sort().join('\0') !== keys.join('\0') ||
      (response.kind !== 'gesture.cancelled' && response.kind !== 'gesture.settled') ||
      response.documentId !== request.documentId) bindingError();
  return response;
}

function stripDocumentId<T extends object>(value: T): Omit<T, 'documentId'> {
  const { documentId: _, ...response } = value as T & { documentId: unknown };
  return response;
}

function extensionIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) bindingError();
  return value;
}

function validateResponseBinding(request: ReturnType<typeof validateExtensionRequest>, value: unknown): void {
  const response = value as Record<string, unknown>;
  for (const key of ['requestId', 'profileId', 'connectionGeneration', 'epoch', 'serviceGeneration', 'origin', 'tabId', 'sequence'])
    if (response[key] !== request[key as keyof typeof request]) throw new Error('Browser response binding is invalid.');
}

declare const chrome: undefined | {
  runtime: {
    connectNative(name: string): NativePort;
    lastError?: unknown;
  };
  tabs: { sendMessage(tabId: number, value: unknown, callback: (response: unknown) => void): void };
};

if (typeof chrome !== 'undefined') {
  const port = chrome.runtime.connectNative(EXTENSION_NATIVE_HOST);
  const boundary = createNativeRequestBoundary((tabId, request) => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, request, response => chrome.runtime.lastError
      ? reject(new Error('Browser content boundary is unavailable.')) : resolve(response));
  }));
  port.onMessage.addListener(value => {
    void dispatchNativePortMessage(boundary, port, value);
  });
}
