// Hokku server for one Bigme F7: shows the last photo sent to a Telegram bot.
//
//   GET|POST /hokku/screen/   the frame's poll (same wire protocol as the Python server)
//   POST     /hokku/api/upload   send a photo over HTTP, like sending it to the bot
//   GET      /hokku/api/openapi.yaml   the upload endpoint's OpenAPI schema
//   GET      /hokku/preview.png   the dithered preview of what the frame is showing
//   GET      /healthz
//
// Configuration is by environment variable; see README.md.

import { timingSafeEqual } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { renderPhoto, type Orientation } from "./render";
import { nextSlot, parseTimes, secondsUntil } from "./schedule";
import { Telegram, type TgMessage } from "./telegram";
import { PANEL_BYTES } from "./f7";

const env = process.env;
const PORT = Number(env.PORT ?? 8080);
const HOST = env.HOST ?? "0.0.0.0";
const DATA_DIR = env.DATA_DIR ?? join(import.meta.dir, "..", "data");
const REFRESH_TIMES = parseTimes(env.REFRESH_TIMES ?? "0600,1200,1800");
const CROP_TO_FILL = Number(env.CROP_TO_FILL ?? 1.0);
const SQUARE_ORIENTATION = (env.SQUARE_ORIENTATION ?? "portrait") as Orientation;
const UPLOAD_TOKEN = env.UPLOAD_TOKEN ?? "";
const BUSY_RETRY_MAX_S = 300;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

if (SQUARE_ORIENTATION !== "portrait" && SQUARE_ORIENTATION !== "landscape") {
  throw new Error("SQUARE_ORIENTATION must be portrait or landscape");
}

// ── State ──────────────────────────────────────────────────────────────────

interface Current {
  panel: Uint8Array;
  preview: Uint8Array;
  orientation: Orientation;
  receivedAt: string;
  from: string;
}

interface ScreenContact {
  at: Date;
  ip: string;
  name: string;
  batteryMv: number | null;
  firmware: string | null;
  sleepS: number;
  status: number;
}

const files = {
  panel: join(DATA_DIR, "current.bin"),
  preview: join(DATA_DIR, "current.png"),
  meta: join(DATA_DIR, "current.json"),
  screenLog: join(DATA_DIR, "screen.log"),
};

let current: Current | null = null;
let lastContact: ScreenContact | null = null;

async function writeAtomic(path: string, data: Uint8Array | string) {
  await Bun.write(path + ".tmp", data);
  await rename(path + ".tmp", path);
}

async function loadCurrent(): Promise<Current | null> {
  const [panel, preview, meta] = [Bun.file(files.panel), Bun.file(files.preview), Bun.file(files.meta)];
  if (!(await panel.exists()) || !(await meta.exists())) return null;
  const bytes = new Uint8Array(await panel.arrayBuffer());
  if (bytes.length !== PANEL_BYTES) return null;
  const m = await meta.json();
  return {
    panel: bytes,
    preview: (await preview.exists()) ? new Uint8Array(await preview.arrayBuffer()) : new Uint8Array(),
    orientation: m.orientation,
    receivedAt: m.receivedAt,
    from: m.from,
  };
}

async function saveCurrent(c: Current) {
  await writeAtomic(files.panel, c.panel);
  await writeAtomic(files.preview, c.preview);
  await writeAtomic(
    files.meta,
    JSON.stringify({ orientation: c.orientation, receivedAt: c.receivedAt, from: c.from }, null, 2),
  );
  current = c;
}

// Renders are CPU-bound; run them one at a time.
let renderQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(job: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(job, job);
  renderQueue = run.catch(() => {});
  return run;
}

/** Render a received photo and make it the one the frame shows next. */
async function acceptPhoto(bytes: Uint8Array, from: string): Promise<Current> {
  const started = performance.now();
  const r = await serialized(() =>
    renderPhoto(bytes, { cropToFill: CROP_TO_FILL, squareOrientation: SQUARE_ORIENTATION }),
  );
  const c: Current = {
    panel: r.panel,
    preview: r.previewPng,
    orientation: r.orientation,
    receivedAt: new Date().toISOString(),
    from,
  };
  await saveCurrent(c);
  console.log(`rendered photo from ${from} (${r.orientation}) in ${Math.round(performance.now() - started)} ms`);
  return c;
}

// ── Upload endpoint ────────────────────────────────────────────────────────

function uploadAuthorized(req: Request): boolean {
  if (!UPLOAD_TOKEN) return false;
  // X-Upload-Token works behind a proxy that uses Authorization for its own basic auth.
  const given =
    req.headers.get("X-Upload-Token") ?? req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(UPLOAD_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const jsonError = (status: number, error: string) => Response.json({ ok: false, error }, { status });

/**
 * POST /hokku/api/upload — the HTTP twin of sending the bot a photo.
 * Body: multipart/form-data with the image in `file` (optional `from` field), or the
 * raw image bytes with an image/* Content-Type. Replies with JSON, or with the
 * dithered preview PNG when the request sends `Accept: image/png`.
 */
async function serveUpload(req: Request): Promise<Response> {
  if (!UPLOAD_TOKEN) return jsonError(403, "uploads are disabled: set UPLOAD_TOKEN");
  if (!uploadAuthorized(req)) return jsonError(401, "missing or wrong upload token");

  let bytes: Uint8Array;
  let from = req.headers.get("X-From") ?? "api";
  const type = req.headers.get("Content-Type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) return jsonError(400, "multipart body needs the image in a `file` field");
    bytes = new Uint8Array(await file.arrayBuffer());
    const f = form.get("from");
    if (typeof f === "string" && f.trim()) from = f.trim();
  } else {
    bytes = new Uint8Array(await req.arrayBuffer());
  }
  if (!bytes.length) return jsonError(400, "empty body");
  if (bytes.length > MAX_UPLOAD_BYTES) return jsonError(413, "image is over 25 MB");

  let c: Current;
  try {
    c = await acceptPhoto(bytes, from.slice(0, 64));
  } catch (err) {
    return jsonError(422, `couldn't process that image: ${(err as Error).message.split("\n")[0]}`);
  }
  const next = nextSlot(REFRESH_TIMES);
  if (req.headers.get("Accept")?.includes("image/png")) {
    return new Response(c.preview, {
      headers: { "Content-Type": "image/png", "X-Orientation": c.orientation, "X-Next-Refresh": next.toISOString() },
    });
  }
  return Response.json({
    ok: true,
    orientation: c.orientation,
    received_at: c.receivedAt,
    next_refresh: next.toISOString(),
    preview: "/hokku/preview.png",
  });
}

// ── Screen endpoint ────────────────────────────────────────────────────────

function timeOf(d: Date) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function serveScreen(req: Request, ip: string): Promise<Response> {
  const h = req.headers;
  if (req.method === "POST") {
    // The firmware POSTs its activity log as the body; keep the latest one.
    const log = await req.text();
    if (log) await Bun.write(files.screenLog, log);
  }
  const model = h.get("X-Screen-Model");
  const next = nextSlot(REFRESH_TIMES);
  let sleepS = secondsUntil(next);

  let res: Response;
  if (model !== null && model.trim() !== "bigme_f7") {
    sleepS = Math.min(BUSY_RETRY_MAX_S, sleepS);
    res = new Response("Unknown X-Screen-Model", { status: 400 });
  } else if (!current) {
    sleepS = Math.min(BUSY_RETRY_MAX_S, sleepS);
    res = new Response("No photo yet — send one to the Telegram bot", { status: 404 });
  } else {
    res = new Response(current.panel, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=hokku.bin",
      },
    });
  }
  res.headers.set("X-Sleep-Seconds", String(sleepS));
  res.headers.set("X-Server-Time-Epoch", String(Math.floor(Date.now() / 1000)));

  const battery = Number(h.get("X-Battery-mV"));
  lastContact = {
    at: new Date(),
    ip,
    name: h.get("X-Screen-Name") ?? "unnamed",
    batteryMv: battery >= 2000 && battery <= 5000 ? battery : null,
    firmware: h.get("X-Firmware-Version"),
    sleepS,
    status: res.status,
  };
  console.log(
    `screen ${lastContact.name} (${ip}, fw ${lastContact.firmware ?? "?"}): ${res.status}, ` +
      `next poll in ${sleepS}s (~${timeOf(new Date(Date.now() + sleepS * 1000 + 30_000))})`,
  );
  return res;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024, // room for multipart framing
  routes: {
    "/hokku/api/upload": { POST: serveUpload },
    "/hokku/api/openapi.yaml": new Response(await Bun.file(new URL("../openapi.yaml", import.meta.url)).bytes(), {
      headers: { "Content-Type": "application/yaml" },
    }),
    "/hokku/screen": (req, srv) => serveScreen(req, clientIp(req, srv.requestIP(req)?.address)),
    "/hokku/screen/": (req, srv) => serveScreen(req, clientIp(req, srv.requestIP(req)?.address)),
    "/hokku/preview.png": () =>
      current?.preview.length
        ? new Response(current.preview, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } })
        : new Response("No photo yet", { status: 404 }),
    "/healthz": () => new Response("ok"),
  },
  fetch: () => new Response("Not found", { status: 404 }),
});

/** Behind Caddy the peer is the proxy, so prefer the forwarded client address. */
function clientIp(req: Request, peer: string | undefined): string {
  return req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? peer ?? "unknown";
}

// ── Telegram bot ───────────────────────────────────────────────────────────

const HELP =
  "Send me a photo and I'll put it on the frame.\n\n" +
  "Tip: send it as a file (paperclip → File) to keep full resolution; " +
  "Telegram shrinks ordinary photos to 1280 px, which is still plenty for the panel.\n\n" +
  "The frame shows it at its next scheduled refresh.\n" +
  "/status — what the frame shows and when it refreshes next";

function statusText(): string {
  const next = nextSlot(REFRESH_TIMES);
  const lines = [
    current
      ? `Showing: photo from ${current.from}, received ${new Date(current.receivedAt).toLocaleString()} (${current.orientation}).`
      : "No photo yet.",
  ];
  if (lastContact) {
    const c = lastContact;
    const wake = new Date(c.at.getTime() + c.sleepS * 1000);
    lines.push(
      `Frame "${c.name}" last polled ${c.at.toLocaleString()} (HTTP ${c.status})` +
        (c.batteryMv ? `, battery ${c.batteryMv} mV` : "") +
        `; next poll ~${wake.toLocaleString()}.`,
    );
  } else {
    lines.push("The frame hasn't polled since the server started.");
  }
  lines.push(`Refresh slots: ${REFRESH_TIMES.map(([h, m]) => `${h}:${String(m).padStart(2, "0")}`).join(", ")} (next ${timeOf(next)}).`);
  return lines.join("\n");
}

function photoFileId(msg: TgMessage): string | null {
  if (msg.photo?.length) return msg.photo.at(-1)!.file_id; // largest size last
  const doc = msg.document;
  if (doc && (doc.mime_type?.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|avif|gif|tiff?|bmp)$/i.test(doc.file_name ?? ""))) {
    return doc.file_id;
  }
  return null;
}

async function handleMessage(tg: Telegram, msg: TgMessage, allowed: Set<number>) {
  const userId = msg.from?.id;
  if (userId === undefined || !allowed.has(userId)) {
    await tg.reply(msg, `Sorry, you're not allowed to post to this frame. Your Telegram user id is ${userId}.`);
    return;
  }
  const text = msg.text?.trim() ?? "";
  if (text.startsWith("/status")) return void (await tg.reply(msg, statusText()));
  if (text.startsWith("/start") || text.startsWith("/help")) return void (await tg.reply(msg, HELP));

  const fileId = photoFileId(msg);
  if (!fileId) return void (await tg.reply(msg, HELP));

  const bytes = await tg.download(fileId);
  if (bytes.length > MAX_UPLOAD_BYTES) return void (await tg.reply(msg, "That file is over 25 MB."));
  const c = await acceptPhoto(bytes, msg.from?.first_name ?? String(userId));
  await tg.replyPhoto(
    msg,
    c.preview,
    `Queued (${c.orientation}). The frame shows it at its next refresh, ${timeOf(nextSlot(REFRESH_TIMES))}.`,
  );
}

async function runBot(token: string, allowed: Set<number>) {
  const tg = new Telegram(token, env.TELEGRAM_API_URL);
  let offset = 0;
  console.log(`telegram bot polling; allowed users: ${[...allowed].join(", ") || "(none)"}`);
  for (;;) {
    try {
      for (const u of await tg.getUpdates(offset, 50)) {
        offset = u.update_id + 1;
        if (!u.message) continue;
        try {
          await handleMessage(tg, u.message, allowed);
        } catch (err) {
          console.error("telegram message failed:", err);
          await tg.reply(u.message, `Couldn't process that: ${(err as Error).message}`).catch(() => {});
        }
      }
    } catch (err) {
      console.error("telegram poll failed:", (err as Error).message);
      await Bun.sleep(5000);
    }
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

await mkdir(DATA_DIR, { recursive: true });
current = await loadCurrent();
console.log(
  `hokku-bun listening on ${server.url} — data ${DATA_DIR}` +
    (current ? `, showing photo from ${current.receivedAt}` : ", no photo yet"),
);

if (env.TELEGRAM_BOT_TOKEN) {
  const allowed = new Set(
    (env.TELEGRAM_ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
  void runBot(env.TELEGRAM_BOT_TOKEN, allowed);
} else {
  console.warn("TELEGRAM_BOT_TOKEN not set — the bot is disabled");
}
