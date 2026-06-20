/*
Structured Review plugin replacement focused on a stable workspace view.
*/
"use strict";

const {
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  requestUrl,
  setIcon,
} = require("obsidian");

const VIEW_TYPE = "structured-review-view";
const TEMPORARY_ARCHIVE_ID = "__temporary_archive__";
const REPORT_ROOT = "StructuredReview/reports";
const CITE_REVIEWS_FILE_NAME = "cite-reviews.json";
const SYNC_ROOT = "StructuredReview/sync";
const SYNC_DATA_FILE = `${SYNC_ROOT}/data.json`;
const SYNC_CITE_REVIEWS_FILE = `${SYNC_ROOT}/cite-reviews.json`;
const DEFAULT_DATA = { version: 3, projects: [], entries: [], timelineModules: [], citeReviews: [], settings: {} };
const DEFAULT_SETTINGS = {
  deepseekApiKey: "",
  deepseekModel: "deepseek-chat",
  reportMemoryCount: 4,
  petSystemPrompt: "你是一个小小的桌宠伙伴。请用中文回答，语气温柔、机灵、简短，像贴心但不啰嗦的朋友。回答控制在 1-3 句话，适合显示在桌宠头上的小气泡里。",
  deskPetMode: "follow",
  tabletMode: "auto",
  lastWeeklyPromptDate: "",
  lastMonthlyPromptDate: "",
};
const FIELD_TYPES = ["number", "score", "emotion", "text", "date", "file"];
const PROJECT_TYPES = ["long-term", "short-term", "temporary", "daily-status"];
const PROJECT_PALETTE = [
  { value: "#BF616A", label: "Rose" },
  { value: "#D08770", label: "Amber" },
  { value: "#EBCB8B", label: "Gold" },
  { value: "#A3BE8C", label: "Moss" },
  { value: "#8FBCBB", label: "Teal" },
  { value: "#88C0D0", label: "Sky" },
  { value: "#81A1C1", label: "Slate" },
];
const PROJECT_DOMAIN_META = [
  { value: "#BF616A", key: "english", label: "English" },
  { value: "#D08770", key: "exercise", label: "Exercise" },
  { value: "#EBCB8B", key: "money", label: "Money" },
  { value: "#A3BE8C", key: "life", label: "Life" },
  { value: "#8FBCBB", key: "habit", label: "Habit" },
  { value: "#88C0D0", key: "sleep", label: "Sleep" },
  { value: "#81A1C1", key: "research", label: "Research" },
];
const RPG_ATTRIBUTES = ["Knowledge", "Sense", "Body", "Mind", "Focus", "Creation"];
const RPG_ATTRIBUTE_HINTS = {
  Knowledge: ["read a paper", "review vocabulary", "take notes", "study one concept", "summarize a chapter"],
  Sense: ["visit an exhibition", "take a city walk", "shoot some photos", "listen closely", "notice one beautiful detail"],
  Body: ["go for a walk", "stretch for ten minutes", "do a light workout", "sleep earlier", "drink water and breathe"],
  Mind: ["have a rest", "watch a movie", "take a quiet shower", "write down your feelings", "sit outside for a while"],
  Focus: ["start a 50-minute deep work block", "close extra tabs", "work on one hard problem", "review today's priority", "protect a quiet hour"],
  Creation: ["write one paragraph", "ship a small improvement", "sketch an idea", "code one tiny feature", "make something visible"],
};
const DAILY_STATUS_FIELDS = [
  { id: "daily-mood", name: "Mood 心情", type: "emotion", required: true, options: [], sortOrder: 0 },
  { id: "daily-sleep", name: "Sleep 睡眠评级", type: "score", required: true, options: [], sortOrder: 1 },
  { id: "daily-sleep-time", name: "Sleep Time 睡眠时间", type: "time-range", required: false, options: [], sortOrder: 2 },
  { id: "daily-dream", name: "Dream Description 梦境描述", type: "text", required: false, options: [], sortOrder: 3 },
  { id: "daily-grip", name: "Grip Strength 握力 (kg)", type: "number", required: false, options: [], sortOrder: 4 },
];
const DAILY_REVIEW_START_HOUR = 8;
const DAILY_REVIEW_END_HOUR = 23;
const DAILY_SLEEP_START_HOUR = 0;
const DAILY_SLEEP_END_HOUR = 24;
const DAILY_TIMELINE_SLOT_HEIGHT = 42;
const CITE_REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30, 60];

function normalizeSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const memoryCount = Number(source.reportMemoryCount);
  const mode = ["fixed", "follow", "free"].includes(source.deskPetMode) ? source.deskPetMode : DEFAULT_SETTINGS.deskPetMode;
  const tabletMode = ["auto", "on", "off"].includes(source.tabletMode) ? source.tabletMode : DEFAULT_SETTINGS.tabletMode;
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    deepseekApiKey: String(source.deepseekApiKey || "").trim(),
    deepseekModel: String(source.deepseekModel || DEFAULT_SETTINGS.deepseekModel).trim() || DEFAULT_SETTINGS.deepseekModel,
    reportMemoryCount: Number.isFinite(memoryCount) ? Math.max(0, Math.min(8, Math.round(memoryCount))) : DEFAULT_SETTINGS.reportMemoryCount,
    petSystemPrompt: String(source.petSystemPrompt || DEFAULT_SETTINGS.petSystemPrompt).trim() || DEFAULT_SETTINGS.petSystemPrompt,
    deskPetMode: mode,
    tabletMode,
    lastWeeklyPromptDate: String(source.lastWeeklyPromptDate || ""),
    lastMonthlyPromptDate: String(source.lastMonthlyPromptDate || ""),
  };
}

function isProbablyTouchDevice() {
  if (typeof window === "undefined") return false;
  return Boolean(window.matchMedia?.("(pointer: coarse)")?.matches || window.navigator?.maxTouchPoints > 0);
}

function isTabletModeEnabled(settings) {
  const mode = normalizeSettings(settings).tabletMode;
  if (mode === "on") return true;
  if (mode === "off") return false;
  return isProbablyTouchDevice();
}

function isTabletMode(plugin) {
  return isTabletModeEnabled(plugin?.settings);
}

function applyTabletModeClass(plugin) {
  if (typeof document === "undefined") return;
  document.body.classList.toggle("sr-tablet-mode", isTabletMode(plugin));
}

function nowIso() {
  return new Date().toISOString();
}

function todayYmd() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function localDateTimeValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateInput(dateString) {
  const [year, month, day] = String(dateString || "").split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function shiftDateDays(dateString, amount) {
  const date = parseDateInput(dateString);
  date.setDate(date.getDate() + Number(amount || 0));
  return ymd(date);
}

function monthKeyFromDate(dateString = todayYmd()) {
  return String(dateString || todayYmd()).slice(0, 7);
}

function shiftMonth(monthKey, amount) {
  const [year, month] = String(monthKey || monthKeyFromDate()).split("-").map(Number);
  const next = new Date(year, (month || 1) - 1 + amount, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0") }`;
}

function monthLabel(monthKey) {
  const [year, month] = String(monthKey || "").split("-").map(Number);
  const date = new Date(year, (month || 1) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function fullDateLabel(dateString) {
  const date = parseDateInput(dateString);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function dateTimeLabel(dateTimeString) {
  const [datePart, timePart = ""] = String(dateTimeString || "").split("T");
  const time = timePart.slice(0, 5);
  return time ? `${fullDateLabel(datePart)} ${time}` : fullDateLabel(datePart);
}

function projectTypeLabel(type) {
  if (type === "short-term") return "Short-term";
  if (type === "temporary") return "Temporary";
  if (type === "daily-status") return "Daily Status";
  return "Long-term";
}

function normalizeProjectType(type) {
  return PROJECT_TYPES.includes(type) ? type : "long-term";
}

function isDailyStatusProject(project) {
  return normalizeProjectType(project?.type) === "daily-status";
}

function isSleepProject(project, index = 0) {
  const name = String(project?.name || "").trim().toLowerCase();
  return projectDomainMeta(project, index).key === "sleep" || name === "sleep" || name === "睡眠";
}

function parseDateTimeInput(dateTimeString) {
  const value = String(dateTimeString || "").trim();
  if (!value) return null;
  const [datePart, timePart = "00:00"] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hours, minutes] = timePart.split(":").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, hours || 0, minutes || 0, 0, 0);
}

function normalizeDateTimeInput(value, fallback = "") {
  const normalized = String(value || "").trim();
  if (normalized) return normalized.slice(0, 16);
  return fallback;
}

function normalizeHourDateTimeInput(value, fallback = "") {
  const date = parseDateTimeInput(value);
  if (!date) return fallback;
  date.setMinutes(0, 0, 0);
  return `${ymd(date)}T${String(date.getHours()).padStart(2, "0")}:00`;
}

function normalizeQuarterDateTimeInput(value, fallback = "") {
  const date = parseDateTimeInput(value);
  if (!date) return fallback;
  const rounded = Math.round(date.getMinutes() / 15) * 15;
  date.setMinutes(rounded, 0, 0);
  return localDateTimeValue(date);
}

function setDateTimeInputPair(startInput, endInput, startAt, minutes = 60) {
  const start = normalizeQuarterDateTimeInput(startAt, startAt);
  if (!start) return;
  startInput.value = start;
  endInput.value = shiftDateTimeMinutes(start, minutes) || endInput.value;
}

function dateForQuickTime(startInput, fallbackDate = todayYmd()) {
  return String(startInput.value || fallbackDate || todayYmd()).slice(0, 10) || todayYmd();
}

function dateTimeFromMinutes(dateString, totalMinutes) {
  const minutes = Math.max(0, Math.min(24 * 60, Math.round(totalMinutes)));
  const hours = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(dateString || todayYmd()).slice(0, 10)}T${String(hours).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function minutesFromDateTimeInput(input, fallbackMinutes) {
  const date = parseDateTimeInput(input.value);
  if (!date) return fallbackMinutes;
  return date.getHours() * 60 + date.getMinutes();
}

function shiftDateTimeHours(dateTimeString, hours) {
  const date = parseDateTimeInput(dateTimeString);
  if (!date) return "";
  date.setHours(date.getHours() + hours);
  return localDateTimeValue(date);
}

function shiftDateTimeMinutes(dateTimeString, minutes) {
  const date = parseDateTimeInput(dateTimeString);
  if (!date) return "";
  date.setMinutes(date.getMinutes() + minutes);
  return localDateTimeValue(date);
}

function defaultEntryStartAt(dateString = "") {
  const baseDate = String(dateString || todayYmd()).slice(0, 10) || todayYmd();
  const now = new Date();
  const hour = baseDate === todayYmd() ? now.getHours() : 9;
  return `${baseDate}T${String(hour).padStart(2, "0")}:00`;
}

function deriveEntryStartAt(entry) {
  if (entry?.startAt) return normalizeQuarterDateTimeInput(entry.startAt);
  if (entry?.date) return `${String(entry.date).slice(0, 10)}T00:00`;
  return defaultEntryStartAt();
}

function deriveEntryEndAt(entry, startAt = deriveEntryStartAt(entry)) {
  if (entry?.endAt) return normalizeQuarterDateTimeInput(entry.endAt);
  if (startAt) return shiftDateTimeHours(startAt, 1) || startAt;
  return shiftDateTimeHours(defaultEntryStartAt(entry?.date), 1);
}

function entryStartAt(entry) {
  return normalizeQuarterDateTimeInput(entry?.startAt || deriveEntryStartAt(entry));
}

function entryEndAt(entry) {
  return normalizeQuarterDateTimeInput(entry?.endAt || deriveEntryEndAt(entry, entryStartAt(entry)));
}

function dateBoundsFor(selectedDate) {
  const date = parseDateInput(selectedDate);
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  return { dayStart, dayEnd };
}

function clampDateTimeRangeToDate(startAt, endAt, selectedDate, minimumMinutes) {
  const start = parseDateTimeInput(startAt);
  const end = parseDateTimeInput(endAt);
  if (!start || !end) return null;
  const { dayStart, dayEnd } = dateBoundsFor(selectedDate);
  if (end <= dayStart || start >= dayEnd) return null;
  const clampedStart = start < dayStart ? dayStart : start;
  const clampedEnd = end > dayEnd ? dayEnd : end;
  const startMinutes = Math.max(0, Math.round((clampedStart.getTime() - dayStart.getTime()) / 60000));
  let endMinutes = Math.min(24 * 60, Math.round((clampedEnd.getTime() - dayStart.getTime()) / 60000));
  if (endMinutes <= startMinutes) endMinutes = Math.min(24 * 60, startMinutes + minimumMinutes);
  return {
    startMinutes,
    endMinutes,
  };
}

function entryOverlapsDate(entry, selectedDate) {
  return Boolean(clampDateTimeRangeToDate(entryStartAt(entry), entryEndAt(entry), selectedDate, 60));
}

function clampEntryToDate(entry, selectedDate) {
  return clampDateTimeRangeToDate(entryStartAt(entry), entryEndAt(entry), selectedDate, 60);
}

function entryTimeLabel(entry) {
  return formatDateTimeRange(entryStartAt(entry), entryEndAt(entry));
}

function deriveProjectStartAt(project) {
  const type = normalizeProjectType(project?.type);
  if (project?.startAt) return normalizeDateTimeInput(project.startAt);
  if (type === "temporary" && project?.occurredAt) return normalizeDateTimeInput(project.occurredAt);
  if (type === "short-term" && project?.startDate) return `${String(project.startDate).slice(0, 10)}T00:00`;
  return "";
}

function deriveProjectEndAt(project, startAt = deriveProjectStartAt(project)) {
  const type = normalizeProjectType(project?.type);
  if (project?.endAt) return normalizeDateTimeInput(project.endAt);
  if (type === "temporary" && project?.occurredAt) return shiftDateTimeHours(project.occurredAt, 1);
  if (type === "short-term" && project?.plannedEndDate) return `${String(project.plannedEndDate).slice(0, 10)}T23:59`;
  if (type !== "long-term" && startAt) return shiftDateTimeHours(startAt, 1) || startAt;
  return "";
}

function dailyStatusFields() {
  return DAILY_STATUS_FIELDS.map((field) => ({ ...field }));
}

function projectStartAt(project) {
  return normalizeDateTimeInput(project?.startAt || deriveProjectStartAt(project));
}

function projectEndAt(project) {
  return normalizeDateTimeInput(project?.endAt || deriveProjectEndAt(project, projectStartAt(project)));
}

function projectStartDate(project) {
  return projectStartAt(project).slice(0, 10);
}

function projectEndDate(project) {
  return projectEndAt(project).slice(0, 10);
}

function projectAnchorDate(project) {
  return projectStartDate(project) || String(project?.createdAt || nowIso()).slice(0, 10);
}

function formatDateTimeRange(startAt, endAt) {
  if (!startAt || !endAt) return "Schedule incomplete";
  const startDate = String(startAt).slice(0, 10);
  const endDate = String(endAt).slice(0, 10);
  const startTime = String(startAt).slice(11, 16);
  const endTime = String(endAt).slice(11, 16);
  const duration = durationLabelFromMinutes(Math.max(0, Math.round((parseDateTimeInput(endAt).getTime() - parseDateTimeInput(startAt).getTime()) / 60000)));
  if (startDate === endDate) return `${startDate} ${startTime}-${endTime} · ${duration}`;
  return `${startDate} ${startTime} → ${endDate} ${endTime} · ${duration}`;
}

function projectScheduleLabel(project) {
  const startAt = projectStartAt(project);
  const endAt = projectEndAt(project);
  if (!startAt || !endAt) {
    return project.type === "long-term" ? "No fixed schedule" : "Schedule incomplete";
  }
  if (project.type === "short-term") {
    return `${projectStartDate(project)} → ${projectEndDate(project)}`;
  }
  const rangeLabel = formatDateTimeRange(startAt, endAt);
  if (project.type === "temporary") {
    return rangeLabel + " | " + (project.completed ? "Completed" : "Pending");
  }
  return rangeLabel;
}

function projectOverlapsDate(project, selectedDate) {
  return Boolean(clampDateTimeRangeToDate(projectStartAt(project), projectEndAt(project), selectedDate, 30));
}

function validateProjectInput(input) {
  const color = normalizeProjectColor(input?.color);
  const type = normalizeProjectType(input?.type);
  const startAt = normalizeQuarterDateTimeInput(input?.startAt || "");
  const endAt = normalizeQuarterDateTimeInput(input?.endAt || "");
  const startDate = String(input?.startDate || "").slice(0, 10);
  const plannedEndDate = String(input?.plannedEndDate || "").slice(0, 10);
  if (type === "temporary") {
    if (!startAt) throw new Error("Temporary projects require a start time.");
    if (!endAt) throw new Error("Temporary projects require an end time.");
    if (endAt <= startAt) throw new Error("End time must be later than start time.");
  } else if (type === "short-term") {
    if (!startDate) throw new Error("Short-term projects require a start date.");
    if (!plannedEndDate) throw new Error("Short-term projects require an end date.");
    if (plannedEndDate < startDate) throw new Error("End date must be on or after start date.");
  }
  if (!PROJECT_PALETTE.some((item) => item.value === color)) {
    throw new Error("Project color must be selected from the preset palette.");
  }
}

function buildMonthGrid(monthKey) {
  const [year, month] = String(monthKey).split("-").map(Number);
  const first = new Date(year, (month || 1) - 1, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(year, (month || 1) - 1, 1 - startOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const current = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return {
      date: ymd(current),
      day: current.getDate(),
      inCurrentMonth: current.getMonth() === first.getMonth(),
    };
  });
}

function isDateInRange(date, start, end) {
  return date >= start && date <= end;
}

function shortTermLaneMap(projects) {
  const laneEnds = [];
  const map = new Map();
  const items = projects
    .filter((project) => project.type === "short-term" && projectStartAt(project) && projectEndAt(project))
    .sort((left, right) => {
      const byStart = projectStartAt(left).localeCompare(projectStartAt(right));
      return byStart !== 0 ? byStart : left.name.localeCompare(right.name);
    });
  for (const project of items) {
    const start = projectStartDate(project);
    const end = projectEndDate(project);
    let lane = laneEnds.findIndex((endDate) => endDate < start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    map.set(project.id, lane);
  }
  return map;
}

function id(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function weekRange(date = new Date()) {
  const current = new Date(date);
  const day = current.getDay() || 7;
  const start = new Date(current);
  start.setDate(current.getDate() - day + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    key: `${ymd(start)}_to_${ymd(end)}`,
    start: ymd(start),
    end: ymd(end),
  };
}

function monthRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return {
    key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
    start: ymd(start),
    end: ymd(end),
  };
}

function shiftDays(dateString, amount) {
  const date = parseDateInput(dateString);
  date.setDate(date.getDate() + amount);
  return ymd(date);
}

function dateRange(days, endDate = todayYmd()) {
  const dates = [];
  const end = parseDateInput(endDate);
  end.setHours(0, 0, 0, 0);
  for (let index = days - 1; index >= 0; index -= 1) {
    const next = new Date(end);
    next.setDate(end.getDate() - index);
    dates.push(ymd(next));
  }
  return dates;
}

function dateRangeInclusive(startDate, endDate) {
  const dates = [];
  const start = parseDateInput(startDate);
  const end = parseDateInput(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    dates.push(ymd(cursor));
  }
  return dates.length ? dates : [todayYmd()];
}

function normalizeProjectColor(color, index = 0) {
  const value = String(color || "").trim().toUpperCase();
  const matched = PROJECT_PALETTE.find((item) => item.value === value);
  if (matched) return matched.value;
  return PROJECT_PALETTE[index % PROJECT_PALETTE.length].value;
}

function getProjectColorOption(color) {
  const normalized = normalizeProjectColor(color, 0);
  return PROJECT_PALETTE.find((item) => item.value === normalized) || PROJECT_PALETTE[0];
}

function projectColor(project, index) {
  return normalizeProjectColor(project?.color, index);
}

function projectDomainMeta(project, index = 0) {
  const color = projectColor(project, index);
  const matched = PROJECT_DOMAIN_META.find((item) => item.value === color);
  if (matched) return matched;
  const fallback = getProjectColorOption(color);
  return {
    value: fallback.value,
    key: fallback.label.toLowerCase(),
    label: fallback.label,
  };
}

function hexToRgb(hex) {
  const clean = (hex || "").replace("#", "");
  if (clean.length !== 6) return { r: 127, g: 127, b: 127 };
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mixRgb(left, right, ratio) {
  const t = Math.max(0, Math.min(1, ratio));
  return {
    r: Math.round(left.r + (right.r - left.r) * t),
    g: Math.round(left.g + (right.g - left.g) * t),
    b: Math.round(left.b + (right.b - left.b) * t),
  };
}

function rgbCss(color) {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function gradientForWeights(items) {
  if (!items || items.length === 0) return "linear-gradient(135deg, rgba(120,120,120,0.12), rgba(120,120,120,0.05))";
  if (items.length === 1) return items[0].color;
  const total = items.reduce((sum, item) => sum + item.weight, 0) || 1;
  let cursor = 0;
  const stops = items.map((item) => {
    const start = Math.round((cursor / total) * 100);
    cursor += item.weight;
    const end = Math.round((cursor / total) * 100);
    return `${item.color} ${start}% ${end}%`;
  });
  return `linear-gradient(135deg, ${stops.join(", ")})`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function defaultFieldName(type, index) {
  const map = {
    number: "Number",
    score: "Score",
    "time-range": "Time Range",
    text: "Text",
    date: "Date",
    file: "File",
  };
  return `${map[type] || "Field"} ${index + 1}`;
}

function normalizeScoreValue(value, fieldName) {
  if (value == null || value === "") return "";
  const score = Number(value);
  if (!Number.isFinite(score)) throw new Error(`Score must be a number: ${fieldName}`);
  if (score < 0 || score > 5) throw new Error(`Score must be between 0 and 5: ${fieldName}`);
  return Math.round(score * 10) / 10;
}

function normalizeEmotionValue(value, fieldName) {
  if (value == null || value === "") return "";
  if (typeof value === "number" || typeof value === "string") {
    const pleasure = normalizeScoreValue(value, fieldName);
    return pleasure === "" ? "" : { pleasure, energy: 3 };
  }
  const pleasure = normalizeScoreValue(value.pleasure, `${fieldName} pleasure`);
  const energy = normalizeScoreValue(value.energy, `${fieldName} energy`);
  if (pleasure === "" && energy === "") return "";
  return {
    pleasure: pleasure === "" ? 3 : pleasure,
    energy: energy === "" ? 3 : energy,
  };
}

function emotionValueParts(value) {
  if (value == null || value === "") return null;
  try {
    const normalized = normalizeEmotionValue(value, "Emotion");
    return normalized && typeof normalized === "object" ? normalized : null;
  } catch (_) {
    return null;
  }
}

function emotionStatusLabel(value) {
  const emotion = emotionValueParts(value);
  if (!emotion) return "-";
  return `Pleasure ${formatRpgXp(emotion.pleasure)}/5 · Energy ${formatRpgXp(emotion.energy)}/5`;
}

function emotionColor(value) {
  const emotion = emotionValueParts(value);
  if (!emotion) return "";
  const pleasureRatio = emotion.pleasure / 5;
  const energyRatio = emotion.energy / 5;
  const topLeft = hexToRgb("#BF616A");
  const topRight = hexToRgb("#EBCB8B");
  const bottomRight = hexToRgb("#A3BE8C");
  const bottomLeft = hexToRgb("#81A1C1");
  const top = mixRgb(topLeft, topRight, pleasureRatio);
  const bottom = mixRgb(bottomLeft, bottomRight, pleasureRatio);
  return rgbCss(mixRgb(bottom, top, energyRatio));
}

function emotionBackground(value) {
  const color = emotionColor(value);
  return color ? `color-mix(in srgb, ${color} 14%, transparent)` : "";
}

function emotionCalendarColor(value) {
  const emotion = emotionValueParts(value);
  if (!emotion) return "";
  const pleasureRatio = emotion.pleasure / 5;
  const energyRatio = emotion.energy / 5;
  const corners = [
    { x: 0, y: 1, color: "#BF616A" },
    { x: 1, y: 1, color: "#EBCB8B" },
    { x: 1, y: 0, color: "#A3BE8C" },
    { x: 0, y: 0, color: "#81A1C1" },
  ];
  const nearest = corners
    .map((corner) => ({
      ...corner,
      distance: Math.hypot(pleasureRatio - corner.x, energyRatio - corner.y),
    }))
    .sort((left, right) => left.distance - right.distance)[0];
  return nearest?.color || "";
}

function calendarMarkJitter(seed) {
  let hash = 0;
  const value = String(seed || "");
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  const part = (shift, modulo) => Math.abs((hash >> shift) % modulo);
  return {
    x: part(0, 7) - 3,
    y: part(4, 5) - 2,
    rotate: part(8, 17) - 8,
    scale: 0.92 + part(12, 17) / 100,
    width: 23 + part(16, 7),
    height: 18 + part(20, 7),
    radius: `${44 + part(2, 16)}% ${42 + part(6, 18)}% ${48 + part(10, 18)}% ${40 + part(14, 18)}%`,
  };
}

function normalizeField(field, index) {
  const type = FIELD_TYPES.includes(field?.type) ? field.type : "text";
  const name = String(field?.name || "").trim() || defaultFieldName(type, index);
  return {
    id: field?.id || id("field"),
    name,
    type,
    required: Boolean(field?.required),
    options: [],
    sortOrder: Number.isFinite(field?.sortOrder) ? field.sortOrder : index,
  };
}

function normalizeProject(project, index) {
  const startAt = deriveProjectStartAt(project);
  const endAt = deriveProjectEndAt(project, startAt);
  const type = normalizeProjectType(project?.type);
  return {
    id: project?.id || id("project"),
    name: String(project?.name || "Untitled Project"),
    description: String(project?.description || ""),
    type,
    startAt,
    endAt,
    startDate: startAt.slice(0, 10),
    plannedEndDate: endAt.slice(0, 10),
    occurredAt: type === "temporary" ? startAt : (project?.occurredAt ? String(project.occurredAt) : ""),
    completed: Boolean(project?.completed),
    createdAt: project?.createdAt || nowIso(),
    updatedAt: project?.updatedAt || nowIso(),
    isActive: project?.isActive !== false,
    color: projectColor(project, index),
    fields: type === "daily-status" ? dailyStatusFields() : (Array.isArray(project?.fields) ? project.fields.map(normalizeField) : []),
  };
}

function normalizeEntry(entry) {
  const startAt = deriveEntryStartAt(entry);
  const endAt = deriveEntryEndAt(entry, startAt);
  return {
    id: entry?.id || id("entry"),
    projectId: String(entry?.projectId || ""),
    date: startAt.slice(0, 10) || String(entry?.date || todayYmd()),
    startAt,
    endAt,
    values: entry?.values && typeof entry.values === "object" ? entry.values : {},
    createdAt: entry?.createdAt || nowIso(),
    updatedAt: entry?.updatedAt || nowIso(),
  };
}

function normalizeTimelineModule(module, index = 0) {
  const startDate = String(module?.startDate || todayYmd()).slice(0, 10);
  const endDate = String(module?.endDate || startDate).slice(0, 10);
  return {
    id: module?.id || id("module"),
    projectId: String(module?.projectId || ""),
    name: String(module?.name || "").trim() || `Plan ${index + 1}`,
    startDate,
    endDate: endDate < startDate ? startDate : endDate,
    done: Boolean(module?.done),
    createdAt: module?.createdAt || nowIso(),
    updatedAt: module?.updatedAt || nowIso(),
  };
}

function normalizeCiteReview(review) {
  const stage = Number(review?.stage);
  const history = Array.isArray(review?.history)
    ? review.history.slice(-80).map((item) => ({
      date: String(item?.date || "").slice(0, 10),
      rating: ["remembered", "fuzzy", "forgotten"].includes(item?.rating) ? item.rating : "fuzzy",
      reviewedAt: String(item?.reviewedAt || nowIso()),
    })).filter((item) => item.date)
    : [];
  return {
    path: normalizePath(String(review?.path || "")),
    stage: Number.isFinite(stage) ? Math.max(-1, Math.min(CITE_REVIEW_INTERVALS.length - 1, Math.round(stage))) : -1,
    nextReview: String(review?.nextReview || todayYmd()).slice(0, 10),
    lastReview: String(review?.lastReview || "").slice(0, 10),
    lastRating: ["remembered", "fuzzy", "forgotten"].includes(review?.lastRating) ? review.lastRating : "",
    reviewCount: Math.max(0, Number(review?.reviewCount) || history.length),
    history,
  };
}

function normalizeCiteReviews(reviews) {
  return Array.isArray(reviews)
    ? reviews.map(normalizeCiteReview).filter((review) => review.path)
    : [];
}

function mainDataPayload(data, settings) {
  const source = data && typeof data === "object" ? data : DEFAULT_DATA;
  return {
    version: source.version || DEFAULT_DATA.version,
    projects: Array.isArray(source.projects) ? source.projects : [],
    entries: Array.isArray(source.entries) ? source.entries : [],
    timelineModules: Array.isArray(source.timelineModules) ? source.timelineModules : [],
    settings: normalizeSettings(settings || source.settings),
  };
}

function validateTimelineModuleInput(input) {
  const name = String(input?.name || "").trim();
  const projectId = String(input?.projectId || "").trim();
  const startDate = String(input?.startDate || "").slice(0, 10);
  const endDate = String(input?.endDate || "").slice(0, 10);
  if (!projectId) throw new Error("Plan project is required.");
  if (!name) throw new Error("Plan name is required.");
  if (!startDate) throw new Error("Plan start date is required.");
  if (!endDate) throw new Error("Plan end date is required.");
  if (endDate < startDate) throw new Error("Plan end date must be on or after start date.");
}

class Repository {
  constructor(plugin, data) {
    this.plugin = plugin;
    this.listeners = new Set();
    const source = data && typeof data === "object" ? data : DEFAULT_DATA;
    this.data = {
      version: 3,
      projects: Array.isArray(source.projects) ? source.projects.map(normalizeProject) : [],
      entries: Array.isArray(source.entries) ? source.entries.map(normalizeEntry) : [],
      timelineModules: Array.isArray(source.timelineModules) ? source.timelineModules.map(normalizeTimelineModule) : [],
      citeReviews: normalizeCiteReviews(source.citeReviews),
      settings: normalizeSettings(source.settings),
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) listener();
  }

  async persist() {
    await this.plugin.saveRepositoryData(this.data);
  }

  listProjects() {
    return [...this.data.projects].sort((left, right) => {
      if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  getProject(projectId) {
    return this.data.projects.find((project) => project.id === projectId) || null;
  }

  createProject(input) {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Project name is required.");
    validateProjectInput(input);
    const fields = Array.isArray(input?.fields)
      ? input.fields.map(normalizeField)
      : [];
    const timestamp = nowIso();
    const type = normalizeProjectType(input?.type);
    const startAt = type === "temporary"
      ? normalizeQuarterDateTimeInput(input?.startAt || "")
      : type === "short-term"
        ? `${String(input?.startDate || "").slice(0, 10)}T00:00`
        : "";
    const endAt = type === "temporary"
      ? normalizeQuarterDateTimeInput(input?.endAt || "")
      : type === "short-term"
        ? `${String(input?.plannedEndDate || "").slice(0, 10)}T23:59`
        : "";
    const project = normalizeProject({
      id: id("project"),
      name,
      description: String(input?.description || "").trim(),
      type,
      startAt,
      endAt,
      completed: type === "temporary" ? Boolean(input?.completed) : false,
      createdAt: timestamp,
      updatedAt: timestamp,
      isActive: input?.isActive !== false,
      color: normalizeProjectColor(input?.color, this.data.projects.length),
      fields: type === "daily-status" ? dailyStatusFields() : fields,
    }, this.data.projects.length);
    this.data.projects.unshift(project);
    this.notify();
    return project;
  }
  async createProjectAndPersist(input) {
    const project = this.createProject(input);
    await this.persist();
    return project;
  }

  updateProject(projectId, input) {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Project name is required.");
    validateProjectInput(input);
    const fields = Array.isArray(input?.fields)
      ? input.fields.map(normalizeField)
      : project.fields;
    const type = normalizeProjectType(input?.type);
    const startAt = type === "temporary"
      ? normalizeQuarterDateTimeInput(input?.startAt || "")
      : type === "short-term"
        ? `${String(input?.startDate || "").slice(0, 10)}T00:00`
        : "";
    const endAt = type === "temporary"
      ? normalizeQuarterDateTimeInput(input?.endAt || "")
      : type === "short-term"
        ? `${String(input?.plannedEndDate || "").slice(0, 10)}T23:59`
        : "";
    Object.assign(project, {
      name,
      description: String(input?.description || "").trim(),
      type,
      startAt,
      endAt,
      startDate: startAt ? startAt.slice(0, 10) : "",
      plannedEndDate: endAt ? endAt.slice(0, 10) : "",
      occurredAt: type === "temporary" ? startAt : "",
      completed: type === "temporary" ? Boolean(input?.completed) : false,
      isActive: input?.isActive !== false,
      color: normalizeProjectColor(input?.color, PROJECT_PALETTE.indexOf(project.color)),
      fields: type === "daily-status" ? dailyStatusFields() : fields,
      updatedAt: nowIso(),
    });
    this.notify();
    return project;
  }

  async updateProjectAndPersist(projectId, input) {
    const project = this.updateProject(projectId, input);
    await this.persist();
    return project;
  }

  listEntries(projectId = null) {
    return this.data.entries
      .filter((entry) => !projectId || entry.projectId === projectId)
      .sort((left, right) => {
        const byDate = right.date.localeCompare(left.date);
        return byDate !== 0 ? byDate : right.updatedAt.localeCompare(left.updatedAt);
      });
  }

  getEntry(entryId) {
    return this.data.entries.find((entry) => entry.id === entryId) || null;
  }

  listTimelineModules(projectId = null) {
    return [...(this.data.timelineModules || [])]
      .filter((module) => !projectId || module.projectId === projectId)
      .sort((left, right) => {
        const byStart = left.startDate.localeCompare(right.startDate);
        if (byStart !== 0) return byStart;
        return left.name.localeCompare(right.name, "en-US");
      });
  }

  getTimelineModule(moduleId) {
    return (this.data.timelineModules || []).find((module) => module.id === moduleId) || null;
  }

  getCiteReview(path) {
    const normalizedPath = normalizePath(String(path || ""));
    return (this.data.citeReviews || []).find((review) => review.path === normalizedPath) || null;
  }

  async reviewCiteCardAndPersist(path, rating, reviewDate = todayYmd()) {
    const normalizedPath = normalizePath(String(path || ""));
    if (!normalizedPath) throw new Error("Card path is required.");
    if (!["remembered", "fuzzy", "forgotten"].includes(rating)) throw new Error("Unknown memory rating.");
    const date = String(reviewDate || todayYmd()).slice(0, 10);
    let review = this.getCiteReview(normalizedPath);
    if (!review) {
      review = normalizeCiteReview({ path: normalizedPath, stage: -1, nextReview: date });
      this.data.citeReviews = [...(this.data.citeReviews || []), review];
    }
    let nextStage = review.stage;
    let intervalDays = 1;
    if (rating === "remembered") {
      nextStage = Math.min(CITE_REVIEW_INTERVALS.length - 1, review.stage + 1);
      intervalDays = CITE_REVIEW_INTERVALS[Math.max(0, nextStage)];
    } else if (rating === "fuzzy") {
      nextStage = Math.max(-1, review.stage - 1);
      intervalDays = 1;
    } else {
      nextStage = -1;
      intervalDays = 1;
    }
    const reviewedAt = nowIso();
    Object.assign(review, {
      stage: nextStage,
      nextReview: shiftDateDays(date, intervalDays),
      lastReview: date,
      lastRating: rating,
      reviewCount: review.reviewCount + 1,
      history: [...review.history, { date, rating, reviewedAt }].slice(-80),
    });
    this.notify();
    await this.persist();
    return review;
  }

  createTimelineModule(input) {
    validateTimelineModuleInput(input);
    const project = this.getProject(input.projectId);
    if (!project) throw new Error("Project not found.");
    if (!["short-term", "long-term"].includes(project.type)) throw new Error("Plans can only be added to short-term or long-term projects.");
    const timestamp = nowIso();
    const module = normalizeTimelineModule({
      id: id("module"),
      projectId: project.id,
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
      done: Boolean(input.done),
      createdAt: timestamp,
      updatedAt: timestamp,
    }, this.data.timelineModules?.length || 0);
    this.data.timelineModules = [...(this.data.timelineModules || []), module];
    project.updatedAt = timestamp;
    this.notify();
    return module;
  }

  async createTimelineModuleAndPersist(input) {
    const module = this.createTimelineModule(input);
    await this.persist();
    return module;
  }

  updateTimelineModule(moduleId, input) {
    const module = this.getTimelineModule(moduleId);
    if (!module) throw new Error("Module not found.");
    validateTimelineModuleInput(input);
    const project = this.getProject(input.projectId);
    if (!project) throw new Error("Project not found.");
    if (!["short-term", "long-term"].includes(project.type)) throw new Error("Plans can only be added to short-term or long-term projects.");
    Object.assign(module, {
      projectId: project.id,
      name: String(input.name || "").trim(),
      startDate: String(input.startDate || "").slice(0, 10),
      endDate: String(input.endDate || "").slice(0, 10),
      done: Boolean(input.done),
      updatedAt: nowIso(),
    });
    project.updatedAt = module.updatedAt;
    this.notify();
    return module;
  }

  async updateTimelineModuleAndPersist(moduleId, input) {
    const module = this.updateTimelineModule(moduleId, input);
    await this.persist();
    return module;
  }

  async deleteTimelineModuleAndPersist(moduleId) {
    const module = this.getTimelineModule(moduleId);
    if (!module) throw new Error("Module not found.");
    this.data.timelineModules = (this.data.timelineModules || []).filter((item) => item.id !== moduleId);
    const project = this.getProject(module.projectId);
    if (project) project.updatedAt = nowIso();
    this.notify();
    await this.persist();
  }

  createEntry(projectId, input) {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    const dailyDate = String(input?.date || todayYmd()).slice(0, 10);
    const startAt = isDailyStatusProject(project) ? `${dailyDate}T00:00` : normalizeQuarterDateTimeInput(input?.startAt || "");
    const endAt = isDailyStatusProject(project) ? `${dailyDate}T00:01` : normalizeQuarterDateTimeInput(input?.endAt || "");
    if (!startAt) throw new Error("Entry start time is required.");
    if (!endAt) throw new Error("Entry end time is required.");
    if (endAt <= startAt) throw new Error("Entry end time must be later than start time.");
    const nextValues = {};
    for (const field of project.fields) {
      let rawValue = input?.values?.[field.id];
      if (field.required) {
        const missing = rawValue == null || rawValue === "" || rawValue === false;
        if (missing) throw new Error(`Field required: ${field.name}`);
      }
      if (field.type === "score") rawValue = normalizeScoreValue(rawValue, field.name);
      if (field.type === "emotion") rawValue = normalizeEmotionValue(rawValue, field.name);
      nextValues[field.id] = rawValue;
    }
    const timestamp = nowIso();
    const entry = normalizeEntry({
      id: id("entry"),
      projectId,
      date: startAt.slice(0, 10),
      startAt,
      endAt,
      values: nextValues,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.data.entries.unshift(entry);
    project.updatedAt = timestamp;
    this.notify();
    return entry;
  }

  async createEntryAndPersist(projectId, input) {
    const entry = this.createEntry(projectId, input);
    await this.persist();
    return entry;
  }

  updateEntry(entryId, input) {
    const entry = this.getEntry(entryId);
    if (!entry) throw new Error("Entry not found.");
    const project = this.getProject(entry.projectId);
    if (!project) throw new Error("Project not found.");
    const dailyDate = String(input?.date || entry.date || todayYmd()).slice(0, 10);
    const startAt = isDailyStatusProject(project) ? `${dailyDate}T00:00` : normalizeQuarterDateTimeInput(input?.startAt || "");
    const endAt = isDailyStatusProject(project) ? `${dailyDate}T00:01` : normalizeQuarterDateTimeInput(input?.endAt || "");
    if (!startAt) throw new Error("Entry start time is required.");
    if (!endAt) throw new Error("Entry end time is required.");
    if (endAt <= startAt) throw new Error("Entry end time must be later than start time.");
    const nextValues = {};
    for (const field of project.fields) {
      let rawValue = input.values[field.id];
      if (field.required) {
        const missing = rawValue == null || rawValue === "" || rawValue === false;
        if (missing) throw new Error(`Field required: ${field.name}`);
      }
      if (field.type === "score") rawValue = normalizeScoreValue(rawValue, field.name);
      if (field.type === "emotion") rawValue = normalizeEmotionValue(rawValue, field.name);
      nextValues[field.id] = rawValue;
    }
    entry.date = startAt.slice(0, 10);
    entry.startAt = startAt;
    entry.endAt = endAt;
    entry.values = nextValues;
    entry.updatedAt = nowIso();
    project.updatedAt = entry.updatedAt;
    this.notify();
    return entry;
  }

  async updateEntryAndPersist(entryId, input) {
    const entry = this.updateEntry(entryId, input);
    await this.persist();
    return entry;
  }

  async deleteEntryAndPersist(entryId) {
    const entry = this.getEntry(entryId);
    if (!entry) throw new Error("Entry not found.");
    this.data.entries = this.data.entries.filter((item) => item.id !== entryId);
    const project = this.getProject(entry.projectId);
    if (project) project.updatedAt = nowIso();
    this.notify();
    await this.persist();
  }

  async setProjectArchivedAndPersist(projectId, isActive) {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    project.isActive = Boolean(isActive);
    project.updatedAt = nowIso();
    this.notify();
    await this.persist();
    return project;
  }

  async deleteProjectAndPersist(projectId) {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    this.data.projects = this.data.projects.filter((item) => item.id !== projectId);
    this.data.entries = this.data.entries.filter((entry) => entry.projectId !== projectId);
    this.data.timelineModules = (this.data.timelineModules || []).filter((module) => module.projectId !== projectId);
    this.notify();
    await this.persist();
  }

  async setTemporaryCompletedAndPersist(projectId, completed) {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found.");
    if (project.type !== "temporary") throw new Error("Only temporary projects can be completed.");
    project.completed = Boolean(completed);
    project.updatedAt = nowIso();
    this.notify();
    await this.persist();
    return project;
  }
}

class ReportService {
  constructor(plugin, repository) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.repository = repository;
  }

  async ensureFolder(target) {
    const adapter = this.app.vault.adapter;
    const parts = normalizePath(target).split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await this.app.vault.createFolder(current);
    }
  }

  entriesBetween(start, end) {
    return this.repository.listEntries().filter((entry) => entry.date >= start && entry.date <= end);
  }

  formatValues(project, entry) {
    return project.fields
      .map((field) => {
        const value = entry.values[field.id];
        if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
        const display = Array.isArray(value) ? value.join(", ") : String(value);
        return `  - ${field.name}: ${display}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  rangeFor(kind) {
    if (kind === "monthly") {
      const today = parseDateInput(todayYmd());
      return monthRange(new Date(today.getFullYear(), today.getMonth() - 1, 1));
    }
    return weekRange(parseDateInput(shiftDays(todayYmd(), -7)));
  }

  reportFolder(kind) {
    return `${REPORT_ROOT}/${kind === "monthly" ? "monthly" : "weekly"}`;
  }

  reportFilename(kind, range) {
    return `${kind === "monthly" ? "monthly" : "weekly"}-${range.key}.md`;
  }

  buildEntryDigest(start, end) {
    const projects = this.repository.listProjects();
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    const entries = this.entriesBetween(start, end);
    const lines = [
      `Period: ${start} to ${end}`,
      `Total projects: ${projects.length}`,
      `Total records: ${entries.length}`,
      "",
      "Project snapshot:",
    ];

    for (const project of projects) {
      const meta = projectDomainMeta(project, 0);
      const projectEntries = entries.filter((entry) => entry.projectId === project.id);
      lines.push(`- ${project.name} (${projectTypeLabel(project.type)}, ${meta.label}, ${projectEntries.length} records): ${projectScheduleLabel(project)}`);
      if (project.description) lines.push(`  Description: ${project.description}`);
    }

    lines.push("", "Records:");
    if (entries.length === 0) {
      lines.push("- No records in this period.");
      return lines.join("\n");
    }

    for (const entry of entries.slice().reverse()) {
      const project = projectMap.get(entry.projectId);
      const meta = projectDomainMeta(project, 0);
      lines.push(`- ${entry.date} | ${project?.name || "Unknown Project"} | ${projectTypeLabel(project?.type)} | ${meta.label}`);
      const values = this.formatValues(project || { fields: [] }, entry);
      lines.push(values || "  - No custom values");
    }
    return lines.join("\n");
  }

  async readRecentReports(limit, excludePath) {
    const count = Math.max(0, Number(limit) || 0);
    if (count === 0) return [];
    const normalizedExclude = excludePath ? normalizePath(excludePath) : "";
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${REPORT_ROOT}/`) && file.path !== normalizedExclude)
      .sort((left, right) => right.path.localeCompare(left.path))
      .slice(0, count);
    const reports = [];
    for (const file of files) {
      reports.push({ path: file.path, content: await this.app.vault.read(file) });
    }
    return reports;
  }

  buildMessages(kind, range, entryDigest, historicalReports) {
    const reportTitle = kind === "monthly" ? `月报 ${range.key}` : `周报 ${range.key}`;
    const planHeading = kind === "monthly" ? "下月计划" : "下周计划";
    const history = historicalReports.length > 0
      ? historicalReports.map((report, index) => `### Memory ${index + 1}: ${report.path}\n${report.content}`).join("\n\n")
      : "没有找到历史报告。";

    return [
      {
        role: "system",
        content: [
          "请只使用中文，使用 Markdown。",
          "你要写的是一份带温度的个人复盘：前半部分清晰、具体、相对客观，后半部分像一封熟悉的人写来的短短信。",
          "前半部分要认真看记录和历史报告，讲清楚他最近在做什么、精力怎么流动、状态哪里变好了或变紧了；可以有判断，但不要像公司绩效总结。",
          "后半部分才切换成一个很熟悉他的女生写给他的信。她常常叫他“大宝”，有一点调皮，会心疼人，也能直接说重点。",
          "共感优先：先捕捉记录背后的情绪和疲惫，再给判断。允许自然的语气词、感叹号、短句、叠词，也可以说“想抱抱你”这类有温度的话。",
          "但是不要装可爱、不要撒糖过量、不要像 AI 角色扮演。亲密感要来自具体观察，而不是空泛称呼。",
          "不要堆建议清单，不要模棱两可。只挑本周期最重要的一个问题，和他一起拆，像坐在他旁边一起想办法。",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `${kind === "monthly" ? "请生成一份简洁的月报" : "请生成一份简洁的周报"}，标题为「${reportTitle}」。`,
          `报告周期是 ${range.start} 到 ${range.end}。`,
          "请完整阅读历史报告，把它当成你对我的记忆；本周期记录是主要依据。",
          "报告结构请按下面来，不要增加太多额外板块：",
          "1. 先写「客观复盘」：用几段话说明我这段时间主要在做什么、精力投向哪里、节奏有什么变化。要有具体证据，可以提优点和不足，但不要灌鸡汤。",
          "2. 再写「本周期最重要的一个问题」：只挑一个最重要的问题。请直接说你看见了什么、为什么它重要、它可能正在怎样消耗我。不要列多个问题。",
          "3. 接着写「我们先一起试试」：不要给一堆建议，只给一个很小、很具体、下周真的能试的动作。写得像你在陪我一起处理，不是把任务甩给我。",
          "4. 最后写「写给大宝的一封信」：这里再切换成亲近、调皮、懂我的女生口吻。开头自然叫我“大宝”。可以有一点心疼、开心、吐槽和想抱抱的感觉，但必须贴着本周期记录写，不要模板化。",
          `5. 最后保留一个名为「${planHeading}」的板块，留给我手动填写；这个板块只放占位提示，不要替我写计划。`,
          "",
          "## 本周期记录",
          entryDigest,
          "",
          "## 历史报告记忆",
          history,
        ].join("\n"),
      },
    ];
  }

  async callDeepSeek(messages) {
    const settings = normalizeSettings(this.plugin.settings);
    if (!settings.deepseekApiKey) {
      throw new Error("DeepSeek API key is missing. Add it in report settings.");
    }

    const response = await requestUrl({
      url: "https://api.deepseek.com/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: settings.deepseekModel,
        messages,
        temperature: 0.8,
        max_tokens: 1800,
      }),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`DeepSeek request failed with status ${response.status}.`);
    }

    const content = response.json?.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek returned an empty report.");
    return content.trim();
  }

  async writeReport(folder, filename, content) {
    await this.ensureFolder(folder);
    const path = normalizePath(`${folder}/${filename}`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(path, content);
    }
    return path;
  }

  async generateReport(kind) {
    const normalizedKind = kind === "monthly" ? "monthly" : "weekly";
    const range = this.rangeFor(normalizedKind);
    const folder = this.reportFolder(normalizedKind);
    const filename = this.reportFilename(normalizedKind, range);
    const path = normalizePath(`${folder}/${filename}`);
    const entryDigest = this.buildEntryDigest(range.start, range.end);
    const historicalReports = await this.readRecentReports(this.plugin.settings.reportMemoryCount, path);
    const messages = this.buildMessages(normalizedKind, range, entryDigest, historicalReports);
    const report = await this.callDeepSeek(messages);
    const header = [
      `<!-- Generated by Structured Review with DeepSeek on ${nowIso()} -->`,
      `<!-- Period: ${range.start} to ${range.end} -->`,
      "",
    ].join("\n");
    return this.writeReport(folder, filename, header + report + "\n");
  }

  async generateWeeklyReport() {
    return this.generateReport("weekly");
  }

  async generateMonthlyReport() {
    return this.generateReport("monthly");
  }
}
function resolveVaultResource(app, value) {
  const path = String(value || "").trim();
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const file = app.vault.getAbstractFileByPath(path);
  if (file) return app.vault.getResourcePath(file);
  return "";
}

function resolveVaultFile(app, value) {
  const path = String(value || "").trim();
  if (!path || /^https?:\/\//i.test(path)) return null;
  const file = app.vault.getAbstractFileByPath(path);
  return file && typeof file.path === "string" ? file : null;
}

function listVaultFilePaths(app) {
  return app.vault.getFiles().map((file) => file.path).sort((a, b) => a.localeCompare(b));
}

function fileNameFromPath(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized || "File";
}

function renderFieldValue(parent, field, value, app) {
  if (field.type === "file" && value) {
    const wrap = parent.createDiv({ cls: "sr-file-field" });
    const head = wrap.createDiv({ cls: "sr-tag-row" });
    head.createSpan({ cls: "sr-tag", text: `${field.name}:` });
    const file = resolveVaultFile(app, value);
    if (file) {
      const link = head.createEl("a", { text: fileNameFromPath(file.path), href: file.path });
      link.addClass("sr-tag");
      link.addClass("internal-link");
      link.setAttr("data-href", file.path);
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        await app.workspace.getLeaf(true).openFile(file);
      });

      return;
    }
    const href = resolveVaultResource(app, value) || String(value);
    const link = head.createEl("a", { text: fileNameFromPath(value), href });
    link.addClass("sr-tag");
    link.setAttr("target", "_blank");

    return;
  }
  if (field.type === "score") {
    const row = parent.createDiv({ cls: "sr-score-meter" });
    const score = Number(value);
    const safeScore = Number.isFinite(score) ? Math.max(0, Math.min(5, score)) : 0;
    const head = row.createDiv({ cls: "sr-score-meter-head" });
    head.createSpan({ text: field.name });
    head.createSpan({ text: value == null || value === "" ? "-" : `${formatRpgXp(safeScore)}/5` });
    const blocks = row.createDiv({ cls: "sr-score-meter-blocks" });
    for (let index = 1; index <= 5; index += 1) {
      const block = blocks.createSpan();
      if (safeScore >= index) block.addClass("is-filled");
      else if (safeScore > index - 1) block.addClass("is-partial");
    }
    return;
  }
  if (field.type === "emotion") {
    const emotion = emotionValueParts(value);
    const row = parent.createDiv({ cls: "sr-emotion-meter" });
    const head = row.createDiv({ cls: "sr-score-meter-head" });
    head.createSpan({ text: field.name });
    head.createSpan({ text: emotionStatusLabel(value) });
    const plane = row.createDiv({ cls: "sr-emotion-plane" });
    const dot = plane.createSpan({ cls: "sr-emotion-dot" });
    if (emotion) {
      dot.style.left = `${(emotion.pleasure / 5) * 100}%`;
      dot.style.top = `${100 - (emotion.energy / 5) * 100}%`;
      dot.style.background = emotionColor(value);
    } else {
      dot.style.display = "none";
    }
    row.createDiv({ cls: "sr-emotion-axis-labels", text: "Calm ← Pleasure → Bright · Low ← Energy → High" });
    return;
  }
  if (field.type === "time-range") {
    const range = parseTimeRangeValue(value, 23 * 60, 31 * 60, { allowWrap: true });
    const row = parent.createDiv({ cls: "sr-tag" });
    row.setText(`${field.name}: ${value ? `${timeRangeValue(range.start, range.end)} · ${durationLabelFromMinutes(range.end - range.start)}` : "-"}`);
    return;
  }
  const row = parent.createDiv({ cls: "sr-tag" });
  const display = value;
  row.setText(`${field.name}: ${display == null || display === "" ? "-" : String(display)}`);
}

function summarizeProject(repository, project) {
  const entries = repository.listEntries(project.id);
  const activeDays = new Set(entries.map((entry) => entry.date)).size;
  return {
    project,
    entries,
    count: entries.length,
    lastDate: entries[0]?.date || "-",
    activeDays,
  };
}

function daysBetweenExclusive(startDate, endDate) {
  const start = parseDateInput(startDate);
  const end = parseDateInput(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
}

function buildHeatDays(repository, days) {
  const dates = dateRange(days);
  const projects = repository.listProjects();
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const byDate = new Map(dates.map((date) => [date, { date, total: 0, items: [] }]));
  for (const entry of repository.listEntries()) {
    const bucket = byDate.get(entry.date);
    if (!bucket) continue;
    bucket.total += 1;
    let item = bucket.items.find((candidate) => candidate.projectId === entry.projectId);
    if (!item) {
      const project = projectMap.get(entry.projectId);
      item = { projectId: entry.projectId, name: project?.name || "Unknown", color: projectColor(project, 0), weight: 0 };
      bucket.items.push(item);
    }
    item.weight += 1;
  }
  return dates.map((date) => byDate.get(date));
}

function emptyRpgXp() {
  return Object.fromEntries(RPG_ATTRIBUTES.map((attribute) => [attribute, 0]));
}

function addRpgXp(target, attribute, amount) {
  if (!Object.prototype.hasOwnProperty.call(target, attribute)) return;
  target[attribute] += amount;
}

function formatRpgXp(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function randomRpgAttributeHint(attribute) {
  const hints = RPG_ATTRIBUTE_HINTS[attribute] || ["make one small move"];
  return hints[Math.floor(Math.random() * hints.length)];
}

function statusScoreDelta(value) {
  if (value == null) return null;
  return Math.round((Number(value) - 3) * 10) / 10;
}

function getEntryNumberValue(project, entry, matchers) {
  const field = project.fields.find((item) => {
    const name = String(item.name || "").toLowerCase();
    return matchers.some((matcher) => name.includes(matcher));
  });
  if (!field) return null;
  const value = Number(entry.values[field.id]);
  return Number.isFinite(value) ? value : null;
}

function getEntryEmotionValue(project, entry, matchers) {
  const field = project.fields.find((item) => {
    const name = String(item.name || "").toLowerCase();
    return item.type === "emotion" && matchers.some((matcher) => name.includes(matcher));
  });
  if (!field) return null;
  return emotionValueParts(entry.values[field.id]);
}

function getEntryTimeRangeMinutes(project, entry, matchers) {
  const field = project.fields.find((item) => {
    const name = String(item.name || "").toLowerCase();
    return item.type === "time-range" && matchers.some((matcher) => name.includes(matcher));
  });
  if (!field) return 0;
  const range = parseTimeRangeValue(entry.values[field.id], 23 * 60, 31 * 60, { allowWrap: true });
  return Math.max(0, range.end - range.start);
}

function rpgApplyProjectEntry(xp, project, entry) {
  const category = projectDomainMeta(project, 0).key;
  const minutes = entryDurationMinutes(entry);
  if (category === "english") {
    addRpgXp(xp, "Knowledge", 2);
    addRpgXp(xp, "Focus", 1);
    addRpgXp(xp, "Creation", 0.5);
    const wrong = getEntryNumberValue(project, entry, ["wrong"]);
    if (wrong != null) addRpgXp(xp, "Mind", wrong <= 5 ? 1 : wrong > 10 ? -1 : 0);
  } else if (category === "exercise") {
    addRpgXp(xp, "Body", 2.5);
    addRpgXp(xp, "Mind", 1);
    addRpgXp(xp, "Focus", 0.5);
    const fatigue = getEntryNumberValue(project, entry, ["fatigue", "tired"]);
    if (fatigue != null) addRpgXp(xp, "Body", -fatigue);
  } else if (category === "money") {
    addRpgXp(xp, "Body", -1);
    addRpgXp(xp, "Focus", 1);
    addRpgXp(xp, "Knowledge", 0.5);
  } else if (category === "life") {
    addRpgXp(xp, "Sense", 2);
    addRpgXp(xp, "Mind", 1);
    addRpgXp(xp, "Creation", 0.5);
  } else if (category === "habit") {
    addRpgXp(xp, "Creation", 2);
    addRpgXp(xp, "Knowledge", 1);
    addRpgXp(xp, "Sense", 0.5);
    if (minutes >= 120) addRpgXp(xp, "Focus", 1.5);
  } else if (category === "sleep") {
    addRpgXp(xp, "Body", 2);
    addRpgXp(xp, "Mind", 1);
    if (minutes >= 420) addRpgXp(xp, "Body", 1);
    if (minutes < 360) {
      addRpgXp(xp, "Body", -2);
      addRpgXp(xp, "Focus", -1);
    }
  } else if (category === "research") {
    addRpgXp(xp, "Knowledge", 2);
    addRpgXp(xp, "Focus", 2);
    addRpgXp(xp, "Creation", 1);
    if (minutes >= 120) {
      addRpgXp(xp, "Focus", 1);
      addRpgXp(xp, "Body", -0.5);
    }
  }
}

function rpgDailyStatusEntries(repository) {
  const projects = repository.listProjects().filter(isDailyStatusProject);
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  return repository.listEntries()
    .filter((entry) => projectMap.has(entry.projectId))
    .map((entry) => ({ entry, project: projectMap.get(entry.projectId) }));
}

function rpgApplyDailyStatus(xp, repository, statusEntry) {
  const { entry, project } = statusEntry;
  const moodEmotion = getEntryEmotionValue(project, entry, ["mood"]);
  const mood = moodEmotion ? moodEmotion.pleasure : getEntryNumberValue(project, entry, ["mood"]);
  const sleep = getEntryNumberValue(project, entry, ["sleep"]);
  const moodDelta = statusScoreDelta(mood);
  const sleepDelta = statusScoreDelta(sleep);
  if (moodDelta != null) addRpgXp(xp, "Mind", moodDelta);
  if (moodEmotion) addRpgXp(xp, "Focus", Math.round((moodEmotion.energy - 3) * 5) / 10);
  if (sleepDelta != null) {
    addRpgXp(xp, "Mind", sleepDelta);
    addRpgXp(xp, "Body", sleepDelta);
  }
  const sleepMinutes = getEntryTimeRangeMinutes(project, entry, ["sleep time", "睡眠时间"]);
  if (sleepMinutes > 0) {
    addRpgXp(xp, "Body", 2);
    addRpgXp(xp, "Mind", 1);
    if (sleepMinutes >= 420) addRpgXp(xp, "Body", 1);
    if (sleepMinutes < 360) {
      addRpgXp(xp, "Body", -2);
      addRpgXp(xp, "Focus", -1);
    }
  }

  const grip = getEntryNumberValue(project, entry, ["grip"]);
  if (grip == null) return;
  const prior = rpgDailyStatusEntries(repository)
    .filter((item) => item.entry.date < entry.date && item.entry.date >= shiftDays(entry.date, -7))
    .map((item) => getEntryNumberValue(item.project, item.entry, ["grip"]))
    .filter((value) => value != null);
  if (prior.length === 0) return;
  const average = prior.reduce((sum, value) => sum + value, 0) / prior.length;
  if (grip > average * 1.05) addRpgXp(xp, "Body", 1);
  if (grip < average * 0.95) addRpgXp(xp, "Body", -1);
}

function rpgLevelFromXp(xp) {
  let remaining = Math.max(0, xp);
  let level = 1;
  while (remaining >= 50 * Math.pow(level, 1.3)) {
    remaining -= 50 * Math.pow(level, 1.3);
    level += 1;
  }
  const next = 50 * Math.pow(level, 1.3);
  return { level, progress: next > 0 ? remaining / next : 0, remaining, next };
}

function rpgOverallLevelFromXp(totalXp) {
  const averageXp = RPG_ATTRIBUTES.reduce((sum, attribute) => sum + Math.max(0, totalXp[attribute]), 0) / RPG_ATTRIBUTES.length;
  return rpgLevelFromXp(averageXp).level;
}

function dailyStatusEntryForDate(repository, selectedDate) {
  return rpgDailyStatusEntries(repository)
    .filter((item) => item.entry.date === selectedDate)
    .sort((left, right) => right.entry.updatedAt.localeCompare(left.entry.updatedAt))[0] || null;
}

function dailyStatusValue(status, fieldId) {
  return status?.entry?.values?.[fieldId] ?? "";
}

function scoreStatusMetric(label, value) {
  const score = Number(value);
  const normalized = Number.isFinite(score) ? Math.max(0, Math.min(5, score)) : null;
  return {
    label,
    value: normalized == null ? "-" : `${formatRpgXp(normalized)}/5`,
    percent: normalized == null ? 0 : (normalized / 5) * 100,
  };
}

function sleepTimeMinutes(value) {
  if (!value) return null;
  const range = parseTimeRangeValue(value, 23 * 60, 31 * 60, { allowWrap: true });
  return Math.max(0, range.end - range.start);
}

function sleepTimeStatusMetric(value) {
  if (!value) {
    return { label: "Sleep Time", value: "-", percent: 0 };
  }
  const range = parseTimeRangeValue(value, 23 * 60, 31 * 60, { allowWrap: true });
  const minutes = sleepTimeMinutes(value) || 0;
  return {
    label: "Sleep Time",
    value: `${timeRangeValue(range.start, range.end)} · ${durationLabelFromMinutes(minutes)}`,
    percent: Math.min(100, (minutes / (8 * 60)) * 100),
  };
}

function buildOverviewStats(repository, selectedDate) {
  const startDate = shiftDays(selectedDate, -6);
  const projects = repository.listProjects();
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const recordsToday = repository.listEntries().filter((entry) => {
    const project = projectMap.get(entry.projectId);
    return entry.date === selectedDate && project && !isDailyStatusProject(project) && !isSleepProject(project);
  });
  const sevenDayCounts = new Map();
  for (const entry of repository.listEntries()) {
    if (entry.date < startDate || entry.date > selectedDate) continue;
    const project = projectMap.get(entry.projectId);
    if (!project || isDailyStatusProject(project) || isSleepProject(project)) continue;
    const current = sevenDayCounts.get(project.id) || { project, count: 0 };
    current.count += 1;
    sevenDayCounts.set(project.id, current);
  }
  const activeProjects = Array.from(sevenDayCounts.values()).filter((item) => item.count > 0);
  const mostProject = activeProjects.slice().sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return right.project.updatedAt.localeCompare(left.project.updatedAt);
  })[0] || null;
  const leastProject = activeProjects.slice().sort((left, right) => {
    if (left.count !== right.count) return left.count - right.count;
    return right.project.updatedAt.localeCompare(left.project.updatedAt);
  })[0] || null;
  return {
    selectedDate,
    totalRecords: recordsToday.length,
    mostProject,
    leastProject,
  };
}

async function ensureVaultFolder(app, target) {
  const adapter = app.vault.adapter;
  const parts = normalizePath(target).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) await app.vault.createFolder(current);
  }
}

async function saveOverviewNote(plugin, selectedDate, content) {
  const text = String(content || "").trim();
  if (!text) throw new Error("Note is empty.");
  const folder = "StructuredReview/notes";
  await ensureVaultFolder(plugin.app, folder);
  const timestamp = localDateTimeValue().replace(/[-:T]/g, "").slice(0, 12);
  let path = normalizePath(`${folder}/${selectedDate}-${timestamp}.md`);
  let suffix = 2;
  while (plugin.app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(`${folder}/${selectedDate}-${timestamp}-${suffix}.md`);
    suffix += 1;
  }
  const body = [
    "---",
    `date: ${selectedDate}`,
    "source: Structured Review Overview",
    "---",
    "",
    text,
    "",
  ].join("\n");
  await plugin.app.vault.create(path, body);
  return path;
}

async function saveDeskPetReply(plugin, content, source = "Desk Pet Reply") {
  const text = String(content || "").trim();
  if (!text) throw new Error("Reply is empty.");
  const folder = "StructuredReview/notes";
  await ensureVaultFolder(plugin.app, folder);
  const timestamp = localDateTimeValue().replace(/[-:T]/g, "").slice(0, 12);
  let path = normalizePath(`${folder}/desk-pet-${timestamp}.md`);
  let suffix = 2;
  while (plugin.app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(`${folder}/desk-pet-${timestamp}-${suffix}.md`);
    suffix += 1;
  }
  const body = [
    "---",
    `date: ${todayYmd()}`,
    `source: ${source}`,
    "---",
    "",
    text,
    "",
  ].join("\n");
  await plugin.app.vault.create(path, body);
  return path;
}

function buildDeskPetAiMessages(plugin, selectedDate, noteContent) {
  const repository = plugin.repository;
  const settings = normalizeSettings(plugin.settings);
  const overview = buildOverviewStats(repository, selectedDate);
  const status = dailyStatusEntryForDate(repository, selectedDate);
  const statusLines = [
    `User mood coordinate: ${emotionStatusLabel(dailyStatusValue(status, "daily-mood"))}`,
    `User sleep rating: ${dailyStatusValue(status, "daily-sleep") || "-"}`,
    `User sleep time: ${dailyStatusValue(status, "daily-sleep-time") || "-"}`,
    `User dream record: ${dailyStatusValue(status, "daily-dream") || "-"} (This is the user's dream record, not the desk pet's dream.)`,
  ];
  const entries = repository.listEntries()
    .filter((entry) => entry.date === selectedDate)
    .slice()
    .sort((left, right) => entryStartAt(left).localeCompare(entryStartAt(right)));
  const projects = new Map(repository.listProjects().map((project) => [project.id, project]));
  const entryLines = entries.slice(0, 12).map((entry) => {
    const project = projects.get(entry.projectId);
    const time = entry.startAt ? `${String(entry.startAt).slice(11, 16)}-${String(entry.endAt || "").slice(11, 16) || "?"}` : entry.date;
    return `- ${time} ${project?.name || "Unknown"} ${entry.note ? `: ${entry.note}` : ""}`;
  });
  const context = [
    `Date: ${fullDateLabel(selectedDate)}`,
    `Total records today: ${overview.totalRecords}`,
    `Most frequent project in 7d: ${overview.mostProject ? `${overview.mostProject.project.name} (${overview.mostProject.count})` : "-"}`,
    `Least frequent completed project in 7d: ${overview.leastProject ? `${overview.leastProject.project.name} (${overview.leastProject.count})` : "-"}`,
    "Low-priority background only - Daily Status:",
    ...statusLines,
    "Low-priority background only - Today's records:",
    ...(entryLines.length ? entryLines : ["- No project records."]),
  ].join("\n");
  const note = String(noteContent || "").trim();
  return [
    {
      role: "system",
      content: [
        settings.petSystemPrompt,
        "你正在作为 Obsidian 插件里的桌宠说话。",
        "用户刚刚在 Overview 的 Note 输入框里写了一段话。输入框内容是最高优先级，也是你要直接回应的对象。",
        "今日状态、睡眠、项目记录和七日统计只作为低权重背景，帮助你理解语气和处境；不要主动围绕它们做复盘、诊断或建议。",
        "Daily Status 里的 Mood、Sleep、Dream 等字段全部是用户自己的记录，不是你的状态，也不是你的梦。",
        "只有当用户输入明确提到状态、睡眠、记录、计划或复盘时，才可以轻量引用背景信息。",
        "如果输入框内容很短或只是情绪表达，也优先回应这句话本身，不要被背景数据带偏。",
        "不要输出标题，不要写长段复盘，不要使用项目符号。回答控制在 1-3 句话。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Primary user note. Respond to this first:",
        note || "(empty)",
        "",
        "Weak background context. Use only if it directly helps answer the note:",
        context,
      ].join("\n"),
    },
  ];
}

async function askDeskPetAi(plugin, selectedDate, noteContent) {
  const messages = buildDeskPetAiMessages(plugin, selectedDate, noteContent);
  return plugin.reportService.callDeepSeek(messages);
}

function buildSelectionAiMessages(plugin, selectedText, question, sourcePath = "", includeSystemPrompt = true) {
  const settings = normalizeSettings(plugin.settings);
  const userMessage = {
    role: "user",
    content: [
      sourcePath ? `Source note: ${sourcePath}` : "",
      "Selected text:",
      String(selectedText || "").trim(),
      "",
      "User question:",
      String(question || "").trim() || "请解释这段内容，并给出我接下来可以怎么理解或使用它。",
    ].filter(Boolean).join("\n"),
  };
  if (!includeSystemPrompt) return [userMessage];
  return [
    {
      role: "system",
      content: [
        settings.petSystemPrompt,
        "你正在作为 Obsidian 插件里的桌宠回答用户针对选中文本提出的问题。",
        "请优先解释选中文本本身，必要时指出可能的上下文缺口。",
        "默认使用中文，回答清晰、具体、简短；不要编造没有依据的信息。",
      ].join("\n"),
    },
    userMessage,
  ];
}

async function askSelectionAi(plugin, selectedText, question, sourcePath = "", includeSystemPrompt = true) {
  const messages = buildSelectionAiMessages(plugin, selectedText, question, sourcePath, includeSystemPrompt);
  return plugin.reportService.callDeepSeek(messages);
}

function openSelectionAiBubble(plugin, selectedText, sourcePath = "") {
  document.dispatchEvent(new CustomEvent("sr-deskpet-ask", {
    bubbles: true,
    detail: {
      selectedText: String(selectedText || "").trim(),
      sourcePath: sourcePath || plugin.app.workspace.getActiveFile()?.path || "",
    },
  }));
}

function buildLifeRpgStats(repository, selectedDate) {
  const projects = repository.listProjects();
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const todayXp = emptyRpgXp();
  const totalXp = emptyRpgXp();
  const todayEntries = [];
  const statusEntries = rpgDailyStatusEntries(repository);
  const statusIds = new Set(statusEntries.map((item) => item.entry.id));

  for (const entry of repository.listEntries()) {
    const project = projectMap.get(entry.projectId);
    if (!project || entry.date > selectedDate || statusIds.has(entry.id)) continue;
    rpgApplyProjectEntry(totalXp, project, entry);
    if (entry.date === selectedDate) {
      rpgApplyProjectEntry(todayXp, project, entry);
      todayEntries.push({ entry, project });
    }
  }

  for (const statusEntry of statusEntries) {
    if (statusEntry.entry.date > selectedDate) continue;
    rpgApplyDailyStatus(totalXp, repository, statusEntry);
    if (statusEntry.entry.date === selectedDate) {
      rpgApplyDailyStatus(todayXp, repository, statusEntry);
      todayEntries.push(statusEntry);
    }
  }

  const levels = Object.fromEntries(RPG_ATTRIBUTES.map((attribute) => [attribute, rpgLevelFromXp(totalXp[attribute])]));
  const overallLevel = rpgOverallLevelFromXp(totalXp);
  const todayTotal = RPG_ATTRIBUTES.reduce((sum, attribute) => sum + todayXp[attribute], 0);
  const classScores = new Map();
  for (const item of todayEntries) {
    if (isDailyStatusProject(item.project)) continue;
    const domain = projectDomainMeta(item.project, 0);
    if (domain.key === "sleep") continue;
    const label = domain.label;
    classScores.set(label, (classScores.get(label) || 0) + Math.max(1, entryDurationMinutes(item.entry)));
  }
  const topClass = Array.from(classScores.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] || "Balanced";
  const className = topClass === "Research" ? "Research Mage" : topClass === "Balanced" ? "Balanced Adventurer" : `${topClass} Adventurer`;
  const avatarKey = rpgAvatarKey(topClass);

  return { todayXp, totalXp, levels, overallLevel, todayTotal, className, classLabel: topClass, avatarKey };
}

function rpgAvatarKey(classLabel) {
  const normalized = String(classLabel || "Balanced").toLowerCase();
  return ["english", "exercise", "money", "life", "habit", "research"].includes(normalized) ? normalized : "balanced";
}

function getRpgAvatarUrl(plugin, avatarKey) {
  const key = rpgAvatarKey(avatarKey);
  const path = normalizePath(`.obsidian/plugins/obsidian-structured-review/assets/avatar-${key}.png`);
  const adapter = plugin?.app?.vault?.adapter;
  if (adapter && typeof adapter.getResourcePath === "function") {
    return adapter.getResourcePath(path);
  }
  return `assets/avatar-${key}.png`;
}

function getPluginAssetUrl(plugin, filename) {
  const path = normalizePath(`.obsidian/plugins/obsidian-structured-review/assets/${filename}`);
  const adapter = plugin?.app?.vault?.adapter;
  if (adapter && typeof adapter.getResourcePath === "function") {
    return adapter.getResourcePath(path);
  }
  return `assets/${filename}`;
}

function renderDeskPet(root, plugin) {
  const petSize = 92;
  const sprites = {
    jumpUp: getPluginAssetUrl(plugin, "deskpet-jump-up.png"),
    jumpMidUp: getPluginAssetUrl(plugin, "deskpet-jump-mid-up.png"),
    jumpDown: getPluginAssetUrl(plugin, "deskpet-jump-down.png"),
    jumpMidDown: getPluginAssetUrl(plugin, "deskpet-jump-mid-down.png"),
    walkA: getPluginAssetUrl(plugin, "deskpet-walk-a.png"),
    walkB: getPluginAssetUrl(plugin, "deskpet-walk-b.png"),
    walkC: getPluginAssetUrl(plugin, "deskpet-walk-c.png"),
    walkD: getPluginAssetUrl(plugin, "deskpet-walk-d.png"),
    read: getPluginAssetUrl(plugin, "deskpet-read.png"),
    readPageA: getPluginAssetUrl(plugin, "deskpet-read-page-a.png"),
    readPageB: getPluginAssetUrl(plugin, "deskpet-read-page-b.png"),
    game: getPluginAssetUrl(plugin, "deskpet-game.png"),
    gameA: getPluginAssetUrl(plugin, "deskpet-game-a.png"),
    gameB: getPluginAssetUrl(plugin, "deskpet-game-b.png"),
    sleep: getPluginAssetUrl(plugin, "deskpet-sleep.png"),
    sleepA: getPluginAssetUrl(plugin, "deskpet-sleep-a.png"),
    sleepB: getPluginAssetUrl(plugin, "deskpet-sleep-b.png"),
    held: getPluginAssetUrl(plugin, "deskpet-held-a.png"),
    heldA: getPluginAssetUrl(plugin, "deskpet-held-a.png"),
    heldB: getPluginAssetUrl(plugin, "deskpet-held-b.png"),
  };
  const pet = root.createDiv({ cls: "sr-deskpet" });
  const img = pet.createEl("img", {
    attr: {
      alt: "",
      src: sprites.jumpDown,
      draggable: "false",
    },
  });
  let frame = 0;
  let x = 120;
  let currentY = 0;
  let direction = 1;
  let action = "move";
  let idleUntil = 0;
  let idleAction = "read";
  let lastSprite = "";
  let jumpPlan = null;
  let mouseTarget = null;
  let dragHoldTimer = 0;
  let dragPointerId = null;
  let dragStartPoint = null;
  let dragOffset = null;
  let isDraggingPet = false;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const setSprite = (key) => {
    if (lastSprite === key) return;
    img.src = sprites[key] || sprites.jumpDown;
    lastSprite = key;
  };
  const setImagePose = (key, facing = direction, lift = 0, rotate = 0) => {
    setSprite(key);
    const poseScale = key === "held" ? 1.2 : 1;
    img.style.transform = `scaleX(${facing >= 0 ? 1 : -1}) scale(${poseScale}) translateY(${lift}px) rotate(${rotate}deg)`;
  };
  const pointInRoot = (event) => {
    const rect = root.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + root.scrollLeft,
      y: event.clientY - rect.top + root.scrollTop,
    };
  };
  const setMouseTarget = (event) => {
    if (isDraggingPet) return;
    mouseTarget = pointInRoot(event);
  };
  root.addEventListener("pointermove", setMouseTarget);
  const rootBounds = () => {
    const rect = root.getBoundingClientRect();
    return {
      rect,
      width: Math.max(petSize, rect.width),
      fallbackGround: Math.max(0, root.scrollHeight - petSize - 18),
    };
  };
  const landingPlatforms = () => {
    const rootRect = root.getBoundingClientRect();
    const selectors = [
      ".sr-panel",
      ".sr-overview-card",
      ".sr-stat-card",
      ".sr-project-card",
      ".sr-overview-chart",
      ".sr-trend-snapshot-card",
      ".sr-rpg-level-row",
    ].join(",");
    return Array.from(root.querySelectorAll(selectors))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left - rootRect.left + root.scrollLeft,
          right: rect.right - rootRect.left + root.scrollLeft,
          y: rect.top - rootRect.top + root.scrollTop - petSize + 2,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((ground) => ground.right > 0 && ground.y > 24 && ground.width >= petSize && ground.height >= 26)
      .sort((left, right) => left.y - right.y);
  };
  const defaultTarget = (bounds) => ({
    x: Math.min(bounds.width - 32, Math.max(32, root.scrollLeft + bounds.width * 0.55)),
    y: root.scrollTop + bounds.rect.height * 0.45,
  });
  const platformForPose = (grounds, centerX, previousY) => {
    const candidates = grounds.filter((ground) => centerX >= ground.left && centerX <= ground.right);
    if (!candidates.length) return null;
    if (!previousY) return candidates.sort((left, right) => left.y - right.y)[0] || null;
    return candidates
      .sort((left, right) => Math.abs(left.y - previousY) - Math.abs(right.y - previousY) || left.y - right.y)[0] || null;
  };
  const destinationOnPlatform = (destination, bounds) => {
    if (!destination) return null;
    const platform = destination.platform;
    const leftLimit = platform ? platform.left : 8;
    const rightLimit = platform ? platform.right - petSize : Math.max(8, bounds.width - petSize - 8);
    const safeRightLimit = Math.max(leftLimit, rightLimit);
    return {
      ...destination,
      x: clamp(destination.x, Math.max(8, leftLimit), Math.max(8, safeRightLimit)),
    };
  };
  const nearestPlatformForDrop = (platforms, bounds) => {
    const centerX = x + petSize / 2;
    const candidates = platforms
      .filter((platform) => centerX >= platform.left - petSize * 0.45 && centerX <= platform.right + petSize * 0.45)
      .map((platform) => {
        const minX = platform.left;
        const maxX = Math.max(minX, platform.right - petSize);
        return {
          platform,
          x: clamp(x, minX, maxX),
          y: platform.y,
          score: Math.abs(platform.y - currentY) + Math.abs(clamp(centerX, platform.left, platform.right) - centerX) * 0.5,
        };
      })
      .sort((left, right) => left.score - right.score);
    return candidates[0] || {
      x: clamp(x, 8, Math.max(8, bounds.width - petSize - 8)),
      y: bounds.fallbackGround,
    };
  };
  const landingForTarget = (platforms, bounds) => {
    const target = mouseTarget || defaultTarget(bounds);
    const fallback = {
      left: 8,
      right: Math.max(petSize + 8, bounds.width - 8),
      y: bounds.fallbackGround,
      width: bounds.width,
      height: 1,
    };
    const platform = platforms
      .map((candidate) => {
        const minCenter = candidate.left + petSize / 2;
        const maxCenter = Math.max(minCenter, candidate.right - petSize / 2);
        const clampedX = clamp(target.x, minCenter, maxCenter);
        const dx = Math.abs(clampedX - target.x);
        const dy = Math.abs((candidate.y + petSize) - target.y);
        return { platform: candidate, clampedX, score: dx * 0.8 + dy };
      })
      .sort((left, right) => left.score - right.score)[0] || {
        platform: fallback,
        clampedX: clamp(target.x, fallback.left + petSize / 2, fallback.right - petSize / 2),
      };
    return destinationOnPlatform({
      target,
      x: clamp(platform.clampedX - petSize / 2, 8, Math.max(8, bounds.width - petSize - 8)),
      y: platform.platform.y,
      platform: platform.platform,
    }, bounds);
  };
  const isNearTarget = (landing) => {
    const petCenterX = x + petSize / 2;
    const petFeetY = currentY + petSize;
    if (mouseTarget && Math.abs(mouseTarget.y - petFeetY) > 118) return false;
    if (Math.abs(landing.y - currentY) > 24) return false;
    return Math.abs(petCenterX - landing.target.x) < 96 && Math.abs(petFeetY - landing.target.y) < 132;
  };
  const startIdle = (now) => {
    const choices = ["read", "game", "sleep"];
    idleAction = choices[Math.floor(Math.random() * choices.length)] || "read";
    idleUntil = now + (idleAction === "sleep" ? 7600 + Math.random() * 3600 : 5200 + Math.random() * 2600);
    action = "idle";
    jumpPlan = null;
  };
  const createJumpPlan = (now, platforms, fallbackGround, destination = null) => {
    const candidates = platforms.filter((platform) => platform.right - platform.left >= petSize * 0.7);
    const normalizedDestination = destinationOnPlatform(destination, rootBounds());
    const platform = normalizedDestination?.platform || candidates[Math.floor(Math.random() * candidates.length)] || null;
    const targetX = normalizedDestination
      ? normalizedDestination.x
      : platform
        ? clamp(platform.left + Math.random() * Math.max(1, platform.right - platform.left - petSize), 8, Math.max(8, root.scrollWidth - petSize - 8))
        : clamp(x + direction * (120 + Math.random() * 180), 8, Math.max(8, root.scrollWidth - petSize - 8));
    const targetY = normalizedDestination ? normalizedDestination.y : (platform ? platform.y : fallbackGround);
    const distance = Math.abs(targetX - x) + Math.abs(targetY - currentY);
    const verticalDistance = targetY - (currentY || fallbackGround);
    const arc = verticalDistance > 0
      ? clamp(42 + Math.abs(targetX - x) * 0.18, 48, 108)
      : clamp(86 + distance * 0.24, 96, 210);
    return {
      start: now,
      duration: clamp(3000 + distance * 3.4, 3400, 6800),
      startX: x,
      startY: currentY || fallbackGround,
      targetX,
      targetY,
      arc,
    };
  };
  const verticalStepDestination = (platforms, bounds, landing, groundY, directionY) => {
    if (!directionY) return null;
    const maxStep = 320;
    const horizontalReach = 88;
    const currentCenterX = x + petSize / 2;
    const stepPlatforms = platforms
      .filter((platform) => {
        const delta = platform.y - groundY;
        if (Math.sign(delta) !== directionY) return false;
        if (Math.abs(delta) < 22 || Math.abs(delta) > maxStep) return false;
        return currentCenterX >= platform.left - horizontalReach && currentCenterX <= platform.right + horizontalReach;
      })
      .map((platform) => {
        const clampedCenterX = clamp(currentCenterX, platform.left + petSize / 2, platform.right - petSize / 2);
        const horizontalAdjust = Math.abs(clampedCenterX - currentCenterX);
        return destinationOnPlatform({
          platform,
          x: clampedCenterX - petSize / 2,
          y: platform.y,
          score: Math.abs(platform.y - groundY) + horizontalAdjust * 0.75 + Math.abs(platform.y - landing.y) * 0.08,
        }, bounds);
      })
      .sort((left, right) => left.score - right.score);
    return stepPlatforms[0] || null;
  };
  const walkToward = (bounds, targetX, currentPlatform) => {
    direction = targetX >= x ? 1 : -1;
    const leftLimit = currentPlatform ? currentPlatform.left : 8;
    const rightLimit = currentPlatform ? currentPlatform.right - petSize : bounds.width - petSize - 8;
    const safeRightLimit = Math.max(leftLimit, rightLimit);
    const next = x + direction * Math.min(0.34, Math.abs(targetX - x) / 180);
    x = clamp(next, Math.max(8, leftLimit), Math.max(8, safeRightLimit));
    if (x <= Math.max(8, leftLimit) || x >= Math.max(8, safeRightLimit)) return false;
    return true;
  };
  const reachablePlatformFromEdge = (platforms, currentPlatform, targetPlatform, groundY) => {
    if (!currentPlatform) return null;
    const movingRight = direction >= 0;
    const currentEdge = movingRight ? currentPlatform.right : currentPlatform.left;
    const candidates = platforms
      .filter((platform) => platform !== currentPlatform)
      .map((platform) => {
        const nearEdge = movingRight ? platform.left : platform.right;
        const gap = movingRight ? nearEdge - currentEdge : currentEdge - nearEdge;
        const verticalGap = platform.y - groundY;
        const targetBonus = platform === targetPlatform ? -70 : 0;
        return { platform, gap, verticalGap, score: Math.abs(gap) + Math.abs(verticalGap) * 1.2 + targetBonus };
      })
      .filter((item) => item.gap >= -18 && item.gap <= 170 && Math.abs(item.verticalGap) <= 120)
      .sort((left, right) => left.score - right.score);
    const best = candidates[0];
    if (!best) return null;
    const targetX = movingRight ? best.platform.left + 4 : best.platform.right - petSize - 4;
    return destinationOnPlatform({
      platform: best.platform,
      x: targetX,
      y: best.platform.y,
    }, rootBounds());
  };
  const clearDragHold = () => {
    if (!dragHoldTimer) return;
    window.clearTimeout(dragHoldTimer);
    dragHoldTimer = 0;
  };
  const updateDraggedPet = (event) => {
    if (!isDraggingPet || event.pointerId !== dragPointerId || !dragOffset) return;
    const bounds = rootBounds();
    const point = pointInRoot(event);
    direction = point.x >= x + petSize / 2 ? 1 : -1;
    x = clamp(point.x - dragOffset.x, 8, Math.max(8, root.scrollWidth - petSize - 8));
    currentY = clamp(point.y - dragOffset.y, 24, Math.max(24, root.scrollHeight - petSize - 8));
    setImagePose("held", direction, Math.sin(performance.now() / 180) * 1.5, Math.sin(performance.now() / 230) * 2.5);
    pet.style.transform = `translate3d(${x}px, ${currentY}px, 0)`;
  };
  const startPetDrag = () => {
    if (!dragStartPoint || dragPointerId == null) return;
    isDraggingPet = true;
    action = "drag";
    idleUntil = 0;
    jumpPlan = null;
    dragOffset = {
      x: dragStartPoint.x - x,
      y: dragStartPoint.y - currentY,
    };
    pet.addClass("is-dragging");
    setImagePose("held", direction);
  };
  const finishPetDrag = (event) => {
    if (event.pointerId !== dragPointerId) return;
    clearDragHold();
    if (isDraggingPet) {
      updateDraggedPet(event);
      const bounds = rootBounds();
      const drop = nearestPlatformForDrop(landingPlatforms(), bounds);
      x = drop.x;
      currentY = drop.y;
      pet.style.transform = `translate3d(${x}px, ${currentY}px, 0)`;
    }
    isDraggingPet = false;
    dragPointerId = null;
    dragStartPoint = null;
    dragOffset = null;
    pet.removeClass("is-dragging");
    action = "move";
  };
  const cancelPetDrag = () => {
    clearDragHold();
    isDraggingPet = false;
    dragPointerId = null;
    dragStartPoint = null;
    dragOffset = null;
    pet.removeClass("is-dragging");
    if (action === "drag") action = "move";
  };
  pet.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragPointerId != null) return;
    event.preventDefault();
    event.stopPropagation();
    dragPointerId = event.pointerId;
    dragStartPoint = pointInRoot(event);
    clearDragHold();
    dragHoldTimer = window.setTimeout(startPetDrag, 360);
  });
  const handleDragPointerMove = (event) => {
    if (event.pointerId !== dragPointerId) return;
    if (!isDraggingPet && dragStartPoint) {
      const point = pointInRoot(event);
      if (Math.hypot(point.x - dragStartPoint.x, point.y - dragStartPoint.y) > 10) cancelPetDrag();
      return;
    }
    updateDraggedPet(event);
  };
  window.addEventListener("pointermove", handleDragPointerMove);
  window.addEventListener("pointerup", finishPetDrag);
  window.addEventListener("pointercancel", cancelPetDrag);
  const tick = (now = performance.now()) => {
    if (isDraggingPet) {
      const heldFrame = Math.floor(now / 170) % 6;
      setImagePose("held", direction, [0.8, 1.4, 1.8, 1.2, 0.4, 0][heldFrame], [-2.5, -1.2, 0.8, 2.5, 1.1, -0.8][heldFrame], heldFrame);
      frame = requestAnimationFrame(tick);
      return;
    }
    const bounds = rootBounds();
    const grounds = landingPlatforms();
    const currentCenterX = x + petSize / 2;
    const currentPlatform = platformForPose(grounds, currentCenterX, currentY);
    const groundY = currentPlatform?.y ?? bounds.fallbackGround;
    const landing = landingForTarget(grounds, bounds);
    let y = groundY;

    if (action === "idle") {
      if (!isNearTarget(landing) || now >= idleUntil) {
        action = "move";
        idleUntil = 0;
      } else {
        y = groundY - Math.abs(Math.sin(now / (idleAction === "sleep" ? 960 : 620))) * 1;
        const idleFrame = Math.floor(now / 420) % 4;
        const idleLift = idleAction === "sleep" ? [0, -0.4, -0.8, -0.4][idleFrame] : [0, -0.8, -1.4, -0.6][idleFrame];
        const idleRotate = idleAction === "game" ? [-1, 0, 1, 0][idleFrame] : 0;
        setImagePose(idleAction, 1, idleLift, idleRotate);
      }
    } else if (action === "jump") {
      if (!jumpPlan) jumpPlan = createJumpPlan(now, grounds, groundY, landing);
      const progress = clamp((now - jumpPlan.start) / jumpPlan.duration, 0, 1);
      x = jumpPlan.startX + (jumpPlan.targetX - jumpPlan.startX) * progress;
      y = Math.max(0, jumpPlan.startY + (jumpPlan.targetY - jumpPlan.startY) * progress - Math.sin(progress * Math.PI) * jumpPlan.arc);
      const jumpFacing = jumpPlan.targetX >= jumpPlan.startX ? 1 : -1;
      const jumpFrame = Math.min(3, Math.floor(progress * 4));
      const jumpSprites = ["jumpUp", "jumpUp", "jumpDown", "jumpDown"];
      const jumpRotates = [-4, -1, 2, 4];
      setImagePose(jumpSprites[jumpFrame], jumpFacing, 0, jumpRotates[jumpFrame]);
      if (progress >= 1) {
        x = jumpPlan.targetX;
        y = jumpPlan.targetY;
        direction = landing.x >= x ? 1 : -1;
        jumpPlan = null;
        action = isNearTarget(landing) ? "idle" : "move";
        if (action === "idle") startIdle(now);
      }
    } else {
      if (isNearTarget(landing)) {
        startIdle(now);
        y = groundY;
      } else {
        const horizontalGap = landing.x - x;
        const verticalGap = landing.y - groundY;
        const targetFeetY = landing.target?.y ?? landing.y + petSize;
        const verticalIntentGap = targetFeetY - (groundY + petSize);
        const verticalDirection = Math.abs(verticalIntentGap) > 72 ? Math.sign(verticalIntentGap) : Math.sign(verticalGap);
        const step = verticalDirection ? verticalStepDestination(grounds, bounds, landing, groundY, verticalDirection) : null;
        if (step) {
          action = "jump";
          jumpPlan = createJumpPlan(now, grounds, groundY, step);
        } else if (Math.abs(horizontalGap) > 90) {
          const couldWalk = walkToward(bounds, landing.x, currentPlatform);
          y = groundY - Math.abs(Math.sin(now / 320)) * 2.2;
          const walkFrame = Math.floor(now / 180) % 4;
          const walkSprites = ["walkA", "walkA", "walkB", "walkB"];
          const walkLifts = [0, -1.4, -0.5, -1.8];
          const walkRotates = [-1, 0, 1, 0];
          setImagePose(walkSprites[walkFrame], direction, walkLifts[walkFrame], walkRotates[walkFrame]);
          if (!couldWalk) {
            const bridge = reachablePlatformFromEdge(grounds, currentPlatform, landing.platform, groundY);
            if (bridge) {
              action = "jump";
              jumpPlan = createJumpPlan(now, grounds, groundY, bridge);
            }
          }
        } else {
          walkToward(bounds, landing.x, currentPlatform);
          y = groundY - Math.abs(Math.sin(now / 320)) * 2.2;
          const walkFrame = Math.floor(now / 180) % 4;
          const walkSprites = ["walkA", "walkA", "walkB", "walkB"];
          const walkLifts = [0, -1.4, -0.5, -1.8];
          const walkRotates = [-1, 0, 1, 0];
          setImagePose(walkSprites[walkFrame], direction, walkLifts[walkFrame], walkRotates[walkFrame]);
        }
      }
    }

    currentY = y;
    pet.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    clearDragHold();
    root.removeEventListener("pointermove", setMouseTarget);
    window.removeEventListener("pointermove", handleDragPointerMove);
    window.removeEventListener("pointerup", finishPetDrag);
    window.removeEventListener("pointercancel", cancelPetDrag);
    pet.remove();
  };
}

function renderDeskPetPlatform(root, plugin) {
  const petSize = 92;
  const isGlobalPet = root === document.body;
  const config = {
    maxWalkDistance: 320,
    maxJumpX: 220,
    maxJumpY: 120,
    maxVerticalStepY: 280,
    landingPointSnapRadius: 110,
    petSpeed: 120,
    jumpDuration: 520,
    maxLandingPoints: 220,
    anchorWalkDistance: 250,
    anchorJumpDistance: 600,
  };
  const sprites = {
    jumpUp: getPluginAssetUrl(plugin, "deskpet-jump-up.png"),
    jumpMidUp: getPluginAssetUrl(plugin, "deskpet-jump-mid-up.png"),
    jumpDown: getPluginAssetUrl(plugin, "deskpet-jump-down.png"),
    jumpMidDown: getPluginAssetUrl(plugin, "deskpet-jump-mid-down.png"),
    walkA: getPluginAssetUrl(plugin, "deskpet-walk-a.png"),
    walkB: getPluginAssetUrl(plugin, "deskpet-walk-b.png"),
    walkC: getPluginAssetUrl(plugin, "deskpet-walk-c.png"),
    walkD: getPluginAssetUrl(plugin, "deskpet-walk-d.png"),
    read: getPluginAssetUrl(plugin, "deskpet-read.png"),
    readPageA: getPluginAssetUrl(plugin, "deskpet-read-page-a.png"),
    readPageB: getPluginAssetUrl(plugin, "deskpet-read-page-b.png"),
    game: getPluginAssetUrl(plugin, "deskpet-game.png"),
    gameA: getPluginAssetUrl(plugin, "deskpet-game-a.png"),
    gameB: getPluginAssetUrl(plugin, "deskpet-game-b.png"),
    sleep: getPluginAssetUrl(plugin, "deskpet-sleep.png"),
    sleepA: getPluginAssetUrl(plugin, "deskpet-sleep-a.png"),
    sleepB: getPluginAssetUrl(plugin, "deskpet-sleep-b.png"),
    held: getPluginAssetUrl(plugin, "deskpet-held-a.png"),
    heldA: getPluginAssetUrl(plugin, "deskpet-held-a.png"),
    heldB: getPluginAssetUrl(plugin, "deskpet-held-b.png"),
  };
  for (const source of new Set(Object.values(sprites))) {
    const preload = new Image();
    preload.decoding = "async";
    preload.src = source;
  }
  const pet = root.createDiv({ cls: isGlobalPet ? "sr-deskpet is-global" : "sr-deskpet" });
  pet.setAttr("title", isTabletMode(plugin) ? "Double click: mode menu. Shift + double click: debug" : "Right click: mode menu. Shift + double click: debug");
  const img = pet.createEl("img", { attr: { alt: "", src: sprites.jumpDown, draggable: "false" } });
  const speechBubble = pet.createDiv({ cls: "sr-deskpet-speech" });
  speechBubble.setAttr("tabindex", "-1");
  const debugLayer = root.createDiv({ cls: isGlobalPet ? "sr-deskpet-debug is-global" : "sr-deskpet-debug" });

  let frame = 0;
  let x = 120;
  let y = 0;
  let direction = 1;
  let lastSprite = "";
  let mouseTarget = null;
  let graph = null;
  let graphDirty = true;
  let currentNodeId = null;
  let targetNodeId = null;
  let activeMove = null;
  let action = "move";
  let idleAction = "read";
  let idleUntil = 0;
  let settleUntil = 0;
  let settleMoveType = "walk";
  let freeTargetNodeId = null;
  let freeTargetUntil = 0;
  let debugEnabled = localStorage.getItem("srDeskPetDebug") === "1";
  let debugRenderKey = "";
  let dragHoldTimer = 0;
  let dragPointerId = null;
  let dragStartPoint = null;
  let dragOffset = null;
  let isDraggingPet = false;
  let hoveredPreviewBlock = null;
  let lastCursorLineElement = null;
  let anchorTarget = null;
  let anchorTargetKey = "";
  let anchorMove = null;
  let anchorDirty = true;
  let anchorForceUpdate = true;
  let anchorTeleportTimer = 0;
  let scrollPausedUntil = 0;
  let scrollStopTimer = 0;
  const scrollStates = new WeakMap();
  let windowScrollState = { left: window.scrollX || 0, top: window.scrollY || 0 };
  let activeObserverRoot = null;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const distance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);
  const rootBounds = () => {
    if (isGlobalPet) {
      return {
        rect: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight },
        width: Math.max(petSize, window.innerWidth),
        height: Math.max(petSize, window.innerHeight),
        fallbackGround: Math.max(24, window.innerHeight - petSize - 18),
      };
    }
    const rect = root.getBoundingClientRect();
    return {
      rect,
      width: Math.max(petSize, rect.width),
      height: Math.max(petSize, root.scrollHeight),
      fallbackGround: Math.max(24, root.scrollHeight - petSize - 18),
    };
  };
  const pointInRoot = (event) => {
    if (isGlobalPet) {
      return {
        x: event.clientX,
        y: event.clientY,
      };
    }
    const rect = root.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + root.scrollLeft,
      y: event.clientY - rect.top + root.scrollTop,
    };
  };
  const setSprite = (key) => {
    if (lastSprite === key) return;
    img.src = sprites[key] || sprites.jumpDown;
    lastSprite = key;
  };
  const setImagePose = (key, facing = direction, lift = 0, rotate = 0, poseFrame = 0) => {
    setSprite(key);
    img.style.transform = `scaleX(${facing >= 0 ? 1 : -1}) translateY(${lift}px) rotate(${rotate}deg)`;
    pet.dataset.pose = key;
    pet.dataset.poseFrame = String(Math.max(0, Math.min(5, poseFrame)));
  };
  const readFrameSprite = (frameIndex) => ["read", "read", "readPageA", "readPageB", "read", "read"][frameIndex] || "read";
  const applyPetTransform = () => {
    pet.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  const clampPetToBounds = () => {
    const bounds = rootBounds();
    x = clamp(x, 8, Math.max(8, bounds.width - petSize - 8));
    y = clamp(y, 24, Math.max(24, bounds.height - petSize - 8));
  };
  const deskPetMode = () => normalizeSettings(plugin.settings).deskPetMode;
  const setDeskPetMode = async (mode) => {
    plugin.settings.deskPetMode = mode;
    await plugin.saveSettings();
    freeTargetNodeId = null;
    freeTargetUntil = 0;
    activeMove = null;
    action = "move";
    new Notice(`Desk pet mode: ${mode === "fixed" ? "Fixed" : mode === "free" ? "Free" : "Follow"}`);
  };
  const closeSpeech = () => {
    speechBubble.empty();
    speechBubble.removeClass("is-visible");
    speechBubble.removeClass("is-ask");
    speechBubble.removeClass("is-below");
    speechBubble.removeClass("is-left");
    action = "move";
  };
  const speechIsOpen = () => speechBubble.hasClass("is-visible");
  const pauseForSpeech = () => {
    activeMove = null;
    freeTargetNodeId = null;
    freeTargetUntil = 0;
    action = "speech";
  };
  const createSpeechCloseButton = () => {
    const closeButton = speechBubble.createEl("button", { cls: "sr-deskpet-speech-close", text: "×", type: "button", attr: { "aria-label": "Close" } });
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeSpeech();
    });
    return closeButton;
  };
  const updateSpeechPlacement = () => {
    const markdownSurface = getMarkdownAnchorSurface();
    speechBubble.toggleClass("is-left", markdownSurface?.mode === "edit");
    speechBubble.removeClass("is-below");
  };
  const bindSpeechSave = (element, getContent, source) => {
    element.setAttr("title", "Double click to save");
    element.addEventListener("dblclick", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        const path = await saveDeskPetReply(plugin, getContent(), source);
        new Notice(`Saved reply: ${path}`);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Failed to save reply.");
      }
    });
  };
  const showSpeech = (text) => {
    const value = String(text || "").trim();
    if (!value) return;
    speechBubble.empty();
    speechBubble.removeClass("is-ask");
    pauseForSpeech();
    updateSpeechPlacement();
    createSpeechCloseButton();
    const textEl = speechBubble.createDiv({ cls: "sr-deskpet-speech-text", text: value });
    bindSpeechSave(textEl, () => value, "Desk Pet Reply");
    speechBubble.addClass("is-visible");
  };
  const showSelectionAsk = (detail = {}) => {
    const selectedText = String(detail.selectedText || "").trim();
    if (!selectedText) return;
    const sourcePath = String(detail.sourcePath || "");
    speechBubble.empty();
    pauseForSpeech();
    updateSpeechPlacement();
    speechBubble.addClass("is-ask");
    createSpeechCloseButton();
    speechBubble.createDiv({ cls: "sr-deskpet-speech-title", text: "Ask AI" });
    if (sourcePath) speechBubble.createDiv({ cls: "sr-deskpet-speech-source", text: sourcePath });
    speechBubble.createDiv({
      cls: "sr-deskpet-speech-excerpt",
      text: selectedText.length > 180 ? `${selectedText.slice(0, 180)}...` : selectedText,
    });
    const questionInput = speechBubble.createEl("textarea", { cls: "sr-deskpet-speech-question" });
    questionInput.rows = 3;
    questionInput.placeholder = "想问什么？";
    const option = speechBubble.createEl("label", { cls: "sr-deskpet-speech-option" });
    const systemInput = option.createEl("input", { type: "checkbox" });
    systemInput.checked = true;
    option.createSpan({ text: "Send system prompt" });
    const answerBox = speechBubble.createDiv({ cls: "sr-deskpet-speech-answer" });
    let latestAnswer = "";
    bindSpeechSave(answerBox, () => latestAnswer || answerBox.textContent || "", "Desk Pet Selection Answer");
    const actions = speechBubble.createDiv({ cls: "sr-deskpet-speech-actions" });
    const sendButton = actions.createEl("button", { text: "Send", type: "button" });
    sendButton.addClass("mod-cta");
    const send = async () => {
      sendButton.disabled = true;
      sendButton.setText("Thinking...");
      answerBox.setText("Thinking...");
      try {
        const answer = await askSelectionAi(plugin, selectedText, questionInput.value, sourcePath, systemInput.checked);
        latestAnswer = answer;
        answerBox.setText(answer);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to ask AI.";
        answerBox.setText(message);
        new Notice(message);
      } finally {
        sendButton.disabled = false;
        sendButton.setText("Send");
      }
    };
    sendButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void send();
    });
    questionInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSpeech();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    });
    speechBubble.addClass("is-visible");
    window.setTimeout(() => questionInput.focus(), 0);
  };
  const showModeMenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const currentMode = deskPetMode();
    const menu = new Menu();
    [
      ["fixed", "Fixed 固定"],
      ["follow", "Follow 跟随"],
      ["free", "Free 自由活动"],
    ].forEach(([mode, title]) => {
      menu.addItem((item) => {
        item.setTitle(title)
          .setChecked(currentMode === mode)
          .onClick(() => setDeskPetMode(mode));
      });
    });
    menu.showAtMouseEvent(event);
  };
  const markGraphDirty = () => {
    graphDirty = true;
    debugRenderKey = "";
  };
  let graphDirtyTimer = 0;
  const scheduleGraphDirty = () => {
    if (graphDirtyTimer) window.clearTimeout(graphDirtyTimer);
    graphDirtyTimer = window.setTimeout(() => {
      graphDirtyTimer = 0;
      markGraphDirty();
    }, 100);
  };
  const handleSurfaceChanged = () => {
    currentNodeId = null;
    activeMove = null;
    anchorMove = null;
    anchorTarget = null;
    anchorTargetKey = "";
    hoveredPreviewBlock = null;
    lastCursorLineElement = null;
    anchorDirty = true;
    anchorForceUpdate = true;
    freeTargetNodeId = null;
    freeTargetUntil = 0;
    rememberActiveScrollStates();
    scheduleGraphDirty();
  };
  const carryPetByScroll = (deltaLeft, deltaTop) => {
    if (!isGlobalPet || isDraggingPet || (!deltaLeft && !deltaTop)) return;
    x -= deltaLeft;
    y -= deltaTop;
    if (activeMove) {
      activeMove.from = { ...activeMove.from, x: activeMove.from.x - deltaLeft, y: activeMove.from.y - deltaTop };
      activeMove.to = { ...activeMove.to, x: activeMove.to.x - deltaLeft, y: activeMove.to.y - deltaTop };
    }
    currentNodeId = null;
    clampPetToBounds();
    applyPetTransform();
  };
  const handleScroll = (event) => {
    scheduleGraphDirty();
    if (!isGlobalPet) return;
    if (getMarkdownAnchorSurface()) {
      activeMove = null;
      anchorMove = null;
      scrollPausedUntil = Infinity;
      if (scrollStopTimer) window.clearTimeout(scrollStopTimer);
      scrollStopTimer = window.setTimeout(() => {
        scrollPausedUntil = 0;
        anchorDirty = true;
        anchorForceUpdate = true;
      }, 200);
      return;
    }
    const target = event.target;
    if (target === document || target === window || target === document.documentElement || target === document.body) {
      const next = { left: window.scrollX || 0, top: window.scrollY || 0 };
      carryPetByScroll(next.left - windowScrollState.left, next.top - windowScrollState.top);
      windowScrollState = next;
      return;
    }
    if (!(target instanceof Element)) return;
    const previous = scrollStates.get(target);
    const next = { left: target.scrollLeft || 0, top: target.scrollTop || 0 };
    if (previous) {
      carryPetByScroll(next.left - previous.left, next.top - previous.top);
    }
    scrollStates.set(target, next);
  };
  const isVisibleRect = (rect, rootRect) => {
    if (rect.width < 18 || rect.height < 12) return false;
    if (isGlobalPet) {
      return rect.right >= 0 && rect.left <= window.innerWidth && rect.bottom >= 0 && rect.top <= window.innerHeight;
    }
    return rect.right >= rootRect.left - 80 && rect.left <= rootRect.right + 80;
  };
  const classLabel = (element) => Array.from(element?.classList || []).slice(0, 3).join(".");
  const getTopVisibleModal = () => {
    if (!isGlobalPet) return null;
    const visibleModals = Array.from(document.querySelectorAll(".modal-container .modal")).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 40 && rect.height > 40 && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    return visibleModals[visibleModals.length - 1] || null;
  };
  const getActiveSurfaceRoot = () => {
    const activeModal = getTopVisibleModal();
    if (activeModal) return activeModal;
    const activeContainer = plugin.app?.workspace?.activeLeaf?.view?.containerEl;
    if (activeContainer instanceof Element) return activeContainer;
    return root;
  };
  const syncPetLayer = () => {
    if (!isGlobalPet) return;
    const activeModal = getTopVisibleModal();
    const host = activeModal?.closest(".modal-container") || root;
    if (pet.parentElement !== host) host.appendChild(pet);
    if (debugLayer.parentElement !== host) host.appendChild(debugLayer);
  };
  const markdownBlockSelector = ".markdown-preview-view h1, .markdown-preview-view h2, .markdown-preview-view h3, .markdown-preview-view h4, .markdown-preview-view p, .markdown-preview-view li, .markdown-preview-view blockquote, .markdown-preview-view pre, .markdown-preview-view table, .markdown-preview-view img";
  const getMarkdownAnchorSurface = () => {
    if (!isGlobalPet) return null;
    const surfaceRoot = getActiveSurfaceRoot();
    if (!(surfaceRoot instanceof Element) || surfaceRoot.querySelector(".structured-review-view")) return null;
    const editor = surfaceRoot.querySelector(".cm-editor");
    if (editor instanceof Element) {
      return {
        mode: "edit",
        root: surfaceRoot,
        editor,
        container: editor.querySelector(".cm-scroller") || editor,
      };
    }
    const preview = surfaceRoot.querySelector(".markdown-preview-view");
    if (preview instanceof Element) {
      return { mode: "preview", root: surfaceRoot, preview, container: preview };
    }
    return null;
  };
  const currentCursorLine = (surface) => {
    if (!surface?.editor) return null;
    const active = surface.editor.querySelector(".cm-line.cm-active, .cm-line.cm-activeLine, .cm-activeLine");
    const activeLine = active?.closest?.(".cm-line");
    if (activeLine instanceof Element) return activeLine;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
    const line = anchor?.closest?.(".cm-line");
    return line instanceof Element && surface.editor.contains(line) ? line : null;
  };
  const anchorFromElement = (element, container, keyPrefix, placement = "beside") => {
    if (!(element instanceof Element) || !(container instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (rect.width < 18 || rect.height < 8 || rect.bottom < 0 || rect.top > window.innerHeight) return null;
    const minX = Math.max(8, containerRect.left + 8);
    const maxX = Math.min(window.innerWidth - petSize - 8, containerRect.right - petSize - 12);
    const targetX = clamp(Math.min(rect.right + 12, maxX), minX, Math.max(minX, window.innerWidth - petSize - 8));
    const rawTargetY = placement === "above" ? rect.top - petSize - 4 : rect.top + rect.height / 2 - petSize / 2;
    const targetY = clamp(rawTargetY, 24, Math.max(24, window.innerHeight - petSize - 8));
    return {
      x: targetX,
      y: targetY,
      key: `${keyPrefix}:${Math.round(rect.top)}:${Math.round(rect.left)}:${Math.round(rect.width)}:${Math.round(rect.height)}`,
      element,
    };
  };
  const getMutationRoot = () => {
    if (isGlobalPet) return document.body;
    const surfaceRoot = getActiveSurfaceRoot();
    return surfaceRoot instanceof Element ? surfaceRoot : root;
  };
  const rememberScrollState = (element) => {
    if (!(element instanceof Element) || scrollStates.has(element)) return;
    scrollStates.set(element, { left: element.scrollLeft || 0, top: element.scrollTop || 0 });
  };
  const rememberActiveScrollStates = () => {
    windowScrollState = { left: window.scrollX || 0, top: window.scrollY || 0 };
    const surfaceRoot = getActiveSurfaceRoot();
    if (!(surfaceRoot instanceof Element)) return;
    rememberScrollState(surfaceRoot);
    surfaceRoot.querySelectorAll(".markdown-preview-view, .cm-scroller, .workspace-leaf-content, .structured-review-view, .modal-content, .sr-matrix-scroll, .sr-date-review-left, .sr-date-review-right").forEach(rememberScrollState);
  };
  const observeActiveSurface = (observer) => {
    const nextRoot = isGlobalPet ? getMutationRoot() : root;
    if (!(nextRoot instanceof Element) || nextRoot === activeObserverRoot) return;
    observer.disconnect();
    activeObserverRoot = nextRoot;
    observer.observe(nextRoot, { childList: true, subtree: true, characterData: true });
  };
  const platformTypeForElement = (element) => {
    const tag = element.tagName?.toLowerCase() || "";
    if (/^h[1-4]$/.test(tag)) return "heading";
    if (tag === "p") return "paragraph";
    if (tag === "li") return "list";
    if (tag === "blockquote") return "quote";
    if (tag === "pre") return "code";
    if (tag === "table") return "table";
    if (tag === "img") return "image";
    return tag || "block";
  };
  const collectLandingPoints = () => {
    const bounds = rootBounds();
    const rootRect = isGlobalPet ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : root.getBoundingClientRect();
    const surfaceRoot = getActiveSurfaceRoot();
    const points = [];
    const addPoint = (px, py, type, element = null) => {
      const point = {
        id: "",
        x: clamp(px, 8, Math.max(8, bounds.width - petSize - 8)),
        y: clamp(py, 24, Math.max(24, bounds.height - petSize - 8)),
        type,
        elementClass: element ? classLabel(element) : "fallback",
      };
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) points.push(point);
    };
    const toLocalLeft = (rect) => isGlobalPet ? rect.left : rect.left - rootRect.left + root.scrollLeft;
    const toLocalRight = (rect) => isGlobalPet ? rect.right : rect.right - rootRect.left + root.scrollLeft;
    const toLocalTop = (rect) => isGlobalPet ? rect.top : rect.top - rootRect.top + root.scrollTop;
    const toLocalBottom = (rect) => isGlobalPet ? rect.bottom : rect.bottom - rootRect.top + root.scrollTop;
    const topY = (rect) => toLocalTop(rect) - petSize + 2;
    const bottomY = (rect) => toLocalBottom(rect) - petSize + 2;
    const addTopEdge = (element, type, inset = 16) => {
      const rect = element.getBoundingClientRect();
      if (!isVisibleRect(rect, rootRect)) return;
      const left = toLocalLeft(rect);
      const right = toLocalRight(rect);
      const minX = left + inset;
      const maxX = Math.max(minX, right - petSize - inset);
      addPoint(minX, topY(rect), type, element);
      addPoint((left + right - petSize) / 2, topY(rect), type, element);
      addPoint(maxX, topY(rect), type, element);
    };
    const addBottom = (element, type) => {
      const rect = element.getBoundingClientRect();
      if (!isVisibleRect(rect, rootRect)) return;
      const left = toLocalLeft(rect);
      const right = toLocalRight(rect);
      addPoint((left + right - petSize) / 2, bottomY(rect), type, element);
    };

    surfaceRoot.querySelectorAll([
      ".modal-content",
      ".sr-date-review-left",
      ".sr-date-review-right",
      ".sr-matrix-scroll",
      ".sr-pulse-stage",
      ".sr-overview-hero",
      ".sr-overview-trend-panel",
      ".sr-calendar-panel",
      ".sr-layout > .sr-panel",
      ".sr-project-summary",
      ".sr-panel",
    ].join(",")).forEach((element) => addTopEdge(element, "panel-top", 18));

    surfaceRoot.querySelectorAll([
      ".sr-pulse-row",
      ".sr-day-timeline-rail",
      ".sr-date-project-card",
      ".sr-project-card",
      ".sr-overview-card",
      ".sr-stat-card",
      ".sr-overview-chart",
      ".sr-trend-snapshot-card",
      ".sr-date-project-card",
    ].join(",")).forEach((element) => {
      addTopEdge(element, "card-top", 10);
      addBottom(element, "card-bottom");
    });

    surfaceRoot.querySelectorAll(".sr-calendar-day").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!isVisibleRect(rect, rootRect)) return;
      const left = toLocalLeft(rect);
      const right = toLocalRight(rect);
      const top = toLocalTop(rect);
      const bottom = toLocalBottom(rect);
      addPoint(left + 8, top - petSize + 2, "calendar-top-left", element);
      addPoint((left + right - petSize) / 2, top - petSize + 2, "calendar-top-center", element);
      addPoint((left + right - petSize) / 2, bottom - petSize - 8, "calendar-bottom-bar", element);
    });

    surfaceRoot.querySelectorAll(".sr-calendar-bar, .sr-calendar-temp-pill").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!isVisibleRect(rect, rootRect)) return;
      const left = toLocalLeft(rect);
      const right = toLocalRight(rect);
      addPoint((left + right - petSize) / 2, topY(rect), "calendar-project-bar", element);
    });

    surfaceRoot.querySelectorAll(".markdown-preview-view h1, .markdown-preview-view h2, .markdown-preview-view h3, .markdown-preview-view h4, .markdown-preview-view p, .markdown-preview-view li, .markdown-preview-view blockquote, .markdown-preview-view pre, .markdown-preview-view table, .markdown-preview-view img").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!isVisibleRect(rect, rootRect) || rect.width < 40 || rect.height < 12) return;
      const left = toLocalLeft(rect);
      const right = toLocalRight(rect);
      const type = platformTypeForElement(element);
      addPoint((left + right - petSize) / 2, topY(rect), type, element);
      if (rect.height >= 48) {
        addPoint(right - petSize - 8, bottomY(rect), `${type}-bottom`, element);
      }
    });

    const visibleLines = Array.from(surfaceRoot.querySelectorAll(".cm-editor .cm-line")).filter((element) => {
      const rect = element.getBoundingClientRect();
      if (!isVisibleRect(rect, rootRect) || rect.width < 40 || rect.height < 12) return false;
      const text = element.textContent || "";
      if (text.trim()) return true;
      if (!mouseTarget) return false;
      return Math.abs((toLocalTop(rect) + toLocalBottom(rect)) / 2 - mouseTarget.y) <= 80;
    });
    visibleLines.forEach((element, index) => {
      if (index % 3 !== 0) return;
      const rect = element.getBoundingClientRect();
      const left = toLocalLeft(rect);
      const right = toLocalRight(rect);
      addPoint((left + right - petSize) / 2, topY(rect), "cm-line", element);
    });

    const groundColumns = 6;
    for (let index = 0; index < groundColumns; index += 1) {
      const ratio = groundColumns === 1 ? 0.5 : index / (groundColumns - 1);
      addPoint(16 + (bounds.width - petSize - 32) * ratio, bounds.fallbackGround, "fallback-ground");
    }

    const unique = [];
    const seen = new Set();
    for (const point of points.sort((left, right) => left.y - right.y || left.x - right.x)) {
      const key = `${Math.round(point.x / 18)}:${Math.round(point.y / 18)}:${point.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      point.id = `p${unique.length}`;
      unique.push(point);
      if (unique.length >= config.maxLandingPoints) break;
    }
    return unique;
  };
  const edgeBetween = (from, to) => {
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    if (dx > 0 && dx <= config.maxWalkDistance && dy <= 24) {
      return { to: to.id, type: "walk", cost: dx };
    }
    if (dx <= config.maxJumpX && dy > 16 && dy <= config.maxJumpY) {
      return { to: to.id, type: "jump", cost: 360 + dx * 0.8 + dy * 1.4 };
    }
    return null;
  };
  const verticalStepEdge = (from, to) => {
    const dx = Math.abs(to.x - from.x);
    const dy = to.y - from.y;
    const absDy = Math.abs(dy);
    if (absDy <= 16 || absDy > config.maxVerticalStepY || dx > config.maxJumpX) return null;
    return { to: to.id, type: "jump", cost: 420 + dx * 0.9 + absDy * 1.5 };
  };
  const buildGraph = () => {
    const nodes = collectLandingPoints();
    const edges = new Map(nodes.map((node) => [node.id, []]));
    const addEdge = (fromId, edge) => {
      if (!edge) return;
      const list = edges.get(fromId);
      if (!list.some((item) => item.to === edge.to && item.type === edge.type)) list.push(edge);
    };
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const forward = edgeBetween(nodes[i], nodes[j]);
        const backward = edgeBetween(nodes[j], nodes[i]);
        addEdge(nodes[i].id, forward);
        addEdge(nodes[j].id, backward);
      }
    }
    for (const node of nodes) {
      const verticalCandidates = nodes
        .filter((candidate) => candidate.id !== node.id)
        .map((candidate) => ({
          node: candidate,
          dx: Math.abs(candidate.x - node.x),
          dy: candidate.y - node.y,
        }))
        .filter((item) => Math.abs(item.dy) > 16 && Math.abs(item.dy) <= config.maxVerticalStepY && item.dx <= config.maxJumpX)
        .sort((left, right) => {
          const leftDirection = Math.sign(left.dy);
          const rightDirection = Math.sign(right.dy);
          if (leftDirection !== rightDirection) return leftDirection - rightDirection;
          return Math.abs(left.dy) - Math.abs(right.dy) || left.dx - right.dx;
        });
      const nearestUp = verticalCandidates.find((item) => item.dy < 0);
      const nearestDown = verticalCandidates.find((item) => item.dy > 0);
      if (nearestUp) addEdge(node.id, verticalStepEdge(node, nearestUp.node));
      if (nearestDown) addEdge(node.id, verticalStepEdge(node, nearestDown.node));
    }
    graph = { nodes, edges, byId: new Map(nodes.map((node) => [node.id, node])) };
    graphDirty = false;
    renderDebug();
    return graph;
  };
  const getGraph = () => (!graph || graphDirty ? buildGraph() : graph);
  const nearestNode = (point, currentGraph = getGraph(), radius = Infinity) => {
    let best = null;
    for (const node of currentGraph.nodes) {
      const nodeDistance = distance(point, node);
      if (nodeDistance > radius) continue;
      if (!best || nodeDistance < best.distance) best = { node, distance: nodeDistance };
    }
    return best?.node || null;
  };
  const nearestTargetNode = (point, currentGraph = getGraph()) => {
    return nearestNode(point, currentGraph, config.landingPointSnapRadius) || nearestNode(point, currentGraph);
  };
  const findPath = (startId, endId, currentGraph = getGraph()) => {
    if (!startId || !endId || !currentGraph.byId.has(startId) || !currentGraph.byId.has(endId)) return null;
    const distances = new Map(currentGraph.nodes.map((node) => [node.id, Infinity]));
    const previous = new Map();
    const queue = new Set(currentGraph.nodes.map((node) => node.id));
    distances.set(startId, 0);
    while (queue.size) {
      let current = null;
      let currentDistance = Infinity;
      for (const id of queue) {
        const candidate = distances.get(id);
        if (candidate < currentDistance) {
          current = id;
          currentDistance = candidate;
        }
      }
      if (!current || currentDistance === Infinity) break;
      queue.delete(current);
      if (current === endId) break;
      for (const edge of currentGraph.edges.get(current) || []) {
        if (!queue.has(edge.to)) continue;
        const nextDistance = currentDistance + edge.cost;
        if (nextDistance < distances.get(edge.to)) {
          distances.set(edge.to, nextDistance);
          previous.set(edge.to, { from: current, edge });
        }
      }
    }
    if (startId !== endId && !previous.has(endId)) return null;
    const nodePath = [endId];
    const edgePath = [];
    let cursor = endId;
    while (cursor !== startId) {
      const step = previous.get(cursor);
      if (!step) return null;
      edgePath.unshift(step.edge);
      cursor = step.from;
      nodePath.unshift(cursor);
    }
    return { nodePath, edgePath, distance: distances.get(endId) };
  };
  const nearestReachableToTarget = (startId, targetNode, currentGraph = getGraph()) => {
    let best = null;
    for (const node of currentGraph.nodes) {
      const path = findPath(startId, node.id, currentGraph);
      if (!path) continue;
      const score = distance(node, targetNode) + path.distance * 0.08;
      if (!best || score < best.score) best = { node, path, score };
    }
    return best;
  };
  const chooseFreeTarget = (startId, now, currentGraph = getGraph()) => {
    if (freeTargetNodeId && now < freeTargetUntil && currentGraph.byId.has(freeTargetNodeId)) {
      return currentGraph.byId.get(freeTargetNodeId);
    }
    const reachable = currentGraph.nodes
      .map((node) => ({ node, path: findPath(startId, node.id, currentGraph) }))
      .filter((item) => item.path && item.node.id !== startId && item.path.distance > 180)
      .sort((left, right) => right.path.distance - left.path.distance)
      .slice(0, 12);
    const selected = reachable[Math.floor(Math.random() * reachable.length)]?.node || currentGraph.byId.get(startId);
    freeTargetNodeId = selected?.id || null;
    freeTargetUntil = now + 7000 + Math.random() * 7000;
    return selected || null;
  };
  const renderDebug = () => {
    const key = `${debugEnabled}:${targetNodeId || ""}:${graph?.nodes.length || 0}:${graphDirty ? 1 : 0}`;
    if (key === debugRenderKey) return;
    debugRenderKey = key;
    debugLayer.empty();
    debugLayer.toggleClass("is-enabled", debugEnabled);
    if (!debugEnabled || !graph) return;
    const bounds = rootBounds();
    const width = isGlobalPet ? bounds.width : Math.max(bounds.width, root.scrollWidth);
    const height = isGlobalPet ? bounds.height : Math.max(bounds.height, root.scrollHeight);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    debugLayer.appendChild(svg);
    for (const [fromId, edges] of graph.edges.entries()) {
      const from = graph.byId.get(fromId);
      for (const edge of edges) {
        const to = graph.byId.get(edge.to);
        if (!from || !to) continue;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(from.x + petSize / 2));
        line.setAttribute("y1", String(from.y + petSize));
        line.setAttribute("x2", String(to.x + petSize / 2));
        line.setAttribute("y2", String(to.y + petSize));
        line.setAttribute("class", `sr-deskpet-debug-edge is-${edge.type}`);
        svg.appendChild(line);
      }
    }
    for (const node of graph.nodes) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(node.x + petSize / 2));
      dot.setAttribute("cy", String(node.y + petSize));
      dot.setAttribute("r", node.id === targetNodeId ? "5" : "3");
      dot.setAttribute("class", node.id === targetNodeId ? "sr-deskpet-debug-node is-target" : "sr-deskpet-debug-node");
      svg.appendChild(dot);
    }
    for (const node of graph.nodes) {
      const label = debugLayer.createDiv({ cls: node.id === targetNodeId ? "sr-deskpet-debug-label is-target" : "sr-deskpet-debug-label", text: node.type });
      label.style.transform = `translate3d(${Math.round(node.x + petSize / 2 + 5)}px, ${Math.round(node.y + petSize - 9)}px, 0)`;
    }
  };
  const setMouseTarget = (event) => {
    if (isDraggingPet) return;
    mouseTarget = pointInRoot(event);
    const surface = getMarkdownAnchorSurface();
    if (surface?.mode !== "preview") return;
    const target = event.target instanceof Element ? event.target : null;
    const block = target?.closest?.(markdownBlockSelector);
    if (block instanceof Element && surface.preview.contains(block) && block !== hoveredPreviewBlock) {
      hoveredPreviewBlock = block;
      anchorDirty = true;
    }
  };
  const startIdle = (now) => {
    const choices = ["read", "game", "sleep"];
    idleAction = choices[Math.floor(Math.random() * choices.length)] || "read";
    idleUntil = now + (idleAction === "sleep" ? 7600 + Math.random() * 3200 : 4800 + Math.random() * 2200);
    action = "idle";
  };
  const playSettle = (now) => {
    const progress = clamp(1 - ((settleUntil - now) / 260), 0, 1);
    const poseFrame = Math.min(5, Math.floor(progress * 6));
    const lifts = settleMoveType === "jump" ? [-2.5, 1.8, 1.1, -0.8, -0.3, 0] : [-1.2, 0.8, 0.3, -0.4, -0.2, 0];
    const rotates = settleMoveType === "jump" ? [3, -2, -1, 1, 0.5, 0] : [1, -1, -0.4, 0.5, 0.2, 0];
    const sprite = settleMoveType === "jump"
      ? ["jumpMidDown", "jumpDown", "jumpDown", "walkC", "walkA", "walkA"][poseFrame]
      : ["walkC", "walkA", "walkD", "walkA", "walkC", "walkA"][poseFrame];
    setImagePose(sprite, direction, lifts[poseFrame], rotates[poseFrame], poseFrame);
    applyPetTransform();
  };
  const startMove = (from, to, edge, now) => {
    direction = to.x >= from.x ? 1 : -1;
    action = edge.type;
    const moveDistance = distance(from, to);
    activeMove = {
      start: now,
      duration: edge.type === "walk" ? Math.max(260, (moveDistance / config.petSpeed) * 1000) : config.jumpDuration,
      from,
      to,
      edge,
      arc: edge.type === "jump" ? clamp(74 + Math.abs(to.y - from.y) * 0.45, 88, 150) : 0,
    };
  };
  const updateMovement = (now) => {
    if (!activeMove) return false;
    const progress = clamp((now - activeMove.start) / activeMove.duration, 0, 1);
    x = activeMove.from.x + (activeMove.to.x - activeMove.from.x) * progress;
    y = activeMove.from.y + (activeMove.to.y - activeMove.from.y) * progress;
    if (activeMove.edge.type === "jump") {
      y -= Math.sin(progress * Math.PI) * activeMove.arc;
      const jumpFrame = Math.min(5, Math.floor(progress * 6));
      setImagePose(["jumpUp", "jumpMidUp", "jumpUp", "jumpDown", "jumpMidDown", "jumpDown"][jumpFrame], direction, 0, [-4, -2, -0.5, 1.5, 3, 4][jumpFrame], jumpFrame);
    } else {
      const walkFrame = Math.floor(now / 165) % 6;
      setImagePose(["walkA", "walkC", "walkB", "walkD", "walkA", "walkD"][walkFrame], direction, [0, -1.2, -0.5, -1.7, -0.8, -1.3][walkFrame], [-1, -0.3, 0.8, 0.2, -0.5, 0.5][walkFrame], walkFrame);
    }
    if (progress >= 1) {
      x = activeMove.to.x;
      y = activeMove.to.y;
      currentNodeId = activeMove.to.id;
      settleUntil = now + 260;
      settleMoveType = activeMove.edge.type;
      activeMove = null;
      action = "move";
    }
    applyPetTransform();
    return true;
  };
  const updateAnchorTarget = (surface) => {
    if (!surface) return null;
    if (surface.mode === "edit") {
      const line = currentCursorLine(surface);
      if (!line) return anchorTarget;
      const lineChanged = line !== lastCursorLineElement;
      if (lineChanged) {
        lastCursorLineElement = line;
        anchorDirty = true;
      }
      if (!lineChanged && anchorTarget && !anchorForceUpdate) return anchorTarget;
      const target = anchorFromElement(line, surface.container, "edit-line", "above");
      if (target) {
        anchorTarget = target;
        anchorTargetKey = target.key;
        anchorDirty = false;
        anchorForceUpdate = false;
      }
      return anchorTarget;
    }
    if (surface.mode === "preview") {
      if (!(hoveredPreviewBlock instanceof Element) || !surface.preview.contains(hoveredPreviewBlock)) return anchorTarget;
      if (!anchorDirty && !anchorForceUpdate && anchorTarget) return anchorTarget;
      const target = anchorFromElement(hoveredPreviewBlock, surface.container, "preview-block");
      if (target) {
        anchorTarget = target;
        anchorTargetKey = target.key;
        anchorDirty = false;
        anchorForceUpdate = false;
      }
      return anchorTarget;
    }
    return null;
  };
  const startAnchorMove = (target, now) => {
    if (!target) return;
    const moveDistance = distance({ x, y }, target);
    if (moveDistance < 6) {
      x = target.x;
      y = target.y;
      applyPetTransform();
      anchorMove = null;
      return;
    }
    direction = target.x >= x ? 1 : -1;
    if (moveDistance > config.anchorJumpDistance) {
      if (anchorTeleportTimer) return;
      anchorMove = null;
      pet.addClass("is-fading");
      anchorTeleportTimer = window.setTimeout(() => {
        x = target.x;
        y = target.y;
        applyPetTransform();
        pet.removeClass("is-fading");
        anchorTeleportTimer = 0;
      }, 140);
      return;
    }
    const type = moveDistance < config.anchorWalkDistance ? "walk" : "jump";
    anchorMove = {
      start: now,
      duration: type === "walk" ? Math.max(220, (moveDistance / 150) * 1000) : 420,
      from: { x, y },
      to: { x: target.x, y: target.y },
      type,
      arc: type === "jump" ? clamp(72 + Math.abs(target.y - y) * 0.25, 76, 130) : 0,
    };
    action = type;
  };
  const updateAnchorMovement = (now) => {
    if (!anchorMove) return false;
    const progress = clamp((now - anchorMove.start) / anchorMove.duration, 0, 1);
    x = anchorMove.from.x + (anchorMove.to.x - anchorMove.from.x) * progress;
    y = anchorMove.from.y + (anchorMove.to.y - anchorMove.from.y) * progress;
    if (anchorMove.type === "jump") {
      y -= Math.sin(progress * Math.PI) * anchorMove.arc;
      const jumpFrame = Math.min(5, Math.floor(progress * 6));
      setImagePose(["jumpUp", "jumpMidUp", "jumpUp", "jumpDown", "jumpMidDown", "jumpDown"][jumpFrame], direction, 0, [-3, -1.8, -0.5, 1.3, 2.3, 3][jumpFrame], jumpFrame);
    } else {
      const walkFrame = Math.floor(now / 175) % 6;
      setImagePose(["walkA", "walkC", "walkB", "walkD", "walkA", "walkD"][walkFrame], direction, [0, -1, -0.4, -1.35, -0.7, -1.1][walkFrame], [-0.8, -0.2, 0.7, 0.2, -0.4, 0.4][walkFrame], walkFrame);
    }
    if (progress >= 1) {
      x = anchorMove.to.x;
      y = anchorMove.to.y;
      anchorMove = null;
      action = "anchor";
    }
    applyPetTransform();
    return true;
  };
  const tickAnchorMode = (surface, now) => {
    activeMove = null;
    currentNodeId = null;
    targetNodeId = null;
    debugLayer.empty();
    if (isDraggingPet || speechIsOpen()) return false;
    if (now < scrollPausedUntil) {
      const readFrame = Math.floor(now / 360) % 6;
      setImagePose(readFrameSprite(readFrame), direction, 0, 0, readFrame);
      applyPetTransform();
      return true;
    }
    const target = updateAnchorTarget(surface);
    if (!target) {
      const readFrame = Math.floor(now / 360) % 6;
      setImagePose(readFrameSprite(readFrame), direction, Math.sin(now / 420) * -0.8, 0, readFrame);
      applyPetTransform();
      return true;
    }
    if (updateAnchorMovement(now)) return true;
    if (distance({ x, y }, target) > 8) {
      startAnchorMove(target, now);
      return true;
    }
    const readFrame = Math.floor(now / 360) % 6;
    setImagePose(readFrameSprite(readFrame), direction, Math.sin(now / 420) * -0.8, 0, readFrame);
    applyPetTransform();
    return true;
  };
  const syncToNearestNode = () => {
    const currentGraph = getGraph();
    if (!currentGraph.nodes.length) return null;
    const nearest = nearestNode({ x, y }, currentGraph);
    if (!currentNodeId || !currentGraph.byId.has(currentNodeId) || distance({ x, y }, nearest) > 18) {
      currentNodeId = nearest.id;
      x = nearest.x;
      y = nearest.y;
      applyPetTransform();
    }
    return nearest;
  };
  const clearDragHold = () => {
    if (!dragHoldTimer) return;
    window.clearTimeout(dragHoldTimer);
    dragHoldTimer = 0;
  };
  const updateDraggedPet = (event) => {
    if (!isDraggingPet || event.pointerId !== dragPointerId || !dragOffset) return;
    const point = pointInRoot(event);
    direction = point.x >= x + petSize / 2 ? 1 : -1;
    const bounds = rootBounds();
    x = clamp(point.x - dragOffset.x, 8, Math.max(8, bounds.width - petSize - 8));
    y = clamp(point.y - dragOffset.y, 24, Math.max(24, bounds.height - petSize - 8));
    const heldFrame = Math.floor(performance.now() / 170) % 6;
    setImagePose(["heldA", "heldA", "heldB", "heldB", "heldA", "heldB"][heldFrame], direction, [0.8, 1.4, 1.8, 1.2, 0.4, 0][heldFrame], [-2.5, -1.2, 0.8, 2.5, 1.1, -0.8][heldFrame], heldFrame);
    applyPetTransform();
  };
  const startPetDrag = () => {
    if (!dragStartPoint || dragPointerId == null) return;
    isDraggingPet = true;
    activeMove = null;
    action = "drag";
    dragOffset = { x: dragStartPoint.x - x, y: dragStartPoint.y - y };
    pet.addClass("is-dragging");
    setImagePose("heldA", direction);
  };
  const finishPetDrag = (event) => {
    if (event.pointerId !== dragPointerId) return;
    clearDragHold();
    if (isDraggingPet) {
      updateDraggedPet(event);
      if (getMarkdownAnchorSurface()) {
        anchorDirty = true;
        anchorForceUpdate = true;
      } else {
        const currentGraph = getGraph();
        const drop = nearestNode({ x, y }, currentGraph);
        if (drop) {
          x = drop.x;
          y = drop.y;
          currentNodeId = drop.id;
          applyPetTransform();
        }
      }
    }
    isDraggingPet = false;
    dragPointerId = null;
    dragStartPoint = null;
    dragOffset = null;
    pet.removeClass("is-dragging");
    action = "move";
  };
  const cancelPetDrag = () => {
    clearDragHold();
    isDraggingPet = false;
    dragPointerId = null;
    dragStartPoint = null;
    dragOffset = null;
    pet.removeClass("is-dragging");
    if (action === "drag") action = "move";
  };
  const handlePetPointerDown = (event) => {
    if (event.button !== 0 || dragPointerId != null) return;
    event.preventDefault();
    event.stopPropagation();
    dragPointerId = event.pointerId;
    dragStartPoint = pointInRoot(event);
    clearDragHold();
    dragHoldTimer = window.setTimeout(startPetDrag, 360);
  };
  const handleDragPointerMove = (event) => {
    if (event.pointerId !== dragPointerId) return;
    if (!isDraggingPet && dragStartPoint) {
      const point = pointInRoot(event);
      if (Math.hypot(point.x - dragStartPoint.x, point.y - dragStartPoint.y) > 10) cancelPetDrag();
      return;
    }
    updateDraggedPet(event);
  };
  const handleDebugToggle = (event) => {
    if (!event.shiftKey && isTabletMode(plugin)) {
      showModeMenu(event);
      return;
    }
    if (!event.shiftKey) return;
    debugEnabled = !debugEnabled;
    localStorage.setItem("srDeskPetDebug", debugEnabled ? "1" : "0");
    debugRenderKey = "";
    renderDebug();
  };
  const handlePetSpeech = (event) => {
    showSpeech(event.detail?.text || "");
    if (speechBubble.hasClass("is-visible")) window.setTimeout(() => speechBubble.focus(), 0);
  };
  const handlePetAsk = (event) => {
    showSelectionAsk(event.detail || {});
  };
  const handleSpeechKeydown = (event) => {
    if (!speechIsOpen() || event.key !== "Escape") return;
    event.preventDefault();
    closeSpeech();
  };
  const handleAnchorRefresh = () => {
    if (getMarkdownAnchorSurface()) anchorDirty = true;
  };
  const tick = (now = performance.now()) => {
    syncPetLayer();
    if (isDraggingPet) {
      const heldFrame = Math.floor(now / 170) % 6;
      setImagePose(["heldA", "heldA", "heldB", "heldB", "heldA", "heldB"][heldFrame], direction, [0.8, 1.4, 1.8, 1.2, 0.4, 0][heldFrame], [-2.5, -1.2, 0.8, 2.5, 1.1, -0.8][heldFrame], heldFrame);
      frame = requestAnimationFrame(tick);
      return;
    }
    if (speechIsOpen()) {
      activeMove = null;
      anchorMove = null;
      const readFrame = Math.floor(now / 360) % 6;
      setImagePose(readFrameSprite(readFrame), direction, 0, 0, readFrame);
      applyPetTransform();
      frame = requestAnimationFrame(tick);
      return;
    }
    const markdownSurface = getMarkdownAnchorSurface();
    if (markdownSurface) {
      tickAnchorMode(markdownSurface, now);
      frame = requestAnimationFrame(tick);
      return;
    }
    const currentGraph = getGraph();
    if (!currentGraph.nodes.length) {
      frame = requestAnimationFrame(tick);
      return;
    }
    if (updateMovement(now)) {
      frame = requestAnimationFrame(tick);
      return;
    }
    const currentNode = syncToNearestNode();
    if (!currentNode) {
      frame = requestAnimationFrame(tick);
      return;
    }
    const mode = deskPetMode();
    let nextTarget = null;
    if (mode === "fixed") {
      nextTarget = currentNode;
    } else if (mode === "free") {
      nextTarget = chooseFreeTarget(currentNode.id, now, currentGraph);
    } else {
      const targetPoint = mouseTarget || {
        x: rootBounds().width * 0.55,
        y: rootBounds().rect.height * 0.45,
      };
      nextTarget = nearestTargetNode(targetPoint, currentGraph);
    }
    targetNodeId = nextTarget?.id || null;
    renderDebug();
    if (!nextTarget || currentNode.id === nextTarget.id) {
      if (now < settleUntil) {
        playSettle(now);
        frame = requestAnimationFrame(tick);
        return;
      }
      if (action !== "idle" || now >= idleUntil) startIdle(now);
      const idleFrame = Math.floor(now / 360) % 6;
      const idleLift = idleAction === "sleep"
        ? [0, -0.25, -0.55, -0.8, -0.55, -0.25][idleFrame]
        : [0, -0.6, -1.1, -1.4, -0.9, -0.35][idleFrame];
      const idleRotate = idleAction === "game" ? [-1, -0.4, 0.5, 1, 0.35, -0.45][idleFrame] : 0;
      const idleSprite = idleAction === "read"
        ? readFrameSprite(idleFrame)
        : idleAction === "game"
          ? ["game", "gameA", "gameA", "gameB", "gameB", "game"][idleFrame]
          : ["sleep", "sleepA", "sleepA", "sleepB", "sleepB", "sleep"][idleFrame];
      setImagePose(idleSprite, 1, idleLift, idleRotate, idleFrame);
      applyPetTransform();
      frame = requestAnimationFrame(tick);
      return;
    }
    let path = findPath(currentNode.id, nextTarget.id, currentGraph);
    if (!path) {
      const reachable = nearestReachableToTarget(currentNode.id, nextTarget, currentGraph);
      path = reachable?.path || null;
    }
    if (path && path.nodePath.length > 1) {
      const to = currentGraph.byId.get(path.nodePath[1]);
      const edge = path.edgePath[0];
      if (to && edge) startMove(currentNode, to, edge, now);
    } else {
      startIdle(now);
    }
    frame = requestAnimationFrame(tick);
  };

  const pointerSurface = isGlobalPet ? document : root;
  const speechSurface = isGlobalPet ? document : root;
  rememberActiveScrollStates();
  ["pointerdown", "click", "dblclick", "contextmenu"].forEach((eventName) => {
    speechBubble.addEventListener(eventName, (event) => event.stopPropagation());
  });
  pointerSurface.addEventListener("pointermove", setMouseTarget);
  speechSurface.addEventListener("sr-deskpet-say", handlePetSpeech);
  speechSurface.addEventListener("sr-deskpet-ask", handlePetAsk);
  document.addEventListener("keydown", handleSpeechKeydown);
  document.addEventListener("selectionchange", handleAnchorRefresh);
  document.addEventListener("keyup", handleAnchorRefresh);
  document.addEventListener("click", handleAnchorRefresh, true);
  pet.addEventListener("pointerdown", handlePetPointerDown);
  pet.addEventListener("contextmenu", showModeMenu);
  pet.addEventListener("dblclick", handleDebugToggle);
  window.addEventListener("pointermove", handleDragPointerMove);
  window.addEventListener("pointerup", finishPetDrag);
  window.addEventListener("pointercancel", cancelPetDrag);
  window.addEventListener("resize", scheduleGraphDirty);
  window.addEventListener("scroll", handleScroll, true);
  const observer = new MutationObserver((mutations) => {
    const hasContentMutation = mutations.some((mutation) => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
      if (target?.closest(".sr-deskpet, .sr-deskpet-debug")) return false;
      if (mutation.type === "characterData") return true;
      return Array.from(mutation.addedNodes || []).concat(Array.from(mutation.removedNodes || [])).some((node) => {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!(element instanceof Element)) return false;
        return !element.closest(".sr-deskpet, .sr-deskpet-debug");
      });
    });
    if (hasContentMutation) scheduleGraphDirty();
  });
  const activeLeafRef = plugin.app?.workspace?.on ? plugin.app.workspace.on("active-leaf-change", () => {
    handleSurfaceChanged();
    observeActiveSurface(observer);
  }) : null;
  observeActiveSurface(observer);

  if (!getMarkdownAnchorSurface()) {
    const initialNode = nearestNode({ x, y }, getGraph());
    if (initialNode) {
      currentNodeId = initialNode.id;
      x = initialNode.x;
      y = initialNode.y;
      applyPetTransform();
    }
  }
  frame = requestAnimationFrame(tick);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    clearDragHold();
    if (graphDirtyTimer) window.clearTimeout(graphDirtyTimer);
    if (scrollStopTimer) window.clearTimeout(scrollStopTimer);
    if (anchorTeleportTimer) window.clearTimeout(anchorTeleportTimer);
    observer.disconnect();
    if (activeLeafRef && plugin.app?.workspace?.offref) plugin.app.workspace.offref(activeLeafRef);
    pointerSurface.removeEventListener("pointermove", setMouseTarget);
    speechSurface.removeEventListener("sr-deskpet-say", handlePetSpeech);
    speechSurface.removeEventListener("sr-deskpet-ask", handlePetAsk);
    document.removeEventListener("keydown", handleSpeechKeydown);
    document.removeEventListener("selectionchange", handleAnchorRefresh);
    document.removeEventListener("keyup", handleAnchorRefresh);
    document.removeEventListener("click", handleAnchorRefresh, true);
    pet.removeEventListener("pointerdown", handlePetPointerDown);
    pet.removeEventListener("contextmenu", showModeMenu);
    pet.removeEventListener("dblclick", handleDebugToggle);
    window.removeEventListener("pointermove", handleDragPointerMove);
    window.removeEventListener("pointerup", finishPetDrag);
    window.removeEventListener("pointercancel", cancelPetDrag);
    window.removeEventListener("resize", scheduleGraphDirty);
    window.removeEventListener("scroll", handleScroll, true);
    debugLayer.remove();
    pet.remove();
  };
}

function getOverviewHighlights(repository) {
  const projects = repository.listProjects();
  const shortTermProjects = projects.filter((project) => project.type === "short-term");
  const recentWindowStart = shiftDays(todayYmd(), -29);
  const shortTermLeader = shortTermProjects
    .map((project) => ({
      project,
      count: repository.listEntries(project.id).filter((entry) => entry.date >= recentWindowStart).length,
    }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return right.project.updatedAt.localeCompare(left.project.updatedAt);
    })[0] || null;

  const recentTemporary = projects
    .filter((project) => project.type === "temporary" && projectStartAt(project))
    .sort((left, right) => projectStartAt(right).localeCompare(projectStartAt(left)))[0] || null;

  return {
    shortTermLeader,
    recentTemporary,
  };
}

function getSelectedDateProjects(repository, selectedDate) {
  const projects = repository.listProjects().filter((project) => project.isActive && projectOverlapsDate(project, selectedDate));
  return {
    longTerm: projects.filter((project) => project.type === "long-term"),
    shortTerm: projects.filter((project) => project.type === "short-term"),
    temporary: projects.filter((project) => project.type === "temporary"),
  };
}

function clockLabelFromMinutes(totalMinutes) {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(totalMinutes)));
  if (clamped === 24 * 60) return "24:00";
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseClockMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 24 || minutes < 0 || minutes > 59) return null;
  if (hours === 24 && minutes !== 0) return null;
  return hours * 60 + minutes;
}

function parseTimeRangeValue(value, fallbackStart = 0, fallbackEnd = 8 * 60, options = {}) {
  const [startText = "", endText = ""] = String(value || "").split("-");
  const start = parseClockMinutes(startText);
  let end = parseClockMinutes(endText);
  if (start != null && end != null && options.allowWrap && end <= start) end += 24 * 60;
  if (start == null || end == null || end <= start) {
    return { start: fallbackStart, end: Math.max(fallbackStart + 15, fallbackEnd) };
  }
  return { start, end };
}

function timeRangeValue(startMinutes, endMinutes) {
  const normalize = (minutes) => {
    const day = 24 * 60;
    const wrapped = ((Math.round(minutes) % day) + day) % day;
    return clockLabelFromMinutes(wrapped);
  };
  return `${normalize(startMinutes)}-${normalize(endMinutes)}`;
}

function clampProjectToDate(project, selectedDate) {
  return clampDateTimeRangeToDate(projectStartAt(project), projectEndAt(project), selectedDate, 30);
}

function buildDailyTimelineData(repository, selectedDate) {
  const projects = repository.listProjects();
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const entryItems = repository.listEntries()
    .map((entry) => {
      const project = projectMap.get(entry.projectId);
      if (!project || !entryOverlapsDate(entry, selectedDate)) return null;
      if (isDailyStatusProject(project)) return null;
      if (isSleepProject(project)) return null;
      const segment = clampEntryToDate(entry, selectedDate);
      if (!segment) return null;
      const paletteIndex = Math.max(0, PROJECT_PALETTE.findIndex((item) => item.value === project.color));
      return {
        kind: "entry",
        entry,
        project,
        color: projectColor(project, paletteIndex),
        domain: projectDomainMeta(project, paletteIndex),
        ...segment,
      };
    })
    .filter(Boolean);

  const temporaryItems = projects
    .filter((project) => project.type === "temporary" && !isSleepProject(project) && projectOverlapsDate(project, selectedDate))
    .map((project) => {
      const paletteIndex = Math.max(0, PROJECT_PALETTE.findIndex((item) => item.value === project.color));
      const segment = clampProjectToDate(project, selectedDate);
      if (!segment) return null;
      return {
        kind: "temporary",
        project,
        color: projectColor(project, paletteIndex),
        domain: projectDomainMeta(project, paletteIndex),
        ...segment,
      };
    })
    .filter(Boolean);

  const items = [...entryItems, ...temporaryItems]
    .sort((left, right) => {
      if (left.startMinutes !== right.startMinutes) return left.startMinutes - right.startMinutes;
      return (right.endMinutes - right.startMinutes) - (left.endMinutes - left.startMinutes);
    });

  const laneEnds = [];
  for (const item of items) {
    let lane = laneEnds.findIndex((endMinutes) => endMinutes <= item.startMinutes);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endMinutes);
    } else {
      laneEnds[lane] = item.endMinutes;
    }
    item.lane = lane;
  }

  return {
    items,
    laneCount: Math.max(1, laneEnds.length),
    totalRecords: entryItems.length,
    totalTemporary: temporaryItems.length,
  };
}

function durationLabelFromMinutes(totalMinutes) {
  const hours = totalMinutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

function entryDurationMinutes(entry) {
  const start = parseDateTimeInput(entryStartAt(entry));
  const end = parseDateTimeInput(entryEndAt(entry));
  if (!start || !end || end <= start) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function timeOfDayLabel(startMinutes) {
  if (startMinutes < 12 * 60) return "Morning";
  if (startMinutes < 18 * 60) return "Afternoon";
  return "Evening";
}

function formatPercentLabel(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function buildDailyReviewSummary(timeline) {
  const entryItems = timeline.items.filter((item) => item.kind === "entry");
  const loggedMinutes = entryItems.reduce((sum, item) => sum + Math.max(0, item.endMinutes - item.startMinutes), 0);
  const domainMinutes = new Map();
  for (const item of entryItems) {
    domainMinutes.set(item.domain.label, (domainMinutes.get(item.domain.label) || 0) + Math.max(0, item.endMinutes - item.startMinutes));
  }
  const breakdown = Array.from(domainMinutes.entries())
    .map(([label, minutes]) => ({
      label,
      minutes,
      color: entryItems.find((item) => item.domain.label === label)?.color || "#999999",
      percent: loggedMinutes > 0 ? (minutes / loggedMinutes) * 100 : 0,
    }))
    .sort((left, right) => right.minutes - left.minutes);

  const moodMap = {
    English: "English-centered learning day",
    Exercise: "exercise-centered active day",
    Money: "money-centered planning day",
    Life: "life-centered maintenance day",
    Habit: "habit-centered consistency day",
    Sleep: "sleep-centered recovery day",
    Research: "Research-centered study day",
  };
  const dominantLabel = breakdown[0]?.label || "Quiet";
  const feeling = breakdown.length > 0 ? (moodMap[dominantLabel] || `${dominantLabel}-centered day`) : "quiet reset day";
  return {
    loggedMinutes,
    breakdown,
    feeling,
  };
}

function dateReviewProjects(repository, selectedDate) {
  const projects = repository.listProjects().filter((project, index) => (
    project.isActive !== false
    && !isDailyStatusProject(project)
    && !isSleepProject(project, index)
  ));
  return {
    shortTerm: projects.filter((project) => project.type === "short-term" && projectOverlapsDate(project, selectedDate)),
    longTerm: projects.filter((project) => project.type === "long-term"),
  };
}

async function ensureDailyStatusProject(plugin) {
  let project = plugin.repository.listProjects().find(isDailyStatusProject);
  if (!project) {
    project = await plugin.repository.createProjectAndPersist({
      name: "Daily Status",
      description: "Daily lightweight status check-in.",
      type: "daily-status",
      color: PROJECT_PALETTE.find((item) => item.label === "Moss")?.value || PROJECT_PALETTE[0].value,
      fields: dailyStatusFields(),
      isActive: true,
    });
  }
  return project;
}

function snapDateTimelinePointer(rail, clientX, clientY) {
  const timelineStartHour = DAILY_REVIEW_START_HOUR;
  const timelineEndHour = DAILY_REVIEW_END_HOUR;
  const totalHours = Math.max(1, timelineEndHour - timelineStartHour);
  const rect = rail.getBoundingClientRect();
  const inside = (
    clientX >= rect.left
    && clientX <= rect.right
    && clientY >= rect.top
    && clientY <= rect.bottom
  );
  const pixelsPerHour = rect.height / totalHours;
  const relativeY = clientY - rect.top;
  const snappedIndex = Math.max(0, Math.min(totalHours - 1, Math.round(relativeY / pixelsPerHour)));
  const snappedHour = Math.max(timelineStartHour, Math.min(timelineEndHour - 1, timelineStartHour + snappedIndex));
  const startMinutes = snappedHour * 60;
  const endMinutes = Math.min(timelineEndHour * 60, startMinutes + 60);
  return {
    inside,
    pixelsPerHour,
    translateY: (snappedHour - timelineStartHour) * pixelsPerHour,
    startMinutes,
    endMinutes,
  };
}

function openDateTimelineDrop(plugin, selectedDate, reopen, payload, snapped) {
  if (!snapped) return;
  if (payload.dragKind === "temporary-template") {
    new ProjectModal(plugin.app, plugin, null, () => reopen(), {
      initialType: "temporary",
      initialStartAt: dateTimeFromMinutes(selectedDate, snapped.startMinutes),
      initialEndAt: dateTimeFromMinutes(selectedDate, snapped.endMinutes),
    }).open();
    return;
  }
  const project = payload.projectId ? plugin.repository.getProject(payload.projectId) : null;
  if (!project || isDailyStatusProject(project) || isSleepProject(project)) return;
  new EntryModal(plugin.app, plugin, project, null, reopen, selectedDate, {
    initialStartAt: dateTimeFromMinutes(selectedDate, snapped.startMinutes),
    initialEndAt: dateTimeFromMinutes(selectedDate, snapped.endMinutes),
  }).open();
}

function attachDateTimelinePointerDrag(item, plugin, selectedDate, reopen, payload) {
  item.draggable = false;
  let suppressClick = false;

  item.addEventListener("click", (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  }, true);

  item.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const layout = item.closest(".sr-date-review-layout");
    const rail = layout?.querySelector(".sr-day-timeline-rail");
    if (!rail) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let latestPoint = null;
    let frame = 0;
    let ghost = null;
    let slot = null;
    let lastSnapped = null;

    const ensurePreview = () => {
      if (!slot) {
        slot = rail.createDiv({ cls: "sr-day-timeline-slot-preview sr-day-timeline-pointer-slot" });
      }
      if (!ghost) {
        ghost = rail.createDiv({ cls: "sr-day-timeline-drop-preview sr-day-timeline-pointer-preview" });
        ghost.createEl("strong");
        ghost.createSpan();
      }
      ghost.style.setProperty("--sr-item-color", payload.color);
      slot.style.setProperty("--sr-item-color", payload.color);
      ghost.querySelector("strong")?.setText(payload.label);
    };

    const hidePreview = () => {
      lastSnapped = null;
      rail.removeClass("is-drop-target");
      ghost?.removeClass("is-visible");
      ghost?.removeClass("is-snapped");
      slot?.removeClass("is-visible");
    };

    const removePreview = () => {
      ghost?.remove();
      slot?.remove();
      ghost = null;
      slot = null;
      rail.removeClass("is-drop-target");
    };

    const updatePreview = () => {
      frame = 0;
      if (!latestPoint) return;
      const snapped = snapDateTimelinePointer(rail, latestPoint.x, latestPoint.y);
      if (!snapped.inside) {
        hidePreview();
        return;
      }
      lastSnapped = snapped;
      ensurePreview();
      rail.addClass("is-drop-target");
      const slotHeight = Math.max(1, snapped.pixelsPerHour);
      slot.style.height = `${Math.max(1, slotHeight - 4)}px`;
      slot.style.transform = `translateY(${snapped.translateY + 2}px)`;
      ghost.style.height = `${Math.max(30, slotHeight - 8)}px`;
      ghost.style.transform = `translateY(${snapped.translateY + 4}px)`;
      ghost.querySelector("span")?.setText(`${clockLabelFromMinutes(snapped.startMinutes)}-${clockLabelFromMinutes(snapped.endMinutes)}`);
      slot.addClass("is-visible");
      ghost.addClass("is-visible");
      ghost.addClass("is-snapped");
    };

    const schedulePreview = (point) => {
      latestPoint = point;
      if (!frame) frame = requestAnimationFrame(updatePreview);
    };

    const onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!dragging && Math.hypot(deltaX, deltaY) < 4) return;
      if (!dragging) {
        dragging = true;
        item.addClass("is-dragging");
        item.setPointerCapture?.(event.pointerId);
      }
      moveEvent.preventDefault();
      schedulePreview({ x: moveEvent.clientX, y: moveEvent.clientY });
    };

    const cleanup = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      item.removeClass("is-dragging");
      removePreview();
    };

    const onPointerUp = (upEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      const snapped = lastSnapped;
      const shouldCreate = dragging && snapped?.inside;
      cleanup();
      if (!dragging) return;
      suppressClick = true;
      upEvent.preventDefault();
      if (shouldCreate) openDateTimelineDrop(plugin, selectedDate, reopen, payload, snapped);
    };

    const onPointerCancel = (cancelEvent) => {
      if (cancelEvent.pointerId !== event.pointerId) return;
      cleanup();
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
  });
}

function renderDateProjectShelf(container, plugin, selectedDate, reopen) {
  const repository = plugin.repository;
  const panel = container.createDiv({ cls: "sr-date-project-shelf" });
  panel.createEl("h3", { text: "Projects" });
  const statusButton = panel.createEl("button", { cls: "sr-date-status-button", text: "Daily Status", type: "button" });
  statusButton.addEventListener("click", async () => {
    const project = await ensureDailyStatusProject(plugin);
    new EntryModal(plugin.app, plugin, project, null, reopen, selectedDate).open();
  });

  const groups = dateReviewProjects(repository, selectedDate);
  const list = panel.createDiv({ cls: "sr-date-project-shelf-list" });

  const tempItem = list.createDiv({ cls: "sr-date-project-chip sr-date-project-chip-create" });
  tempItem.setAttr("data-drag-kind", "temporary-template");
  tempItem.style.setProperty("--project-color", PROJECT_PALETTE[1].value);
  const tempHead = tempItem.createDiv({ cls: "sr-tag-row" });
  tempHead.createSpan({ cls: "sr-project-dot" }).style.background = PROJECT_PALETTE[1].value;
  tempHead.createEl("strong", { text: "New Temporary" });
  attachDateTimelinePointerDrag(tempItem, plugin, selectedDate, reopen, {
    dragKind: "temporary-template",
    color: PROJECT_PALETTE[1].value,
    label: "New Temporary",
  });
  tempItem.addEventListener("click", () => {
    new ProjectModal(plugin.app, plugin, null, () => reopen(), {
      initialType: "temporary",
      initialStartAt: `${selectedDate}T09:00`,
      initialEndAt: `${selectedDate}T10:00`,
    }).open();
  });

  const renderShelfSection = (label, projects) => {
    if (!projects.length) return;
    list.createDiv({ cls: "sr-date-project-section-label", text: label });
    for (const project of projects) {
      const item = list.createDiv({ cls: "sr-date-project-chip" });
      item.setAttr("data-project-id", project.id);
      item.setAttr("data-drag-kind", "project-entry");
      item.style.setProperty("--project-color", project.color);
      const head = item.createDiv({ cls: "sr-tag-row" });
      head.createSpan({ cls: "sr-project-dot" }).style.background = project.color;
      head.createEl("strong", { text: project.name });
      attachDateTimelinePointerDrag(item, plugin, selectedDate, reopen, {
        dragKind: "project-entry",
        projectId: project.id,
        color: project.color,
        label: project.name,
      });
      item.addEventListener("click", () => {
        const startAt = `${selectedDate}T09:00`;
        new EntryModal(plugin.app, plugin, project, null, reopen, selectedDate, {
          initialStartAt: startAt,
          initialEndAt: shiftDateTimeHours(startAt, 1) || `${selectedDate}T10:00`,
        }).open();
      });
    }
  };

  renderShelfSection("Short-term", groups.shortTerm);
  renderShelfSection("Long-term", groups.longTerm);

  if (!groups.shortTerm.length && !groups.longTerm.length) {
    list.createDiv({ cls: "sr-empty", text: "No active short-term or long-term projects." });
  }
}

function renderDateTimeline(container, plugin, selectedDate, reopen) {
  const repository = plugin.repository;
  const timeline = buildDailyTimelineData(repository, selectedDate);
  const panel = container.createDiv({ cls: "sr-day-timeline-panel" });
  const hoverCard = panel.createDiv({ cls: "sr-day-hover-card" });

  const daily = buildDailyReviewSummary(timeline);
  const header = panel.createDiv({ cls: "sr-day-review-header" });
  const pills = header.createDiv({ cls: "sr-tag-row sr-day-review-pills" });
  pills.createSpan({ cls: "sr-day-kpi-pill", text: `${timeline.totalRecords} records` });
  pills.createSpan({ cls: "sr-day-kpi-pill", text: `${durationLabelFromMinutes(daily.loggedMinutes)} logged` });
  header.createDiv({ cls: "sr-day-review-feel" , text: `Today feels like: ${daily.feeling}` });

  if (daily.breakdown.length > 0) {
    const investment = panel.createDiv({ cls: "sr-day-investment" });
    const bar = investment.createDiv({ cls: "sr-day-investment-bar" });
    for (const item of daily.breakdown) {
      const segment = bar.createDiv({ cls: "sr-day-investment-segment" });
      segment.style.width = `${item.percent}%`;
      segment.style.background = item.color;
      segment.setAttr("title", `${item.label} ${formatPercentLabel(item.percent)}`);
    }
    investment.createDiv({ cls: "sr-day-investment-labels", text: daily.breakdown.map((item) => `${item.label} ${formatPercentLabel(item.percent)}`).join(" | ") });
  }

  const visibleStartHour = DAILY_REVIEW_START_HOUR;
  const visibleEndHour = DAILY_REVIEW_END_HOUR;
  const hourHeight = DAILY_TIMELINE_SLOT_HEIGHT;
  const visibleHours = Array.from({ length: Math.max(1, visibleEndHour - visibleStartHour + 1) }, (_, index) => visibleStartHour + index);
  const visibleSlotCount = Math.max(1, visibleEndHour - visibleStartHour);

  const shell = panel.createDiv({ cls: "sr-day-timeline-shell" });
  const hours = shell.createDiv({ cls: "sr-day-timeline-hours" });
  const rail = shell.createDiv({ cls: "sr-day-timeline-rail sr-day-timeline-rail-focused" });
  rail.style.setProperty("--sr-timeline-lanes", String(timeline.laneCount));
  rail.style.minHeight = `${visibleSlotCount * hourHeight}px`;

  for (const hour of visibleHours) {
    hours.createDiv({ cls: "sr-day-timeline-hour-label", text: `${String(hour).padStart(2, "0")}:00` });
    if (hour >= visibleEndHour) continue;
    const row = rail.createDiv({ cls: "sr-day-timeline-hour-row" });
    row.style.top = `${(hour - visibleStartHour) * hourHeight}px`;
    row.style.height = `${hourHeight}px`;
  }

  if (selectedDate === todayYmd()) {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes >= visibleStartHour * 60 && nowMinutes <= visibleEndHour * 60) {
      const nowLine = rail.createDiv({ cls: "sr-day-timeline-now" });
      nowLine.style.top = `${((nowMinutes - visibleStartHour * 60) / 60) * hourHeight}px`;
      nowLine.createSpan({ text: `Now ${clockLabelFromMinutes(nowMinutes)}` });
    }
  }

  for (const item of timeline.items) {
    const visibleStartMinutes = visibleStartHour * 60;
    const card = rail.createDiv({ cls: "sr-day-timeline-item" });
    card.style.setProperty("--sr-item-color", item.color);
    card.style.top = `${((item.startMinutes - visibleStartMinutes) / 60) * hourHeight + 4}px`;
    card.style.height = `${Math.max(hourHeight - 8, ((item.endMinutes - item.startMinutes) / 60) * hourHeight - 8)}px`;
    card.style.left = `calc(${(item.lane / timeline.laneCount) * 100}% + 6px)`;
    card.style.width = `calc(${100 / timeline.laneCount}% - 12px)`;
    const titleText = item.kind === "entry"
      ? `${item.project.name} | ${entryTimeLabel(item.entry)}`
      : `${item.project.name} | ${projectScheduleLabel(item.project)}`;
    card.setAttr("title", titleText);
    card.createEl("strong", { cls: "sr-day-timeline-item-name", text: item.project.name });
    attachTimelineHover(card, hoverCard, item, plugin.app);
  }

  if (timeline.items.length === 0) {
    const empty = rail.createDiv({ cls: "sr-day-timeline-empty" });
    empty.createDiv({ text: "Drag a project here to create a record." });
  }

  return timeline;
}

function renderDateProjectCards(container, plugin, timeline, selectedDate, reopen) {
  const wrap = container.createDiv({ cls: "sr-date-detail-groups" });
  if (!timeline.items.length) return;
  for (const item of timeline.items) {
    const project = item.project;
    const card = wrap.createDiv({ cls: "sr-date-project-card sr-date-project-card-detailed" });
    const title = card.createDiv({ cls: "sr-tag-row" });
    title.createSpan({ cls: "sr-project-dot" }).style.background = item.color;
    title.createEl("strong", { text: project.name });
    title.createSpan({ cls: "sr-tag", text: item.domain.label });
    if (item.kind === "entry") {
      title.createSpan({ cls: "sr-tag", text: durationLabelFromMinutes(item.endMinutes - item.startMinutes) });
      title.createSpan({ cls: "sr-tag", text: timeOfDayLabel(item.startMinutes) });
    } else {
      title.createSpan({ cls: "sr-tag", text: `${clockLabelFromMinutes(item.startMinutes)} - ${clockLabelFromMinutes(item.endMinutes)}` });
    }
    if (item.kind !== "entry") {
      card.createDiv({ cls: "sr-muted", text: projectScheduleLabel(project) });
    }
    if (project.description) card.createDiv({ cls: "sr-muted", text: project.description });

    const actions = card.createDiv({ cls: "sr-entry-actions" });
    if (item.kind === "entry") {
      actions.createEl("button", { text: "Edit Entry", type: "button" }).addEventListener("click", () => {
        new EntryModal(plugin.app, plugin, project, item.entry, reopen, selectedDate).open();
      });
    }
    if (project.type === "temporary") {
      const completeWrap = card.createDiv({ cls: "sr-inline-check" });
      const completeInput = completeWrap.createEl("input");
      completeInput.type = "checkbox";
      completeInput.checked = Boolean(project.completed);
      completeWrap.createSpan({ text: "Completed" });
      completeInput.addEventListener("change", async () => {
        await plugin.repository.setTemporaryCompletedAndPersist(project.id, completeInput.checked);
        reopen();
      });
    }

    if (item.kind !== "entry") continue;

    const values = card.createDiv({ cls: "sr-tag-row" });
    for (const field of project.fields) {
      renderFieldValue(values, field, item.entry.values[field.id], plugin.app);
    }
    if (project.fields.length === 0) {
      card.createDiv({ cls: "sr-muted", text: "No custom fields configured." });
    }
  }
}

function timelineItemDetailData(item) {
  const fields = [];
  if (item.kind === "entry") {
    for (const field of item.project.fields) {
      const value = item.entry.values[field.id];
      if (value == null || value === "") continue;
      if (field.type === "score") {
        fields.push([field.name, `${formatRpgXp(Number(value))}/5`]);
      } else if (field.type === "emotion") {
        fields.push([field.name, emotionStatusLabel(value)]);
      } else if (field.type === "file") {
        fields.push([field.name, fileNameFromPath(value)]);
      } else if (field.type === "time-range") {
        const range = parseTimeRangeValue(value, 23 * 60, 31 * 60, { allowWrap: true });
        fields.push([field.name, `${timeRangeValue(range.start, range.end)} · ${durationLabelFromMinutes(range.end - range.start)}`]);
      } else {
        fields.push([field.name, String(value)]);
      }
    }
  }
  return {
    title: item.project.name,
    time: item.kind === "entry" ? entryTimeLabel(item.entry) : projectScheduleLabel(item.project),
    meta: `${projectTypeLabel(item.project.type)} · ${item.domain.label}`,
    description: item.project.description || "",
    fields,
  };
}

function attachTimelineHover(card, hoverCard, item, app) {
  const setPosition = (event) => {
    const panelRect = hoverCard.parentElement?.getBoundingClientRect();
    if (!panelRect) return;
    const left = Math.min(panelRect.width - 260, Math.max(12, event.clientX - panelRect.left + 14));
    const top = Math.min(panelRect.height - 120, Math.max(56, event.clientY - panelRect.top - 8));
    hoverCard.style.left = `${left}px`;
    hoverCard.style.top = `${top}px`;
  };
  const show = (event) => {
    hoverCard.empty();
    hoverCard.style.setProperty("--sr-item-color", item.color);
    const detail = timelineItemDetailData(item, app);
    hoverCard.createEl("strong", { text: detail.title });
    hoverCard.createDiv({ cls: "sr-day-hover-time", text: detail.time });
    hoverCard.createDiv({ cls: "sr-day-hover-meta", text: detail.meta });
    if (detail.description) hoverCard.createDiv({ cls: "sr-day-hover-description", text: detail.description });
    if (detail.fields.length > 0) {
      const list = hoverCard.createDiv({ cls: "sr-day-hover-fields" });
      for (const [label, value] of detail.fields) {
        const row = list.createDiv({ cls: "sr-day-hover-field" });
        row.createSpan({ cls: "sr-day-hover-field-label", text: label });
        row.createSpan({ cls: "sr-day-hover-field-value", text: value });
      }
    }
    hoverCard.addClass("is-visible");
    setPosition(event);
  };
  const hide = () => hoverCard.removeClass("is-visible");
  card.addEventListener("mouseenter", show);
  card.addEventListener("mousemove", setPosition);
  card.addEventListener("mouseleave", hide);
}
function calendarProjectLabel(name, limit = 8) {
  const value = String(name || "").trim();
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(4, limit - 3)) + "...";
}

function calendarProjectMonogram(name) {
  const value = String(name || "").trim();
  if (!value) return "?";
  const first = Array.from(value)[0] || "?";
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

function renderCalendarPanel(container, plugin, view) {
  const repository = plugin.repository;
  const projects = repository.listProjects().filter((project, index) => project.isActive && !isDailyStatusProject(project) && projectDomainMeta(project, index).key !== "sleep");
  const laneMap = shortTermLaneMap(projects);
  const statusByDate = new Map();
  for (const item of rpgDailyStatusEntries(repository).sort((left, right) => left.entry.updatedAt.localeCompare(right.entry.updatedAt))) {
    statusByDate.set(item.entry.date, item);
  }
  const entryDatesByProject = new Map(
    projects.map((project) => [project.id, new Set(repository.listEntries(project.id).map((entry) => entry.date))])
  );
  const shell = container.createDiv({ cls: "sr-calendar-shell" });

  const header = shell.createDiv({ cls: "sr-calendar-header" });
  header.createEl("h3", { text: "Calendar" });
  const nav = header.createDiv({ cls: "sr-calendar-nav" });
  nav.createEl("button", { text: "<", type: "button" }).addEventListener("click", () => {
    view.currentMonthKey = shiftMonth(view.currentMonthKey, -1);
    view.render();
  });
  nav.createEl("strong", { text: monthLabel(view.currentMonthKey) });
  nav.createEl("button", { text: ">", type: "button" }).addEventListener("click", () => {
    view.currentMonthKey = shiftMonth(view.currentMonthKey, 1);
    view.render();
  });
  shell.createDiv({ cls: "sr-calendar-focus-date sr-muted", text: fullDateLabel(view.selectedDate) });

  const weekdays = shell.createDiv({ cls: "sr-calendar-weekdays" });
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((label) => {
    weekdays.createDiv({ cls: "sr-calendar-weekday", text: label });
  });

  const grid = shell.createDiv({ cls: "sr-calendar-grid" });
  for (const cell of buildMonthGrid(view.currentMonthKey)) {
    const day = grid.createEl("button", { cls: "sr-calendar-day", type: "button" });
    if (!cell.inCurrentMonth) day.addClass("is-outside-month");
    if (cell.date === todayYmd()) day.addClass("is-today");
    if (cell.date === view.selectedDate) day.addClass("is-selected");
    let todayMark = null;
    if (cell.date === todayYmd()) {
      const todayJitter = calendarMarkJitter(`${cell.date}-today-ring`);
      todayMark = todayJitter;
      day.style.setProperty("--today-ring-x", `${todayJitter.x}px`);
      day.style.setProperty("--today-ring-y", `${todayJitter.y}px`);
      day.style.setProperty("--today-ring-rotate", `${todayJitter.rotate}deg`);
      day.style.setProperty("--today-ring-scale", String(1.04 + (todayJitter.scale - 0.92)));
      day.style.setProperty("--today-ring-width", `${todayJitter.width + 12}px`);
      day.style.setProperty("--today-ring-height", `${todayJitter.height + 9}px`);
      day.style.setProperty("--today-ring-radius", todayJitter.radius);
    }
    const status = statusByDate.get(cell.date);
    const moodColor = emotionCalendarColor(dailyStatusValue(status, "daily-mood"));
    if (moodColor) {
      day.addClass("has-emotion");
      day.style.setProperty("--calendar-mood-color", moodColor);
      day.style.setProperty("--calendar-mood-bg", emotionBackground(dailyStatusValue(status, "daily-mood")));
    }
    const sleepMinutes = sleepTimeMinutes(dailyStatusValue(status, "daily-sleep-time"));
    let sleepMark = null;
    if (sleepMinutes != null && cell.date !== todayYmd()) {
      const isSleepOk = sleepMinutes >= 420;
      day.addClass("has-sleep-mark");
      day.addClass(isSleepOk ? "is-sleep-ok" : "is-sleep-low");
      const jitter = calendarMarkJitter(`${cell.date}-${isSleepOk ? "ok" : "low"}`);
      sleepMark = { isSleepOk, jitter };
      day.style.setProperty("--sleep-mark-x", `${jitter.x}px`);
      day.style.setProperty("--sleep-mark-y", `${jitter.y}px`);
      day.style.setProperty("--sleep-mark-rotate", `${jitter.rotate}deg`);
      day.style.setProperty("--sleep-mark-scale", String(jitter.scale));
      day.style.setProperty("--sleep-mark-width", `${jitter.width}px`);
      day.style.setProperty("--sleep-mark-height", `${jitter.height}px`);
      day.style.setProperty("--sleep-mark-radius", jitter.radius);
      day.setAttr("title", `${fullDateLabel(cell.date)} | Sleep ${durationLabelFromMinutes(sleepMinutes)}`);
    }
    day.addEventListener("click", () => {
      view.selectedDate = cell.date;
      view.currentMonthKey = monthKeyFromDate(cell.date);
      view.render();
      new DateDetailModal(plugin.app, plugin, cell.date).open();
    });

    const longTermProjects = projects.filter((project) => project.type === "long-term" && (entryDatesByProject.get(project.id)?.has(cell.date) || projectOverlapsDate(project, cell.date)));
    if (longTermProjects.length > 0) {
      const dotsWrap = day.createDiv({ cls: "sr-calendar-dots" });
      for (const project of longTermProjects) {
        const dot = dotsWrap.createSpan({ cls: "sr-calendar-dot" });
        dot.style.background = project.color;
        dot.setAttr("title", project.name + " | " + projectScheduleLabel(project));
      }
    }

    const number = day.createDiv({ cls: "sr-calendar-day-number", text: String(cell.day) });
    number.setAttr("aria-label", fullDateLabel(cell.date));
    if (sleepMark?.isSleepOk) {
      const ring = number.createSpan({ cls: "sr-calendar-sketch-ring sr-calendar-sleep-ring", attr: { "aria-hidden": "true" } });
      for (let lineIndex = 0; lineIndex < 3; lineIndex += 1) {
        const jitter = calendarMarkJitter(`${cell.date}-sleep-ring-${lineIndex}`);
        const line = ring.createSpan();
        line.style.setProperty("--ring-x", `${jitter.x + lineIndex - 1}px`);
        line.style.setProperty("--ring-y", `${jitter.y + (lineIndex % 2 ? 1 : -1)}px`);
        line.style.setProperty("--ring-rotate", `${jitter.rotate + (lineIndex - 1) * 7}deg`);
        line.style.setProperty("--ring-scale", String(jitter.scale + lineIndex * 0.035));
        line.style.setProperty("--ring-width", `${jitter.width + 7 + lineIndex * 2}px`);
        line.style.setProperty("--ring-height", `${jitter.height + 7 + (lineIndex % 2) * 3}px`);
        line.style.setProperty("--ring-radius", jitter.radius);
      }
    } else if (sleepMark && !sleepMark.isSleepOk) {
      const mark = number.createSpan({ cls: "sr-calendar-sleep-x", text: "×", attr: { "aria-hidden": "true" } });
      mark.style.setProperty("--ring-x", `${sleepMark.jitter.x}px`);
      mark.style.setProperty("--ring-y", `${sleepMark.jitter.y}px`);
      mark.style.setProperty("--ring-rotate", `${sleepMark.jitter.rotate}deg`);
      mark.style.setProperty("--ring-scale", String(sleepMark.jitter.scale + 0.08));
    }
    if (todayMark) {
      const ring = number.createSpan({ cls: "sr-calendar-sketch-ring sr-calendar-today-ring", attr: { "aria-hidden": "true" } });
      for (let lineIndex = 0; lineIndex < 3; lineIndex += 1) {
        const jitter = calendarMarkJitter(`${cell.date}-today-ring-line-${lineIndex}`);
        const line = ring.createSpan();
        line.style.setProperty("--ring-x", `${jitter.x + lineIndex - 1}px`);
        line.style.setProperty("--ring-y", `${jitter.y + (lineIndex % 2 ? 1 : -2)}px`);
        line.style.setProperty("--ring-rotate", `${jitter.rotate + (lineIndex - 1) * 8}deg`);
        line.style.setProperty("--ring-scale", String(1.08 + (jitter.scale - 0.92) + lineIndex * 0.04));
        line.style.setProperty("--ring-width", `${jitter.width + 18 + lineIndex * 3}px`);
        line.style.setProperty("--ring-height", `${jitter.height + 14 + (lineIndex % 2) * 4}px`);
        line.style.setProperty("--ring-radius", jitter.radius);
      }
    }

    const temporaryProjects = projects.filter((project) => project.type === "temporary" && projectOverlapsDate(project, cell.date));
    if (temporaryProjects.length > 0) {
      const pillWrap = day.createDiv({ cls: "sr-calendar-temp-pills" });
      const firstProject = temporaryProjects[0];
      const pill = pillWrap.createDiv({ cls: "sr-calendar-temp-pill", text: calendarProjectMonogram(firstProject.name) });
      pill.style.background = rgba(firstProject.color, 0.16);
      pill.style.borderColor = rgba(firstProject.color, 0.42);
      pill.style.color = firstProject.color;
      pill.setAttr("title", temporaryProjects.map((project) => project.name).join(", "));
      if (temporaryProjects.length > 1) {
        const more = pillWrap.createDiv({ cls: "sr-calendar-temp-pill sr-calendar-temp-pill-overflow", text: "+" + (temporaryProjects.length - 1) });
        more.setAttr("title", temporaryProjects.slice(1).map((project) => project.name).join(", "));
      }
    }

    const shortTermProjects = projects
      .filter((project) => project.type === "short-term" && projectOverlapsDate(project, cell.date))
      .sort((left, right) => (laneMap.get(left.id) || 0) - (laneMap.get(right.id) || 0));

    if (shortTermProjects.length > 0) {
      const barsWrap = day.createDiv({ cls: "sr-calendar-bars" });
      barsWrap.style.height = ((Math.max(...shortTermProjects.map((project) => laneMap.get(project.id) || 0)) + 1) * 10) + "px";
      for (const project of shortTermProjects) {
        const bar = barsWrap.createDiv({ cls: "sr-calendar-bar" });
        const hasRecord = entryDatesByProject.get(project.id)?.has(cell.date);
        bar.style.top = ((laneMap.get(project.id) || 0) * 10) + "px";
        bar.style.background = hasRecord ? project.color : rgba(project.color, 0.38);
        bar.style.borderColor = rgba(project.color, hasRecord ? 0.92 : 0.36);
        bar.setAttr("title", project.name + " | " + projectScheduleLabel(project) + (hasRecord ? " | recorded" : " | planned"));
        const label = bar.createSpan({ cls: "sr-calendar-bar-label", text: calendarProjectMonogram(project.name) });
        label.style.color = hasRecord ? "#ffffff" : project.color;
        if (!hasRecord) bar.addClass("is-planned");
        if (projectStartDate(project) === cell.date) bar.addClass("is-start");
        if (projectEndDate(project) === cell.date) bar.addClass("is-end");
      }
    }
  }
}

function renderOverview(container, plugin, view) {
  const wrap = container.createDiv({ cls: "sr-overview" });
  const top = wrap.createDiv({ cls: "sr-overview-top" });

  const hero = top.createDiv({ cls: "sr-panel sr-overview-hero" });
  renderLifeRpgOverview(hero, plugin, view.selectedDate);

  const trendPanel = top.createDiv({ cls: "sr-panel sr-overview-trend-panel" });
  renderProjectLines(trendPanel, plugin);

  const calendarLayout = wrap.createDiv({ cls: "sr-calendar-layout" });
  renderCalendarPanel(calendarLayout.createDiv({ cls: "sr-panel sr-calendar-panel" }), plugin, view);
}

function citeTagValues(cache) {
  const values = [];
  for (const tag of cache?.tags || []) values.push(tag?.tag);
  const frontmatterTags = cache?.frontmatter?.tags ?? cache?.frontmatter?.tag;
  if (Array.isArray(frontmatterTags)) values.push(...frontmatterTags);
  else if (typeof frontmatterTags === "string") values.push(...frontmatterTags.split(/[\s,]+/));
  return values
    .map((value) => String(value || "").trim().replace(/^#/, "").toLowerCase())
    .filter(Boolean);
}

function listCiteMemoryCards(plugin, reviewDate = todayYmd()) {
  const cards = plugin.app.vault.getMarkdownFiles()
    .filter((file) => !normalizePath(file.path).startsWith(".trash/"))
    .filter((file) => citeTagValues(plugin.app.metadataCache.getFileCache(file)).some((tag) => tag === "aed" || tag.startsWith("aed/")))
    .map((file) => {
      const cache = plugin.app.metadataCache.getFileCache(file);
      const title = String(cache?.frontmatter?.title || file.basename || file.name).trim();
      const review = plugin.repository.getCiteReview(file.path);
      return {
        file,
        path: file.path,
        title,
        review,
        due: !review || !review.nextReview || review.nextReview <= reviewDate,
      };
    });
  cards.sort((left, right) => {
    if (left.due !== right.due) return left.due ? -1 : 1;
    if (!left.review !== !right.review) return !left.review ? -1 : 1;
    const leftDate = left.review?.nextReview || reviewDate;
    const rightDate = right.review?.nextReview || reviewDate;
    const byDate = leftDate.localeCompare(rightDate);
    return byDate !== 0 ? byDate : left.title.localeCompare(right.title, "en-US");
  });
  return cards;
}

function listOrganizeNotes(plugin) {
  return plugin.app.vault.getMarkdownFiles()
    .filter((file) => !normalizePath(file.path).startsWith(".trash/"))
    .filter((file) => citeTagValues(plugin.app.metadataCache.getFileCache(file)).some((tag) => tag === "aing" || tag.startsWith("aing/")))
    .map((file) => {
      const cache = plugin.app.metadataCache.getFileCache(file);
      return {
        file,
        path: file.path,
        title: String(cache?.frontmatter?.title || file.basename || file.name).trim(),
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title, "en-US"));
}

function citeMemoryCatalogSignature(plugin) {
  const recite = listCiteMemoryCards(plugin).map((card) => `aed\u0000${card.path}\u0000${card.title}`);
  const organize = listOrganizeNotes(plugin).map((note) => `aing\u0000${note.path}\u0000${note.title}`);
  return [...recite, ...organize].sort().join("\u0001");
}

async function openCiteMemoryCard(plugin, card) {
  const file = plugin.app.vault.getAbstractFileByPath(card.path);
  if (!file || typeof file.path !== "string") throw new Error("Card note was not found.");
  await plugin.app.workspace.getLeaf("tab").openFile(file);
}

function attachCiteCardPointerDrag(cardEl, card, zones, plugin, options = {}) {
  cardEl.draggable = false;
  let pointerId = null;
  let start = null;
  let offset = null;
  let dragging = false;
  let ghost = null;
  let activeZone = null;
  let suppressClick = false;

  const clearZone = () => {
    for (const zone of zones) zone.element.removeClass("is-active");
    activeZone = null;
  };
  const cleanup = () => {
    clearZone();
    ghost?.remove();
    ghost = null;
    cardEl.removeClass("is-dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    pointerId = null;
    start = null;
    offset = null;
    dragging = false;
  };
  const zoneNearPoint = (x, y) => zones.find((zone) => {
    const rect = zone.element.getBoundingClientRect();
    const magnet = 24;
    return x >= rect.left - magnet && x <= rect.right + magnet && y >= rect.top - magnet && y <= rect.bottom + magnet;
  }) || null;
  const ensureGhost = () => {
    if (ghost) return ghost;
    const rect = cardEl.getBoundingClientRect();
    ghost = document.body.createDiv({ cls: "sr-memory-card-ghost" });
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.createEl("strong", { text: card.title });
    ghost.createSpan({ text: "AED" });
    return ghost;
  };
  const positionGhost = (event) => {
    const preview = ensureGhost();
    const zone = zoneNearPoint(event.clientX, event.clientY);
    clearZone();
    activeZone = zone;
    if (zone) zone.element.addClass("is-active");
    let left = event.clientX - offset.x;
    let top = event.clientY - offset.y;
    if (zone) {
      const zoneRect = zone.element.getBoundingClientRect();
      const ghostRect = preview.getBoundingClientRect();
      const snappedLeft = zoneRect.left + (zoneRect.width - ghostRect.width) / 2;
      const snappedTop = zoneRect.top + (zoneRect.height - ghostRect.height) / 2;
      left += (snappedLeft - left) * 0.55;
      top += (snappedTop - top) * 0.55;
      preview.addClass("is-magnetic");
    } else {
      preview.removeClass("is-magnetic");
    }
    preview.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    preview.addClass("is-visible");
  };
  const onMove = (event) => {
    if (event.pointerId !== pointerId || !start) return;
    if (!dragging && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
    if (!dragging) {
      dragging = true;
      suppressClick = true;
      cardEl.addClass("is-dragging");
      cardEl.setPointerCapture?.(pointerId);
    }
    event.preventDefault();
    positionGhost(event);
  };
  const commit = async (zone) => {
    const zoneRect = zone.element.getBoundingClientRect();
    const ghostRect = ghost?.getBoundingClientRect();
    if (ghost && ghostRect) {
      ghost.addClass("is-committing");
      ghost.style.transform = `translate3d(${zoneRect.left + (zoneRect.width - ghostRect.width) / 2}px, ${zoneRect.top + (zoneRect.height - ghostRect.height) / 2}px, 0) scale(.84)`;
    }
    cardEl.addClass("is-committing");
    await new Promise((resolve) => window.setTimeout(resolve, 170));
    cleanup();
    try {
      await plugin.repository.reviewCiteCardAndPersist(card.path, zone.rating, todayYmd());
      new Notice(`${card.title}: ${zone.label}`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Failed to update card review.");
    }
  };
  const onUp = (event) => {
    if (event.pointerId !== pointerId) return;
    const zone = dragging ? activeZone : null;
    if (zone) {
      void commit(zone);
      return;
    }
    cleanup();
  };
  const onCancel = (event) => {
    if (event.pointerId === pointerId) cleanup();
  };

  cardEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || pointerId != null) return;
    const rect = cardEl.getBoundingClientRect();
    pointerId = event.pointerId;
    start = { x: event.clientX, y: event.clientY };
    offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  });
  cardEl.addEventListener("click", (event) => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (typeof options.onCardClick === "function") {
      event.preventDefault();
      event.stopPropagation();
      options.onCardClick(card, cardEl);
      return;
    }
    void openCiteMemoryCard(plugin, card).catch((error) => new Notice(error instanceof Error ? error.message : "Failed to open card."));
  });
  cardEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (typeof options.onCardClick === "function") {
      options.onCardClick(card, cardEl);
      return;
    }
    void openCiteMemoryCard(plugin, card).catch((error) => new Notice(error instanceof Error ? error.message : "Failed to open card."));
  });
}

function renderCiteMemoryPanel(container, plugin) {
  const tablet = isTabletMode(plugin);
  const cards = listCiteMemoryCards(plugin);
  const dueCards = cards.filter((card) => card.due);
  const organizeNotes = listOrganizeNotes(plugin);
  const tomorrow = shiftDateDays(todayYmd(), 1);
  const tomorrowCount = cards.filter((card) => card.review?.nextReview === tomorrow).length;
  const nextCard = cards.filter((card) => !card.due && card.review?.nextReview).sort((left, right) => left.review.nextReview.localeCompare(right.review.nextReview))[0];
  const head = container.createDiv({ cls: "sr-memory-head" });
  head.createEl("h3", { text: dueCards.length > 0 ? "Aed Review" : organizeNotes.length > 0 ? "Aing Notes" : "Daily Cards" });
  head.createSpan({ text: `${dueCards.length} Aed · ${organizeNotes.length} Aing · ${tomorrowCount} tomorrow` });

  const body = container.createDiv({ cls: "sr-memory-body" });
  const queue = body.createDiv({ cls: "sr-memory-queue" });
  if (dueCards.length === 0 && organizeNotes.length === 0) {
    body.addClass("is-empty");
    const empty = queue.createDiv({ cls: "sr-memory-empty" });
    setIcon(empty.createSpan(), "check-circle-2");
    empty.createEl("strong", { text: cards.length === 0 ? "No #Aed cards found" : "All caught up" });
    empty.createSpan({ text: nextCard ? `Next review · ${fullDateLabel(nextCard.review.nextReview)}` : "Use #Aed for review and #Aing for notes." });
  }

  if (dueCards.length > 0) {
    queue.addClass("is-hand");
    if (tablet) body.addClass("is-tablet-review");
    const slots = body.createDiv({ cls: "sr-memory-slots" });
    let selectedCard = null;
    let selectedCardEl = null;
    const selectCard = (card, element) => {
      selectedCardEl?.removeClass("is-selected");
      selectedCard = card;
      selectedCardEl = element;
      selectedCardEl.addClass("is-selected");
      for (const zone of zones) {
        zone.element.addClass("is-ready");
        const hint = zone.element.querySelector("span:last-child");
        if (hint) hint.textContent = "Tap to review";
      }
    };
    const commitSelected = async (zone) => {
      if (!tablet || !selectedCard) {
        if (tablet) new Notice("Select a card first.");
        return;
      }
      zone.element.addClass("is-active");
      selectedCardEl?.addClass("is-committing");
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      try {
        await plugin.repository.reviewCiteCardAndPersist(selectedCard.path, zone.rating, todayYmd());
        new Notice(`${selectedCard.title}: ${zone.label}`);
        container.empty();
        renderCiteMemoryPanel(container, plugin);
      } catch (error) {
        selectedCardEl?.removeClass("is-committing");
        zone.element.removeClass("is-active");
        new Notice(error instanceof Error ? error.message : "Failed to update card review.");
      }
    };
    const zoneDefinitions = [
      { rating: "remembered", label: "Remembered", icon: "check", color: "green" },
      { rating: "fuzzy", label: "Fuzzy", icon: "circle-help", color: "yellow" },
      { rating: "forgotten", label: "Forgotten", icon: "rotate-ccw", color: "blue" },
    ];
    const zones = zoneDefinitions.map((definition) => {
      const element = slots.createDiv({ cls: `sr-memory-slot is-${definition.color}` });
      setIcon(element.createSpan({ cls: "sr-memory-slot-icon" }), definition.icon);
      element.createEl("strong", { text: definition.label });
      element.createSpan({ text: tablet ? "Tap card first" : "Drop card" });
      if (tablet) {
        element.setAttr("role", "button");
        element.setAttr("tabindex", "0");
        element.addEventListener("click", () => void commitSelected({ ...definition, element }));
        element.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          void commitSelected({ ...definition, element });
        });
      }
      return { ...definition, element };
    });

    const handCenter = (dueCards.length - 1) / 2;
    for (const [index, card] of dueCards.entries()) {
      const item = queue.createDiv({ cls: tablet ? "sr-memory-card is-tablet-card" : "sr-memory-card", attr: { tabindex: "0", role: tablet ? "button" : "link", "aria-label": tablet ? `Select ${card.title}` : `Open ${card.title}` } });
      item.style.setProperty("--memory-card-rotate", `${Math.max(-7, Math.min(7, (index - handCenter) * 1.7))}deg`);
      item.style.setProperty("--memory-card-lift", `${Math.min(7, Math.abs(index - handCenter) * 1.25)}px`);
      item.style.zIndex = String(index + 1);
      const icon = item.createSpan({ cls: "sr-memory-card-icon" });
      setIcon(icon, "notebook-tabs");
      const copy = item.createDiv({ cls: "sr-memory-card-copy" });
      copy.createEl("strong", { text: card.title });
      copy.createSpan({ text: card.path });
      item.createSpan({ cls: "sr-memory-card-state", text: card.review ? `Due · ${card.review.reviewCount} reviews` : "New" });
      if (tablet) {
        const openButton = item.createEl("button", { cls: "sr-memory-card-open", attr: { type: "button", "aria-label": `Open ${card.title}` } });
        setIcon(openButton, "external-link");
        openButton.addEventListener("pointerdown", (event) => event.stopPropagation());
        openButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void openCiteMemoryCard(plugin, card).catch((error) => new Notice(error instanceof Error ? error.message : "Failed to open card."));
        });
      }
      attachCiteCardPointerDrag(item, card, zones, plugin, { onCardClick: tablet ? selectCard : null });
    }
  } else if (organizeNotes.length > 0) {
    body.addClass("is-organize");
    queue.addClass("is-hand");
    const handCenter = (organizeNotes.length - 1) / 2;
    for (const [index, note] of organizeNotes.entries()) {
      const item = queue.createDiv({ cls: "sr-memory-card is-organize", attr: { tabindex: "0", role: "link", "aria-label": `Open ${note.title}` } });
      item.style.setProperty("--memory-card-rotate", `${Math.max(-7, Math.min(7, (index - handCenter) * 1.7))}deg`);
      item.style.setProperty("--memory-card-lift", `${Math.min(7, Math.abs(index - handCenter) * 1.25)}px`);
      item.style.zIndex = String(index + 1);
      const icon = item.createSpan({ cls: "sr-memory-card-icon" });
      setIcon(icon, "inbox");
      const copy = item.createDiv({ cls: "sr-memory-card-copy" });
      copy.createEl("strong", { text: note.title });
      copy.createSpan({ text: note.path });
      item.createSpan({ cls: "sr-memory-card-state", text: "Pending" });
      const open = () => void openCiteMemoryCard(plugin, note).catch((error) => new Notice(error instanceof Error ? error.message : "Failed to open note."));
      item.addEventListener("click", open);
      item.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      });
    }
  }
}

function renderLifeRpgOverview(container, plugin, selectedDate) {
  const repository = plugin.repository;
  const overview = buildOverviewStats(repository, selectedDate);
  container.createEl("h2", { text: "Overview" });

  const grid = container.createDiv({ cls: "sr-overview-dashboard" });

  const statsPanel = grid.createDiv({ cls: "sr-overview-card sr-overview-stats-panel" });
  statsPanel.createEl("h3", { text: "Snapshot" });
  const statRows = [
    ["Date", fullDateLabel(overview.selectedDate)],
    ["Total records", String(overview.totalRecords)],
    ["Most frequent 7d", overview.mostProject ? `${overview.mostProject.project.name} · ${overview.mostProject.count}` : "-"],
    ["Least frequent 7d", overview.leastProject ? `${overview.leastProject.project.name} · ${overview.leastProject.count}` : "-"],
  ];
  for (const [label, value] of statRows) {
    const row = statsPanel.createDiv({ cls: "sr-overview-data-row" });
    row.createSpan({ text: label });
    row.createEl("strong", { text: value });
  }

  const notePanel = grid.createDiv({ cls: "sr-overview-card sr-overview-note-panel" });
  notePanel.createEl("h3", { text: "Note" });
  const noteInput = notePanel.createEl("textarea", {
    cls: "sr-overview-note-input",
    attr: { placeholder: "Write a quick note..." },
  });
  const noteActions = notePanel.createDiv({ cls: "sr-overview-note-actions" });
  const saveButton = noteActions.createEl("button", { text: "Save to Obsidian", type: "button" });
  const aiButton = noteActions.createEl("button", { text: "Send to AI", type: "button" });
  saveButton.addEventListener("click", async () => {
    try {
      const path = await saveOverviewNote(plugin, selectedDate, noteInput.value);
      noteInput.value = "";
      new Notice(`Saved note: ${path}`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Failed to save note.");
    }
  });
  const sendOverviewNoteToAi = async () => {
    if (aiButton.disabled) return;
    const originalText = aiButton.textContent || "Send to AI";
    try {
      aiButton.disabled = true;
      aiButton.setText("Thinking...");
      const answer = await askDeskPetAi(plugin, selectedDate, noteInput.value);
      container.dispatchEvent(new CustomEvent("sr-deskpet-say", {
        bubbles: true,
        detail: { text: answer },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send note to AI.";
      new Notice(message);
      container.dispatchEvent(new CustomEvent("sr-deskpet-say", {
        bubbles: true,
        detail: { text: message },
      }));
    } finally {
      aiButton.disabled = false;
      aiButton.setText(originalText);
    }
  };
  aiButton.addEventListener("click", () => {
    void sendOverviewNoteToAi();
  });
  noteInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void sendOverviewNoteToAi();
  });

  const memoryPanel = grid.createDiv({ cls: "sr-overview-card sr-memory-panel" });
  renderCiteMemoryPanel(memoryPanel, plugin);
}

function buildPixelAvatarSvg(classLabel) {
  const palette = {
    English: { outfit: "#BF616A", accent: "#EBCB8B", prop: "book" },
    Exercise: { outfit: "#D08770", accent: "#A3BE8C", prop: "dumbbell" },
    Money: { outfit: "#EBCB8B", accent: "#BF616A", prop: "coin" },
    Life: { outfit: "#A3BE8C", accent: "#88C0D0", prop: "camera" },
    Habit: { outfit: "#8FBCBB", accent: "#EBCB8B", prop: "pencil" },
    Research: { outfit: "#81A1C1", accent: "#88C0D0", prop: "flask" },
    Balanced: { outfit: "#88C0D0", accent: "#A3BE8C", prop: "spark" },
  };
  const meta = palette[classLabel] || palette.Balanced;
  const rect = (x, y, w, h, fill, cls = "") => `<rect${cls ? ` class="${cls}"` : ""} x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  const prop = (() => {
    if (meta.prop === "book") return rect(54, 58, 12, 16, meta.accent) + rect(56, 60, 8, 2, "#2E3440") + rect(56, 66, 8, 2, "#2E3440");
    if (meta.prop === "dumbbell") return rect(12, 66, 6, 12, "#4C566A") + rect(18, 70, 16, 4, "#4C566A") + rect(34, 66, 6, 12, "#4C566A");
    if (meta.prop === "coin") return rect(56, 62, 12, 12, meta.accent) + rect(60, 64, 4, 8, "#2E3440");
    if (meta.prop === "camera") return rect(54, 62, 16, 12, "#4C566A") + rect(58, 58, 8, 4, "#4C566A") + rect(60, 65, 5, 5, meta.accent);
    if (meta.prop === "pencil") return rect(56, 58, 5, 22, meta.accent) + rect(56, 56, 5, 3, "#D08770") + rect(56, 80, 5, 4, "#2E3440");
    if (meta.prop === "flask") return rect(58, 56, 8, 5, "#D8DEE9") + rect(60, 61, 4, 8, "#D8DEE9") + rect(56, 69, 12, 10, meta.accent);
    return rect(58, 58, 4, 4, meta.accent) + rect(54, 62, 12, 4, meta.accent) + rect(58, 66, 4, 12, meta.accent);
  })();
  return [
    '<svg class="sr-pixel-avatar-svg" viewBox="0 0 80 104" width="100%" height="144" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">',
    rect(22, 8, 36, 8, "#2E3440"),
    rect(18, 16, 44, 8, "#2E3440"),
    rect(18, 24, 44, 24, "#E0B89B"),
    rect(14, 28, 8, 16, "#E0B89B"),
    rect(58, 28, 8, 16, "#E0B89B"),
    rect(24, 28, 10, 4, "#2E3440"),
    rect(46, 28, 10, 4, "#2E3440"),
    rect(24, 32, 12, 8, "transparent", "sr-pixel-glasses"),
    rect(44, 32, 12, 8, "transparent", "sr-pixel-glasses"),
    rect(36, 35, 8, 3, "#2E3440"),
    rect(36, 44, 8, 3, "#BF616A"),
    rect(22, 52, 36, 10, meta.accent),
    rect(18, 62, 44, 26, meta.outfit),
    rect(26, 62, 8, 26, "rgba(255,255,255,0.28)"),
    rect(46, 62, 8, 26, "rgba(0,0,0,0.1)"),
    rect(10, 62, 10, 22, meta.outfit),
    rect(60, 62, 10, 22, meta.outfit),
    prop,
    rect(24, 88, 12, 12, "#3B4252"),
    rect(44, 88, 12, 12, "#3B4252"),
    rect(20, 100, 18, 4, "#2E3440"),
    rect(42, 100, 18, 4, "#2E3440"),
    "</svg>",
  ].join("");
}

function buildRpgRadarSvg(totalXp) {
  const width = 250;
  const height = 178;
  const cx = width / 2;
  const cy = 90;
  const radius = 48;
  const uid = `sr-radar-${Math.random().toString(36).slice(2, 8)}`;
  const max = Math.max(100, ...RPG_ATTRIBUTES.map((attribute) => Math.max(0, totalXp[attribute])));
  const pointFor = (index, value) => {
    const angle = -Math.PI / 2 + (index / RPG_ATTRIBUTES.length) * Math.PI * 2;
    const r = radius * Math.max(0, value) / max;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  };
  const outerPoint = (index, scale = 1) => {
    const angle = -Math.PI / 2 + (index / RPG_ATTRIBUTES.length) * Math.PI * 2;
    return [cx + Math.cos(angle) * radius * scale, cy + Math.sin(angle) * radius * scale];
  };
  const rings = [0.33, 0.66, 1].map((scale) => {
    const points = RPG_ATTRIBUTES.map((_, index) => outerPoint(index, scale).join(",")).join(" ");
    return `<polygon class="sr-rpg-radar-ring" points="${points}" fill="none" stroke="currentColor" stroke-opacity="${scale === 1 ? "0.22" : "0.12"}" stroke-width="${scale === 1 ? "1.2" : "1"}"/>`;
  });
  const axes = RPG_ATTRIBUTES.map((attribute, index) => {
    const [x, y] = outerPoint(index);
    const [lx, ly] = outerPoint(index, 1.55);
    const value = `Lv.${rpgLevelFromXp(totalXp[attribute]).level}`;
    const hint = `${attribute}: ${randomRpgAttributeHint(attribute)}`;
    return `<g class="sr-rpg-axis"><title>${escapeHtml(hint)}</title><line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="currentColor" stroke-opacity="0.14" stroke-width="1"/><text class="sr-rpg-axis-name" x="${lx}" y="${ly - 6}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(attribute)}</text><text class="sr-rpg-axis-level" x="${lx}" y="${ly + 7}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(value)}</text></g>`;
  });
  const dataPointsArray = RPG_ATTRIBUTES.map((attribute, index) => pointFor(index, totalXp[attribute]));
  const dataPoints = dataPointsArray.map((point) => point.join(",")).join(" ");
  const vertexDots = dataPointsArray.map(([x, y]) => `<circle class="sr-rpg-radar-dot" cx="${x}" cy="${y}" r="2.6"/>`).join("");
  const defs = [
    "<defs>",
    `<radialGradient id="${uid}-fill" cx="50%" cy="42%" r="70%">`,
    '<stop offset="0%" stop-color="#EBCB8B" stop-opacity="0.34"/>',
    '<stop offset="52%" stop-color="#88C0D0" stop-opacity="0.26"/>',
    '<stop offset="100%" stop-color="#8FBCBB" stop-opacity="0.14"/>',
    "</radialGradient>",
    `<linearGradient id="${uid}-stroke" x1="0%" y1="0%" x2="100%" y2="100%">`,
    '<stop offset="0%" stop-color="#EBCB8B"/>',
    '<stop offset="48%" stop-color="#88C0D0"/>',
    '<stop offset="100%" stop-color="#A3BE8C"/>',
    "</linearGradient>",
    `<filter id="${uid}-glow" x="-40%" y="-40%" width="180%" height="180%">`,
    '<feGaussianBlur stdDeviation="2.4" result="blur"/>',
    '<feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.53 0 0 0 0 0.75 0 0 0 0 0.82 0 0 0 0.55 0" result="glow"/>',
    '<feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>',
    "</filter>",
    "</defs>",
  ].join("");
  return `<svg class="sr-rpg-radar-svg" viewBox="0 0 ${width} ${height}" width="100%" height="178" xmlns="http://www.w3.org/2000/svg">${defs}<circle cx="${cx}" cy="${cy}" r="${radius + 10}" fill="rgba(136,192,208,0.045)"/>${rings.join("")}${axes.join("")}<polygon class="sr-rpg-radar-shape" points="${dataPoints}" fill="url(#${uid}-fill)" stroke="url(#${uid}-stroke)" stroke-width="2.2" filter="url(#${uid}-glow)"/>${vertexDots}</svg>`;
}
function renderHeatCalendar(container, repository) {
  container.createEl("h3", { text: "Heat Calendar" });
  container.createDiv({ cls: "sr-muted", text: "Recent 12 weeks activity with blended project colors." });
  const grid = container.createDiv({ cls: "sr-heatmap-grid" });
  for (const day of buildHeatDays(repository, 84)) {
    const cell = grid.createDiv({ cls: "sr-heatmap-cell" });
    const boost = Math.min(day.total * 0.08, 0.22);
    const items = day.items.map((item) => ({ ...item, color: rgba(item.color, 0.78 + boost) }));
    const background = gradientForWeights(items);
    cell.style.background = background;
    cell.style.backgroundImage = typeof background === "string" && background.startsWith("linear-gradient") ? background : "none";
    cell.style.backgroundColor = items[0]?.color || "transparent";
    cell.style.border = day.total > 0 ? "1px solid rgba(255,255,255,0.08)" : "1px solid var(--sr-border)";
    cell.setText(day.total > 0 ? String(day.total) : "");
    cell.setAttr("title", `${day.date}\n${day.items.map((item) => `${item.name}: ${item.weight}`).join("\n") || "No records"}`);
    if (day.total === 0) cell.style.color = "transparent";
  }
}

function renderProjectLines(container, pluginOrRepository) {
  const repository = pluginOrRepository?.repository || pluginOrRepository;
  const plugin = pluginOrRepository?.repository ? pluginOrRepository : null;
  const header = container.createDiv({ cls: "sr-trend-panel-header" });
  const title = header.createDiv();
  title.createEl("h3", { text: "Project Trends" });
  title.createDiv({ cls: "sr-muted", text: "Curves use recorded time only, merged by domain." });
  const expandButton = header.createEl("button", { cls: "sr-icon-button sr-trend-expand-button", attr: { "aria-label": "Expand Project Trends" } });
  setIcon(expandButton, "maximize-2");
  expandButton.setAttr("title", "Open Task Decomposition Board");
  expandButton.addEventListener("click", () => {
    if (plugin) new ProjectTimelineMatrixModal(plugin.app, plugin).open();
  });

  const chart = container.createDiv({ cls: "sr-overview-chart" });
  const pastDates = dateRange(7, todayYmd());
  const futureDates = dateRange(7, shiftDays(todayYmd(), 7));
  const dates = pastDates.concat(futureDates);
  const firstFutureIndex = pastDates.length;
  const projects = repository.listProjects().filter((project) => project.isActive && !isDailyStatusProject(project));
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const grouped = new Map();

  projects.forEach((project, index) => {
    const meta = projectDomainMeta(project, index);
    if (meta.key === "sleep") return;
    let bucket = grouped.get(meta.key);
    if (!bucket) {
      bucket = {
        meta,
        loggedMinutes: new Map(),
      };
      grouped.set(meta.key, bucket);
    }

    for (const entry of repository.listEntries(project.id)) {
      if (!dateIndex.has(entry.date)) continue;
      bucket.loggedMinutes.set(entry.date, (bucket.loggedMinutes.get(entry.date) || 0) + entryDurationMinutes(entry));
    }

  });

  const domainOrder = new Map(PROJECT_DOMAIN_META.map((item, index) => [item.key, index]));
  const groups = Array.from(grouped.values()).sort((left, right) => {
    const leftOrder = domainOrder.has(left.meta.key) ? domainOrder.get(left.meta.key) : PROJECT_DOMAIN_META.length;
    const rightOrder = domainOrder.has(right.meta.key) ? domainOrder.get(right.meta.key) : PROJECT_DOMAIN_META.length;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.meta.label.localeCompare(right.meta.label, "en-US");
  });
  const timeSeries = groups.map((group) => ({
    meta: group.meta,
    minutes: dates.map((date) => group.loggedMinutes.get(date) || 0),
    loggedMinutes: dates.map((date) => group.loggedMinutes.get(date) || 0),
  }));
  const max = Math.max(60, ...timeSeries.flatMap((item) => item.minutes));
  const width = 620;
  const height = 210;
  const leftPad = 18;
  const rightPad = 18;
  const topPad = 16;
  const bottomPad = 14;
  const innerWidth = width - leftPad - rightPad;
  const innerHeight = height - topPad - bottomPad;
  const lastIndex = Math.max(0, dates.length - 1);
  const centerX = (index) => leftPad + (index / Math.max(1, lastIndex)) * innerWidth;
  const rangeStartX = (index) => index <= 0 ? leftPad : leftPad + ((index - 0.5) / Math.max(1, lastIndex)) * innerWidth;
  const rangeEndX = (index) => index >= lastIndex ? leftPad + innerWidth : leftPad + ((index + 0.5) / Math.max(1, lastIndex)) * innerWidth;
  const svg = [
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="210" xmlns="http://www.w3.org/2000/svg">`,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="transparent"/>`,
  ];

  if (futureDates.length > 0) {
    const futureStartX = rangeStartX(firstFutureIndex);
    svg.push(`<rect x="${futureStartX}" y="${topPad}" width="${Math.max(0, leftPad + innerWidth - futureStartX)}" height="${innerHeight}" fill="rgba(255,255,255,0.03)"/>`);
  }

  for (let tick = 0; tick <= 4; tick += 1) {
    const y = topPad + innerHeight - (tick / 4) * innerHeight;
    svg.push(`<line x1="${leftPad}" y1="${y}" x2="${leftPad + innerWidth}" y2="${y}" stroke="rgba(128,128,128,0.14)" stroke-width="1"/>`);
  }

  for (const item of timeSeries) {
    if (!item.minutes.some((minutes) => minutes > 0)) continue;
    const totalMinutes = item.minutes.reduce((sum, minutes) => sum + minutes, 0);
    const points = item.minutes.map((minutes, index) => ({
      x: centerX(index),
      y: topPad + innerHeight - (minutes / max) * innerHeight,
    }));
    const path = buildSmoothHorizontalPath(points);
    svg.push(`<g><title>${escapeHtml(item.meta.label)} | Timeline ${escapeHtml(durationLabelFromMinutes(totalMinutes))}</title><path d="${path}" fill="none" stroke="${item.meta.value}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/></g>`);
  }

  if (futureDates.length > 0) {
    const dividerX = rangeStartX(firstFutureIndex);
    svg.push(`<line x1="${dividerX}" y1="${topPad}" x2="${dividerX}" y2="${topPad + innerHeight}" stroke="rgba(255,255,255,0.22)" stroke-width="1" stroke-dasharray="3 3"/>`);
    svg.push(`<text x="${Math.min(dividerX + 4, leftPad + innerWidth - 24)}" y="11" fill="rgba(255,255,255,0.55)" font-size="9" font-family="ui-monospace, SFMono-Regular, monospace">Today</text>`);
  }

  svg.push("</svg>");
  chart.innerHTML = svg.join("");

  const domainTotals = groups
    .map((group) => {
      const loggedMinutes = pastDates.reduce((sum, date) => sum + (group.loggedMinutes.get(date) || 0), 0);
      return {
        meta: group.meta,
        loggedMinutes,
        activityMinutes: loggedMinutes,
      };
    })
    .filter((item) => item.activityMinutes > 0);
  const totalLoggedMinutes = domainTotals.reduce((sum, item) => sum + item.loggedMinutes, 0);
  const leadingDomain = domainTotals.slice().sort((left, right) => right.activityMinutes - left.activityMinutes)[0] || null;
  const trendSnapshot = container.createDiv({ cls: "sr-trend-snapshot" });
  const snapshotRows = [
    ["Logged 7d", durationLabelFromMinutes(totalLoggedMinutes)],
    ["Lead", leadingDomain ? leadingDomain.meta.label : "-"],
    ["Active", String(domainTotals.length)],
    ["Records", String(repository.listEntries().filter((entry) => entry.date >= pastDates[0] && entry.date <= pastDates[pastDates.length - 1]).length)],
  ];
  for (const [label, value] of snapshotRows) {
    const card = trendSnapshot.createDiv({ cls: "sr-trend-snapshot-card" });
    card.createSpan({ text: label });
    card.createEl("strong", { text: value });
  }

  const maxDomainMinutes = Math.max(1, ...domainTotals.map((item) => item.activityMinutes));
  const domainBars = container.createDiv({ cls: "sr-trend-bars" });
  for (const item of domainTotals.sort((left, right) => right.activityMinutes - left.activityMinutes)) {
    const row = domainBars.createDiv({ cls: "sr-trend-bar-row" });
    const label = row.createDiv({ cls: "sr-trend-bar-label" });
    label.createSpan({ cls: "sr-project-dot" }).style.background = item.meta.value;
    label.createSpan({ text: item.meta.label });
    row.createSpan({ cls: "sr-trend-bar-value", text: durationLabelFromMinutes(item.activityMinutes) });
    const track = row.createDiv({ cls: "sr-trend-bar-track" });
    const fill = track.createDiv({ cls: "sr-trend-bar-fill" });
    fill.style.width = `${Math.max(4, (item.activityMinutes / maxDomainMinutes) * 100)}%`;
    fill.style.background = item.meta.value;
  }
}

function buildSmoothHorizontalPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midX = previous.x + (current.x - previous.x) / 2;
    path += ` C ${midX} ${previous.y}, ${midX} ${current.y}, ${current.x} ${current.y}`;
  }
  return path;
}
function renderProjectList(container, summaries, temporaryProjects, selectedProjectId, onSelect) {
  const list = container.createDiv({ cls: "sr-project-list" });
  const regularSummaries = summaries.filter((summary) => summary.project.type !== "temporary");
  if (regularSummaries.length === 0 && temporaryProjects.length === 0) {
    list.createDiv({ cls: "sr-empty", text: "No projects yet. Use Create Project to start." });
    return;
  }
  for (const summary of regularSummaries) {
    const card = list.createDiv({ cls: "sr-project-card" });
    card.style.setProperty("--project-color", summary.project.color);
    if (summary.project.id === selectedProjectId) card.addClass("is-active");
    if (!summary.project.isActive) card.style.opacity = "0.72";
    const title = card.createDiv({ cls: "sr-project-header" });
    const left = title.createDiv();
    const line = left.createDiv({ cls: "sr-tag-row" });
    line.createSpan({ cls: "sr-project-dot" }).style.background = summary.project.color;
    line.createEl("strong", { text: summary.project.name });
    if (!summary.project.isActive) line.createSpan({ cls: "sr-tag", text: "Archived" });
    if (summary.project.description) left.createDiv({ cls: "sr-muted", text: summary.project.description });
    const stats = card.createDiv({ cls: "sr-tag-row" });
    stats.createSpan({ cls: "sr-tag", text: projectTypeLabel(summary.project.type) });
    stats.createSpan({ cls: "sr-tag", text: `${summary.count} entries` });
    stats.createSpan({ cls: "sr-tag", text: `Last ${summary.lastDate}` });
    card.createDiv({ cls: "sr-muted", text: projectScheduleLabel(summary.project) });
    card.addEventListener("click", () => onSelect(summary.project.id));
  }
  if (temporaryProjects.length > 0) {
    const completedCount = temporaryProjects.filter((project) => project.completed).length;
    const card = list.createDiv({ cls: "sr-project-card sr-project-card-temporary" });
    if (selectedProjectId === TEMPORARY_ARCHIVE_ID) card.addClass("is-active");
    card.style.setProperty("--project-color", temporaryProjects[0].color);
    const title = card.createDiv({ cls: "sr-project-header" });
    const left = title.createDiv();
    const line = left.createDiv({ cls: "sr-tag-row" });
    line.createSpan({ cls: "sr-project-dot" }).style.background = temporaryProjects[0].color;
    line.createEl("strong", { text: "Temporary Archive" });
    left.createDiv({ cls: "sr-muted", text: "Temporary projects are grouped here." });
    const stats = card.createDiv({ cls: "sr-tag-row" });
    stats.createSpan({ cls: "sr-tag", text: `${temporaryProjects.length} items` });
    stats.createSpan({ cls: "sr-tag", text: `${completedCount} completed` });
    card.addEventListener("click", () => onSelect(TEMPORARY_ARCHIVE_ID));
  }
}

function renderTemporaryArchiveDetails(container, plugin, view) {
  container.empty();
  const temporaryProjects = plugin.repository.listProjects().filter((project, index) => project.type === "temporary" && !isSleepProject(project, index));
  const panel = container.createDiv({ cls: "sr-panel sr-project-summary" });
  panel.createEl("h2", { text: "Temporary Archive" });
  panel.createDiv({ cls: "sr-muted", text: "All temporary projects are grouped here." });
  if (temporaryProjects.length === 0) {
    panel.createDiv({ cls: "sr-empty", text: "No temporary projects yet." });
    return;
  }
  const list = container.createDiv({ cls: "sr-entry-list" });
  for (const project of temporaryProjects) {
    const card = list.createDiv({ cls: "sr-date-project-card" });
    const header = card.createDiv({ cls: "sr-project-header" });
    const title = header.createDiv({ cls: "sr-tag-row" });
    title.createSpan({ cls: "sr-project-dot" }).style.background = project.color;
    title.createEl("strong", { text: project.name });
    title.createSpan({ cls: "sr-tag", text: project.completed ? "Completed" : "Pending" });

    const actions = header.createDiv({ cls: "sr-entry-actions" });
    actions.createEl("button", { text: "Edit" }).addEventListener("click", () => {
      new ProjectModal(plugin.app, plugin, project, (saved) => {
        view.selectedProjectId = saved.type === "temporary" ? TEMPORARY_ARCHIVE_ID : saved.id;
        view.render();
      }).open();
    });
    const deleteButton = actions.createEl("button", { text: "Delete" });
    deleteButton.addClass("mod-warning");
    deleteButton.addEventListener("click", async () => {
      if (!confirm(`Delete project "${project.name}" and all its records?`)) return;
      await plugin.repository.deleteProjectAndPersist(project.id);
      const remainingProjects = plugin.repository.listProjects().filter((item, index) => !isSleepProject(item, index));
      view.selectedProjectId = remainingProjects.some((item) => item.type === "temporary")
        ? TEMPORARY_ARCHIVE_ID
        : remainingProjects.find((item) => item.type !== "temporary")?.id || null;
      view.render();
    });

    if (project.description) card.createDiv({ cls: "sr-muted", text: project.description });
    card.createDiv({ text: projectScheduleLabel(project) });
  }
}
function renderProjectDetails(container, plugin, project, view) {
  container.empty();
  if (!project) {
    container.createDiv({ cls: "sr-empty", text: "Select a project to review its records." });
    return;
  }
  const repository = plugin.repository;
  const summary = summarizeProject(repository, project);

  const panel = container.createDiv({ cls: "sr-panel sr-project-summary" });
  panel.style.setProperty("--project-color", project.color);
  const header = panel.createDiv({ cls: "sr-project-header" });
  const left = header.createDiv();
  const titleRow = left.createDiv({ cls: "sr-tag-row" });
  titleRow.createSpan({ cls: "sr-project-dot" }).style.background = project.color;
  titleRow.createEl("h2", { text: project.name });
  if (project.description) left.createDiv({ cls: "sr-muted", text: project.description });
  left.createDiv({ cls: "sr-muted", text: projectScheduleLabel(project) });

  const actions = header.createDiv({ cls: "sr-entry-actions" });
  actions.createEl("button", { text: "New Entry" }).addEventListener("click", () => {
    new EntryModal(plugin.app, plugin, project, null, () => view.render()).open();
  });
  actions.createEl("button", { text: "Edit Project" }).addEventListener("click", () => {
    new ProjectModal(plugin.app, plugin, project, (saved) => {
      view.selectedProjectId = saved.type === "temporary" ? TEMPORARY_ARCHIVE_ID : saved.id;
      view.selectedDate = projectStartDate(saved) || view.selectedDate;
      view.currentMonthKey = monthKeyFromDate(view.selectedDate);
      view.render();
    }).open();
  });
  actions.createEl("button", { text: project.isActive ? "Archive" : "Activate" }).addEventListener("click", async () => {
    await repository.setProjectArchivedAndPersist(project.id, !project.isActive);
    view.render();
  });
  const deleteButton = actions.createEl("button", { text: "Delete Project" });
  deleteButton.addClass("mod-warning");
  deleteButton.addEventListener("click", async () => {
    if (!confirm(`Delete project \"${project.name}\" and all its records?`)) return;
    await repository.deleteProjectAndPersist(project.id);
    view.selectedProjectId = repository.listProjects()[0]?.id || null;
    view.render();
  });

  const statGrid = panel.createDiv({ cls: "sr-stat-grid" });
  const statRows = [
    ["Type", projectTypeLabel(project.type)],
    ["Entries", String(summary.count)],
    ["Active Days", String(summary.activeDays)],
    ["Last Record", summary.lastDate],
    ["Fields", String(project.fields.length)],
  ];
  for (const [label, value] of statRows) {
    const card = statGrid.createDiv({ cls: "sr-stat-card" });
    card.createDiv({ cls: "sr-muted", text: label });
    card.createEl("strong", { text: value });
  }

  renderSelectedProjectChart(container.createDiv({ cls: "sr-panel" }), summary, project.color);
  renderRecentEntries(container.createDiv({ cls: "sr-panel" }), plugin, project, view);
}
function renderSelectedProjectChart(container, summary, color) {
  container.createEl("h3", { text: "Recent Trend" });
  container.createDiv({ cls: "sr-muted", text: "Daily record counts for the past 7 days." });
  const chart = container.createDiv({ cls: "sr-overview-chart" });
  const dates = dateRange(7, todayYmd());
  const counts = dates.map((date) => summary.entries.filter((entry) => entry.date === date).length);
  const max = Math.max(1, ...counts);
  const width = 680;
  const height = 190;
  const leftPad = 18;
  const bottomPad = 16;
  const innerWidth = width - leftPad * 2;
  const innerHeight = height - bottomPad - 8;
  const points = counts.map((count, index) => {
    const x = leftPad + (index / Math.max(1, dates.length - 1)) * innerWidth;
    const y = 8 + innerHeight - (count / max) * innerHeight;
    return `${x},${y}`;
  }).join(" ");
  chart.innerHTML = [
    `<svg viewBox=\"0 0 ${width} ${height}\" width=\"100%\" height=\"170\" xmlns=\"http://www.w3.org/2000/svg\">`,
    `<polyline fill=\"none\" stroke=\"${color}\" stroke-width=\"3\" stroke-linejoin=\"round\" stroke-linecap=\"round\" points=\"${points}\"/>`,
    "</svg>",
  ].join("");
}

function renderRecentEntries(container, plugin, project, view) {
  container.createEl("h3", { text: "Recent Entries" });
  const list = container.createDiv({ cls: "sr-entry-list" });
  const entries = plugin.repository.listEntries(project.id).slice(0, 20);
  if (entries.length === 0) {
    list.createDiv({ cls: "sr-empty", text: "No records yet. Use New Entry from the toolbar." });
    return;
  }
  for (const entry of entries) {
    const row = list.createDiv({ cls: "sr-entry-row" });
    const head = row.createDiv({ cls: "sr-entry-head" });
    head.createEl("strong", { text: entryTimeLabel(entry) });
    const actions = head.createDiv({ cls: "sr-entry-actions" });
    actions.createEl("button", { text: "Edit" }).addEventListener("click", () => {
      new EntryModal(plugin.app, plugin, project, entry, () => view.render()).open();
    });
    const deleteButton = actions.createEl("button", { text: "Delete" });
    deleteButton.addClass("mod-warning");
    deleteButton.addEventListener("click", async () => {
      if (!confirm(`Delete entry from ${entryTimeLabel(entry)}?`)) return;
      await plugin.repository.deleteEntryAndPersist(entry.id);
      view.render();
    });
    const values = row.createDiv({ cls: "sr-tag-row" });
    for (const field of project.fields) {
      renderFieldValue(values, field, entry.values[field.id], plugin.app);
    }
  }
}

function collectFieldDefinitions(container) {
  return Array.from(container.querySelectorAll(".sr-field-editor-row")).map((row, index) => ({
    id: row.getAttribute("data-field-id") || id("field"),
    name: row.querySelector(".sr-field-name")?.value || "",
    type: row.querySelector(".sr-field-type")?.value || "text",
    required: Boolean(row.querySelector(".sr-field-required")?.checked),
    options: "",
    sortOrder: index,
  }));
}

function renderTimeRangeSlider(container, startInput, endInput, fallbackDate = todayYmd(), options = {}) {
  const min = (options.startHour ?? DAILY_REVIEW_START_HOUR) * 60;
  const max = (options.endHour ?? DAILY_REVIEW_END_HOUR) * 60;
  const step = 15;
  const wrap = container.createDiv({ cls: "sr-time-slider" });
  const ticks = wrap.createDiv({ cls: "sr-time-slider-ticks" });
  for (let hour = min / 60; hour <= max / 60; hour += 1) {
    ticks.createSpan({ text: String(hour).padStart(2, "0") });
  }

  const range = wrap.createDiv({ cls: "sr-time-slider-range" });
  const selected = range.createDiv({ cls: "sr-time-slider-selected" });
  const startRange = range.createEl("input", { type: "range" });
  const endRange = range.createEl("input", { type: "range" });
  for (const input of [startRange, endRange]) {
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
  }
  const label = wrap.createDiv({ cls: "sr-time-slider-label" });
  let syncing = false;

  const updateVisual = () => {
    const start = Number(startRange.value);
    const end = Number(endRange.value);
    const left = ((start - min) / (max - min)) * 100;
    const right = ((end - min) / (max - min)) * 100;
    selected.style.left = `${left}%`;
    selected.style.width = `${Math.max(0, right - left)}%`;
    label.setText(`${clockLabelFromMinutes(start)}-${clockLabelFromMinutes(end)} · ${durationLabelFromMinutes(end - start)}`);
  };

  const syncSliderFromInputs = () => {
    if (syncing) return;
    syncing = true;
    let start = Math.max(min, Math.min(max - step, minutesFromDateTimeInput(startInput, 9 * 60)));
    let end = Math.max(min + step, Math.min(max, minutesFromDateTimeInput(endInput, start + 60)));
    if (end <= start) end = Math.min(max, start + 60);
    if (end <= start) start = Math.max(min, end - step);
    startRange.value = String(start);
    endRange.value = String(end);
    updateVisual();
    syncing = false;
  };

  const syncInputsFromSlider = (active) => {
    if (syncing) return;
    syncing = true;
    let start = Number(startRange.value);
    let end = Number(endRange.value);
    if (active === "start" && start >= end) start = Math.max(min, end - step);
    if (active === "end" && end <= start) end = Math.min(max, start + step);
    startRange.value = String(start);
    endRange.value = String(end);
    const date = dateForQuickTime(startInput, fallbackDate);
    startInput.value = dateTimeFromMinutes(date, start);
    endInput.value = dateTimeFromMinutes(date, end);
    updateVisual();
    syncing = false;
  };

  startRange.addEventListener("input", () => syncInputsFromSlider("start"));
  endRange.addEventListener("input", () => syncInputsFromSlider("end"));
  startInput.addEventListener("input", syncSliderFromInputs);
  endInput.addEventListener("input", syncSliderFromInputs);
  startInput.addEventListener("change", syncSliderFromInputs);
  endInput.addEventListener("change", syncSliderFromInputs);
  syncSliderFromInputs();
  return syncSliderFromInputs;
}

function renderDateTimeQuickControls(container, startInput, endInput, fallbackDate = todayYmd()) {
  return renderTimeRangeSlider(container, startInput, endInput, fallbackDate);
}

function projectMatrixStartDate(project, fallback = todayYmd()) {
  return String(project?.startDate || projectStartDate(project) || fallback).slice(0, 10);
}

function projectMatrixEndDate(project, fallback = todayYmd()) {
  return String(project?.endDate || project?.plannedEndDate || projectEndDate(project) || fallback).slice(0, 10);
}

function projectTypeClass(type) {
  return normalizeProjectType(type).replace(/[^a-z0-9]+/g, "-");
}

function buildProjectDateBuckets(repository, project, rangeStart, rangeEnd) {
  const buckets = new Map();
  for (const entry of repository.listEntries(project.id)) {
    if (entry.date < rangeStart || entry.date > rangeEnd) continue;
    const bucket = buckets.get(entry.date) || { date: entry.date, minutes: 0, count: 0, entries: [] };
    bucket.minutes += entryDurationMinutes(entry);
    bucket.count += 1;
    bucket.entries.push(entry);
    buckets.set(entry.date, bucket);
  }
  return buckets;
}

function pulseEntryDetailLines(project, entries) {
  return entries.map((entry) => {
    const range = clampEntryToDate(entry, entry.date);
    const time = range
      ? `${clockLabelFromMinutes(range.startMinutes)}-${clockLabelFromMinutes(range.endMinutes)}`
      : entryTimeLabel(entry);
    const values = project.fields
      .map((field) => {
        const value = entry.values[field.id];
        if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return "";
        return `${field.name}: ${Array.isArray(value) ? value.join(", ") : String(value)}`;
      })
      .filter(Boolean)
      .join(" · ");
    return {
      time,
      duration: durationLabelFromMinutes(entryDurationMinutes(entry)),
      values,
    };
  });
}

function projectHasMatrixPresence(repository, project, rangeStart, rangeEnd) {
  return repository.listEntries(project.id).some((entry) => entry.date >= rangeStart && entry.date <= rangeEnd);
}

function signedDaysBetween(startDate, endDate) {
  const start = parseDateInput(startDate);
  const end = parseDateInput(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function matrixRangeForMode(mode, repository, offsetDays = 0) {
  const center = shiftDays(todayYmd(), Number(offsetDays) || 0);
  return { start: shiftDays(center, -7), end: shiftDays(center, 7) };
}

function clampPulseModuleDateRange(dates, startIndex, spanDays = 3) {
  const dayCount = Math.max(1, dates.length);
  const start = Math.max(0, Math.min(dayCount - 1, startIndex));
  const end = Math.max(start, Math.min(dayCount - 1, start + Math.max(1, spanDays) - 1));
  return { startDate: dates[start], endDate: dates[end], startIndex: start, endIndex: end };
}

function snapPulseModulePointer(stage, clientX, clientY) {
  const context = stage?._pulseDropContext;
  if (!context || !context.dropTargets?.length) return null;
  const rect = stage.getBoundingClientRect();
  const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  if (!inside) return { inside: false };

  const relativeX = clientX - rect.left - (context.motionOffset || 0);
  const relativeY = clientY - rect.top;
  const slotIndex = Math.round((relativeX - context.leftPad - context.dayWidth / 2) / context.dayWidth);
  const dateIndex = Math.max(0, Math.min(context.dates.length - 1, slotIndex));
  let target = null;
  let distance = Infinity;
  for (const candidate of context.dropTargets) {
    const nextDistance = Math.abs(relativeY - candidate.y);
    if (nextDistance < distance) {
      distance = nextDistance;
      target = candidate;
    }
  }
  if (!target || distance > context.laneSnapRadius) return { inside: true, snapped: false };

  const range = clampPulseModuleDateRange(context.dates, dateIndex, 3);
  return {
    inside: true,
    snapped: true,
    projectId: target.projectId,
    projectName: target.projectName,
    color: target.color,
    startDate: range.startDate,
    endDate: range.endDate,
    x: context.leftPad + range.startIndex * context.dayWidth + 5,
    y: target.y - 14,
    width: Math.max(44, (range.endIndex - range.startIndex + 1) * context.dayWidth - 10),
    height: 28,
  };
}

function pulseDateIndexFromClientX(stage, clientX) {
  const context = stage?._pulseDropContext;
  if (!context) return 0;
  const rect = stage.getBoundingClientRect();
  const relativeX = clientX - rect.left - (context.motionOffset || 0);
  return Math.max(0, Math.min(
    context.dates.length - 1,
    Math.floor((relativeX - context.leftPad) / context.dayWidth)
  ));
}

function updatePulseContinuousMotion(stage, offset = 0) {
  const context = stage?._pulseDropContext;
  if (!context) return;
  const clamp01 = (value) => Math.max(0, Math.min(1, value));
  const smoothstep = (value) => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
  };
  const edgeVisibility = (progress) => Math.pow(1 - smoothstep(progress), 1.22);
  context.motionOffset = offset;
  stage.style.setProperty("--pulse-motion-x", `${offset}px`);
  const leftEdge = context.leftPad;
  const rightEdge = context.stageWidth - context.rightPad;
  const leftEnd = 16;
  const rightEnd = context.stageWidth - 16;

  for (const node of stage.querySelectorAll(".sr-pulse-long-node[data-pulse-base-x]")) {
    const baseX = Number(node.dataset.pulseBaseX);
    const laneY = Number(node.dataset.pulseLaneY);
    const compressedY = Number(node.dataset.pulseCompressedY);
    const rawX = baseX + offset;
    let x = rawX;
    let y = laneY;
    let opacity = 1;
    let scale = 1;
    if (rawX < leftEdge) {
      const progress = Math.max(0, Math.min(1, (leftEdge - rawX) / Math.max(1, leftEdge - leftEnd)));
      const eased = smoothstep(progress);
      x = leftEdge + (leftEnd - leftEdge) * eased;
      y = laneY + (compressedY - laneY) * eased;
      opacity = edgeVisibility(progress);
      scale = 0.58 + opacity * 0.42;
    } else if (rawX > rightEdge) {
      const progress = Math.max(0, Math.min(1, (rawX - rightEdge) / Math.max(1, rightEnd - rightEdge)));
      const eased = smoothstep(progress);
      x = rightEdge + (rightEnd - rightEdge) * eased;
      y = laneY + (compressedY - laneY) * eased;
      opacity = edgeVisibility(progress);
      scale = 0.58 + opacity * 0.42;
    }
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.opacity = String(Math.max(0, opacity));
    node.style.setProperty("--pulse-node-scale", String(scale));
    node.style.pointerEvents = opacity > 0.12 ? "auto" : "none";
  }
  for (const plan of stage.querySelectorAll(".sr-pulse-module-block[data-pulse-base-left]")) {
    const baseLeft = Number(plan.dataset.pulseBaseLeft);
    const width = Number(plan.dataset.pulseWidth);
    const laneY = Number(plan.dataset.pulseLaneY);
    const compressedY = Number(plan.dataset.pulseCompressedY);
    const planLeft = baseLeft + offset;
    const planRight = planLeft + width;
    const baseOpacity = plan.classList.contains("is-done") ? 0.72 : 1;
    const leftProgress = clamp01((leftEdge - planLeft) / Math.max(1, width + leftEdge - leftEnd));
    const rightProgress = clamp01((planRight - rightEdge) / Math.max(1, width + rightEnd - rightEdge));
    const progress = Math.max(leftProgress, rightProgress);
    const eased = smoothstep(progress);
    const visibility = edgeVisibility(progress);
    const opacity = baseOpacity * visibility;
    const edgeY = (compressedY - laneY) * eased * 0.72;
    plan.style.setProperty("--pulse-plan-edge-y", `${edgeY}px`);
    plan.style.setProperty("--pulse-plan-scale-x", String(1 - eased * 0.34));
    plan.style.setProperty("--pulse-plan-scale-y", String(1 - eased * 0.1));
    plan.style.transformOrigin = leftProgress > rightProgress ? "right center" : rightProgress > 0 ? "left center" : "center";
    plan.style.opacity = String(Math.max(0, opacity));
    plan.style.pointerEvents = opacity > 0.12 ? "auto" : "none";
  }
  for (const element of stage.querySelectorAll("[data-pulse-presence-min-x]")) {
    const minX = Number(element.dataset.pulsePresenceMinX) + offset;
    const maxX = Number(element.dataset.pulsePresenceMaxX) + offset;
    const baseOpacity = Number(element.dataset.pulseBaseOpacity || 1);
    let factor = 1;
    if (maxX < leftEdge) factor = edgeVisibility((leftEdge - maxX) / Math.max(1, leftEdge - leftEnd));
    if (minX > rightEdge) factor = edgeVisibility((minX - rightEdge) / Math.max(1, rightEnd - rightEdge));
    element.style.opacity = String(baseOpacity * factor);
  }
}

function attachPulseModulePointerDrag(item, plugin, body, rerender) {
  item.draggable = false;
  let suppressClick = false;

  item.addEventListener("click", (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  }, true);

  item.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let latestPoint = null;
    let frame = 0;
    let ghost = null;
    let lastSnapped = null;

    const currentStage = () => body.querySelector(".sr-pulse-stage");
    const currentOverlay = () => currentStage()?.querySelector(".sr-pulse-stage-overlays");

    const ensurePreview = (snapped) => {
      const overlay = currentOverlay();
      if (!overlay) return null;
      if (!ghost || ghost.parentElement !== overlay) {
        ghost?.remove();
        ghost = overlay.createDiv({ cls: "sr-pulse-module-ghost" });
        ghost.createSpan({ cls: "sr-pulse-module-ghost-name", text: "New Plan" });
        ghost.createSpan({ cls: "sr-pulse-module-ghost-date" });
      }
      ghost.style.setProperty("--project-color", snapped.color);
      return ghost;
    };

    const hidePreview = () => {
      lastSnapped = null;
      currentStage()?.removeClass("is-module-drop-target");
      ghost?.removeClass("is-visible");
      ghost?.removeClass("is-snapped");
    };

    const removePreview = () => {
      ghost?.remove();
      ghost = null;
      currentStage()?.removeClass("is-module-drop-target");
    };

    const updatePreview = () => {
      frame = 0;
      if (!latestPoint) return;
      const stage = currentStage();
      const snapped = snapPulseModulePointer(stage, latestPoint.x, latestPoint.y);
      if (!snapped?.inside || !snapped.snapped) {
        hidePreview();
        return;
      }
      lastSnapped = snapped;
      const preview = ensurePreview(snapped);
      if (!preview) return;
      stage.addClass("is-module-drop-target");
      preview.style.width = `${snapped.width}px`;
      preview.style.height = `${snapped.height}px`;
      preview.style.transform = `translate(${snapped.x}px, ${snapped.y}px)`;
      preview.querySelector(".sr-pulse-module-ghost-date")?.setText(`${snapped.projectName} · ${snapped.startDate.slice(5)}-${snapped.endDate.slice(5)}`);
      preview.addClass("is-visible");
      preview.addClass("is-snapped");
    };

    const schedulePreview = (point) => {
      latestPoint = point;
      if (!frame) frame = requestAnimationFrame(updatePreview);
    };

    const onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!dragging && Math.hypot(deltaX, deltaY) < 4) return;
      if (!dragging) {
        dragging = true;
        item.addClass("is-dragging");
        item.setPointerCapture?.(event.pointerId);
      }
      moveEvent.preventDefault();
      schedulePreview({ x: moveEvent.clientX, y: moveEvent.clientY });
    };

    const cleanup = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      item.removeClass("is-dragging");
      removePreview();
    };

    const onPointerUp = async (upEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      const snapped = lastSnapped;
      const shouldCreate = dragging && snapped?.inside && snapped.snapped;
      cleanup();
      if (!dragging) return;
      suppressClick = true;
      upEvent.preventDefault();
      if (!shouldCreate) return;
      try {
        await plugin.repository.createTimelineModuleAndPersist({
          projectId: snapped.projectId,
          name: `Plan ${snapped.startDate.slice(5)}`,
          startDate: snapped.startDate,
          endDate: snapped.endDate,
        });
        rerender?.();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Failed to create plan.");
      }
    };

    const onPointerCancel = (cancelEvent) => {
      if (cancelEvent.pointerId !== event.pointerId) return;
      cleanup();
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
  });
}

function attachPulseModuleResize(block, handle, plugin, module, side, rerender) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.stopPropagation();
    const stage = block.closest(".sr-pulse-stage");
    const context = stage?._pulseDropContext;
    if (!stage || !context) return;

    let startIndex = Math.max(0, Math.min(context.dates.length - 1, daysBetweenExclusive(context.rangeStart, module.startDate)));
    let endIndex = Math.max(startIndex, Math.min(context.dates.length - 1, daysBetweenExclusive(context.rangeStart, module.endDate)));
    let dragging = false;
    let latestX = event.clientX;
    let frame = 0;

    const applyPreview = () => {
      frame = 0;
      const index = pulseDateIndexFromClientX(stage, latestX);
      if (side === "left") startIndex = Math.min(index, endIndex);
      else endIndex = Math.max(index, startIndex);
      block.style.left = `${context.leftPad + startIndex * context.dayWidth + 5}px`;
      block.style.width = `${Math.max(36, (endIndex - startIndex + 1) * context.dayWidth - 10)}px`;
      block.querySelector(".sr-pulse-module-range")?.setText(`${context.dates[startIndex].slice(5)}-${context.dates[endIndex].slice(5)}`);
    };

    const schedulePreview = (x) => {
      latestX = x;
      if (!frame) frame = requestAnimationFrame(applyPreview);
    };

    const onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      if (!dragging && Math.abs(moveEvent.clientX - event.clientX) < 3) return;
      if (!dragging) {
        dragging = true;
        block.dataset.suppressClick = "true";
        block.addClass("is-resizing");
        handle.setPointerCapture?.(event.pointerId);
      }
      moveEvent.preventDefault();
      schedulePreview(moveEvent.clientX);
    };

    const cleanup = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      block.removeClass("is-resizing");
    };

    const onPointerUp = async (upEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      cleanup();
      if (!dragging) return;
      upEvent.preventDefault();
      try {
        await plugin.repository.updateTimelineModuleAndPersist(module.id, {
          ...module,
          startDate: context.dates[startIndex],
          endDate: context.dates[endIndex],
        });
        rerender?.();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Failed to resize plan.");
      }
    };

    const onPointerCancel = (cancelEvent) => {
      if (cancelEvent.pointerId !== event.pointerId) return;
      cleanup();
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
  });
}

function attachPulseModuleMove(block, plugin, module, rerender) {
  block.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    if (event.target.closest(".sr-pulse-module-handle, .sr-pulse-module-name-input")) return;
    const stage = block.closest(".sr-pulse-stage");
    const context = stage?._pulseDropContext;
    if (!stage || !context) return;

    const durationDays = Math.max(1, Math.min(
      context.dates.length,
      daysBetweenExclusive(module.startDate, module.endDate) + 1
    ));
    const maxStartIndex = Math.max(0, context.dates.length - durationDays);
    const initialStartIndex = Math.max(0, Math.min(maxStartIndex, daysBetweenExclusive(context.rangeStart, module.startDate)));
    const initialTarget = context.dropTargets.find((target) => target.projectId === module.projectId) || context.dropTargets[0];
    let startIndex = initialStartIndex;
    let target = initialTarget;
    let dragging = false;
    let latestX = event.clientX;
    let latestY = event.clientY;
    let frame = 0;

    const applyPreview = () => {
      frame = 0;
      const deltaDays = Math.round((latestX - event.clientX) / context.dayWidth);
      startIndex = Math.max(0, Math.min(maxStartIndex, initialStartIndex + deltaDays));
      const endIndex = startIndex + durationDays - 1;
      const stageRect = stage.getBoundingClientRect();
      const relativeY = latestY - stageRect.top;
      target = context.dropTargets.reduce((nearest, candidate) => (
        !nearest || Math.abs(relativeY - candidate.y) < Math.abs(relativeY - nearest.y) ? candidate : nearest
      ), target);
      block.style.left = `${context.leftPad + startIndex * context.dayWidth + 5}px`;
      block.style.top = `${target.y - 13}px`;
      block.style.setProperty("--project-color", target.color);
      block.querySelector(".sr-pulse-module-range")?.setText(`${context.dates[startIndex].slice(5)}-${context.dates[endIndex].slice(5)}`);
    };

    const onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      if (!dragging && Math.hypot(moveEvent.clientX - event.clientX, moveEvent.clientY - event.clientY) < 4) return;
      if (!dragging) {
        dragging = true;
        block.dataset.suppressClick = "true";
        block.addClass("is-moving");
        block.setPointerCapture?.(event.pointerId);
      }
      moveEvent.preventDefault();
      latestX = moveEvent.clientX;
      latestY = moveEvent.clientY;
      if (!frame) frame = requestAnimationFrame(applyPreview);
    };

    const cleanup = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      block.removeClass("is-moving");
    };

    const onPointerUp = async (upEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      cleanup();
      if (!dragging) return;
      upEvent.preventDefault();
      const endIndex = startIndex + durationDays - 1;
      try {
        await plugin.repository.updateTimelineModuleAndPersist(module.id, {
          ...module,
          projectId: target.projectId,
          startDate: context.dates[startIndex],
          endDate: context.dates[endIndex],
        });
        rerender?.();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Failed to move plan.");
      }
    };

    const onPointerCancel = (cancelEvent) => {
      if (cancelEvent.pointerId !== event.pointerId) return;
      cleanup();
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
  });
}

function openPulseModuleRename(block, plugin, module, rerender) {
  if (block.querySelector(".sr-pulse-module-name-input")) return;
  const nameEl = block.querySelector(".sr-pulse-module-name");
  if (!nameEl) return;
  const input = document.createElement("input");
  input.className = "sr-pulse-module-name-input";
  input.type = "text";
  input.value = module.name;
  input.setAttribute("aria-label", "Plan name");
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let saved = false;
  const save = async () => {
    if (saved) return;
    saved = true;
    const name = input.value.trim();
    if (!name || name === module.name) {
      rerender?.();
      return;
    }
    try {
      await plugin.repository.updateTimelineModuleAndPersist(module.id, { ...module, name });
      rerender?.();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Failed to rename plan.");
      rerender?.();
    }
  };

  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("dblclick", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      rerender?.();
    }
  });
  input.addEventListener("blur", () => void save());
}

function renderProjectTimelineMatrix(container, plugin, state) {
  const repository = plugin.repository;
  container.empty();
  const range = matrixRangeForMode(state.rangeMode, repository, state.rangeOffsetDays);
  const dates = dateRangeInclusive(range.start, range.end);
  const bufferedRange = { start: shiftDays(range.start, -2), end: shiftDays(range.end, 2) };
  const bufferedDates = dateRangeInclusive(bufferedRange.start, bufferedRange.end);
  const dayCount = Math.max(1, dates.length);
  const measuredWidth = Math.floor(container.getBoundingClientRect().width || container.clientWidth || 0);
  const fallbackWidth = Math.floor(Math.min(1720, window.innerWidth * 0.88));
  const stageWidth = Math.max(360, measuredWidth > 40 ? measuredWidth - 4 : fallbackWidth);
  const edgePad = Math.max(44, Math.min(76, stageWidth * 0.05));
  const leftPad = edgePad;
  const rightPad = edgePad;
  const dayWidth = (stageWidth - leftPad - rightPad) / dayCount;
  const dateLabel = (date) => {
    return parseDateInput(date).toLocaleDateString("en-US", { month: "short", day: "2-digit" }).replace(" ", ".");
  };
  const shortProjects = repository
    .listProjects()
    .filter((project, index) => project.isActive && !project.completed && normalizeProjectType(project.type) === "short-term" && !isSleepProject(project, index))
    .filter((project) => projectHasMatrixPresence(repository, project, bufferedRange.start, bufferedRange.end))
    .sort((left, right) => projectMatrixStartDate(left, range.start).localeCompare(projectMatrixStartDate(right, range.start)) || left.name.localeCompare(right.name, "en-US"));
  const longProjects = repository
    .listProjects()
    .filter((project, index) => project.isActive && normalizeProjectType(project.type) === "long-term" && !isDailyStatusProject(project) && !isSleepProject(project, index))
    .filter((project) => projectHasMatrixPresence(repository, project, bufferedRange.start, bufferedRange.end))
    .sort((left, right) => left.name.localeCompare(right.name, "en-US"));
  const projects = [...shortProjects, ...longProjects];

  if (projects.length === 0) {
    container.createDiv({ cls: "sr-empty", text: "No active short-term or long-term projects." });
    return;
  }

  const viewportStageLimit = Math.max(220, Math.min(430, window.innerHeight - 210));
  const stageHeight = Math.max(220, Math.min(viewportStageLimit, projects.length * 42 + 104));
  const topPad = stageHeight < 300 ? 52 : 58;
  const bottomPad = stageHeight < 300 ? 28 : 34;
  const usableHeight = Math.max(80, stageHeight - topPad - bottomPad);
  const centerY = topPad + usableHeight / 2;
  const laneGap = projects.length <= 1 ? 0 : Math.min(42, usableHeight / (projects.length - 1));
  const firstY = projects.length <= 1 ? centerY : centerY - laneGap * (projects.length - 1) / 2;
  const xForDate = (date) => leftPad + (signedDaysBetween(range.start, date) + 0.5) * dayWidth;
  const xForDateEdge = (date) => leftPad + signedDaysBetween(range.start, date) * dayWidth;
  const yForLane = (index) => firstY + laneGap * index;
  const compressedY = (y) => centerY + (y - centerY) * 0.28;
  const pathForLane = (y) => {
    const startY = compressedY(y);
    const endY = compressedY(y);
    const rangeLeft = leftPad;
    const rangeRight = stageWidth - rightPad;
    return `M 16 ${startY} C ${leftPad * 0.44} ${startY}, ${leftPad * 0.62} ${y}, ${rangeLeft} ${y} L ${rangeRight} ${y} C ${stageWidth - leftPad * 0.62} ${y}, ${stageWidth - leftPad * 0.44} ${endY}, ${stageWidth - 16} ${endY}`;
  };

  const stage = container.createDiv({ cls: "sr-pulse-stage" });
  stage.style.width = `${stageWidth}px`;
  stage.style.height = `${stageHeight}px`;
  stage.style.setProperty("--stage-width", `${stageWidth}px`);
  stage.style.setProperty("--stage-height", `${stageHeight}px`);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("sr-pulse-stage-svg");
  svg.setAttribute("viewBox", `0 0 ${stageWidth} ${stageHeight}`);
  svg.setAttribute("width", String(stageWidth));
  svg.setAttribute("height", String(stageHeight));
  stage.appendChild(svg);

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);

  const dateMotionGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  dateMotionGroup.setAttribute("class", "sr-pulse-date-motion");
  svg.appendChild(dateMotionGroup);
  for (const date of bufferedDates) {
    const index = signedDaysBetween(range.start, date);
    const x = xForDate(date);
    const guide = document.createElementNS("http://www.w3.org/2000/svg", "line");
    guide.setAttribute("x1", String(x));
    guide.setAttribute("x2", String(x));
    guide.setAttribute("y1", "58");
    guide.setAttribute("y2", String(stageHeight - 38));
    guide.setAttribute("class", date === todayYmd() ? "sr-pulse-guide is-today" : "sr-pulse-guide");
    dateMotionGroup.appendChild(guide);

    if (dayWidth >= 48 || Math.abs(index) % 2 === 0 || date === todayYmd()) {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(x));
      text.setAttribute("y", "38");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "sr-pulse-date-label");
      text.textContent = dayWidth < 58 ? date.slice(5).replace("-", "/") : dateLabel(date);
      dateMotionGroup.appendChild(text);
    }
  }

  const overlays = stage.createDiv({ cls: "sr-pulse-stage-overlays" });
  overlays.style.width = `${stageWidth}px`;
  overlays.style.height = `${stageHeight}px`;
  const dropTargets = [];
  const nodeHover = overlays.createDiv({ cls: "sr-pulse-node-hover" });
  stage._pulseDropContext = {
    rangeStart: range.start,
    dates,
    dayWidth,
    leftPad,
    rightPad,
    stageWidth,
    dropTargets,
    laneSnapRadius: 28,
    motionOffset: Number(state.motionOffset) || 0,
  };

  projects.forEach((project, projectIndex) => {
    const y = yForLane(projectIndex);
    const type = normalizeProjectType(project.type);
    const buckets = buildProjectDateBuckets(repository, project, bufferedRange.start, bufferedRange.end);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathForLane(y));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", project.color);
    path.setAttribute("stroke-width", type === "long-term" ? "3" : "4");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("opacity", type === "long-term" ? "0.56" : "0.42");
    path.setAttribute("class", `sr-pulse-track-path is-${projectTypeClass(project.type)}`);
    svg.appendChild(path);
    const bucketDates = [...buckets.keys()].sort();
    const presenceMinX = bucketDates.length ? xForDate(bucketDates[0]) : leftPad;
    const presenceMaxX = bucketDates.length ? xForDate(bucketDates[bucketDates.length - 1]) : leftPad;
    path.dataset.pulsePresenceMinX = String(presenceMinX);
    path.dataset.pulsePresenceMaxX = String(presenceMaxX);
    path.dataset.pulseBaseOpacity = type === "long-term" ? "0.56" : "0.42";

    dropTargets.push({ projectId: project.id, projectName: project.name, color: project.color, y });
    const slot = overlays.createDiv({ cls: "sr-pulse-short-slot" });
    slot.style.left = `${leftPad}px`;
      slot.style.top = `${y - 16}px`;
      slot.style.width = `${dayCount * dayWidth}px`;
      slot.style.height = "32px";
    slot.style.setProperty("--project-color", project.color);
    slot.dataset.pulsePresenceMinX = String(presenceMinX);
    slot.dataset.pulsePresenceMaxX = String(presenceMaxX);
    slot.dataset.pulseBaseOpacity = "0.58";
    slot.setAttr("title", `${project.name}\nDrop plan here`);
    slot.createSpan({ cls: "sr-pulse-slot-label", text: project.name });
    const slotCells = slot.createDiv({ cls: "sr-pulse-slot-cells" });
    slotCells.style.setProperty("--day-count", String(dayCount));
    for (const date of dates) {
      slotCells.createSpan({ cls: date === todayYmd() ? "is-today" : "" });
    }

    const modules = repository.listTimelineModules(project.id).filter((module) => module.startDate <= bufferedRange.end && module.endDate >= bufferedRange.start);
    const renderModuleBlock = (module) => {
      const visibleStart = module.startDate < bufferedRange.start ? bufferedRange.start : module.startDate;
      const visibleEnd = module.endDate > bufferedRange.end ? bufferedRange.end : module.endDate;
      const startIndex = signedDaysBetween(range.start, visibleStart);
      const endIndex = Math.max(startIndex, signedDaysBetween(range.start, visibleEnd));
      const blockLeft = leftPad + startIndex * dayWidth + 5;
      const blockWidth = Math.max(36, (endIndex - startIndex + 1) * dayWidth - 10);
      const block = overlays.createDiv({ cls: module.done ? "sr-pulse-module-block is-done" : "sr-pulse-module-block" });
      block.style.left = `${blockLeft}px`;
      block.style.top = `${y - 13}px`;
      block.style.width = `${blockWidth}px`;
      block.style.height = "26px";
      block.style.setProperty("--project-color", project.color);
      block.style.setProperty("--pulse-base-left", `${blockLeft}px`);
      block.dataset.pulseBaseLeft = String(blockLeft);
      block.dataset.pulseWidth = String(blockWidth);
      block.dataset.pulseLaneY = String(y);
      block.dataset.pulseCompressedY = String(compressedY(y));
      block.setAttr("title", `${project.name}\n${module.name}\n${module.startDate} → ${module.endDate}\nClick: toggle done\nDouble click: rename\nDrag body: move\nDrag edges: resize`);
      const leftHandle = block.createSpan({ cls: "sr-pulse-module-handle is-left" });
      block.createSpan({ cls: "sr-pulse-module-name", text: module.name });
      const rightHandle = block.createSpan({ cls: "sr-pulse-module-handle is-right" });
      let clickTimer = 0;
      block.addEventListener("click", (event) => {
        if (event.target.closest(".sr-pulse-module-handle")) return;
        if (event.detail > 1) return;
        if (block.dataset.suppressClick === "true") {
          block.dataset.suppressClick = "";
          return;
        }
        window.clearTimeout(clickTimer);
        clickTimer = window.setTimeout(async () => {
          try {
            await repository.updateTimelineModuleAndPersist(module.id, { ...module, done: !module.done });
            renderProjectTimelineMatrix(container, plugin, state);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Failed to update plan.");
          }
        }, 320);
      });
      block.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.clearTimeout(clickTimer);
        openPulseModuleRename(block, plugin, module, () => renderProjectTimelineMatrix(container, plugin, state));
      });
      attachPulseModuleResize(block, leftHandle, plugin, module, "left", () => renderProjectTimelineMatrix(container, plugin, state));
      attachPulseModuleResize(block, rightHandle, plugin, module, "right", () => renderProjectTimelineMatrix(container, plugin, state));
      attachPulseModuleMove(block, plugin, module, () => renderProjectTimelineMatrix(container, plugin, state));
    };
    for (const module of modules) renderModuleBlock(module);

    for (const bucket of buckets.values()) {
      const node = overlays.createDiv({ cls: "sr-pulse-long-node" });
      const hours = bucket.minutes / 60;
      const radius = Math.max(4, Math.min(14, 4 + hours * 3.2));
      const size = radius * 2;
      node.style.left = `${xForDate(bucket.date)}px`;
      node.style.top = `${y}px`;
      node.style.width = `${size}px`;
      node.style.height = `${size}px`;
      node.style.setProperty("--project-color", project.color);
      node.dataset.pulseBaseX = String(xForDate(bucket.date));
      node.dataset.pulseLaneY = String(y);
      node.dataset.pulseCompressedY = String(compressedY(y));
      node.setAttr("aria-label", `${project.name}, ${bucket.date}, ${durationLabelFromMinutes(bucket.minutes)}`);
      node.addEventListener("mouseenter", () => {
        nodeHover.empty();
        const head = nodeHover.createDiv({ cls: "sr-pulse-node-hover-head" });
        head.createEl("strong", { text: project.name });
        head.createSpan({ text: `${bucket.date} · ${durationLabelFromMinutes(bucket.minutes)}` });
        for (const detail of pulseEntryDetailLines(project, bucket.entries)) {
          const row = nodeHover.createDiv({ cls: "sr-pulse-node-hover-row" });
          row.createDiv({ cls: "sr-pulse-node-hover-time", text: `${detail.time} · ${detail.duration}` });
          if (detail.values) row.createDiv({ cls: "sr-pulse-node-hover-values", text: detail.values });
        }
        const hoverWidth = 280;
        const hoverLeft = Math.max(8, Math.min(stageWidth - hoverWidth - 8, xForDate(bucket.date) + (Number(state.motionOffset) || 0) + 14));
        const hoverTop = y > stageHeight / 2
          ? Math.max(48, y - 168)
          : Math.max(48, Math.min(stageHeight - 168, y + 18));
        nodeHover.style.left = `${hoverLeft}px`;
        nodeHover.style.top = `${hoverTop}px`;
        nodeHover.addClass("is-visible");
      });
      node.addEventListener("mouseleave", () => nodeHover.removeClass("is-visible"));
    }
  });
  updatePulseContinuousMotion(stage, Number(state.motionOffset) || 0);

}

function renderProjectTimelineMatrixAnimated(container, plugin, state, direction = 0) {
  const previous = direction ? container.querySelector(".sr-pulse-stage") : null;
  const previousClone = previous?.cloneNode(true) || null;
  if (previousClone) {
    previousClone.style.transform = "";
    previousClone.style.opacity = "";
  }
  if (previous) {
    previous.style.transform = "";
    previous.style.opacity = "";
  }
  renderProjectTimelineMatrix(container, plugin, state);
  const next = container.querySelector(".sr-pulse-stage");
  if (!previousClone || !next || !direction) return;

  container.addClass("is-pulse-transitioning");
  previousClone.classList.add("sr-pulse-stage-transition-copy", direction > 0 ? "is-exit-left" : "is-exit-right");
  next.classList.add("is-pulse-entering", direction > 0 ? "from-right" : "from-left");
  container.appendChild(previousClone);

  requestAnimationFrame(() => {
    previousClone.classList.add("is-active");
    next.classList.add("is-active");
  });

  window.setTimeout(() => {
    previousClone.remove();
    next.removeClass("is-pulse-entering");
    next.removeClass("from-right");
    next.removeClass("from-left");
    next.removeClass("is-active");
    container.removeClass("is-pulse-transitioning");
  }, 380);
}

class TimelineModuleModal extends Modal {
  constructor(app, plugin, module, onSaved) {
    super(app);
    this.plugin = plugin;
    this.module = module || null;
    this.onSaved = onSaved;
  }

  onOpen() {
    const { contentEl } = this;
    const repository = this.plugin.repository;
    const planProjects = repository
      .listProjects()
      .filter((project, index) => ["short-term", "long-term"].includes(project.type) && project.isActive && !isSleepProject(project, index));
    contentEl.empty();
    contentEl.createEl("h2", { text: this.module ? "Edit Plan" : "Add Plan" });
    if (planProjects.length === 0) {
      contentEl.createDiv({ cls: "sr-empty", text: "No active short-term or long-term projects available." });
      return;
    }
    const form = contentEl.createDiv({ cls: "sr-form" });

    const projectRow = form.createDiv({ cls: "sr-form-row" });
    projectRow.createEl("label", { text: "Project" });
    const projectSelect = projectRow.createEl("select");
    for (const project of planProjects) {
      projectSelect.createEl("option", { value: project.id, text: project.name });
    }
    projectSelect.value = this.module?.projectId || planProjects[0].id;

    const nameRow = form.createDiv({ cls: "sr-form-row" });
    nameRow.createEl("label", { text: "Plan Name" });
    const nameInput = nameRow.createEl("input");
    nameInput.type = "text";
    nameInput.placeholder = "Literature Review";
    nameInput.value = this.module?.name || "";

    const startRow = form.createDiv({ cls: "sr-form-row" });
    startRow.createEl("label", { text: "Start Date" });
    const startInput = startRow.createEl("input", { type: "date" });
    startInput.value = this.module?.startDate || projectStartDate(repository.getProject(projectSelect.value)) || todayYmd();

    const endRow = form.createDiv({ cls: "sr-form-row" });
    endRow.createEl("label", { text: "End Date" });
    const endInput = endRow.createEl("input", { type: "date" });
    endInput.value = this.module?.endDate || startInput.value;

    projectSelect.addEventListener("change", () => {
      const project = repository.getProject(projectSelect.value);
      if (!this.module && project) {
        startInput.value = projectStartDate(project) || todayYmd();
        endInput.value = startInput.value;
      }
    });
    startInput.addEventListener("change", () => {
      if (!endInput.value || endInput.value < startInput.value) endInput.value = startInput.value;
    });

    const actions = form.createDiv({ cls: "sr-entry-actions" });
    actions.createEl("button", { text: "Cancel", type: "button" }).addEventListener("click", () => this.close());
    if (this.module) {
      const deleteButton = actions.createEl("button", { text: "Delete", type: "button" });
      deleteButton.addClass("mod-warning");
      deleteButton.addEventListener("click", async () => {
        if (!confirm(`Delete module "${this.module.name}"?`)) return;
        await repository.deleteTimelineModuleAndPersist(this.module.id);
        this.close();
        this.onSaved?.();
      });
    }
    const saveButton = actions.createEl("button", { text: this.module ? "Save Plan" : "Add Plan", type: "button" });
    saveButton.addClass("mod-cta");
    saveButton.addEventListener("click", async () => {
      try {
        const payload = {
          projectId: projectSelect.value,
          name: nameInput.value,
          startDate: startInput.value,
          endDate: endInput.value,
          done: Boolean(this.module?.done),
        };
        if (this.module) await repository.updateTimelineModuleAndPersist(this.module.id, payload);
        else await repository.createTimelineModuleAndPersist(payload);
        this.close();
        this.onSaved?.();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Failed to save plan.");
      }
    });

    window.setTimeout(() => nameInput.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ProjectTimelineMatrixModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.state = {
      types: new Set(["long-term", "short-term", "temporary"]),
      rangeOffsetDays: 0,
      motionOffset: 0,
    };
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl?.addClass("sr-trend-matrix-modal-shell");
    this.modalEl?.toggleClass("is-tablet-mode", isTabletMode(this.plugin));
    contentEl.empty();
    contentEl.addClass("sr-trend-matrix-modal");
    contentEl.toggleClass("is-tablet-mode", isTabletMode(this.plugin));
    const header = contentEl.createDiv({ cls: "sr-matrix-header" });
    const title = header.createDiv();
    title.createEl("h2", { text: "Task Decomposition" });
    title.createDiv({ cls: "sr-muted", text: "Plans can be moved, stretched, renamed, and checked off. Daily records appear as time-sized nodes." });
    const controls = header.createDiv({ cls: "sr-matrix-controls" });
    const moduleTemplate = controls.createDiv({ cls: "sr-pulse-module-template" });
    moduleTemplate.createSpan({ cls: "sr-pulse-module-template-icon", text: "+" });
    moduleTemplate.createSpan({ text: "Plan" });
    const body = contentEl.createDiv({ cls: "sr-matrix-scroll" });

    const render = () => {
      renderProjectTimelineMatrix(body, this.plugin, this.state);
    };

    attachPulseModulePointerDrag(moduleTemplate, this.plugin, body, render);
    render();
    this.handleTimelineWheel = (event) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      this.pendingWheelDelta = (this.pendingWheelDelta || 0) + delta;
      if (this.wheelFrame) return;
      this.wheelFrame = requestAnimationFrame(() => {
        this.wheelFrame = 0;
        const wheelDelta = this.pendingWheelDelta || 0;
        this.pendingWheelDelta = 0;
        const stage = body.querySelector(".sr-pulse-stage");
        const context = stage?._pulseDropContext;
        if (!stage || !context) return;
        this.state.motionOffset -= wheelDelta * 0.52;
        let recycled = false;
        while (this.state.motionOffset <= -context.dayWidth) {
          this.state.motionOffset += context.dayWidth;
          this.state.rangeOffsetDays += 1;
          recycled = true;
        }
        while (this.state.motionOffset >= context.dayWidth) {
          this.state.motionOffset -= context.dayWidth;
          this.state.rangeOffsetDays -= 1;
          recycled = true;
        }
        if (recycled) render();
        else updatePulseContinuousMotion(stage, this.state.motionOffset);
      });
    };
    body.addEventListener("wheel", this.handleTimelineWheel, { passive: false });
    let lastWidth = Math.round(body.getBoundingClientRect().width);
    this.resizeObserver = new ResizeObserver((entries) => {
      const nextWidth = Math.round(entries[0]?.contentRect?.width || body.getBoundingClientRect().width);
      if (!nextWidth || Math.abs(nextWidth - lastWidth) < 6) return;
      lastWidth = nextWidth;
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(render, 80);
    });
    this.resizeObserver.observe(body);
    this.handleWindowResize = () => {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(render, 80);
    };
    window.addEventListener("resize", this.handleWindowResize);
  }

  onClose() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.handleWindowResize) window.removeEventListener("resize", this.handleWindowResize);
    this.handleWindowResize = null;
    if (this.handleTimelineWheel) this.contentEl.querySelector(".sr-matrix-scroll")?.removeEventListener("wheel", this.handleTimelineWheel);
    this.handleTimelineWheel = null;
    if (this.wheelFrame) cancelAnimationFrame(this.wheelFrame);
    this.wheelFrame = 0;
    window.clearTimeout(this.resizeTimer);
    this.modalEl?.removeClass("sr-trend-matrix-modal-shell");
    this.contentEl.empty();
  }
}

function renderTimeRangeValueSlider(container, input, options = {}) {
  const min = (options.startHour ?? 0) * 60;
  const max = (options.endHour ?? 24) * 60;
  const step = options.step ?? 15;
  const wrap = container.createDiv({ cls: "sr-time-slider sr-time-slider-compact" });
  const ticks = wrap.createDiv({ cls: "sr-time-slider-ticks" });
  for (let hour = min / 60; hour <= max / 60; hour += 3) {
    ticks.createSpan({ text: clockLabelFromMinutes((hour * 60) % (24 * 60)) });
  }
  const range = wrap.createDiv({ cls: "sr-time-slider-range" });
  const selected = range.createDiv({ cls: "sr-time-slider-selected" });
  const startHandle = range.createDiv({ cls: "sr-time-slider-handle is-start" });
  const endHandle = range.createDiv({ cls: "sr-time-slider-handle is-end" });
  startHandle.setAttr("role", "slider");
  endHandle.setAttr("role", "slider");
  startHandle.setAttr("aria-label", "Sleep start time");
  endHandle.setAttr("aria-label", "Sleep end time");
  const label = wrap.createDiv({ cls: "sr-time-slider-label" });
  let startValue = options.fallbackStartMinutes ?? 23 * 60;
  let endValue = options.fallbackEndMinutes ?? 31 * 60;

  const clampToStep = (value) => Math.round(value / step) * step;
  const percentFor = (value) => ((value - min) / (max - min)) * 100;

  const updateVisual = () => {
    const left = percentFor(startValue);
    const right = percentFor(endValue);
    selected.style.left = `${left}%`;
    selected.style.width = `${Math.max(0, right - left)}%`;
    startHandle.style.left = `${left}%`;
    endHandle.style.left = `${right}%`;
    input.value = timeRangeValue(startValue, endValue);
    label.setText(`${input.value} · ${durationLabelFromMinutes(endValue - startValue)}`);
    startHandle.setAttr("aria-valuetext", clockLabelFromMinutes(startValue % (24 * 60)));
    endHandle.setAttr("aria-valuetext", clockLabelFromMinutes(endValue % (24 * 60)));
  };

  const syncFromValue = () => {
    const fallbackStart = options.fallbackStartMinutes ?? 0;
    const fallbackEnd = options.fallbackEndMinutes ?? 8 * 60;
    let { start, end } = parseTimeRangeValue(input.value, fallbackStart, fallbackEnd, { allowWrap: Boolean(options.allowWrap) });
    if (options.allowWrap && start < min) start += 24 * 60;
    if (options.allowWrap && end < start) end += 24 * 60;
    start = Math.max(min, Math.min(max - step, Math.round(start / step) * step));
    end = Math.max(min + step, Math.min(max, Math.round(end / step) * step));
    if (end <= start) end = Math.min(max, start + step);
    startValue = start;
    endValue = end;
    updateVisual();
  };

  const valueFromPointer = (event) => {
    const rect = range.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    return clampToStep(min + Math.max(0, Math.min(1, ratio)) * (max - min));
  };

  const setActiveValue = (active, value) => {
    if (active === "start") {
      startValue = Math.max(min, Math.min(endValue - step, value));
    } else {
      endValue = Math.min(max, Math.max(startValue + step, value));
    }
    updateVisual();
  };

  const beginDrag = (event, active) => {
    event.preventDefault();
    const handle = active === "start" ? startHandle : endHandle;
    handle.addClass("is-active");
    setActiveValue(active, valueFromPointer(event));
    handle.setPointerCapture?.(event.pointerId);
    const move = (moveEvent) => setActiveValue(active, valueFromPointer(moveEvent));
    const stop = () => {
      handle.removeClass("is-active");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  startHandle.addEventListener("pointerdown", (event) => beginDrag(event, "start"));
  endHandle.addEventListener("pointerdown", (event) => beginDrag(event, "end"));
  range.addEventListener("pointerdown", (event) => {
    if (event.target === startHandle || event.target === endHandle) return;
    const value = valueFromPointer(event);
    const active = Math.abs(value - startValue) <= Math.abs(value - endValue) ? "start" : "end";
    beginDrag(event, active);
  });
  input.addEventListener("change", syncFromValue);
  syncFromValue();
}

class ProjectModal extends Modal {
  constructor(app, plugin, project, onSaved, options = {}) {
    super(app);
    this.plugin = plugin;
    this.project = project || null;
    this.onSaved = onSaved;
    this.options = options || {};
    this.fieldState = (project?.fields || []).map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      required: Boolean(field.required),
      options: Array.isArray(field.options) ? field.options.join(", ") : "",
    }));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.project ? "Edit Project" : "Create Project" });
    const form = contentEl.createDiv({ cls: "sr-form" });
    const initialType = this.project?.type || this.options.initialType || "long-term";
    const initialStartDate = this.project?.startDate || this.options.initialStartDate || todayYmd();
    const initialEndDate = this.project?.plannedEndDate || this.options.initialEndDate || initialStartDate;
    const initialStartAt = this.project ? projectStartAt(this.project) : (this.options.initialStartAt || normalizeQuarterDateTimeInput(localDateTimeValue(), defaultEntryStartAt()));
    const initialEndAt = this.project ? projectEndAt(this.project) : (this.options.initialEndAt || shiftDateTimeHours(initialStartAt, 1) || initialStartAt);

    const nameRow = form.createDiv({ cls: "sr-form-row" });
    nameRow.createEl("label", { text: "Project Name" });
    const nameInput = nameRow.createEl("input");
    nameInput.type = "text";
    nameInput.placeholder = "Project name";
    nameInput.autocomplete = "off";
    nameInput.value = this.project?.name || "";

    const descRow = form.createDiv({ cls: "sr-form-row" });
    descRow.createEl("label", { text: "Description" });
    const descInput = descRow.createEl("textarea");
    descInput.value = this.project?.description || "";

    const typeRow = form.createDiv({ cls: "sr-form-row" });
    typeRow.createEl("label", { text: "Project Type" });
    const typeInput = typeRow.createEl("select");
    [
      ["long-term", "Long-term"],
      ["short-term", "Short-term"],
      ["temporary", "Temporary"],
      ["daily-status", "Daily Status"],
    ].forEach(([value, label]) => typeInput.createEl("option", { value, text: label }));
    typeInput.value = initialType;

    const colorRow = form.createDiv({ cls: "sr-form-row" });
    colorRow.createEl("label", { text: "Color" });
    const colorInput = colorRow.createEl("select");
    PROJECT_PALETTE.forEach((color) => colorInput.createEl("option", { value: color.value, text: color.label }));
    colorInput.value = normalizeProjectColor(this.project?.color, 0);

    const shortStartRow = form.createDiv({ cls: "sr-form-row" });
    shortStartRow.createEl("label", { text: "Start Date" });
    const shortStartInput = shortStartRow.createEl("input", { type: "date" });
    shortStartInput.value = initialStartDate;

    const shortEndRow = form.createDiv({ cls: "sr-form-row" });
    shortEndRow.createEl("label", { text: "End Date" });
    const shortEndInput = shortEndRow.createEl("input", { type: "date" });
    shortEndInput.value = initialEndDate;

    const startRow = form.createDiv({ cls: "sr-form-row" });
    startRow.createEl("label", { text: "Start Time" });
    const startInput = startRow.createEl("input", { type: "datetime-local" });
    startInput.step = "900";
    startInput.value = normalizeQuarterDateTimeInput(initialStartAt, defaultEntryStartAt());

    const endRow = form.createDiv({ cls: "sr-form-row" });
    endRow.createEl("label", { text: "End Time" });
    const endInput = endRow.createEl("input", { type: "datetime-local" });
    endInput.step = "900";
    endInput.value = normalizeQuarterDateTimeInput(initialEndAt, shiftDateTimeHours(startInput.value, 1));
    const timeControlRow = form.createDiv({ cls: "sr-form-row sr-form-row-full" });
    const timeControlHost = timeControlRow.createDiv();
    const syncTemporarySlider = renderDateTimeQuickControls(timeControlHost, startInput, endInput, projectStartDate(this.project) || this.options.initialStartDate || todayYmd());

    const scheduleHint = form.createDiv({ cls: "sr-muted" });
    let fieldsSection = null;
    let fieldsList = null;
    const syncProjectScheduleInputs = () => {
      const isDailyStatus = typeInput.value === "daily-status";
      const isShortTerm = typeInput.value === "short-term";
      const isTemporary = typeInput.value === "temporary";
      shortStartRow.style.display = isShortTerm ? "grid" : "none";
      shortEndRow.style.display = isShortTerm ? "grid" : "none";
      startRow.style.display = isTemporary ? "grid" : "none";
      endRow.style.display = isTemporary ? "grid" : "none";
      timeControlRow.style.display = isTemporary ? "grid" : "none";
      scheduleHint.setText(
        isDailyStatus
          ? "Daily Status uses one date-based check-in per day."
          : isShortTerm
            ? "Short-term projects are date-based and stay active across the selected range."
            : isTemporary
              ? "Temporary projects use a precise time window."
              : "Long-term projects stay open-ended and do not need a fixed schedule."
      );
      if (typeInput.value === "long-term" || isDailyStatus) {
        startInput.value = "";
        endInput.value = "";
      } else if (isTemporary && !startInput.value) {
        startInput.value = normalizeQuarterDateTimeInput(localDateTimeValue(), defaultEntryStartAt());
        endInput.value = shiftDateTimeHours(startInput.value, 1) || endInput.value;
        syncTemporarySlider?.();
      }
      if (isShortTerm) {
        if (!shortStartInput.value) shortStartInput.value = todayYmd();
        if (!shortEndInput.value || shortEndInput.value < shortStartInput.value) shortEndInput.value = shortStartInput.value;
      }
      if (fieldsSection && fieldsList) {
        if (isDailyStatus) this.fieldState = dailyStatusFields();
        fieldsSection.style.display = isDailyStatus ? "none" : "block";
        renderFieldEditorRows(fieldsList, this.fieldState);
      }
    };

    startInput.addEventListener("change", () => {
      startInput.value = normalizeQuarterDateTimeInput(startInput.value, startInput.value);
      if (!endInput.value || normalizeQuarterDateTimeInput(endInput.value, endInput.value) <= startInput.value) {
        endInput.value = shiftDateTimeHours(startInput.value, 1) || endInput.value;
      }
      syncTemporarySlider?.();
    });
    endInput.addEventListener("change", () => {
      endInput.value = normalizeQuarterDateTimeInput(endInput.value, endInput.value);
      syncTemporarySlider?.();
    });
    shortStartInput.addEventListener("change", () => {
      if (!shortEndInput.value || shortEndInput.value < shortStartInput.value) shortEndInput.value = shortStartInput.value;
    });
    typeInput.addEventListener("change", syncProjectScheduleInputs);
    syncProjectScheduleInputs();

    const activeRow = form.createDiv({ cls: "sr-inline-check" });
    const activeInput = activeRow.createEl("input");
    activeInput.type = "checkbox";
    activeInput.checked = this.project ? this.project.isActive !== false : true;
    activeRow.createSpan({ text: "Active project" });

    fieldsSection = form.createDiv({ cls: "sr-form-section" });
    const fieldsHeader = fieldsSection.createDiv({ cls: "sr-project-header" });
    fieldsHeader.createEl("strong", { text: "Fields" });
    const addFieldButton = fieldsHeader.createEl("button", { text: "Add Field", type: "button" });
    fieldsList = fieldsSection.createDiv({ cls: "sr-field-editor-list" });
    addFieldButton.addEventListener("click", () => {
      if (typeInput.value === "daily-status") return;
      this.fieldState.push({ id: id("field"), name: "", type: "text", required: false, options: "" });
      renderFieldEditorRows(fieldsList, this.fieldState);
    });
    renderFieldEditorRows(fieldsList, this.fieldState);
    syncProjectScheduleInputs();

    const actions = form.createDiv({ cls: "sr-entry-actions" });
    actions.createEl("button", { text: "Cancel", type: "button" }).addEventListener("click", () => this.close());
    const saveButton = actions.createEl("button", { text: this.project ? "Save Project" : "Create Project", type: "button" });
    saveButton.addClass("mod-cta");
    saveButton.addEventListener("click", async () => {
      try {
        const payload = {
          name: nameInput.value,
          description: descInput.value,
          type: typeInput.value,
          color: colorInput.value,
          startAt: typeInput.value === "temporary" ? normalizeQuarterDateTimeInput(startInput.value, startInput.value) : "",
          endAt: typeInput.value === "temporary" ? normalizeQuarterDateTimeInput(endInput.value, endInput.value) : "",
          startDate: typeInput.value === "short-term" ? shortStartInput.value : "",
          plannedEndDate: typeInput.value === "short-term" ? shortEndInput.value : "",
          completed: typeInput.value === "temporary" ? Boolean(this.project?.completed) : false,
          isActive: activeInput.checked,
          fields: typeInput.value === "daily-status" ? dailyStatusFields() : collectFieldDefinitions(fieldsList),
        };
        const saved = this.project
          ? await this.plugin.repository.updateProjectAndPersist(this.project.id, payload)
          : await this.plugin.repository.createProjectAndPersist(payload);
        new Notice(this.project ? "Project updated." : "Project created.");
        this.close();
        this.onSaved?.(saved);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Failed to save project.");
      }
    });

    window.setTimeout(() => nameInput.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

function renderFieldEditorRows(container, fieldState) {
  container.empty();
  if (fieldState.length === 0) {
    container.createDiv({ cls: "sr-empty", text: "No fields yet. Add a field to structure records." });
    return;
  }

  fieldState.forEach((field, index) => {
    const row = container.createDiv({ cls: "sr-field-editor-row" });
    row.setAttr("data-field-id", field.id);

    const nameInput = row.createEl("input");
    nameInput.type = "text";
    nameInput.placeholder = "Field name";
    nameInput.autocomplete = "off";
    nameInput.value = field.name || "";
    nameInput.addClass("sr-field-name");

    const typeSelect = row.createEl("select");
    typeSelect.addClass("sr-field-type");
    for (const type of FIELD_TYPES) typeSelect.createEl("option", { value: type, text: type });
    typeSelect.value = field.type || "text";

    const requiredWrap = row.createDiv({ cls: "sr-inline-check" });
    const requiredInput = requiredWrap.createEl("input");
    requiredInput.type = "checkbox";
    requiredInput.checked = Boolean(field.required);
    requiredInput.addClass("sr-field-required");
    requiredWrap.createSpan({ text: "Required" });

    const removeButton = row.createEl("button", { text: "Remove", type: "button" });
    removeButton.addEventListener("click", () => {
      fieldState.splice(index, 1);
      renderFieldEditorRows(container, fieldState);
    });
  });
}

class DateDetailModal extends Modal {
  constructor(app, plugin, selectedDate) {
    super(app);
    this.plugin = plugin;
    this.selectedDate = selectedDate;
  }

  reopen() {
    this.onOpen();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sr-date-modal");
    contentEl.createEl("h2", { text: fullDateLabel(this.selectedDate) });
    const layout = contentEl.createDiv({ cls: "sr-date-review-layout" });
    renderDateProjectShelf(layout.createDiv({ cls: "sr-date-review-left" }), this.plugin, this.selectedDate, () => this.reopen());
    renderDateTimeline(layout.createDiv({ cls: "sr-date-review-right" }), this.plugin, this.selectedDate, () => this.reopen());
  }

  onClose() {
    this.contentEl.empty();
  }
}
class EntryModal extends Modal {
  constructor(app, plugin, project, entry, onSaved, initialDate = "", options = {}) {
    super(app);
    this.plugin = plugin;
    this.project = project;
    this.entry = entry || null;
    this.onSaved = onSaved;
    this.initialDate = initialDate;
    this.options = options || {};
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.entry ? `Edit Entry - ${this.project.name}` : `New Entry - ${this.project.name}` });
    const form = contentEl.createDiv({ cls: "sr-form" });
    const isDailyStatus = isDailyStatusProject(this.project);

    const initialStartAt = this.entry ? entryStartAt(this.entry) : (this.options.initialStartAt || defaultEntryStartAt(this.initialDate));
    const initialEndAt = this.entry ? entryEndAt(this.entry) : (this.options.initialEndAt || shiftDateTimeHours(initialStartAt, 1) || initialStartAt);

    const startRow = form.createDiv({ cls: "sr-form-row" });
    startRow.createEl("label", { text: isDailyStatus ? "Date" : "Start Time" });
    const startInput = startRow.createEl("input", { type: isDailyStatus ? "date" : "datetime-local" });
    if (!isDailyStatus) startInput.step = "900";
    startInput.value = isDailyStatus ? String(this.entry?.date || this.initialDate || todayYmd()).slice(0, 10) : initialStartAt;

    const endRow = form.createDiv({ cls: "sr-form-row" });
    endRow.createEl("label", { text: "End Time" });
    const endInput = endRow.createEl("input", { type: "datetime-local" });
    endInput.step = "900";
    endInput.value = initialEndAt;
    if (isDailyStatus) endRow.style.display = "none";
    if (!isDailyStatus) renderDateTimeQuickControls(form, startInput, endInput, this.entry?.date || this.initialDate || todayYmd());

    startInput.addEventListener("change", () => {
      if (isDailyStatus) return;
      startInput.value = normalizeQuarterDateTimeInput(startInput.value, startInput.value);
      if (!endInput.value || normalizeQuarterDateTimeInput(endInput.value, endInput.value) <= startInput.value) {
        endInput.value = shiftDateTimeHours(startInput.value, 1) || endInput.value;
      }
    });
    endInput.addEventListener("change", () => {
      endInput.value = normalizeQuarterDateTimeInput(endInput.value, endInput.value);
    });

    const filePaths = listVaultFilePaths(this.app);
    const inputs = new Map();

    for (const field of this.project.fields) {
      const row = form.createDiv({ cls: "sr-form-row" });
      row.createEl("label", { text: field.required ? `${field.name} *` : field.name });
      const existing = this.entry?.values[field.id];

      if (field.type === "date") {
        const input = row.createEl("input", { type: "date" });
        input.value = existing || "";
        inputs.set(field.id, input);
      } else if (field.type === "number") {
        const input = row.createEl("input", { type: "number" });
        input.value = existing ?? "";
        inputs.set(field.id, input);
      } else if (field.type === "score") {
        const scoreWrap = row.createDiv({ cls: "sr-score-input" });
        const input = scoreWrap.createEl("input", { type: "range" });
        input.min = "0";
        input.max = "5";
        input.step = "0.5";
        input.value = existing ?? "";
        const label = scoreWrap.createDiv({ cls: "sr-score-input-label" });
        const track = scoreWrap.createDiv({ cls: "sr-score-input-blocks" });
        for (let index = 1; index <= 5; index += 1) track.createSpan();
        const updateScorePreview = () => {
          const score = Number(input.value);
          label.setText(Number.isFinite(score) ? `${formatRpgXp(score)}/5` : "-");
          Array.from(track.children).forEach((block, index) => {
            block.toggleClass("is-filled", Number.isFinite(score) && score >= index + 1);
            block.toggleClass("is-partial", Number.isFinite(score) && score > index && score < index + 1);
          });
        };
        input.addEventListener("input", updateScorePreview);
        updateScorePreview();
        inputs.set(field.id, input);
      } else if (field.type === "emotion") {
        const current = emotionValueParts(existing) || { pleasure: 3, energy: 3 };
        const emotionWrap = row.createDiv({ cls: "sr-emotion-input" });
        const plane = emotionWrap.createDiv({ cls: "sr-emotion-plane is-input" });
        const dot = plane.createSpan({ cls: "sr-emotion-dot" });
        const label = emotionWrap.createDiv({ cls: "sr-emotion-input-label" });
        let emotion = { ...current };
        const updateEmotionPreview = () => {
          dot.style.left = `${(emotion.pleasure / 5) * 100}%`;
          dot.style.top = `${100 - (emotion.energy / 5) * 100}%`;
          dot.style.background = emotionColor(emotion);
          label.setText(emotionStatusLabel(emotion));
        };
        const setEmotionFromPointer = (event) => {
          const rect = plane.getBoundingClientRect();
          const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
          const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
          emotion = {
            pleasure: Math.round(x * 10) / 2,
            energy: Math.round((1 - y) * 10) / 2,
          };
          updateEmotionPreview();
        };
        plane.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          plane.setPointerCapture?.(event.pointerId);
          setEmotionFromPointer(event);
        });
        plane.addEventListener("pointermove", (event) => {
          if (!plane.hasPointerCapture?.(event.pointerId)) return;
          event.preventDefault();
          setEmotionFromPointer(event);
        });
        updateEmotionPreview();
        inputs.set(field.id, {
          get value() {
            return { ...emotion };
          },
        });
      } else if (field.type === "time-range") {
        const input = row.createEl("input", { type: "hidden" });
        input.value = existing || "23:00-07:00";
        renderTimeRangeValueSlider(row, input, {
          startHour: 12,
          endHour: 36,
          fallbackStartMinutes: 23 * 60,
          fallbackEndMinutes: 31 * 60,
          allowWrap: true,
        });
        inputs.set(field.id, input);
      } else if (field.type === "file") {
        const input = row.createEl("input", { type: "text" });
        input.placeholder = "Search vault file path";
        input.value = existing || "";
        const listId = `sr-file-list-${field.id}`;
        input.setAttr("list", listId);
        const datalist = row.createEl("datalist");
        datalist.id = listId;
        for (const path of filePaths) datalist.createEl("option", { value: path });
        const status = row.createDiv({ cls: "sr-muted" });
        const updateStatus = () => {
          const value = input.value.trim();
          if (!value) {
            status.setText("Type to search files in the vault.");
            return;
          }
          const matched = filePaths.find((path) => path === value);
          status.setText(matched ? `Matched: ${fileNameFromPath(matched)}` : "No exact file match yet.");
        };
        input.addEventListener("input", updateStatus);
        updateStatus();
        inputs.set(field.id, input);
      } else {
        const input = row.createEl("textarea");
        input.rows = 3;
        input.value = existing || "";
        inputs.set(field.id, input);
      }
    }

    const actions = form.createDiv({ cls: "sr-entry-actions" });
    actions.createEl("button", { text: "Cancel", type: "button" }).addEventListener("click", () => this.close());
    const saveButton = actions.createEl("button", { text: this.entry ? "Save Entry" : "Create Entry", type: "button" });
    saveButton.addClass("mod-cta");
    saveButton.addEventListener("click", async () => {
      try {
        const values = {};
        for (const field of this.project.fields) {
          const input = inputs.get(field.id);
          values[field.id] = input?.value ?? "";
        }
        const payload = {
          date: isDailyStatus ? startInput.value : "",
          startAt: isDailyStatus ? "" : normalizeQuarterDateTimeInput(startInput.value, startInput.value),
          endAt: isDailyStatus ? "" : normalizeQuarterDateTimeInput(endInput.value, endInput.value),
          values,
        };
        if (this.entry) {
          await this.plugin.repository.updateEntryAndPersist(this.entry.id, payload);
          new Notice("Entry updated.");
        } else {
          await this.plugin.repository.createEntryAndPersist(this.project.id, payload);
          new Notice("Entry created.");
        }
        this.close();
        this.onSaved?.();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Failed to save entry.");
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ReportPromptModal extends Modal {
  constructor(app, title, message, confirmText, resolve) {
    super(app);
    this.title = title;
    this.message = message;
    this.confirmText = confirmText;
    this.resolve = resolve;
    this.resolved = false;
  }

  finish(value) {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(value);
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    contentEl.createDiv({ cls: "sr-muted", text: this.message });
    const actions = contentEl.createDiv({ cls: "sr-entry-actions" });
    const confirmButton = actions.createEl("button", { text: this.confirmText, type: "button" });
    confirmButton.addClass("mod-cta");
    confirmButton.addEventListener("click", () => this.finish(true));
    actions.createEl("button", { text: "Skip", type: "button" }).addEventListener("click", () => this.finish(false));
  }

  onClose() {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(false);
    }
  }
}

function confirmReportPrompt(app, title, message, confirmText) {
  return new Promise((resolve) => {
    new ReportPromptModal(app, title, message, confirmText, resolve).open();
  });
}

class SelectionAiModal extends Modal {
  constructor(app, plugin, selectedText, sourcePath = "") {
    super(app);
    this.plugin = plugin;
    this.selectedText = String(selectedText || "").trim();
    this.sourcePath = sourcePath || "";
    this.answer = "";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sr-selection-ai-modal");
    contentEl.createEl("h2", { text: "Ask AI" });
    if (this.sourcePath) contentEl.createDiv({ cls: "sr-muted", text: this.sourcePath });

    const form = contentEl.createDiv({ cls: "sr-form" });
    const selectedRow = form.createDiv({ cls: "sr-form-row" });
    selectedRow.createEl("label", { text: "Selected text" });
    const selectedBox = selectedRow.createEl("textarea");
    selectedBox.rows = 6;
    selectedBox.value = this.selectedText;
    selectedBox.readOnly = true;

    const questionRow = form.createDiv({ cls: "sr-form-row" });
    questionRow.createEl("label", { text: "Question" });
    const questionInput = questionRow.createEl("textarea");
    questionInput.rows = 3;
    questionInput.placeholder = "解释这段话 / 总结重点 / 告诉我怎么理解";

    const answerWrap = form.createDiv({ cls: "sr-selection-ai-answer" });
    if (this.answer) answerWrap.setText(this.answer);

    const actions = form.createDiv({ cls: "sr-entry-actions" });
    const askButton = actions.createEl("button", { text: "Send to AI", type: "button" });
    askButton.addClass("mod-cta");
    actions.createEl("button", { text: "Close", type: "button" }).addEventListener("click", () => this.close());

    const send = async () => {
      if (!this.selectedText) {
        new Notice("No selected text.");
        return;
      }
      askButton.disabled = true;
      askButton.setText("Thinking...");
      answerWrap.setText("Thinking...");
      try {
        const answer = await askSelectionAi(this.plugin, this.selectedText, questionInput.value, this.sourcePath);
        this.answer = answer;
        answerWrap.setText(answer);
        document.dispatchEvent(new CustomEvent("sr-deskpet-say", {
          bubbles: true,
          detail: { text: answer },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to ask AI.";
        answerWrap.setText(message);
        new Notice(message);
        document.dispatchEvent(new CustomEvent("sr-deskpet-say", {
          bubbles: true,
          detail: { text: message },
        }));
      } finally {
        askButton.disabled = false;
        askButton.setText("Send to AI");
      }
    };

    askButton.addEventListener("click", send);
    questionInput.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void send();
      }
    });
    window.setTimeout(() => questionInput.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ReportSettingsModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.toggleClass("is-tablet-mode", isTabletMode(this.plugin));
    contentEl.createEl("h2", { text: "Report Settings" });
    contentEl.createDiv({ cls: "sr-muted", text: "DeepSeek API key is stored in Obsidian plugin data, not in reports or source code." });
    const form = contentEl.createDiv({ cls: "sr-form" });

    const keyRow = form.createDiv({ cls: "sr-form-row" });
    keyRow.createEl("label", { text: "DeepSeek API key" });
    const keyInput = keyRow.createEl("input", { type: "password" });
    keyInput.placeholder = "sk-...";
    keyInput.value = this.plugin.settings.deepseekApiKey;

    const modelRow = form.createDiv({ cls: "sr-form-row" });
    modelRow.createEl("label", { text: "DeepSeek model" });
    const modelInput = modelRow.createEl("input", { type: "text" });
    modelInput.placeholder = DEFAULT_SETTINGS.deepseekModel;
    modelInput.value = this.plugin.settings.deepseekModel;

    const memoryRow = form.createDiv({ cls: "sr-form-row" });
    memoryRow.createEl("label", { text: "Report memory count" });
    const memoryInput = memoryRow.createEl("input", { type: "number" });
    memoryInput.min = "0";
    memoryInput.max = "8";
    memoryInput.value = String(this.plugin.settings.reportMemoryCount);

    const petPromptRow = form.createDiv({ cls: "sr-form-row" });
    petPromptRow.createEl("label", { text: "Desk pet personality / System prompt" });
    const petPromptInput = petPromptRow.createEl("textarea");
    petPromptInput.placeholder = DEFAULT_SETTINGS.petSystemPrompt;
    petPromptInput.value = this.plugin.settings.petSystemPrompt;

    const tabletRow = form.createDiv({ cls: "sr-form-row" });
    tabletRow.createEl("label", { text: "Tablet Mode" });
    const tabletSelect = tabletRow.createEl("select");
    [
      ["auto", "Auto"],
      ["on", "On"],
      ["off", "Off"],
    ].forEach(([value, label]) => tabletSelect.createEl("option", { value, text: label }));
    tabletSelect.value = normalizeSettings(this.plugin.settings).tabletMode;

    const actions = form.createDiv({ cls: "sr-entry-actions" });
    actions.createEl("button", { text: "Cancel", type: "button" }).addEventListener("click", () => this.close());
    const saveButton = actions.createEl("button", { text: "Save", type: "button" });
    saveButton.addClass("mod-cta");
    saveButton.addEventListener("click", async () => {
      const parsedMemoryCount = Number(memoryInput.value);
      this.plugin.settings.deepseekApiKey = keyInput.value.trim();
      this.plugin.settings.deepseekModel = modelInput.value.trim() || DEFAULT_SETTINGS.deepseekModel;
      this.plugin.settings.reportMemoryCount = Number.isFinite(parsedMemoryCount)
        ? Math.max(0, Math.min(8, Math.round(parsedMemoryCount)))
        : DEFAULT_SETTINGS.reportMemoryCount;
      this.plugin.settings.petSystemPrompt = petPromptInput.value.trim() || DEFAULT_SETTINGS.petSystemPrompt;
      this.plugin.settings.tabletMode = ["auto", "on", "off"].includes(tabletSelect.value) ? tabletSelect.value : DEFAULT_SETTINGS.tabletMode;
      await this.plugin.saveSettings();
      new Notice("Report settings saved.");
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
class StructuredReviewSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Structured Review Settings" });

    new Setting(containerEl)
      .setName("DeepSeek API key")
      .setDesc("Stored in Obsidian plugin data. Do not put keys in report files or source code.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("sk-...")
          .setValue(this.plugin.settings.deepseekApiKey)
          .onChange(async (value) => {
            this.plugin.settings.deepseekApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("DeepSeek model")
      .setDesc("Default: deepseek-chat.")
      .addText((text) => {
        text.setPlaceholder(DEFAULT_SETTINGS.deepseekModel)
          .setValue(this.plugin.settings.deepseekModel)
          .onChange(async (value) => {
            this.plugin.settings.deepseekModel = value.trim() || DEFAULT_SETTINGS.deepseekModel;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Report memory count")
      .setDesc("How many recent reports to send as memory when generating a new report.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.max = "8";
        text.setValue(String(this.plugin.settings.reportMemoryCount))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.reportMemoryCount = Number.isFinite(parsed) ? Math.max(0, Math.min(8, Math.round(parsed))) : DEFAULT_SETTINGS.reportMemoryCount;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Desk pet personality / System prompt")
      .setDesc("Used by Send to AI for the speech bubble response.")
      .addTextArea((text) => {
        text.setPlaceholder(DEFAULT_SETTINGS.petSystemPrompt)
          .setValue(this.plugin.settings.petSystemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.petSystemPrompt = value.trim() || DEFAULT_SETTINGS.petSystemPrompt;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5;
      });

    new Setting(containerEl)
      .setName("Desk pet movement mode")
      .setDesc("You can also right-click the pet to switch modes.")
      .addDropdown((dropdown) => {
        dropdown.addOption("fixed", "Fixed")
          .addOption("follow", "Follow")
          .addOption("free", "Free")
          .setValue(this.plugin.settings.deskPetMode)
          .onChange(async (value) => {
            this.plugin.settings.deskPetMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Tablet Mode")
      .setDesc("Auto detects touch devices. On enables touch-first card review, larger hit targets, and pet menu access without right-click.")
      .addDropdown((dropdown) => {
        dropdown.addOption("auto", "Auto")
          .addOption("on", "On")
          .addOption("off", "Off")
          .setValue(normalizeSettings(this.plugin.settings).tabletMode)
          .onChange(async (value) => {
            this.plugin.settings.tabletMode = ["auto", "on", "off"].includes(value) ? value : DEFAULT_SETTINGS.tabletMode;
            await this.plugin.saveSettings();
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view?.render?.();
          });
      });
  }
}
class StructuredReviewView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.selectedProjectId = null;
    this.selectedDate = todayYmd();
    this.currentMonthKey = monthKeyFromDate(this.selectedDate);
    this.unsubscribe = null;
    this.deskPetCleanup = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Structured Review";
  }

  getIcon() {
    return "list-checks";
  }

  async onOpen() {
    this.unsubscribe = this.plugin.repository.subscribe(() => this.render());
    this.render();
  }

  async onClose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deskPetCleanup?.();
    this.deskPetCleanup = null;
  }

  render() {
    const root = this.containerEl.children[1];
    this.deskPetCleanup?.();
    this.deskPetCleanup = null;
    root.empty();
    root.addClass("structured-review-view");
    root.toggleClass("is-tablet-mode", isTabletMode(this.plugin));

    const toolbar = root.createDiv({ cls: "sr-toolbar" });
    toolbar.createEl("button", { text: "Create Project" }).addEventListener("click", () => {
      new ProjectModal(this.app, this.plugin, null, (project) => {
        this.selectedProjectId = project.type === "temporary" ? TEMPORARY_ARCHIVE_ID : project.id;
        this.selectedDate = projectStartDate(project) || this.selectedDate;
        this.currentMonthKey = monthKeyFromDate(this.selectedDate);
        this.render();
      }).open();
    });
    toolbar.createEl("button", { text: "Daily Status" }).addEventListener("click", async () => {
      const project = await ensureDailyStatusProject(this.plugin);
      this.selectedProjectId = project.id;
      new EntryModal(this.app, this.plugin, project, null, () => this.render(), this.selectedDate).open();
    });
    toolbar.createEl("button", { text: "Report Settings" }).addEventListener("click", () => {
      new ReportSettingsModal(this.app, this.plugin).open();
    });
    toolbar.createEl("button", { text: "Refresh" }).addEventListener("click", () => this.render());

    renderOverview(root, this.plugin, this);

    const layout = root.createDiv({ cls: "sr-layout" });
    const left = layout.createDiv({ cls: "sr-panel" });
    left.createEl("h2", { text: "Projects" });
    const right = layout.createDiv();

    const allProjects = this.plugin.repository.listProjects().filter((project, index) => !isSleepProject(project, index));
    const summaries = allProjects.map((project) => summarizeProject(this.plugin.repository, project));
    const temporaryProjects = allProjects.filter((project) => project.type === "temporary");
    const regularSummaries = summaries.filter((summary) => summary.project.type !== "temporary");
    if (!this.selectedProjectId && (regularSummaries.length > 0 || temporaryProjects.length > 0)) {
      this.selectedProjectId = regularSummaries[0]?.project.id || TEMPORARY_ARCHIVE_ID;
    }
    if (this.selectedProjectId && this.selectedProjectId !== TEMPORARY_ARCHIVE_ID) {
      const selectedProject = this.plugin.repository.getProject(this.selectedProjectId);
      if (!selectedProject) {
        this.selectedProjectId = regularSummaries[0]?.project.id || (temporaryProjects.length > 0 ? TEMPORARY_ARCHIVE_ID : null);
      } else if (isSleepProject(selectedProject)) {
        this.selectedProjectId = regularSummaries[0]?.project.id || (temporaryProjects.length > 0 ? TEMPORARY_ARCHIVE_ID : null);
      } else if (selectedProject.type === "temporary") {
        this.selectedProjectId = TEMPORARY_ARCHIVE_ID;
      }
    }
    renderProjectList(left, summaries, temporaryProjects, this.selectedProjectId, (projectId) => {
      this.selectedProjectId = projectId;
      this.render();
    });
    if (this.selectedProjectId === TEMPORARY_ARCHIVE_ID) {
      renderTemporaryArchiveDetails(right, this.plugin, this);
    } else {
      renderProjectDetails(right, this.plugin, this.plugin.repository.getProject(this.selectedProjectId), this);
    }
  }
}

async function openStructuredReview(app, reveal) {
  let leaf = app.workspace.getLeavesOfType(VIEW_TYPE)[0];
  if (!leaf) {
    leaf = app.workspace.getLeaf("tab");
    if (!leaf) leaf = app.workspace.getLeaf(true);
    if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: reveal });
  }
  if (reveal && leaf) await app.workspace.revealLeaf(leaf);
}

module.exports = class StructuredReviewPlugin extends Plugin {
  citeReviewsPath() {
    const pluginDir = this.manifest?.dir || `${this.app.vault.configDir || ".obsidian"}/plugins/${this.manifest?.id || "structured-review"}`;
    return normalizePath(`${pluginDir}/${CITE_REVIEWS_FILE_NAME}`);
  }

  async ensureSyncFolder() {
    const adapter = this.app.vault.adapter;
    let current = "";
    for (const part of SYNC_ROOT.split("/")) {
      current = current ? `${current}/${part}` : part;
      const normalized = normalizePath(current);
      if (!(await adapter.exists(normalized))) await adapter.mkdir(normalized);
    }
  }

  async readJsonFile(path) {
    const normalized = normalizePath(path);
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(normalized);
    if (!exists) return { exists: false, data: null };
    const raw = await adapter.read(normalized);
    return { exists: true, data: JSON.parse(raw || "{}") };
  }

  async writeJsonFile(path, payload) {
    await this.ensureSyncFolder();
    await this.app.vault.adapter.write(normalizePath(path), `${JSON.stringify(payload, null, 2)}\n`);
  }

  async loadSyncMainData() {
    try {
      const result = await this.readJsonFile(SYNC_DATA_FILE);
      if (!result.exists) return { exists: false, data: null };
      return { exists: true, data: mainDataPayload(result.data, result.data?.settings) };
    } catch (error) {
      console.error("Structured Review: failed to load sync data mirror", error);
      new Notice("Failed to load StructuredReview/sync/data.json. Falling back to plugin data.");
      return { exists: false, data: null };
    }
  }

  async loadSyncCiteReviewsData() {
    try {
      const result = await this.readJsonFile(SYNC_CITE_REVIEWS_FILE);
      if (!result.exists) return { exists: false, citeReviews: [] };
      const source = Array.isArray(result.data) ? result.data : result.data?.citeReviews;
      return { exists: true, citeReviews: normalizeCiteReviews(source) };
    } catch (error) {
      console.error("Structured Review: failed to load sync cite reviews mirror", error);
      new Notice("Failed to load StructuredReview/sync/cite-reviews.json. Falling back to local cite reviews.");
      return { exists: false, citeReviews: [] };
    }
  }

  async saveSyncMainData(data, settings) {
    const payload = {
      ...mainDataPayload(data, settings),
      syncUpdatedAt: nowIso(),
    };
    await this.writeJsonFile(SYNC_DATA_FILE, payload);
  }

  async saveSyncCiteReviewsData(citeReviews) {
    await this.writeJsonFile(SYNC_CITE_REVIEWS_FILE, {
      version: 1,
      syncUpdatedAt: nowIso(),
      citeReviews: normalizeCiteReviews(citeReviews),
    });
  }

  async saveSyncMirrorData(data, citeReviews, settings) {
    try {
      await this.saveSyncMainData(data, settings);
      await this.saveSyncCiteReviewsData(citeReviews);
    } catch (error) {
      console.error("Structured Review: failed to save sync mirror", error);
      new Notice("Structured Review saved locally, but sync mirror failed.");
    }
  }

  async loadCiteReviewsData() {
    const path = this.citeReviewsPath();
    try {
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) return { exists: false, citeReviews: [] };
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw || "{}");
      const source = Array.isArray(parsed) ? parsed : parsed?.citeReviews;
      return { exists: true, citeReviews: normalizeCiteReviews(source) };
    } catch (error) {
      console.error("Structured Review: failed to load cite reviews", error);
      new Notice("Failed to load cite-reviews.json. Falling back to data.json.");
      return { exists: false, citeReviews: [] };
    }
  }

  async saveCiteReviewsData(citeReviews) {
    const path = this.citeReviewsPath();
    const payload = {
      version: 1,
      updatedAt: nowIso(),
      citeReviews: normalizeCiteReviews(citeReviews),
    };
    await this.app.vault.adapter.write(path, `${JSON.stringify(payload, null, 2)}\n`);
  }

  async onload() {
    const savedData = await this.loadData();
    const localSource = savedData && typeof savedData === "object" ? savedData : DEFAULT_DATA;
    const syncMain = await this.loadSyncMainData();
    const source = syncMain.exists ? syncMain.data : localSource;
    const citeReviewFile = await this.loadCiteReviewsData();
    const syncCiteReviewFile = await this.loadSyncCiteReviewsData();
    const hasLegacyCiteReviews = Boolean(savedData && typeof savedData === "object" && Object.prototype.hasOwnProperty.call(savedData, "citeReviews"));
    const legacyCiteReviews = normalizeCiteReviews(localSource.citeReviews || source.citeReviews);
    const citeReviews = syncCiteReviewFile.exists
      ? syncCiteReviewFile.citeReviews
      : citeReviewFile.exists
        ? citeReviewFile.citeReviews
        : legacyCiteReviews;
    this.settings = normalizeSettings(source.settings);
    applyTabletModeClass(this);
    this.repository = new Repository(this, { ...source, citeReviews, settings: this.settings });
    if (syncMain.exists) {
      await this.saveData(mainDataPayload(this.repository.data, this.settings));
    }
    if (syncCiteReviewFile.exists) {
      await this.saveCiteReviewsData(this.repository.data.citeReviews);
    }
    if (!syncMain.exists || !syncCiteReviewFile.exists || hasLegacyCiteReviews || (!citeReviewFile.exists && legacyCiteReviews.length > 0)) {
      await this.saveRepositoryData(this.repository.data);
    }
    this.reportService = new ReportService(this, this.repository);
    this.citeMemorySignature = citeMemoryCatalogSignature(this);
    this.citeMemoryDate = todayYmd();
    let citeRefreshTimer = 0;
    const scheduleCiteRefresh = () => {
      if (citeRefreshTimer) window.clearTimeout(citeRefreshTimer);
      citeRefreshTimer = window.setTimeout(() => {
        citeRefreshTimer = 0;
        const signature = citeMemoryCatalogSignature(this);
        if (signature === this.citeMemorySignature) return;
        this.citeMemorySignature = signature;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view?.render?.();
      }, 450);
    };
    this.registerEvent(this.app.metadataCache.on("changed", scheduleCiteRefresh));
    this.registerEvent(this.app.vault.on("create", scheduleCiteRefresh));
    this.registerEvent(this.app.vault.on("delete", scheduleCiteRefresh));
    this.registerEvent(this.app.vault.on("rename", scheduleCiteRefresh));
    this.register(() => {
      if (citeRefreshTimer) window.clearTimeout(citeRefreshTimer);
    });

    this.registerView(VIEW_TYPE, (leaf) => new StructuredReviewView(leaf, this));
    this.addSettingTab(new StructuredReviewSettingTab(this.app, this));

    this.addRibbonIcon("list-checks", "Structured Review", async () => {
      await openStructuredReview(this.app, true);
    });

    this.addCommand({
      id: "open-structured-review",
      name: "Open Structured Review",
      callback: async () => openStructuredReview(this.app, true),
    });

    this.addCommand({
      id: "configure-report-settings",
      name: "Configure Report Settings",
      callback: () => new ReportSettingsModal(this.app, this).open(),
    });

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
      const selectedText = String(editor?.getSelection?.() || "").trim();
      if (!selectedText) return;
      const sourcePath = view?.file?.path || this.app.workspace.getActiveFile()?.path || "";
      menu.addItem((item) => {
        item.setTitle("Ask AI / 提问 AI")
          .setIcon("sparkles")
          .onClick(() => openSelectionAiBubble(this, selectedText, sourcePath));
      });
    }));

    this.registerDomEvent(document, "contextmenu", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(".cm-editor, input, textarea")) return;
      const preview = target.closest(".markdown-preview-view");
      if (!preview) return;
      const selection = window.getSelection();
      const selectedText = String(selection?.toString() || "").trim();
      if (!selectedText) return;
      const anchorElement = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
      const focusElement = selection?.focusNode instanceof Element ? selection.focusNode : selection?.focusNode?.parentElement;
      if ((anchorElement && !preview.contains(anchorElement)) || (focusElement && !preview.contains(focusElement))) return;
      event.preventDefault();
      const sourcePath = this.app.workspace.getActiveFile()?.path || "";
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle("Ask AI / 提问 AI")
          .setIcon("sparkles")
          .onClick(() => openSelectionAiBubble(this, selectedText, sourcePath));
      });
      menu.showAtMouseEvent(event);
    });

    this.addCommand({
      id: "generate-weekly-report",
      name: "Generate Weekly Report",
      callback: async () => this.generateReportWithNotice("weekly"),
    });

    this.addCommand({
      id: "generate-monthly-report",
      name: "Generate Monthly Report",
      callback: async () => this.generateReportWithNotice("monthly"),
    });

    this.app.workspace.onLayoutReady(() => {
      if (!this.globalDeskPetCleanup) {
        this.globalDeskPetCleanup = renderDeskPetPlatform(document.body, this);
      }
      void this.maybePromptScheduledReports();
    });
    this.registerInterval(window.setInterval(() => {
      void this.maybePromptScheduledReports();
      const currentDate = todayYmd();
      if (currentDate !== this.citeMemoryDate) {
        this.citeMemoryDate = currentDate;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view?.render?.();
      }
    }, 60 * 60 * 1000));
  }

  async saveRepositoryData(data) {
    const settings = normalizeSettings(this.settings || data?.settings);
    this.settings = settings;
    applyTabletModeClass(this);
    const payload = mainDataPayload(data, settings);
    if (this.repository) this.repository.data.settings = settings;
    await this.saveData(payload);
    const citeReviews = data?.citeReviews || [];
    await this.saveCiteReviewsData(citeReviews);
    await this.saveSyncMirrorData(payload, citeReviews, settings);
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    applyTabletModeClass(this);
    if (this.repository) {
      this.repository.data.settings = this.settings;
      const payload = mainDataPayload(this.repository.data, this.settings);
      await this.saveData(payload);
      await this.saveSyncMainData(payload, this.settings).catch((error) => {
        console.error("Structured Review: failed to save sync settings mirror", error);
        new Notice("Settings saved locally, but sync mirror failed.");
      });
      return;
    }
    const payload = mainDataPayload(DEFAULT_DATA, this.settings);
    await this.saveData(payload);
    await this.saveSyncMainData(payload, this.settings).catch((error) => {
      console.error("Structured Review: failed to save sync settings mirror", error);
      new Notice("Settings saved locally, but sync mirror failed.");
    });
  }

  async generateReportWithNotice(kind) {
    const normalizedKind = kind === "monthly" ? "monthly" : "weekly";
    try {
      new Notice(`Generating ${normalizedKind} report with DeepSeek...`);
      const path = await this.reportService.generateReport(normalizedKind);
      new Notice(`${normalizedKind === "monthly" ? "Monthly" : "Weekly"} report generated: ${path}`);
      return path;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : `Failed to generate ${normalizedKind} report.`);
      return null;
    }
  }

  async maybePromptScheduledReports() {
    const today = todayYmd();
    const todayDate = parseDateInput(today);
    const dueReports = [];

    if (todayDate.getDay() === 1 && this.settings.lastWeeklyPromptDate !== today) {
      dueReports.push({
        kind: "weekly",
        title: "Generate weekly report?",
        message: "It will summarize last week, read your recent reports as memory, and leave space for next week's plan.",
        confirmText: "Generate weekly report",
        mark: "lastWeeklyPromptDate",
      });
    }

    if (today.endsWith("-01") && this.settings.lastMonthlyPromptDate !== today) {
      dueReports.push({
        kind: "monthly",
        title: "Generate monthly report?",
        message: "It will summarize last month, read your recent reports as memory, and leave space for next month's plan.",
        confirmText: "Generate monthly report",
        mark: "lastMonthlyPromptDate",
      });
    }

    for (const report of dueReports) {
      this.settings[report.mark] = today;
      await this.saveSettings();
      const confirmed = await confirmReportPrompt(this.app, report.title, report.message, report.confirmText);
      if (confirmed) await this.generateReportWithNotice(report.kind);
    }
  }

  async onunload() {
    if (this.globalDeskPetCleanup) {
      this.globalDeskPetCleanup();
      this.globalDeskPetCleanup = null;
    }
    document.body.classList.remove("sr-tablet-mode");
    await this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
};













































