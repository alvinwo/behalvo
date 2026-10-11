import { Editor, matchesKey, isKeyRelease, Text, TuiMainScreen, ProcessTerminal, stripTerminalSequences, truncateToWidth, type Terminal } from '@earendil-works/pi-tui';
import type { Readable, Writable } from 'node:stream';
import { NodeLineIo } from './node-io.js';
import type { ReplIo } from './repl.js';
import { inputMessage } from './input-messages.js';

const plain = (value: string) => value;
const theme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };

// Bound each rendered line before the library's width assertion/crash-dump path.
class PromptScreen extends TuiMainScreen {
  override render(width: number): string[] {
    return super.render(width).map(line => truncateToWidth(line, Math.max(0, width)));
  }
}

/** Interactive chat editor only. Pipes and authentication retain NodeLineIo. */
export class TerminalPromptIo implements ReplIo {
  #auth: NodeLineIo | undefined;
  #finish: ((value: string | null) => void) | undefined;
  #closed = false;
  readonly #onExit = () => this.close();

  constructor(private readonly input: Readable, private readonly output: Writable,
    private readonly terminal: Terminal = new ProcessTerminal()) {
    if (process.env.PI_TUI_WRITE_LOG || process.env.PI_TUI_DEBUG === '1' || process.env.PI_TUI_DEBUG_REDRAW === '1')
      throw new Error(inputMessage('loggingDisabled'));
    process.once('exit', this.#onExit);
  }

  readLine(prompt = '', signal?: AbortSignal): Promise<string | null> {
    if (this.#closed) return Promise.resolve(null);
    this.#auth ??= new NodeLineIo(this.input, this.output);
    return this.#auth.readLine(prompt, signal);
  }

  readSecret(prompt = '', signal?: AbortSignal): Promise<string | null> {
    if (this.#closed) return Promise.resolve(null);
    this.#auth ??= new NodeLineIo(this.input, this.output);
    return this.#auth.readSecret(prompt, signal);
  }

  readPrompt(prompt = 'You > '): Promise<string | null> {
    if (this.#closed || this.input.readableEnded) return Promise.resolve(null);
    if (this.#finish) throw new Error(inputMessage('busy'));
    // Discard all authentication editor state, undo/kill rings and queued input.
    this.#auth?.close(); this.#auth = undefined;
    const tui = new PromptScreen(this.terminal, true);
    const editor = new Editor(tui, theme);
    const hint = new Text(inputMessage('keys'), 0, 0);
    tui.addChild(new Text(prompt, 0, 0)); tui.addChild(editor); tui.addChild(hint);
    tui.setFocus(editor);
    let oversized = false;
    return new Promise((resolve, reject) => {
      let finishing = false;
      let settled = false;
      const complete = (value: string | null, failure?: unknown) => {
        if (settled) return;
        settled = true; this.#finish = undefined;
        this.input.off('end', eof); this.input.off('close', eof);
        process.off('SIGTERM', terminate); process.off('SIGINT', eof);
        removeListener();
        let error = failure;
        try { if (!error) tui.renderNow(); } catch (caught) { error ??= caught; }
        try { tui.stop(); } catch (caught) { error ??= caught; }
        tui.clear(); tui.setFocus(null);
        if (error) reject(error); else resolve(value);
      };
      const finish = (value: string | null, failure?: unknown) => {
        if (settled) return;
        // close/EOF/signals must still restore raw mode synchronously on exit.
        if (finishing) { if (value === null) complete(null, failure); return; }
        finishing = true;
        if (failure || this.#closed || this.input.readableEnded) { complete(value, failure); return; }
        // Disable extended keyboard reporting and discard delayed releases before
        // readline (login) or the next prompt can take ownership of stdin.
        try {
          void this.terminal.drainInput(1000, 50).then(() => complete(value), error => complete(null, error));
        } catch (error) { complete(null, error); }
      };
      const eof = () => finish(null);
      const terminate = () => { process.exitCode = 143; finish(null); };
      const overLimit = () => {
        oversized = true;
        editor.setText('');
        hint.setText(inputMessage('oversized'));
        tui.requestRender();
      };
      const removeListener = tui.addInputListener(data => {
        if (finishing || settled || isKeyRelease(data)) return { consume: true };
        if (matchesKey(data, 'ctrl+c')) {
          if (!oversized && !editor.getExpandedText()) finish(null);
          else {
            oversized = false;
            editor.setText('');
            hint.setText(inputMessage('keys'));
            tui.requestRender();
          }
          return { consume: true };
        }
        if (matchesKey(data, 'ctrl+d') && !editor.getExpandedText()) { finish(null); return { consume: true }; }
        if (oversized) return { consume: true };
        if (Buffer.byteLength(data, 'utf8') > 65548) { overLimit(); return { consume: true }; }
        // ProcessTerminal assembles fragmented bracketed pastes into one event.
        // Insert literally: Editor.handlePaste adds file-path spacing heuristics.
        if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
          const decoded = data.slice(6, -6).replace(/\x1b\[(\d+);5u/g, (sequence, code: string) => {
            const point = Number(code);
            return point >= 65 && point <= 90 ? String.fromCharCode(point - 64)
              : point >= 97 && point <= 122 ? String.fromCharCode(point - 96) : sequence;
          });
          const text = stripTerminalSequences(decoded).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
          editor.insertTextAtCursor(text); tui.requestRender(); return { consume: true };
        }
        if (data === '\n' || matchesKey(data, 'ctrl+j') || matchesKey(data, 'shift+enter') || matchesKey(data, 'alt+enter')) {
          editor.insertTextAtCursor('\n'); tui.requestRender(); return { consume: true };
        }
        if (matchesKey(data, 'enter')) {
          const text = editor.getExpandedText();
          if (text.trim()) finish(text);
          return { consume: true };
        }
        return undefined;
      });
      editor.onChange = () => {
        if (!oversized && Buffer.byteLength(editor.getExpandedText(), 'utf8') > 65536) overLimit();
      };
      this.#finish = finish;
      this.input.once('end', eof); this.input.once('close', eof);
      process.once('SIGTERM', terminate); process.once('SIGINT', eof);
      try { tui.start(); tui.renderNow(); } catch (error) {
        finish(null, error);
      }
    });
  }

  write(line = ''): void { this.output.write(`${line}\n`); }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#finish?.(null); this.#auth?.close(); this.#auth = undefined;
    process.off('exit', this.#onExit);
  }
}
