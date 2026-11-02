/**
 * Team Inbox: pure helpers (no network, no database), kept apart so they can be tested.
 */
import crypto from "node:crypto";

// ---------- encryption and signing ----------

const keyOf = (secret: string, purpose: string) => crypto.createHash("sha256").update(`team-inbox:${purpose}:${secret}`).digest();

/** AES-256-GCM. Each stored Google login is sealed with the server secret. */
export function seal(text: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyOf(secret, "seal"), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}

/** Null when the value was sealed with another secret or was altered. */
export function unseal(value: string, secret: string): string | null {
  try {
    const raw = Buffer.from(value, "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", keyOf(secret, "seal"), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** A signed, expiring token (session cookie, sign in state). */
export function sign(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const mac = crypto.createHmac("sha256", keyOf(secret, "sign")).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify<T = Record<string, unknown>>(token: string | null | undefined, secret: string): T | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = crypto.createHmac("sha256", keyOf(secret, "sign")).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof p.exp !== "number" || p.exp < Date.now() / 1000) return null;
    return p as T;
  } catch {
    return null;
  }
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- email addresses ----------

export const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
/** Plain ASCII addresses only (internationalized ones would need encoding in headers); IDN top level domains allowed. */
export const isEmail = (e: string) => /^[\x21-\x7e]+$/.test(e) && /^[^\s@<>"',;:()[\]]+@[^\s@<>"',;:()[\]]+\.[a-z0-9-]{2,}$/i.test(e);

/** The bare address inside a header like `"Jane Doe" <jane@x.com>`. */
export function addressIn(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/<([^<>\s]+@[^<>\s]+)>/) ?? header.match(/([^\s<>,;"]+@[^\s<>,;"]+)/);
  const e = m ? normEmail(m[1]) : "";
  return isEmail(e) ? e : null;
}

/** Every address in a To/Cc header. */
export function addressesIn(header: string | undefined): string[] {
  return (header ?? "")
    .split(",")
    .map((p) => addressIn(p))
    .filter((e): e is string => Boolean(e));
}

// ---------- building a reply ----------

/** Header values may never carry a line break: that would let text inject new headers. */
export const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** RFC 2047 for a header that has non ASCII characters. */
export function encodeHeader(v: string): string {
  const s = oneLine(v);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  // Encoded words of at most 75 characters, never splitting a character across words.
  const words: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch, "utf8") > 45) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

export interface ReplyInput {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** Message-ID of the message being answered, and the References chain before it. */
  inReplyTo: string | null;
  references: string | null;
  body: string;
}

/** The subject of a reply: "Re: " once, never "Re: Re:". */
export const replySubject = (s: string) => (/^\s*re\s*:/i.test(s) ? oneLine(s) : `Re: ${oneLine(s)}`);

export type MessageInput = Omit<ReplyInput, "inReplyTo" | "references"> & { inReplyTo?: string | null; references?: string | null };

/** A plain text message as RFC 2822, base64url encoded for the Gmail API. Every header value is kept to one line. */
export function buildMessage(r: MessageInput): string {
  const ids = (v: string | null | undefined) => (v ?? "").match(/<[^<>\s]+>/g) ?? [];
  const inReply = ids(r.inReplyTo)[0] ?? null;
  const refs = [...ids(r.references), ...(inReply ? [inReply] : [])].filter((v, i, a) => a.indexOf(v) === i).slice(-20);
  const headers = [
    `From: ${oneLine(r.from)}`,
    `To: ${r.to.map(oneLine).join(", ")}`,
    ...(r.cc.length ? [`Cc: ${r.cc.map(oneLine).join(", ")}`] : []),
    `Subject: ${encodeHeader(r.subject)}`,
    ...(inReply ? [`In-Reply-To: ${inReply}`] : []),
    ...(refs.length ? [`References: ${refs.join(" ")}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(r.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

/** A plain text reply as an RFC 2822 message, base64url encoded for the Gmail API. */
export function buildReply(r: ReplyInput): string {
  return buildMessage({ ...r, subject: replySubject(r.subject) });
}

/** The subject of a forward: "Fwd: " once. */
export const forwardSubject = (s: string) => (/^\s*(fwd?|fw)\s*:/i.test(s) ? oneLine(s) : `Fwd: ${oneLine(s)}`);

/** The original under a reply: "On <date>, <from> wrote:" and each line marked with "> ". */
export function quoteOriginal(text: string, from: string, date: string): string {
  const lines = text.replace(/\r\n?/g, "\n").trimEnd().split("\n").map((l) => (l === "" ? ">" : l.startsWith(">") ? `>${l}` : `> ${l}`));
  return `On ${oneLine(date)}, ${oneLine(from)} wrote:\n${lines.join("\n")}`;
}

/** The body of a forward: the sender's note, then the original's headers and text. */
export function forwardBody(note: string, o: { from: string; date: string; subject: string; to: string; cc?: string; text: string }): string {
  const head = [
    "Begin forwarded message:",
    "",
    `From: ${oneLine(o.from)}`,
    `Date: ${oneLine(o.date)}`,
    `Subject: ${oneLine(o.subject)}`,
    `To: ${oneLine(o.to)}`,
    ...(o.cc ? [`Cc: ${oneLine(o.cc)}`] : []),
  ];
  return `${note.trimEnd()}${note.trim() ? "\n\n" : ""}${head.join("\n")}\n\n${o.text.replace(/\r\n?/g, "\n")}`;
}

/** Addresses typed by a person, split on commas, semicolons or lines. Anything not an address comes back in `bad`. */
export function parseAddressList(input: unknown): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const piece of String(input ?? "").split(/[,;\n]+/)) {
    const p = piece.trim();
    if (!p) continue;
    const e = addressIn(p);
    if (e) {
      if (!ok.includes(e)) ok.push(e);
    } else bad.push(p);
  }
  return { ok, bad };
}

// ---------- folders and search ----------

export const FOLDERS = { inbox: "in:inbox", starred: "is:starred", sent: "in:sent", trash: "in:trash" } as const;
export type Folder = keyof typeof FOLDERS;
export const folderOf = (v: unknown): Folder => (typeof v === "string" && Object.prototype.hasOwnProperty.call(FOLDERS, v) ? (v as Folder) : "inbox");

/** The Gmail search for a folder, the unread filter and what the person typed (kept inside the folder). */
export function mailQuery(folder: unknown, unread: boolean, search: unknown): string {
  const s = oneLine(String(search ?? "")).slice(0, 300);
  return [FOLDERS[folderOf(folder)], unread ? "is:unread" : "", s ? `(${s})` : ""].filter(Boolean).join(" ");
}

/** What a thread action does in Gmail: the path to post to and the label change, or null when unknown. */
export function threadAction(action: unknown, id: string): { path: string; body?: Record<string, string[]> } | null {
  const m = (body: Record<string, string[]>) => ({ path: `threads/${id}/modify`, body });
  switch (action) {
    case "read": return m({ removeLabelIds: ["UNREAD"] });
    case "unread": return m({ addLabelIds: ["UNREAD"] });
    case "archive": return m({ removeLabelIds: ["INBOX"] });
    case "star": return m({ addLabelIds: ["STARRED"] });
    case "unstar": return m({ removeLabelIds: ["STARRED"] });
    case "trash": return { path: `threads/${id}/trash` };
    case "untrash": return { path: `threads/${id}/untrash` };
    default: return null;
  }
}

/**
 * Who a reply goes to: Reply-To or the sender, and for reply all the other To and Cc people too, never the inbox
 * itself. A message the inbox sent is answered to its original recipients.
 */
export function replyRecipients(
  inbox: string,
  h: { from?: string; replyTo?: string; to?: string; cc?: string },
  all: boolean
): { to: string[]; cc: string[] } {
  const me = normEmail(inbox);
  const sender = addressIn(h.replyTo) ?? addressIn(h.from);
  const fromMe = addressIn(h.from) === me;
  let to = fromMe ? addressesIn(h.to) : sender ? [sender] : [];
  let cc = all ? [...(fromMe ? [] : addressesIn(h.to)), ...addressesIn(h.cc)] : [];
  to = [...new Set(to.filter((e) => e !== me))];
  cc = [...new Set(cc.filter((e) => e !== me && !to.includes(e)))];
  return { to, cc };
}

// ---------- reading a message ----------

export interface Part {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
}

/** A part's text in its own character set (Gmail returns the bytes as sent), UTF-8 when unknown. */
function decodePart(p: Part): string {
  const bytes = Buffer.from((p.body?.data ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const ct = header(p.headers, "Content-Type") ?? "";
  const cs = (ct.match(/charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/i)?.[1] ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** HTML turned into readable plain text. The page shows only text, so no sender's HTML ever runs. */
/** Turns HTML character codes (&amp;, &#39;, &#8217;, &#x2019;) into the characters they stand for. */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n");
  return decodeEntities(stripped).replace(/\u00a0/g, " ").trim();
}

/** The message text: its plain text part, else its HTML part as text. */
export function textOf(payload: Part | undefined): string {
  const find = (p: Part | undefined, type: string): string | null => {
    if (!p) return null;
    if (p.mimeType === type && p.body?.data) return decodePart(p);
    for (const c of p.parts ?? []) {
      const t = find(c, type);
      if (t !== null) return t;
    }
    return null;
  };
  const plain = find(payload, "text/plain");
  if (plain !== null) return plain.trim();
  const html = find(payload, "text/html");
  return html !== null ? htmlToText(html) : "";
}

/** The message's HTML part, or null. Shown only inside a sandboxed frame where nothing in it can run. */
export function htmlOf(payload: Part | undefined): string | null {
  const find = (p: Part | undefined): string | null => {
    if (!p) return null;
    if (p.mimeType === "text/html" && p.body?.data) return decodePart(p);
    for (const c of p.parts ?? []) {
      const t = find(c);
      if (t !== null) return t;
    }
    return null;
  };
  return find(payload);
}

export const header = (headers: { name: string; value: string }[] | undefined, name: string) =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

// ---------- attachments and inline images ----------

/** Every part of a message, depth first. */
export function allParts(p: Part | undefined, out: Part[] = []): Part[] {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts ?? []) allParts(c, out);
  return out;
}

export const partById = (payload: Part | undefined, partId: string) => allParts(payload).find((p) => p.partId === partId) ?? null;

/** A Content-ID or cid: reference in one comparable form: no angle brackets, lower case. */
export function cidKey(v: unknown): string {
  let s = String(v ?? "").trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as typed */
  }
  return s.replace(/^<|>$/g, "").trim().toLowerCase();
}

const IMAGE_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
/** An image type safe for a data: address, from the part's type or else its file name; null when not an image. */
export function imageType(mimeType: string | undefined, filename?: string): string | null {
  const t = String(mimeType ?? "").toLowerCase().trim();
  if (/^image\/[a-z0-9.+-]{1,40}$/.test(t)) return t;
  const ext = String(filename ?? "").toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1];
  return ext && Object.prototype.hasOwnProperty.call(IMAGE_EXT, ext) ? IMAGE_EXT[ext] : null;
}

/** Image parts an email can show inline (they carry a Content-ID). */
export function inlineImages(payload: Part | undefined): { cid: string; type: string; partId: string; attachmentId?: string; data?: string; size: number }[] {
  return allParts(payload).flatMap((p) => {
    const cid = cidKey(header(p.headers, "Content-ID") ?? header(p.headers, "X-Attachment-Id"));
    const type = imageType(p.mimeType, p.filename);
    if (!cid || !type || (!p.body?.attachmentId && !p.body?.data)) return [];
    return [{ cid, type, partId: p.partId ?? "", attachmentId: p.body?.attachmentId, data: p.body?.data, size: Number(p.body?.size ?? 0) }];
  });
}

/** The cid: references in an email's HTML. */
export function citedCids(html: string): Set<string> {
  return new Set([...html.matchAll(/cid:([^"'\s)>]+)/gi)].map((m) => cidKey(m[1])));
}

/** Points cid: references at the images given (data: addresses); unknown ones stay as they are. */
export function rewriteCids(html: string, images: Map<string, string>): string {
  return html.replace(/cid:([^"'\s)>]+)/gi, (m, id: string) => images.get(cidKey(id)) ?? m);
}

/** Files attached to a message, leaving out images already shown inline. */
export function attachmentsOf(payload: Part | undefined, shown: Set<string> = new Set()): { part: string; name: string; size: number }[] {
  return allParts(payload).flatMap((p) => {
    const name = (p.filename ?? "").trim();
    if (!name || !p.partId || (!p.body?.attachmentId && !p.body?.data)) return [];
    const cid = cidKey(header(p.headers, "Content-ID") ?? "");
    if (cid && shown.has(cid)) return [];
    return [{ part: p.partId, name: safeFilename(name), size: Number(p.body?.size ?? 0) }];
  });
}

/** A file name safe to save: no folders, control characters or reserved marks, at most 150 characters. */
export function safeFilename(name: unknown): string {
  let s = String(name ?? "")
    .normalize("NFC")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (s.length > 150) {
    const ext = s.match(/\.[^.]{1,10}$/)?.[0] ?? "";
    s = s.slice(0, 150 - ext.length) + ext;
  }
  return s || "attachment";
}

/** Content-Disposition that always downloads, with a plain fallback name and the full name encoded. */
export function contentDisposition(name: unknown): string {
  const safe = safeFilename(name);
  const plain = safe.replace(/[^\x20-\x7e]/g, "_").replace(/[%;\\"]/g, "_");
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}
