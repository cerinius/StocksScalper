declare module "ws" {
  class WebSocket {
    constructor(url: string);
    send(data: string): void;
    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: string | Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: () => void): this;
  }

  export default WebSocket;
}
