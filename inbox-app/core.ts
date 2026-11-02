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

/** A plain text reply as an RFC 2822 message, base64url encoded for the Gmail API. */
export function buildReply(r: ReplyInput): string {
  const ids = (v: string | null) => (v ?? "").match(/<[^<>\s]+>/g) ?? [];
  const inReply = ids(r.inReplyTo)[0] ?? null;
  const refs = [...ids(r.references), ...(inReply ? [inReply] : [])].filter((v, i, a) => a.indexOf(v) === i).slice(-20);
  const headers = [
    `From: ${oneLine(r.from)}`,
    `To: ${r.to.map(oneLine).join(", ")}`,
    ...(r.cc.length ? [`Cc: ${r.cc.map(oneLine).join(", ")}`] : []),
    `Subject: ${encodeHeader(replySubject(r.subject))}`,
    ...(inReply ? [`In-Reply-To: ${inReply}`] : []),
    ...(refs.length ? [`References: ${refs.join(" ")}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(r.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
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

interface Part {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
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
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
