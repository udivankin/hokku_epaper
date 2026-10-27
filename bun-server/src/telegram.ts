// Minimal Telegram Bot API client (long polling).

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; first_name?: string };
  text?: string;
  photo?: { file_id: string; width: number; height: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string };
}

export class Telegram {
  private api: string;
  private files: string;

  constructor(token: string, base = "https://api.telegram.org") {
    this.api = `${base}/bot${token}/`;
    this.files = `${base}/file/bot${token}/`;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutS = 30): Promise<T> {
    const res = await fetch(this.api + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
    const body = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!body.ok) throw new Error(`telegram ${method}: ${body.description}`);
    return body.result;
  }

  async getUpdates(offset: number, pollS: number) {
    return this.call<{ update_id: number; message?: TgMessage }[]>(
      "getUpdates",
      { offset, timeout: pollS, allowed_updates: ["message"] },
      pollS + 10,
    );
  }

  async download(fileId: string): Promise<Uint8Array> {
    const { file_path } = await this.call<{ file_path: string }>("getFile", { file_id: fileId });
    const res = await fetch(this.files + file_path, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`telegram download: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  reply(msg: TgMessage, text: string) {
    return this.call("sendMessage", {
      chat_id: msg.chat.id,
      text,
      reply_parameters: { message_id: msg.message_id },
    });
  }

  async replyPhoto(msg: TgMessage, png: Uint8Array, caption: string) {
    const form = new FormData();
    form.set("chat_id", String(msg.chat.id));
    form.set("caption", caption);
    form.set("reply_parameters", JSON.stringify({ message_id: msg.message_id }));
    form.set("photo", new Blob([png], { type: "image/png" }), "preview.png");
    const res = await fetch(this.api + "sendPhoto", { method: "POST", body: form });
    const body = (await res.json()) as { ok: boolean; description?: string };
    if (!body.ok) throw new Error(`telegram sendPhoto: ${body.description}`);
  }
}
