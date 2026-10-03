import { translate, type Locale, type Translator } from "./i18n";

const formatters = new Map<Locale, {
  day: Intl.DateTimeFormat;
  year: Intl.DateTimeFormat;
  weekday: Intl.DateTimeFormat;
  monthDay: Intl.DateTimeFormat;
  numericDate: Intl.DateTimeFormat;
}>();

function localeFormatters(locale: Locale) {
  const existing = formatters.get(locale);
  if (existing) return existing;
  // `zh-Hans` is our document/catalog tag, while `zh-CN` gives stable
  // month/day punctuation across browser and Node Intl implementations.
  const intlLocale = locale === "zh-Hans" ? "zh-CN" : locale;
  const created = {
    day: new Intl.DateTimeFormat(intlLocale, { month: "long", day: "numeric", weekday: "short" }),
    year: new Intl.DateTimeFormat(intlLocale, { year: "numeric", month: "long", day: "numeric", weekday: "short" }),
    weekday: new Intl.DateTimeFormat(intlLocale, { weekday: "short" }),
    monthDay: new Intl.DateTimeFormat(intlLocale, { month: "long", day: "numeric" }),
    numericDate: new Intl.DateTimeFormat(intlLocale, { year: "numeric", month: "numeric", day: "numeric" }),
  };
  formatters.set(locale, created);
  return created;
}

function localDayNumber(timestamp: number): number {
  const value = new Date(timestamp);
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
}

export function startsNewMessageDay(timestamp: number, previousTimestamp?: number): boolean {
  return previousTimestamp === undefined || localDayNumber(timestamp) !== localDayNumber(previousTimestamp);
}

export function messageDateLabel(timestamp: number, now = Date.now(), locale: Locale = "zh-Hans", t: Translator = translate): string {
  const dayDistance = localDayNumber(now) - localDayNumber(timestamp);
  if (dayDistance === 0) return t("common.today");
  if (dayDistance === 1) return t("common.yesterday");
  const value = new Date(timestamp);
  const formatter = localeFormatters(locale);
  return value.getFullYear() === new Date(now).getFullYear() ? formatter.day.format(value) : formatter.year.format(value);
}

export function messageDateValue(timestamp: number): string {
  const value = new Date(timestamp);
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-");
}

export function roomActivityTimeLabel(timestamp: number, now = Date.now(), locale: Locale = "zh-Hans", t: Translator = translate): string {
  const value = new Date(timestamp);
  const dayDistance = localDayNumber(now) - localDayNumber(timestamp);
  if (dayDistance === 0) return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  if (dayDistance === 1) return t("common.yesterday");
  const formatter = localeFormatters(locale);
  if (dayDistance > 1 && dayDistance < 7) return formatter.weekday.format(value);
  if (value.getFullYear() === new Date(now).getFullYear()) return formatter.monthDay.format(value);
  return formatter.numericDate.format(value);
}

export function millisecondsUntilNextLocalDay(now = Date.now()): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 50);
  return Math.max(1, next.getTime() - now);
}
