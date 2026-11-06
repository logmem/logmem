/** America/New_York slot helpers for fleet-truth cadence. */

const SLOT_HOUR = { 9: "morning", 13: "midday", 17: "closeout" };

function parts(nowMs, timeZone = "America/New_York") {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const bag = Object.fromEntries(dtf.formatToParts(new Date(nowMs)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return {
    year: bag.year,
    month: bag.month,
    day: bag.day,
    hour: Number(bag.hour),
  };
}

export function slotFor(nowMs, timeZone = "America/New_York") {
  const { hour } = parts(nowMs, timeZone);
  return SLOT_HOUR[hour] || null;
}

export function etDate(nowMs, timeZone = "America/New_York") {
  const { year, month, day } = parts(nowMs, timeZone);
  return `${year}-${month}-${day}`;
}

export function trailId(dateEt, slot) {
  const compact = String(dateEt).replaceAll("-", "");
  return `fleetTruth-${compact}-${slot}`;
}
