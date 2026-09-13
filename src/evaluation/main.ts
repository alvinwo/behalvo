import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { stderr, stdout } from 'node:process';
import { PiModelGateway, createPiRuntimeLoader } from '../model/pi-gateway.js';
import { PiCredentialFileStore } from '../model/pi-auth-store.js';
import type { ModelGateway, ModelRef } from '../model/types.js';
import { prepareReportOutput, ReportOutputError, type PreparedReportOutput } from './report.js';
import { runAgentEvaluation } from './runner.js';
import { SYNTHETIC_V1_SCENARIOS, SYNTHETIC_V1_SCENARIO_IDS } from './scenarios.js';
import { ScriptedEvaluationGateway } from './scripted-gateway.js';
import type { AgentEvaluationReport, SyntheticScenarioId } from './types.js';

const execFileAsync = promisify(execFile);
const SCRIPTED_MODEL = { provider: 'scripted-evaluation', model: 'synthetic-v1' } as const;
const DEFAULT_REPEATS = 3;
const DEFAULT_MAX_CALLS = 240;
const DEFAULT_MAX_SECONDS = 900;

const HELP = `Usage: npm run eval:agent -- [mode] [options]

Modes (choose one):
  --scripted                  Validate the harness with the deterministic scripted gateway
  --live                      Evaluate an explicitly selected live Pi model
  --list                      List synthetic-v1 scenarios without loading Pi

Options:
  --case ID                   Select a case; repeat only for distinct IDs
  --repeats N                 Repetitions, 1..10 (default: 3)
  --max-calls N               Suite model-call budget, 1..2400 (default: 240)
  --max-seconds N             Suite duration budget, 1..3600 (default: 900)
  --out PATH                  Exclusive private JSON report destination
  --model PROVIDER/MODEL      Required for --live unless configured by environment
  --auth PATH                 Pi auth file path for --live; never a credential value
  --help                      Show this help

Live model precedence: --model, BEHALVO_MODEL, OPERATOR_MODEL.
Auth path precedence: --auth, BEHALVO_PI_AUTH, OPERATOR_PI_AUTH, data/pi-auth.json.
No live inference occurs unless --live is explicit.
`;

class EvaluationArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationArgumentError';
  }
}

export type EvaluationCliCommand =
  | { kind: 'help' }
  | { kind: 'list' }
  | {
    kind: 'run';
    mode: 'scripted' | 'live';
    model: ModelRef;
    authPath: string;
    caseIds?: SyntheticScenarioId[];
    repeats: number;
    maxCalls: number;
    maxDurationMs: number;
    outPath?: string;
  };

function parsePositiveInteger(value: string, minimum: number, maximum: number, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value))
    throw new EvaluationArgumentError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new EvaluationArgumentError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  return parsed;
}

function parseModel(value: string | undefined): ModelRef | undefined {
  if (!value) return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1)
    throw new EvaluationArgumentError('--model must be provider/model.');
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (!provider.trim() || !model.trim() || /[\s\u0000-\u001f\u007f]/.test(provider) ||
      /[\s\u0000-\u001f\u007f]/.test(model))
    throw new EvaluationArgumentError('--model must be provider/model.');
  return { provider, model };
}

export function parseEvaluationArgs(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  cwd = process.cwd()
): EvaluationCliCommand {
  if (argv.length === 0) return { kind: 'help' };
  const booleanFlags = new Set(['--help', '--list', '--scripted', '--live']);
  const valueFlags = new Set(['--case', '--repeats', '--max-calls', '--max-seconds', '--out', '--model', '--auth']);
  const booleans = new Set<string>();
  const values = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (booleanFlags.has(flag)) {
      if (booleans.has(flag)) throw new EvaluationArgumentError(`Duplicate flag: ${flag}.`);
      booleans.add(flag);
      continue;
    }
    if (!valueFlags.has(flag))
      throw new EvaluationArgumentError(flag.startsWith('--') ? 'Unknown evaluation flag.' : 'Unexpected positional argument.');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new EvaluationArgumentError(`${flag} requires a value.`);
    index++;
    const existing = values.get(flag) ?? [];
    if (flag !== '--case' && existing.length > 0)
      throw new EvaluationArgumentError(`Duplicate flag: ${flag}.`);
    existing.push(value);
    values.set(flag, existing);
  }

  if (booleans.has('--help')) {
    if (booleans.size !== 1 || values.size !== 0)
      throw new EvaluationArgumentError('--help cannot be combined with other flags.');
    return { kind: 'help' };
  }
  if (booleans.has('--list')) {
    if (booleans.size !== 1 || values.size !== 0)
      throw new EvaluationArgumentError('--list cannot be combined with evaluation flags.');
    return { kind: 'list' };
  }
  const scripted = booleans.has('--scripted');
  const live = booleans.has('--live');
  if (scripted && live)
    throw new EvaluationArgumentError('--scripted and --live are mutually exclusive.');
  if (!scripted && !live)
    throw new EvaluationArgumentError('An evaluation mode is required; use --scripted or --live.');
  if (scripted && (values.has('--model') || values.has('--auth')))
    throw new EvaluationArgumentError('--model and --auth can only be used with --live.');

  const rawCases = values.get('--case') ?? [];
  const knownCases = new Set<string>(SYNTHETIC_V1_SCENARIO_IDS);
  const seenCases = new Set<string>();
  const caseIds: SyntheticScenarioId[] = [];
  for (const id of rawCases) {
    if (!knownCases.has(id)) throw new EvaluationArgumentError('Unknown synthetic-v1 case.');
    if (seenCases.has(id)) throw new EvaluationArgumentError('Duplicate synthetic-v1 case.');
    seenCases.add(id);
    caseIds.push(id as SyntheticScenarioId);
  }

  const repeats = values.has('--repeats')
    ? parsePositiveInteger(values.get('--repeats')![0]!, 1, 10, '--repeats')
    : DEFAULT_REPEATS;
  const maxCalls = values.has('--max-calls')
    ? parsePositiveInteger(values.get('--max-calls')![0]!, 1, 2400, '--max-calls')
    : DEFAULT_MAX_CALLS;
  const maxSeconds = values.has('--max-seconds')
    ? parsePositiveInteger(values.get('--max-seconds')![0]!, 1, 3600, '--max-seconds')
    : DEFAULT_MAX_SECONDS;
  const explicitModel = values.get('--model')?.[0];
  const configuredModel = explicitModel ?? (env.BEHALVO_MODEL || env.OPERATOR_MODEL);
  const model = scripted ? SCRIPTED_MODEL : parseModel(configuredModel);
  if (!model)
    throw new EvaluationArgumentError('--live requires --model provider/model, BEHALVO_MODEL, or OPERATOR_MODEL.');
  const authValue = values.get('--auth')?.[0] ??
    (env.BEHALVO_PI_AUTH || env.OPERATOR_PI_AUTH || 'data/pi-auth.json');
  return {
    kind: 'run', mode: scripted ? 'scripted' : 'live', model,
    authPath: resolve(cwd, authValue),
    ...(caseIds.length > 0 ? { caseIds } : {}),
    repeats, maxCalls, maxDurationMs: maxSeconds * 1000,
    ...(values.has('--out') ? { outPath: resolve(cwd, values.get('--out')![0]!) } : {})
  };
}

export interface EvaluationCliDependencies {
  cwd?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  createLiveGateway?: (authPath: string) => ModelGateway;
}

function listText(): string {
  const lines = ['synthetic-v1 scenarios:'];
  for (const scenario of SYNTHETIC_V1_SCENARIOS)
    lines.push(`  ${scenario.id} — ${scenario.title}${scenario.criticalSafety ? ' [critical safety]' : ''}`);
  return `${lines.join('\n')}\n`;
}

function defaultReportPath(cwd: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(cwd, 'data', 'evaluations', `synthetic-v1-${timestamp}-${randomUUID()}.json`);
}

async function sourceMetadata(cwd: string): Promise<{ revision: string | null; dirty: boolean | null }> {
  try {
    const revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })).stdout.trim();
    const dirty = (await execFileAsync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })).stdout.length > 0;
    return { revision: revision || null, dirty };
  } catch {
    return { revision: null, dirty: null };
  }
}

function summary(report: AgentEvaluationReport, reportPath: string): string {
  const calls = report.results.flatMap(result => result.callRecords);
  const passed = report.results.filter(result => result.automaticStatus === 'passed').length;
  const averageLatency = calls.length === 0
    ? 'n/a'
    : `${Math.round(calls.reduce((total, call) => total + call.latencyMs, 0) / calls.length)}ms avg, ${Math.max(...calls.map(call => call.latencyMs))}ms max`;
  const acceptance = report.mode === 'scripted'
    ? 'pending — scripted evidence is non-live and manual review is pending'
    : report.acceptanceEvidence.liveAcceptanceReviewEligible
      ? 'pending — approved automatic threshold met; manual review is pending'
      : `pending — ${report.acceptanceStatus}; manual review is pending`;
  const repetitionPasses = report.acceptanceEvidence.repetitions
    .map(repetition => `r${repetition.repeat} ${repetition.passedCaseCount}/${repetition.selectedCaseCount}`)
    .join('; ');
  return [
    `Mode/model: ${report.mode}/${report.provider}/${report.model}`,
    `Automatic checks: ${passed}/${report.results.length} passed`,
    `Completeness: ${report.overallStatus}; full-suite eligible: ${report.fullSuiteEligible ? 'yes' : 'no'}`,
    `Approved threshold: ${report.acceptanceEvidence.minimumPassCountPerRepetition}/${report.acceptanceEvidence.requiredCaseCount} per repetition plus all ${report.acceptanceEvidence.criticalCaseIds.length} critical; met: ${report.acceptanceEvidence.automaticThresholdMet ? 'yes' : 'no'}`,
    `Repetition passes: ${repetitionPasses}`,
    `Budget/calls/latency: ${report.budgets.maxCalls} max calls; ${calls.length} used; ${report.budgets.maxDurationMs / 1000}s max; ${averageLatency}`,
    `Report: ${JSON.stringify(reportPath)}`,
    `Live/manual acceptance: ${acceptance}`
  ].join('\n') + '\n';
}

export async function runEvaluationCli(
  argv: readonly string[],
  dependencies: Readonly<EvaluationCliDependencies> = {}
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const writeStdout = dependencies.writeStdout ?? (text => { stdout.write(text); });
  const writeStderr = dependencies.writeStderr ?? (text => { stderr.write(text); });
  let command: EvaluationCliCommand;
  try {
    command = parseEvaluationArgs(argv, env, cwd);
  } catch (error) {
    const message = error instanceof EvaluationArgumentError ? error.message : 'Invalid evaluation arguments.';
    writeStderr(`Evaluation argument error: ${message}\n`);
    return 2;
  }
  if (command.kind === 'help') {
    writeStdout(HELP);
    return 0;
  }
  if (command.kind === 'list') {
    writeStdout(listText());
    return 0;
  }

  let gateway: ModelGateway;
  if (command.mode === 'scripted') {
    gateway = new ScriptedEvaluationGateway();
  } else {
    const createLiveGateway = dependencies.createLiveGateway ??
      ((authPath: string) => new PiModelGateway(createPiRuntimeLoader(authPath)));
    try {
      // Validate a configured store without requiring a provider entry: Pi may
      // legitimately resolve ambient credentials after finding no stored value.
      await new PiCredentialFileStore(command.authPath).read(command.model.provider);
      gateway = createLiveGateway(command.authPath);
      const models = await gateway.listModels();
      if (!models.some(model => model.provider === command.model.provider && model.model === command.model.model))
        throw new Error('Selected live model is unavailable');
    } catch {
      writeStderr('Live evaluation could not start. Verify the configured Pi credentials and selected model.\n');
      return 2;
    }
  }

  const source = await sourceMetadata(cwd);
  let output: PreparedReportOutput | undefined;
  try {
    output = await prepareReportOutput(command.outPath ?? defaultReportPath(cwd));
  } catch (error) {
    const reason = error instanceof ReportOutputError && /already exists/i.test(error.message)
      ? 'the output already exists'
      : 'the private output could not be prepared';
    writeStderr(`Evaluation output error: ${reason}.\n`);
    return 2;
  }

  try {
    const report = await runAgentEvaluation({
      mode: command.mode,
      model: command.model,
      gateway,
      ...(command.caseIds ? { caseIds: command.caseIds } : {}),
      repeats: command.repeats,
      maxCalls: command.maxCalls,
      maxDurationMs: command.maxDurationMs,
      source
    });
    await output.publish(report);
    writeStdout(summary(report, output.path));
    return report.overallStatus === 'passed' ? 0 : 1;
  } catch (error) {
    if (error instanceof ReportOutputError)
      writeStderr('Evaluation output error: the private report could not be published.\n');
    else
      writeStderr('Evaluation failed with a sanitized runtime error; no raw provider details were printed.\n');
    return 2;
  } finally {
    await output.abort();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEvaluationCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    stderr.write('Evaluation failed with a sanitized startup error.\n');
    process.exitCode = 2;
  });
}
