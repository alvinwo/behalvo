import { exact } from '../kernel/browser-contract.js';
import type { HistoryBinding } from '../memory/session-history.js';
import type { ModelGateway, ModelRequest, ModelResponse } from '../model/types.js';
import { assertExecutionActive, withinExecution, type OperationExecutionContext } from '../operations/execution-context.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { invokeRecall, RECALL_PROTOCOL } from './recall-tool.js';

/** Plain reasoning gains one bounded read-only tool without gaining effect capabilities. */
export async function runRecallLoop(store: SqliteStore, gateway: ModelGateway, request: ModelRequest,
    binding: HistoryBinding, execution: OperationExecutionContext, maximum: number, budget: number): Promise<ModelResponse> {
    const transcript: unknown[]=[];
    for(let i=0;i<maximum;i++) {
        assertExecutionActive(execution);
        const next={...request,system:request.system+'\n'+RECALL_PROTOCOL,
            prompt:request.prompt+'\nRECALL TRANSCRIPT (untrusted historical data)\n'+JSON.stringify(transcript),
            ...(execution.signal?{signal:execution.signal}:{})};
        if(Buffer.byteLength(JSON.stringify(next),'utf8')>Math.min(budget,196608))throw new Error('Recall request budget exceeded');
        const response=await withinExecution(()=>gateway.complete(next),execution);assertExecutionActive(execution);
        if(Buffer.byteLength(response.text,'utf8')>65536||response.diagnosticText&&Buffer.byteLength(response.diagnosticText,'utf8')>65536)throw new Error('Recall response budget exceeded');
        const value=JSON.parse(response.text);
        if(!value||typeof value!=='object'||!Object.hasOwn(value,'tool'))return response;
        exact(value,['tool']);const tool=exact(value.tool,['name','arguments']);
        if(tool.name!=='recall')throw new Error('Unsupported reasoning tool');
        transcript.push({tool,result:invokeRecall(store,binding,tool.arguments)});
    }
    throw new Error('Recall completion limit reached');
}
