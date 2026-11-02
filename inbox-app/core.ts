/**
 * Team Inbox: pure helpers (no network, no database), kept apart so they can be tested.
 */
import crypto from "node:crypto";
import net from "node:net";

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
export function mailQuery(folder: unknown, unread: boolean, search: unknown, primary = false): string {
  const s = oneLine(String(search ?? "")).slice(0, 300);
  const f = folderOf(folder);
  // Important only keeps the Primary and Updates tabs (orders, shipping), and never narrows a search.
  return [FOLDERS[f], primary && f === "inbox" && !s ? "{category:primary category:updates}" : "", unread ? "is:unread" : "", s ? `(${s})` : ""].filter(Boolean).join(" ");
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

// ---------- junk mail: unsubscribe, senders and rules ----------

/** The name part of a From header (`"Jane" <jane@x.com>` gives Jane), or "". */
export function displayName(from: string | undefined): string {
  const m = String(from ?? "").match(/^\s*"?([^"<]*?)"?\s*</);
  return m ? oneLine(m[1]).slice(0, 120) : "";
}

/** Expands an IPv6 address to its 8 groups, or null. An embedded IPv4 tail is turned into two groups. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const b = v4[1].split(".").map(Number);
    if (b.some((x) => x > 255)) return null;
    s = s.slice(0, -v4[1].length) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h ? h.split(":") : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

function privateV4(ip: string): boolean {
  const b = ip.split(".").map(Number);
  const [a, c] = [b[0], b[1]];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && c >= 64 && c <= 127) ||
    (a === 169 && c === 254) ||
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 168) ||
    (a === 192 && c === 0 && (b[2] === 0 || b[2] === 2)) ||
    (a === 198 && (c === 18 || c === 19)) ||
    (a === 198 && c === 51 && b[2] === 100) ||
    (a === 203 && c === 0 && b[2] === 113)
  );
}

/** True for any address that isn't a plain public one: private, loopback, link local, multicast, reserved, or unparsable. */
export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return privateV4(ip);
  if (kind !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateV4(v4(g[6], g[7])); // mapped and compatible IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4(v4(g[6], g[7])); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link and site local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return privateV4(v4(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  return false;
}

const INTERNAL_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa|in-addr\.arpa|ip6\.arpa)$/;

/**
 * An unsubscribe address the server may call: https, the normal port, no login in it, and a public host name
 * or public IP. The name is checked again after it is looked up, so it can't point inside.
 */
export function safeUnsubUrl(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 2048 || /[\s<>]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return null;
  if (net.isIP(host)) return isPrivateIp(host) ? null : u.toString();
  if (!host.includes(".") || INTERNAL_HOST.test(host) || !/^[a-z0-9.-]+$/.test(host)) return null;
  return u.toString();
}

/** The https and mailto addresses in a List-Unsubscribe header, in the order given. */
export function parseListUnsubscribe(h: string | undefined): { https: string[]; mailto: string[] } {
  const out = { https: [] as string[], mailto: [] as string[] };
  for (const m of String(h ?? "").matchAll(/<([^<>]{1,2048})>/g)) {
    const v = m[1].replace(/\s+/g, "");
    if (/^https:\/\//i.test(v)) out.https.push(v);
    else if (/^mailto:/i.test(v)) out.mailto.push(v);
  }
  return out;
}

const pctDecode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

export const UNSUB_SUBJECT = "Unsubscribe";
export const UNSUB_BODY = "Please unsubscribe this address.";

/**
 * A mailto: link as the email to send from the owner's mailbox: only to the one address in the link, with a fixed
 * body. The sender's subject is kept only when it is short, plain and says unsubscribe; their body is never used.
 */
export function parseMailto(uri: string | undefined): { to: string; subject: string; body: string } | null {
  const s = String(uri ?? "").trim();
  if (!/^mailto:/i.test(s)) return null;
  const rest = s.slice(7);
  const q = rest.indexOf("?");
  const params: Record<string, string> = {};
  for (const pair of (q >= 0 ? rest.slice(q + 1) : "").split("&")) {
    const i = pair.indexOf("=");
    const k = pctDecode(i >= 0 ? pair.slice(0, i) : pair).toLowerCase();
    if (k && !(k in params)) params[k] = pctDecode(i >= 0 ? pair.slice(i + 1) : "");
  }
  // Exactly one recipient, the one in the link itself: no extra "to", cc or bcc from the sender.
  const to = normEmail(pctDecode(q >= 0 ? rest.slice(0, q) : rest));
  if (!isEmail(to)) return null;
  const subject = params.subject ?? "";
  return { to, subject: /^[\w\s-]{0,60}$/.test(subject) && /unsubscribe/i.test(subject) ? oneLine(subject) : UNSUB_SUBJECT, body: UNSUB_BODY };
}

/** True when List-Unsubscribe-Post asks for the RFC 8058 one click POST. */
export const isOneClick = (v: string | undefined) => /^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i.test(String(v ?? ""));

export type UnsubPlan =
  | { kind: "post"; url: string; mailto: ReturnType<typeof parseMailto>; link: string | null }
  | { kind: "mailto"; mailto: NonNullable<ReturnType<typeof parseMailto>>; link: string | null }
  | { kind: "link"; link: string }
  | null;

/** How to unsubscribe: one click POST first, then an email, then a page for the person to open. */
export function unsubscribePlan(listUnsubscribe: string | undefined, listUnsubscribePost: string | undefined): UnsubPlan {
  const p = parseListUnsubscribe(listUnsubscribe);
  const link = p.https.map(safeUnsubUrl).find((u): u is string => Boolean(u)) ?? null;
  const mailto = p.mailto.map(parseMailto).find((m) => m !== null) ?? null;
  if (link && isOneClick(listUnsubscribePost)) return { kind: "post", url: link, mailto, link };
  if (mailto) return { kind: "mailto", mailto, link };
  if (link) return { kind: "link", link };
  return null;
}

export interface SenderRow { inboxId: string; from?: string; date: number; listUnsubscribe?: string; listUnsubscribePost?: string; self?: string }
export interface SenderGroup { inboxId: string; address: string; name: string; count: number; last: number; unsub: "post" | "mailto" | "link" | null }

/** Mail grouped by inbox and sender address, most mail first. The unsubscribe way comes from the newest message that has one. */
export function groupSenders(rows: SenderRow[]): SenderGroup[] {
  const by = new Map<string, SenderGroup & { unsubAt: number }>();
  for (const r of rows) {
    const address = addressIn(r.from);
    if (!address || (r.self && normEmail(r.self) === address)) continue;
    const key = `${r.inboxId}\n${address}`;
    const g = by.get(key) ?? { inboxId: r.inboxId, address, name: "", count: 0, last: 0, unsub: null, unsubAt: -1 };
    g.count++;
    if (r.date >= g.last) {
      g.last = r.date;
      g.name = displayName(r.from) || g.name;
    } else if (!g.name) g.name = displayName(r.from);
    const plan = unsubscribePlan(r.listUnsubscribe, r.listUnsubscribePost);
    if (plan && r.date > g.unsubAt) {
      g.unsub = plan.kind;
      g.unsubAt = r.date;
    }
    by.set(key, g);
  }
  return [...by.values()]
    .map(({ unsubAt: _u, ...g }) => g)
    .sort((a, b) => b.count - a.count || b.last - a.last || a.address.localeCompare(b.address));
}

/** The small count on the Clean up screen. */
export function senderTotals(groups: SenderGroup[]): { total: number; unsubscribable: number } {
  return {
    total: groups.reduce((n, g) => n + g.count, 0),
    unsubscribable: groups.reduce((n, g) => n + (g.unsub ? g.count : 0), 0),
  };
}

/** A rule's sender: an exact address, or a whole domain written as @domain.com. Null when it is neither. */
export function ruleSender(v: unknown): string | null {
  const s = normEmail(v);
  if (s.length > 254) return null;
  if (!s.startsWith("@")) return isEmail(s) ? s : null;
  const d = s.slice(1);
  const labels = d.split(".");
  if (labels.length < 2 || !/^[a-z0-9-]{2,}$/.test(labels[labels.length - 1])) return null;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) ? s : null;
}

export const RULE_ACTIONS = ["trash", "archive"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
export const ruleAction = (v: unknown): RuleAction | null => (v === "trash" || v === "archive" ? v : null);

/** Whether a sender address falls under a rule: the same address, or any address at exactly that domain. */
export function senderMatches(rule: string, address: string | null): boolean {
  const a = normEmail(address);
  if (!a || !rule) return false;
  return rule.startsWith("@") ? a.slice(a.lastIndexOf("@")) === rule : a === rule;
}

/**
 * Whether a rule would hit the team's own mail: an exact team address, or a domain that any team address uses
 * (an exact rule for someone else at that domain, like a shared gmail.com, is still allowed).
 */
export function ruleTargetsTeam(rule: string, team: (string | null | undefined)[]): boolean {
  const addrs = team.map(normEmail).filter((e) => e.includes("@"));
  return rule.startsWith("@") ? addrs.some((e) => e.slice(e.lastIndexOf("@")) === rule) : addrs.includes(rule);
}

/**
 * The Gmail searches that find mail for a set of rules, at most 20 senders each. Gmail's search is looser than the
 * rule, so every match is checked again with senderMatches before anything is moved.
 */
export function ruleQueries(senders: string[], extra = ""): string[] {
  const terms = [...new Set(senders.map(ruleSender).filter((s): s is string => Boolean(s)).map((s) => (s.startsWith("@") ? s.slice(1) : s)))];
  const out: string[] = [];
  for (let i = 0; i < terms.length; i += 20) {
    const chunk = terms.slice(i, i + 20);
    out.push(["in:inbox", oneLine(extra), `from:(${chunk.join(" OR ")})`].filter(Boolean).join(" "));
  }
  return out;
}
