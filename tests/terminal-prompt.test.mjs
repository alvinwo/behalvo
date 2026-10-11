import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
const api=()=>import('../dist/cli/terminal-prompt.js');
class Terminal {
 columns=80; rows=24; kittyProtocolActive=false; output=''; stopped=0;
 start(input,resize){this.input=input;this.resize=resize;}
 stop(){this.stopped++;}
 async drainInput(){}
 write(s){this.output+=s;}
 moveBy(){} hideCursor(){} showCursor(){} clearLine(){} clearFromCursor(){} clearScreen(){} setTitle(){} setProgress(){}
 key(s){this.input?.(s);}
}
async function fixture(t){const {TerminalPromptIo}=await api();const terminal=new Terminal();const input=new PassThrough();input.resume();const output=new PassThrough();output.resume();const io=new TerminalPromptIo(input,output,terminal);t.after(()=>io.close());return {io,terminal,input,output};}
test('pasting a multiline block stays editable and sends exactly once after Enter',async t=>{
 const {io,terminal}=await fixture(t);let done=false;const p=io.readPrompt('You > ').then(v=>{done=true;return v;});
 terminal.key('\x1b[200~  first\r\n\r\n/quit\r\n  last  \x1b[201~');await Promise.resolve();assert.equal(done,false);
 terminal.key('\r');assert.equal(await p,'  first\n\n/quit\n  last  ');assert.equal(terminal.stopped,1);
});
test('Ctrl+J, Alt+Enter and Shift+Enter insert newlines; cursor editing works',async t=>{
 const {io,terminal}=await fixture(t);const p=io.readPrompt();
 for(const key of ['one','\n','two','\x1b\r','three','\x1b[13;2u','four','\x1b[D','\x7f','X','\r'])terminal.key(key);
 assert.equal(await p,'one\ntwo\nthree\nfoXr');
});
test('paste inserts exact text at the cursor without file-path spacing heuristics',async t=>{
 const {io,terminal}=await fixture(t);const p=io.readPrompt();
 terminal.key('foo');terminal.key('\x1b[200~/bar\nbaz\x1b[201~');terminal.key('\r');
 assert.equal(await p,'foo/bar\nbaz');
});
test('fragmented paste stays one inert draft and strips terminal controls',async t=>{
 const {StdinBuffer}=await import('@earendil-works/pi-tui');
 const {io,terminal}=await fixture(t);const buffer=new StdinBuffer();t.after(()=>buffer.destroy());
 buffer.on('data',data=>terminal.key(data));buffer.on('paste',text=>terminal.key(`\x1b[200~${text}\x1b[201~`));
 let done=false;const p=io.readPrompt().then(value=>{done=true;return value;});
 for(const chunk of ['\x1b[20','0~/quit\r\n\x1b[31mred\x1b[0m\x03\t','\x1b[106;5uend\x1b[20','1~'])buffer.process(chunk);
 await Promise.resolve();assert.equal(done,false);buffer.process('\r');
 assert.equal(await p,'/quit\nred    \nend');
});
test('large pasted blocks remain visible and editable as text',async t=>{
 const {io,terminal}=await fixture(t);const p=io.readPrompt();const text='long line\n'.repeat(120);
 terminal.key(`\x1b[200~${text}\x1b[201~`);terminal.key('\x7f');terminal.key('!');terminal.key('\r');
 assert.equal(await p,text.slice(0,-1)+'!');
});
test('Ctrl+C clears draft and a second Ctrl+C exits without submitting',async t=>{
 const {io,terminal}=await fixture(t);const p=io.readPrompt();terminal.key('discard');terminal.key('\x03');terminal.key('replacement');terminal.key('\r');assert.equal(await p,'replacement');
 const next=io.readPrompt();terminal.key('\x03');assert.equal(await next,null);
});
test('EOF discards an unsubmitted draft and restores terminal ownership',async t=>{
 const {io,terminal,input}=await fixture(t);const p=io.readPrompt();terminal.key('unfinished');input.end();assert.equal(await p,null);assert.equal(terminal.stopped,1);
});
test('secret prompts use isolated hidden input and cannot populate a later editor',async t=>{
 const {io,terminal,input}=await fixture(t);const secret=io.readSecret('Secret > ');input.write('SYNTHETIC-KEY\n');assert.equal(await secret,'SYNTHETIC-KEY');
 const p=io.readPrompt();terminal.key('\x19');terminal.key('safe');terminal.key('\r');assert.equal(await p,'safe');assert.doesNotMatch(terminal.output,/SYNTHETIC-KEY/);
});
test('oversized draft cannot partially submit',async t=>{
 const {io,terminal}=await fixture(t);let done=false;const p=io.readPrompt().then(v=>{done=true;return v;});terminal.key('\x1b[200~'+'x'.repeat(65537)+'\x1b[201~');terminal.key('\r');await Promise.resolve();assert.equal(done,false);terminal.key('\x03');terminal.key('safe');terminal.key('\r');assert.equal(await p,'safe');
});
test('terminal startup failure rejects and releases prompt ownership',async t=>{
 const {io,terminal}=await fixture(t);terminal.start=()=>{throw new Error('synthetic start failure');};await assert.rejects(io.readPrompt(),/synthetic start failure/);assert.equal(terminal.stopped,1);
});
test('submission drains terminal events before handing input to login',async t=>{
 const {io,terminal,input}=await fixture(t);let releaseDrain;
 terminal.drainInput=()=>new Promise(resolve=>{releaseDrain=resolve;});
 const prompt=io.readPrompt();terminal.key('/login fake oauth');terminal.key('\r');
 assert.equal(terminal.stopped,0);assert.equal(typeof releaseDrain,'function');
 terminal.key('\x1b[13;1:3u');releaseDrain();assert.equal(await prompt,'/login fake oauth');
 assert.equal(terminal.stopped,1);const login=io.readLine('Method > ');input.write('device_code\n');assert.equal(await login,'device_code');
});
test('drain failure rejects submission and restores the terminal',async t=>{
 const {io,terminal}=await fixture(t);terminal.drainInput=async()=>{throw new Error('synthetic drain failure');};
 const p=io.readPrompt();terminal.key('draft');terminal.key('\r');await assert.rejects(p,/synthetic drain failure/);assert.equal(terminal.stopped,1);
});
test('close restores terminal synchronously during a pending drain and discards submission',async t=>{
 const {io,terminal}=await fixture(t);let releaseDrain;
 terminal.drainInput=()=>new Promise(resolve=>{releaseDrain=resolve;});
 const p=io.readPrompt();terminal.key('draft');terminal.key('\r');io.close();assert.equal(terminal.stopped,1);assert.equal(await p,null);
 releaseDrain();await Promise.resolve();assert.equal(terminal.stopped,1);
});
test('Kitty key release events cannot submit or clear a draft',async t=>{
 const {io,terminal}=await fixture(t);let done=false;const p=io.readPrompt().then(v=>{done=true;return v;});terminal.key('draft');terminal.key('\x1b[13;1:3u');terminal.key('\x1b[99;5:3u');await Promise.resolve();assert.equal(done,false);terminal.key('\r');assert.equal(await p,'draft');
});
