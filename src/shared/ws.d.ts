declare module 'ws' {
  import { Buffer } from 'node:buffer';
  import { EventEmitter } from 'node:events';

  export class WebSocket extends EventEmitter {
    constructor(url: string);
    on(event: 'open', cb: () => void): this;
    on(event: 'message', cb: (data: string) => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    on(event: 'close', cb: () => void): this;
    terminate(): void;
    send(data: any): void;
  }
}
