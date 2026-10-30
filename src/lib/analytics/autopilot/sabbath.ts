/**
 * Sabbath rest: from Friday sundown to Saturday sundown the scheduled
 * autopilot does nothing (no rank checks, no keyword work, no changes).
 * Sundown is worked out for the owner's area (Alvarado, Texas by default,
 * or SABBATH_LAT / SABBATH_LNG / SABBATH_TZ), with the standard sunset
 * formula, so it follows the seasons.
 */

const LAT = Number(process.env.SABBATH_LAT ?? 32.406);
const LNG = Number(process.env.SABBATH_LNG ?? -97.212);
const TZ = process.env.SABBATH_TZ ?? "America/Chicago";

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Sunset on a calendar day (y, m 1 to 12, d) at the given place, as a UTC time. */
export function sunsetUtc(y: number, m: number, d: number, lat = LAT, lng = LNG): Date {
  const n = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86_400_000);
  const lngHour = lng / 15;
  const t = n + (18 - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  const L = mod(M + 1.916 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 282.634, 360);
  let RA = mod(deg(Math.atan(0.91764 * Math.tan(rad(L)))), 360);
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(rad(L));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(rad(90.833)) - sinDec * Math.sin(rad(lat))) / (cosDec * Math.cos(rad(lat)));
  const H = deg(Math.acos(Math.max(-1, Math.min(1, cosH)))) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  let ut = mod(T - lngHour, 24);
  // West of Greenwich, an evening sunset can fall after midnight UTC.
  if (ut < 12 - lngHour - 6) ut += 24;
  return new Date(Date.UTC(y, m - 1, d) + ut * 3_600_000);
}

/** The local weekday and date for a moment. */
function localDay(now: Date): { weekday: string; y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { weekday: get("weekday"), y: Number(get("year")), m: Number(get("month")), d: Number(get("day")) };
}

/** True from Friday sundown to Saturday sundown. */
export function isSabbath(now = new Date()): boolean {
  const { weekday, y, m, d } = localDay(now);
  if (weekday === "Fri") return now >= sunsetUtc(y, m, d);
  if (weekday === "Sat") return now < sunsetUtc(y, m, d);
  return false;
}
