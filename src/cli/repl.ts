import { restoreTaskThread, selectTaskThread } from '../runtime/task-continuity.js';
import { handleSessionCommand } from './session-commands.js';
import { memoryMessage } from '../memory/messages.js';
import { taskStatusLines } from '../runtime/task-messages.js';
import { inputMessage } from './input-messages.js';
import { handleVaultCommand } from './vault-commands.js';
import { vaultMessage } from '../vault/messages.js';
import type { LocalCredentialVault } from '../vault/local-vault.js';
import { authorizeTaskInput, revokeTaskInput } from '../runtime/browser-learning.js';
import { browserMessage } from '../runtime/browser-messages.js';
import { isOperationCommand } from '../operations/validation.js';
import { ActionReview } from './action-review.js';
import type { OperationService } from '../operations/service.js';
import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { AgentService } from '../runtime/agent-service.js';
import { Operator } from '../runtime/operator.js';
import { buildContext } from '../memory/context.js';
import type { ModelRegistry } from '../model/registry.js';
import type { PiAuthInteraction, PiAuthType } from '../model/pi-gateway.js';
import type { PiCredential } from '../model/pi-auth-store.js';
import type { ModelRef } from '../model/types.js';

export interface ReplIo {
  interactive?: boolean;
  discardSensitiveInput?(): void;
  readPrompt?(prompt?: string): Promise<string | null>;
  readLine(prompt?: string, signal?: AbortSignal): Promise<string | null>;
  readSecret?(prompt?: string, signal?: AbortSignal): Promise<string | null>;
  write(line?: string): void;
}

export interface ReplAuthenticator {
  login(providerId: string, type: PiAuthType, interaction: PiAuthInteraction): Promise<PiCredential>;
}

export interface ReplOptions {
  vault?: LocalCredentialVault;
  store: SqliteStore;
  registry: ModelRegistry;
  service: AgentService;
  authenticator?: ReplAuthenticator;
  operations?: OperationService;
  clock?: () => string;
  io: ReplIo;
  workspaceId: string;
  ownerId: string;
  initialThreadId?: string;
  onModelSelected?: (model: ModelRef) => void | Promise<void>;
}

export interface ReplResult {
  reason: 'quit' | 'eof';
  threadId: string;
  workId?: string;
}

const HELP = `Commands:
/help                         Show commands
/model                        List models
/model <provider> <model>     Select model
/login <provider> <oauth|api_key>  Run provider-owned login
/work                         List durable work
/work <work-id>               Focus work in the current thread
/work clear                   Clear focused work
/actions                      Display exact operations for focused work
/approve <action-id> <digest> Approve a command displayed by /actions (ten minutes)
/state                        Show projected state
/context                      Show base context (without loop protocol/transcript)
/quit                         Exit`;

export async function runRepl(options: ReplOptions): Promise<ReplResult> {
  const { store, registry, service, io, workspaceId, ownerId } = options;
  const operator = new Operator(store);
  const review = options.operations ? new ActionReview(store, options.operations, workspaceId, ownerId, options.clock) : undefined;
  const restored=service.continuityEnabled?restoreTaskThread(store,workspaceId,options.initialThreadId):undefined;
  let threadId = restored?.threadId ?? options.initialThreadId ?? `local-${randomUUID()}`;
  let workId: string | undefined = restored?.workId;
  if(service.continuityEnabled)selectTaskThread(store,workspaceId,ownerId,threadId,workId??null,true);

  io.write(`Behalvo — workspace ${workspaceId} — thread ${threadId}`);
  io.write(inputMessage('hint'));

  for (;;) {
    const raw = await (io.readPrompt ? io.readPrompt('You > ') : io.readLine('You > '));
    if (raw === null) return { reason: 'eof', threadId, ...(workId ? { workId } : {}) };
    if (await handleVaultCommand(raw, { ...(options.vault ? { vault: options.vault } : {}), io,
      scope: { workspaceId, ownerId } })) continue;
    const multiline = /[\r\n]/.test(raw);
    const line = raw.trim();
    if (!line) continue;

    if (!multiline && line.startsWith('/')) {
      const [command, ...args] = line.split(/\s+/);
      try {
        const session=handleSessionCommand(store,{workspaceId,ownerId,threadId,...(workId?{workId}:{})},line,service.continuityEnabled,line=>io.write(line));
        if(session){threadId=session.threadId;workId=session.workId;continue;}
        if (command === '/quit')
          return { reason: 'quit', threadId, ...(workId ? { workId } : {}) };
        if (command === '/help') {
          io.write(HELP+'\n'+memoryMessage('help')+'\n'+inputMessage('help')+'\n'+browserMessage('help')+'\n'+vaultMessage('help'));
          continue;
        }
        if(command==='/browser-input'||command==='/browser-revoke') {
          if(!workId)throw new Error(browserMessage('inputUsage'));
          const state=store.state(workspaceId);const work=state.works[workId]!;
          const value=command==='/browser-input'?JSON.parse(line.slice(command.length).trim()):args[0];
          if(command==='/browser-revoke'&&args.length!==1)throw new Error(browserMessage('inputUsage'));
          const record=store.ingest(workspaceId,{source:'owner:browser-input',externalId:randomUUID(),threadId,senderId:ownerId,senderRole:'owner',text:line});
          const binding={workspaceId,ownerId,workId,ownerRecordId:record.id,expectedWorkRevision:work.revision};
          if(command==='/browser-input'){const input=authorizeTaskInput(store,binding,value,true);io.write(browserMessage('inputSaved')+input.id);}
          else {revokeTaskInput(store,binding,value,true);io.write(browserMessage('inputRevoked'));}
          continue;
        }
        if (command === '/model') {
          if (args.length === 0) {
            const selected = registry.selected();
            const models = await registry.listModels();
            io.write(`Selected: ${selected ? `${selected.provider}/${selected.model}` : '(none)'}`);
            for (const model of models)
              io.write(`${model.provider}/${model.model}${model.label ? ` — ${model.label}` : ''}`);
            continue;
          }
          if (args.length !== 2) throw new Error('Usage: /model <provider> <model>');
          const selected = await registry.select(args[0]!, args[1]!);
          io.write(`Model selected: ${selected.provider}/${selected.model}`);
          try {
            await options.onModelSelected?.(selected);
          } catch {
            io.write('Warning: model selection is active for this session but was not saved for restart.');
          }
          continue;
        }
        if (command === '/login') {
          if (args.length !== 2 || !['oauth', 'api_key'].includes(args[1]!))
            throw new Error('Usage: /login <provider> <oauth|api_key>');
          if (!options.authenticator) throw new Error('No model authenticator is configured');
          const interaction: PiAuthInteraction = {
            notify(event) {
              if (event.type === 'auth_url') {
                io.write(event.instructions ?? 'Open this URL to authenticate:');
                io.write(event.url);
              } else if (event.type === 'device_code') {
                io.write(`Open ${event.verificationUri} and enter code ${event.userCode}`);
              } else {
                io.write(event.message);
              }
            },
            async prompt(prompt) {
              prompt.signal?.throwIfAborted();
              if (prompt.type === 'select') {
                io.write(prompt.message);
                for (const option of prompt.options)
                  io.write(`${option.id} — ${option.label}${option.description ? `: ${option.description}` : ''}`);
              } else {
                io.write(prompt.message);
              }
              const answer = prompt.type === 'secret' || prompt.type === 'manual_code'
                ? (io.readSecret ? await io.readSecret('> ', prompt.signal) : null)
                : await io.readLine('> ', prompt.signal);
              if (answer === null) {
                if (prompt.type === 'secret' && !io.readSecret)
                  throw new Error('This terminal does not support hidden secret input');
                throw new Error('Login cancelled');
              }
              prompt.signal?.throwIfAborted();
              return answer.trim();
            }
          };
          const credential = await options.authenticator.login(args[0]!, args[1]! as PiAuthType, interaction);
          io.write(`Login complete for ${args[0]} (${credential.type}).`);
          continue;
        }
        if (command === '/work') {
          if (args.length === 0) {
            const works = Object.values(store.state(workspaceId).works);
            if (!works.length) io.write('No durable work.');
            for (const work of works) {
              io.write(`${work.id} — ${work.title} [${work.phase}]${work.id === workId ? ' *' : ''}`);
              if(service.continuityEnabled)for(const line of taskStatusLines(store.state(workspaceId),work))io.write(line);
            }
            continue;
          }
          if (args.length !== 1) throw new Error('Usage: /work [work-id|clear]');
          if (args[0] === 'clear') {
            if(service.continuityEnabled)selectTaskThread(store,workspaceId,ownerId,threadId,null,true);
            workId = undefined;
            io.write('Focused work cleared.');
            continue;
          }
          const state = store.state(workspaceId);
          const work = state.works[args[0]!];
          if (!work) throw new Error(`Work not found: ${args[0]}`);
          if(service.continuityEnabled&&['done','cancelled'].includes(work.phase))throw new Error('Closed work cannot be focused');
          if (!work.threadIds.includes(threadId)) {
            const pendingApproval = Object.values(state.actions).some(action => action.workId === work.id &&
              isOperationCommand(action.command) && ['proposed', 'approved'].includes(action.status));
            if (pendingApproval) {
              const linkedThread = work.threadIds.at(-1);
              if (!linkedThread) throw new Error('Pending operation work has no linked thread to resume');
              threadId = linkedThread;
              io.write(`Resumed existing work thread ${JSON.stringify(threadId)} to preserve prepared approval revision.`);
            } else {
              if(!service.continuityEnabled)operator.linkThread(workspaceId, ownerId, work.id, threadId);
            }
          }
          if(service.continuityEnabled)selectTaskThread(store,workspaceId,ownerId,threadId,work.id,true);
          workId = work.id;
          io.write(`Focused work: ${work.id} — ${work.title} on thread ${threadId}`);
          continue;
        }
        if (command === '/actions') {
          if (args.length !== 0) throw new Error('Usage: /actions');
          if (!review) throw new Error('Operation service is unavailable');
          review.display(workId, line => io.write(line));
          continue;
        }
        if (command === '/approve') {
          if (!review) throw new Error('Operation service is unavailable');
          io.write(review.approve(args, workId));
          continue;
        }
        if (command === '/state') {
          io.write(JSON.stringify(store.state(workspaceId), null, 2));
          continue;
        }
        if (command === '/context') {
          const packet = buildContext(store, {
            workspaceId, ownerId, threadId,
            ...(workId ? { workId } : {}),
            windowTokens: 64000,
            outputReserve: 8000
          });
          io.write(packet.text);
          continue;
        }
        io.write(`Unknown command: ${command}. Use /help.`);
      } catch (error) {
        io.write(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    const selected = registry.selected();
    if (!selected) {
      io.write('Select a model first with /model <provider> <model>.');
      continue;
    }
    try {
      const result = await service.runOwnerTurn({
        workspaceId,
        ownerId,
        threadId,
        externalId: `local-${randomUUID()}`,
        text: raw,
        model: selected,
        ...(workId ? { workId } : {})
      });
      if (!service.continuityEnabled && !workId && result.turn.workProposals.length === 1)
        workId = result.turn.workProposals[0]!.id;
      io.write(`Agent > ${result.turn.reply}`);
    } catch (error) {
      io.write(`Agent error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if(service.continuityEnabled)workId=restoreTaskThread(store,workspaceId,threadId)?.workId;
    }
  }
}
