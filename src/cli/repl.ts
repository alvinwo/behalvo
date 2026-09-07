import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { AgentService } from '../runtime/agent-service.js';
import { Operator } from '../runtime/operator.js';
import { buildContext } from '../memory/context.js';
import type { ModelRegistry } from '../model/registry.js';
import type { PiAuthInteraction, PiAuthType } from '../model/pi-gateway.js';
import type { PiCredential } from '../model/pi-auth-store.js';

export interface ReplIo {
  readLine(prompt?: string, signal?: AbortSignal): Promise<string | null>;
  readSecret?(prompt?: string): Promise<string | null>;
  write(line?: string): void;
}

export interface ReplAuthenticator {
  login(providerId: string, type: PiAuthType, interaction: PiAuthInteraction): Promise<PiCredential>;
}

export interface ReplOptions {
  store: SqliteStore;
  registry: ModelRegistry;
  service: AgentService;
  authenticator?: ReplAuthenticator;
  io: ReplIo;
  workspaceId: string;
  ownerId: string;
  initialThreadId?: string;
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
/new [thread-id]              Start a new communication thread
/work                         List durable work
/work <work-id>               Focus work in the current thread
/work clear                   Clear focused work
/state                        Show projected state
/history [limit]              Show recent journal records
/context                      Show the exact bounded context view
/quit                         Exit`;

export async function runRepl(options: ReplOptions): Promise<ReplResult> {
  const { store, registry, service, io, workspaceId, ownerId } = options;
  const operator = new Operator(store);
  let threadId = options.initialThreadId ?? `local-${randomUUID()}`;
  let workId: string | undefined;

  io.write(`Personal Operator — workspace ${workspaceId} — thread ${threadId}`);
  io.write('Use /help for commands.');

  for (;;) {
    const raw = await io.readLine('You > ');
    if (raw === null) return { reason: 'eof', threadId, ...(workId ? { workId } : {}) };
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('/')) {
      const [command, ...args] = line.split(/\s+/);
      try {
        if (command === '/quit')
          return { reason: 'quit', threadId, ...(workId ? { workId } : {}) };
        if (command === '/help') {
          io.write(HELP);
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
              const answer = prompt.type === 'secret'
                ? (io.readSecret ? await io.readSecret('> ') : null)
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
        if (command === '/new') {
          if (args.length > 1) throw new Error('Usage: /new [thread-id]');
          threadId = args[0] ?? `local-${randomUUID()}`;
          workId = undefined;
          io.write(`New thread: ${threadId}`);
          continue;
        }
        if (command === '/work') {
          if (args.length === 0) {
            const works = Object.values(store.state(workspaceId).works);
            if (!works.length) io.write('No durable work.');
            for (const work of works)
              io.write(`${work.id} — ${work.title} [${work.phase}]${work.id === workId ? ' *' : ''}`);
            continue;
          }
          if (args.length !== 1) throw new Error('Usage: /work [work-id|clear]');
          if (args[0] === 'clear') {
            workId = undefined;
            io.write('Focused work cleared.');
            continue;
          }
          const work = store.state(workspaceId).works[args[0]!];
          if (!work) throw new Error(`Work not found: ${args[0]}`);
          if (!work.threadIds.includes(threadId))
            operator.linkThread(workspaceId, ownerId, work.id, threadId);
          workId = work.id;
          io.write(`Focused work: ${work.id} — ${work.title} on thread ${threadId}`);
          continue;
        }
        if (command === '/state') {
          io.write(JSON.stringify(store.state(workspaceId), null, 2));
          continue;
        }
        if (command === '/history') {
          if (args.length > 1) throw new Error('Usage: /history [limit]');
          const limit = args[0] === undefined ? 20 : Number(args[0]);
          if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200)
            throw new Error('History limit must be an integer from 1 to 200');
          const records = store.journal(workspaceId).slice(-limit);
          for (const record of records)
            io.write(`${record.seq} ${record.recordedAt} ${record.event.type} ${record.id}`);
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
        text: line,
        model: selected,
        ...(workId ? { workId } : {})
      });
      if (!workId && result.turn.workProposals.length === 1)
        workId = result.turn.workProposals[0]!.id;
      io.write(`Agent > ${result.turn.reply}`);
    } catch (error) {
      io.write(`Agent error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
