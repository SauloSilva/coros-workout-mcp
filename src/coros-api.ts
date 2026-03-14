import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type {
  AuthData,
  CatalogExercise,
  ExerciseOverrides,
  ExercisePayload,
  RawExercise,
  Region,
  WorkoutPayload,
} from "./types.js";
import {
  REGION_URLS,
  MuscleCode,
  PartCode,
  EquipmentCode,
} from "./types.js";
import { findByName } from "./exercise-catalog.js";

const CONFIG_DIR = resolve(homedir(), ".config", "coros-workout-mcp");
const AUTH_FILE = resolve(CONFIG_DIR, "auth.json");
const DEFAULT_SOURCE_URL =
  "https://d31oxp44ddzkyk.cloudfront.net/source/source_default/0/2fbd46e17bc54bc5873415c9fa767bdc.jpg";

// --- Auth ---

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

export function storeAuth(auth: AuthData): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
}

export function loadAuth(): AuthData | null {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export async function login(
  email: string,
  password: string,
  region: Region = "eu"
): Promise<AuthData> {
  const apiUrl = REGION_URLS[region] ?? REGION_URLS["eu"];
  const res = await fetch(`${apiUrl}/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account: email,
      accountType: 2,
      pwd: md5(password),
    }),
  });
  const data = await res.json();
  if (data.result !== "0000") {
    throw new Error(`COROS login failed: ${data.message || data.result}`);
  }

  const auth: AuthData = {
    accessToken: data.data.accessToken,
    userId: data.data.userId,
    region,
    timestamp: Date.now(),
  };
  storeAuth(auth);
  memoryAuth = auth;
  return auth;
}

const TOKEN_MAX_AGE_MS = 20 * 60 * 60 * 1000; // 20 hours

// In-memory cache prevents multiple concurrent logins from invalidating each other
let memoryAuth: AuthData | null = null;
let loginPromise: Promise<AuthData> | null = null;

function isTokenFresh(auth: AuthData): boolean {
  if (!auth.timestamp) return false;
  return Date.now() - auth.timestamp < TOKEN_MAX_AGE_MS;
}

/** Get valid auth from memory cache, stored file, or env vars (with login deduplication) */
export async function getValidAuth(): Promise<AuthData | null> {
  const email = process.env.COROS_EMAIL;
  const password = process.env.COROS_PASSWORD;
  const rawRegion = process.env.COROS_REGION?.toLowerCase();
  const envRegion: Region = rawRegion === "us" || rawRegion === "eu" ? rawRegion : "eu";

  // 1. Memory cache — fastest path, but only if region matches env
  if (memoryAuth && isTokenFresh(memoryAuth)) {
    if (!rawRegion || memoryAuth.region === envRegion) return memoryAuth;
  }

  // 2. File cache — only if region matches env var (prevents stale cross-region tokens)
  const stored = loadAuth();
  if (stored && isTokenFresh(stored)) {
    if (!rawRegion || stored.region === envRegion) {
      memoryAuth = stored;
      return memoryAuth;
    }
    // Region mismatch: stored token is for wrong region, must re-login
  }

  // 3. Re-authenticate via env vars — deduplicated so only ONE login happens
  //    even if multiple tool calls arrive simultaneously
  if (email && password) {
    if (!loginPromise) {
      loginPromise = login(email, password, envRegion).finally(() => {
        loginPromise = null;
      });
    }
    memoryAuth = await loginPromise;
    return memoryAuth;
  }

  // 4. Last resort: stale stored token (no env credentials available)
  if (stored) return stored;

  return null;
}

/** Clear the cached auth so the next getValidAuth() call triggers a fresh login. */
export function clearAuthCache(): void {
  memoryAuth = null;
  loginPromise = null;
}

// --- API helpers ---

function apiHeaders(auth: AuthData): Record<string, string> {
  return {
    "Content-Type": "application/json",
    accesstoken: auth.accessToken,
    yfheader: JSON.stringify({ userId: auth.userId }),
  };
}

const AUTH_ERROR_CODES = new Set(["0002", "0003", "1002"]);

async function apiPost(auth: AuthData, path: string, body: unknown): Promise<unknown> {
  const apiUrl = REGION_URLS[auth.region];
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: apiHeaders(auth),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.result !== "0000") {
    if (AUTH_ERROR_CODES.has(data.result)) {
      throw new Error(`COROS auth error (${path}): token invalid or expired. Use authenticate_coros to re-login.`);
    }
    throw new Error(`COROS API error (${path}): ${data.message || data.result}`);
  }
  return data;
}

async function apiGet(
  auth: AuthData,
  path: string,
  params: Record<string, string | number> = {}
): Promise<unknown> {
  const apiUrl = REGION_URLS[auth.region];
  const url = new URL(`${apiUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: apiHeaders(auth),
  });
  const data = await res.json();
  if (data.result !== "0000") {
    if (AUTH_ERROR_CODES.has(data.result)) {
      throw new Error(`COROS auth error (${path}): token invalid or expired. Use authenticate_coros to re-login.`);
    }
    throw new Error(`COROS API error (${path}): ${data.message || data.result}`);
  }
  return data;
}

/** Fetch the full exercise catalog from COROS API */
export async function queryExerciseCatalog(
  auth: AuthData,
  sportType: number = 4
): Promise<RawExercise[]> {
  const result = (await apiGet(auth, "/training/exercise/query", {
    userId: auth.userId,
    sportType,
  })) as { data: RawExercise[] };
  return result.data;
}

/** Fetch i18n strings from the COROS static CDN (no auth needed) */
export async function fetchI18nStrings(): Promise<Record<string, string>> {
  const url = "https://static.coros.com/locale/coros-traininghub-v2/en-US.prod.js";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch i18n strings: ${res.status} ${res.statusText}`);
  }
  let text = await res.text();
  // Strip "window.en_US=" prefix and trailing semicolon
  text = text.replace(/^window\.en_US\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(text);
}

/**
 * Transform raw exercises + i18n map into CatalogExercise[].
 * Name resolution order: i18n[codeName] → existingCatalog[codeName].name → codeName
 * The i18n file only covers ~100 of ~383 exercises, so the existing catalog
 * provides names for exercises that predate the i18n system.
 */
export function buildCatalogFromRaw(
  rawExercises: RawExercise[],
  i18n: Record<string, string>,
  existingCatalog: CatalogExercise[] = []
): { catalog: CatalogExercise[]; i18nMisses: string[] } {
  const i18nMisses: string[] = [];
  const catalog: CatalogExercise[] = [];

  // Build lookup from existing catalog by codeName for fallback
  const existingByCode = new Map<string, CatalogExercise>();
  for (const e of existingCatalog) {
    existingByCode.set(e.codeName, e);
  }

  for (const r of rawExercises) {
    // Resolve human-readable name:
    // 1. i18n (code name key, e.g. "T1300" → "Weighted Jump Squats")
    // 2. Existing catalog entry (for older exercises without i18n)
    // 3. Fall back to raw code name
    let humanName = i18n[r.name];
    if (!humanName) {
      const existing = existingByCode.get(r.name);
      if (existing) {
        humanName = existing.name;
      } else {
        humanName = r.name;
        i18nMisses.push(r.name);
      }
    }

    // Resolve description from i18n
    const desc = i18n[r.name + "_desc"] || "";

    // Build text fields from numeric codes
    const muscle = r.muscle || [];
    const muscleRelevance = r.muscleRelevance || [];
    const part = r.part || [];
    const equipment = r.equipment || [];
    const primaryMuscle = muscle[0];
    const secondaryMuscles = muscleRelevance.filter((m) => m !== primaryMuscle);
    const muscleText = primaryMuscle
      ? (MuscleCode as Record<number, string>)[primaryMuscle] || String(primaryMuscle)
      : "";
    const secondaryMuscleText = secondaryMuscles
      .map((m) => (MuscleCode as Record<number, string>)[m] || String(m))
      .join(",");
    const partText = part
      .map((p) => (PartCode as Record<number, string>)[p] || String(p))
      .join(",");
    const equipmentText = equipment
      .map((e) => (EquipmentCode as Record<number, string>)[e] || String(e))
      .join(",");

    catalog.push({
      id: r.id,
      name: humanName.trim(),
      codeName: r.name,
      overview: r.overview,
      animationId: r.animationId,
      muscle,
      muscleRelevance,
      part,
      equipment,
      exerciseType: r.exerciseType,
      targetType: r.targetType,
      targetValue: r.targetValue,
      intensityType: r.intensityType,
      intensityValue: r.intensityValue,
      restType: r.restType,
      restValue: r.restValue,
      sets: r.sets,
      sortNo: r.sortNo,
      sportType: r.sportType,
      status: r.status,
      createTimestamp: r.createTimestamp,
      thumbnailUrl: r.thumbnailUrl || "",
      sourceUrl: r.sourceUrl,
      videoUrl: r.videoUrl,
      coverUrlArrStr: r.coverUrlArrStr,
      videoUrlArrStr: r.videoUrlArrStr,
      videoInfos: r.videoInfos,
      muscleText,
      secondaryMuscleText,
      partText,
      equipmentText,
      desc,
    });
  }

  // Sort alphabetically by name
  catalog.sort((a, b) => a.name.localeCompare(b.name));

  return { catalog, i18nMisses };
}

// --- Payload construction ---

export function buildExercisePayload(
  exercise: CatalogExercise,
  sortNo: number,
  overrides: Partial<ExerciseOverrides> = {}
): ExercisePayload {
  const sets = overrides.sets ?? exercise.sets;
  let targetType = exercise.targetType;
  let targetValue = exercise.targetValue;
  if (overrides.reps !== undefined) {
    targetType = 3;
    targetValue = overrides.reps;
  } else if (overrides.duration !== undefined) {
    targetType = 2;
    targetValue = overrides.duration;
  }

  const restValue = overrides.restSeconds ?? exercise.restValue;

  let intensityType = exercise.intensityType;
  let intensityValue = exercise.intensityValue;
  if (overrides.weightGrams !== undefined) {
    intensityType = 1;
    intensityValue = overrides.weightGrams;
  } else if (overrides.weightKg !== undefined) {
    intensityType = 1;
    intensityValue = overrides.weightKg * 1000;
  }

  // Build text fields from codes
  const primaryMuscle = exercise.muscle[0];
  const secondaryMuscles = (exercise.muscleRelevance || []).filter(
    (m) => m !== primaryMuscle
  );
  const muscleText =
    exercise.muscleText ||
    (primaryMuscle
      ? (MuscleCode as Record<number, string>)[primaryMuscle] || ""
      : "");
  const secondaryMuscleText =
    exercise.secondaryMuscleText ||
    secondaryMuscles
      .map((m) => (MuscleCode as Record<number, string>)[m] || "")
      .filter(Boolean)
      .join(",");
  const partText =
    exercise.partText ||
    exercise.part
      .map((p) => (PartCode as Record<number, string>)[p] || "")
      .filter(Boolean)
      .join(",");
  const equipmentText =
    exercise.equipmentText ||
    exercise.equipment
      .map((e) => (EquipmentCode as Record<number, string>)[e] || "")
      .filter(Boolean)
      .join(",");

  return {
    access: 0,
    animationId: exercise.animationId ?? 0,
    coverUrlArrStr: exercise.coverUrlArrStr,
    createTimestamp: exercise.createTimestamp,
    defaultOrder: 0,
    equipment: exercise.equipment,
    exerciseType: exercise.exerciseType,
    id: sortNo, // sequential 1-based index used in API
    intensityCustom: 0,
    intensityType,
    intensityValue,
    isDefaultAdd: 0,
    isGroup: false,
    isIntensityPercent: false,
    muscle: exercise.muscle,
    muscleRelevance: exercise.muscleRelevance || [],
    name: exercise.codeName,
    overview: exercise.overview,
    part: exercise.part,
    restType: 1,
    restValue,
    sets,
    sortNo,
    sourceUrl: exercise.sourceUrl,
    sportType: 4,
    status: 1,
    targetType,
    targetValue,
    thumbnailUrl: exercise.thumbnailUrl,
    userId: 0,
    videoInfos: exercise.videoInfos,
    videoUrl: exercise.videoUrl,
    videoUrlArrStr: exercise.videoUrlArrStr,
    nameText: exercise.name,
    desc: exercise.desc,
    descText: exercise.desc,
    partText,
    muscleText,
    secondaryMuscleText,
    equipmentText,
    groupId: "",
    originId: exercise.id,
    targetDisplayUnit: 0,
    hrType: 0,
    intensityValueExtend: 0,
    intensityMultiplier: 0,
    intensityPercent: 0,
    intensityPercentExtend: 0,
    intensityDisplayUnit: "6",
  };
}

export function buildWorkoutPayload(
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[]
): WorkoutPayload {
  return {
    access: 1,
    authorId: "0",
    createTimestamp: 0,
    distance: 0,
    duration: 0,
    essence: 0,
    estimatedType: 0,
    estimatedValue: 0,
    exerciseNum: 0,
    exercises: exercisePayloads,
    headPic: "",
    id: "0",
    idInPlan: "0",
    name,
    nickname: "",
    originEssence: 0,
    overview,
    pbVersion: 2,
    planIdIndex: 0,
    poolLength: 2500,
    profile: "",
    referExercise: { intensityType: 1, hrType: 0, valueType: 1 },
    sex: 0,
    shareUrl: "",
    simple: false,
    sourceUrl: DEFAULT_SOURCE_URL,
    sportType: 4,
    star: 0,
    subType: 65535,
    targetType: 0,
    targetValue: 0,
    thirdPartyId: 0,
    totalSets: 0,
    trainingLoad: 0,
    type: 0,
    unit: 0,
    userId: "0",
    version: 0,
    videoCoverUrl: "",
    videoUrl: "",
    fastIntensityTypeName: "weight",
    poolLengthId: 1,
    poolLengthUnit: 2,
    sourceId: "425868133463670784",
  };
}

/** Resolve exercise overrides to catalog entries and build payloads */
export function resolveExercises(
  exercises: ExerciseOverrides[]
): ExercisePayload[] {
  return exercises.map((override, index) => {
    const catalog = findByName(override.name);
    if (!catalog) {
      throw new Error(`Exercise not found in catalog: "${override.name}"`);
    }
    return buildExercisePayload(catalog, index + 1, override);
  });
}

// --- Workout API ---

export interface CalculateResult {
  duration: number;
  totalSets: number;
  trainingLoad: number;
}

export async function calculateWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[]
): Promise<CalculateResult> {
  const payload = buildWorkoutPayload(name, overview, exercisePayloads);
  const result = (await apiPost(auth, "/training/program/calculate", payload)) as {
    data: { planDuration: number; planSets: number; planTrainingLoad: number };
  };
  return {
    duration: result.data.planDuration,
    totalSets: result.data.planSets,
    trainingLoad: result.data.planTrainingLoad,
  };
}

export async function addWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[],
  calculated: CalculateResult
): Promise<unknown> {
  const payload = buildWorkoutPayload(name, overview, exercisePayloads);
  // Apply calculated values
  payload.duration = calculated.duration;
  payload.totalSets = calculated.totalSets;
  payload.distance = "0"; // String in add (number in calculate)
  payload.sets = calculated.totalSets;
  payload.pitch = 0;
  return apiPost(auth, "/training/program/add", payload);
}

// --- Running Workout ---

/**
 * Step types matching COROS Training Hub UI:
 * warmup=aquecimento, active=treino, rest=rest, cooldown=desaquecimento, interval=intervalo
 */
export type RunStepType = "warmup" | "active" | "rest" | "cooldown" | "interval";

/**
 * Intensity target type:
 * open=sem alvo, pace=ritmo (s/km), heartrate=freq. cardíaca (bpm)
 */
export type RunTargetType = "open" | "pace" | "heartrate";

/**
 * Duration/objective type:
 * time=tempo (seconds), distance=distância (meters),
 * training_load=carga de treino, open=aberto (sem objetivo)
 */
export type RunDurationType = "time" | "distance" | "training_load" | "open";

export interface RunStep {
  type: RunStepType;
  /**
   * Duration value: seconds (time), meters (distance), load units (training_load),
   * or 0 (open). Ignored when durationType=open.
   */
  durationValue: number;
  durationType: RunDurationType;
  /** Intensity target type (default: open) */
  targetType?: RunTargetType;
  /** Pace range low in s/km (e.g. 270 = 4:30/km). Required if targetType=pace */
  paceLow?: number;
  /** Pace range high in s/km (e.g. 300 = 5:00/km). Required if targetType=pace */
  paceHigh?: number;
  /** HR range low in bpm. Required if targetType=heartrate */
  hrLow?: number;
  /** HR range high in bpm. Required if targetType=heartrate */
  hrHigh?: number;
  /** Repeat this step N times (creates N copies in the sequence) */
  repeat?: number;
}

// exerciseType codes confirmed from COROS API:
// 0=aquecimento, 1=treino, 2=rest, 3=desaquecimento, 4=intervalo
const RUN_EXERCISE_TYPE: Record<RunStepType, number> = {
  warmup: 0,
  active: 1,
  rest: 2,
  cooldown: 3,
  interval: 4,
};

// targetType codes confirmed from COROS API:
// 0=aberto, 2=tempo (s), 3=distância (m), 1=carga de treino
const RUN_DURATION_TYPE: Record<RunDurationType, number> = {
  open: 0,
  training_load: 1,
  time: 2,
  distance: 3,
};

const RUN_STEP_NAMES: Record<RunStepType, string> = {
  warmup: "Aquecimento",
  active: "Treino",
  rest: "Rest",
  cooldown: "Desaquecimento",
  interval: "Intervalo",
};

function buildRunStep(step: RunStep, index: number): object {
  // intensityType: 0=open, 1=pace (ms/km), 2=heartrate (bpm)
  let intensityType = 0;
  let intensityValue = 0;      // low bound (pace ms/km or HR bpm)
  let intensityValueExtend: number | undefined; // high bound

  const tgt = step.targetType ?? "open";
  if (tgt === "pace" && (step.paceLow != null || step.paceHigh != null)) {
    intensityType = 1;
    // COROS stores pace in ms/km (s/km * 1000)
    // intensityValue = low (faster), intensityValueExtend = high (slower)
    intensityValue = (step.paceLow ?? step.paceHigh ?? 300) * 1000;
    if (step.paceHigh != null) {
      intensityValueExtend = step.paceHigh * 1000;
    }
  } else if (tgt === "heartrate" && (step.hrLow != null || step.hrHigh != null)) {
    intensityType = 2;
    intensityValue = step.hrLow ?? step.hrHigh ?? 0;
    if (step.hrHigh != null) {
      intensityValueExtend = step.hrHigh;
    }
  }

  const base: Record<string, unknown> = {
    name: RUN_STEP_NAMES[step.type],
    exerciseType: RUN_EXERCISE_TYPE[step.type],
    sets: 1,
    targetType: RUN_DURATION_TYPE[step.durationType],
    targetValue: step.durationType === "open" ? 0 : step.durationValue,
    intensityType,
    intensityValue,
    restValue: 0,
    sortNo: (index + 1) * 16777216,
    defaultOrder: 0,
    groupId: "0",
    isGroup: false,
    isDefaultAdd: 0,
    isIntensityPercent: false,
    sportType: 1,
    status: 1,
    videoInfos: [],
  };

  if (intensityValueExtend != null) {
    base.intensityValueExtend = intensityValueExtend;
  }

  return base;
}

function buildRunningPayload(
  name: string,
  overview: string,
  steps: RunStep[]
): object {
  // Expand repeats
  const expanded: RunStep[] = [];
  for (const step of steps) {
    const times = step.repeat ?? 1;
    for (let i = 0; i < times; i++) expanded.push(step);
  }

  const exercises = expanded.map((step, i) => buildRunStep(step, i));
  const totalDurationSec = expanded.reduce((sum, step) => {
    if (step.durationType === "time") return sum + step.durationValue;
    // Estimate from pace for distance steps
    const paceSkm = step.paceLow ?? step.paceHigh ?? 300;
    return sum + Math.round((step.durationValue / 1000) * paceSkm);
  }, 0);

  return {
    access: 1,
    authorId: "0",
    createTimestamp: 0,
    distance: 0,
    duration: totalDurationSec,
    essence: 0,
    estimatedType: 0,
    estimatedValue: 0,
    exerciseNum: exercises.length,
    exercises,
    headPic: "",
    id: "0",
    idInPlan: "0",
    name,
    nickname: "",
    originEssence: 0,
    overview,
    pbVersion: 2,
    planIdIndex: 0,
    poolLength: 2500,
    profile: "",
    referExercise: { intensityType: 0, hrType: 0, valueType: 0 },
    sex: 0,
    shareUrl: "",
    simple: false,
    sourceUrl: DEFAULT_SOURCE_URL,
    sportType: 1,
    star: 0,
    subType: 65535,
    targetType: 0,
    targetValue: 0,
    thirdPartyId: 0,
    totalSets: exercises.length,
    trainingLoad: 0,
    type: 0,
    unit: 0,
    userId: "0",
    version: 0,
    videoCoverUrl: "",
    videoUrl: "",
    poolLengthId: 1,
    poolLengthUnit: 2,
    sourceId: "0",
  };
}

export async function createRunningWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  steps: RunStep[]
): Promise<{ duration: number; totalSteps: number }> {
  const payload = buildRunningPayload(name, overview, steps);

  // Calculate
  const calcResult = (await apiPost(auth, "/training/program/calculate", payload)) as {
    data: { planDuration: number; planSets: number; planTrainingLoad: number };
  };

  // Add with calculated values
  const addPayload = {
    ...(payload as Record<string, unknown>),
    duration: calcResult.data.planDuration || (payload as Record<string, unknown>).duration,
    distance: "0",
    sets: calcResult.data.planSets,
    totalSets: calcResult.data.planSets,
    pitch: 0,
  };

  await apiPost(auth, "/training/program/add", addPayload);

  return {
    duration: addPayload.duration as number,
    totalSteps: calcResult.data.planSets,
  };
}

export interface QueryOptions {
  name?: string;
  sportType?: number;
  startNo?: number;
  limitSize?: number;
}

export async function queryWorkouts(
  auth: AuthData,
  options: QueryOptions = {}
): Promise<unknown> {
  const body = {
    name: options.name || "",
    supportRestExercise: 1,
    startNo: options.startNo ?? 0,
    limitSize: options.limitSize ?? 10,
    sportType: options.sportType ?? 0,
  };
  return apiPost(auth, "/training/program/query", body);
}

// --- Activities ---

export interface ActivityQueryOptions {
  /** Days to look back from today (default: 30) */
  days?: number;
  /** Page size (default: 20) */
  size?: number;
  /** Page number starting at 1 (default: 1) */
  pageNumber?: number;
  /** Sport mode filter, empty = all */
  modeList?: string;
}

export interface Activity {
  labelId: string;
  name: string;
  /** YYYYMMDD integer – use startTime for a real Unix timestamp */
  date: number;
  /** Unix timestamp in seconds */
  startTime: number;
  endTime: number;
  mode: number;
  sportType: number;
  /** Distance in meters */
  distance: number;
  /** Duration in seconds */
  totalTime: number;
  workoutTime: number;
  /** Calories × 1000 (divide by 1000 for kcal) */
  calorie: number;
  avgHr: number;
  /** Average pace in s/km */
  avgSpeed: number;
  /** Adjusted/GAP pace in s/km */
  adjustedPace: number;
  /** Best pace (fastest point) in s/km */
  best: number;
  /** Best 1km pace in s/km */
  bestKm: number;
  /** Average cadence in spm */
  avgCadence: number;
  /** Average power in watts */
  avgPower: number;
  ascent: number;
  descent: number;
  trainingLoad: number;
  step: number;
  device: string;
  deviceId: string;
  imageUrl: string;
}

const ACTIVITY_MODE_NAMES: Record<number, string> = {
  0: "Outdoor Run",
  1: "Indoor Run",
  8: "Run",
  9: "Trail Run",
  10: "Track Run",
  11: "Hike",
  12: "Walk",
  13: "Bike",
  14: "Indoor Bike",
  15: "Mountain Bike",
  16: "Pool Swim",
  17: "Open Water",
  18: "Triathlon",
  19: "Ski",
  20: "Snowboard",
  21: "Rowing",
  22: "Strength",
  23: "Gym Cardio",
  24: "HIIT",
  25: "Yoga",
  26: "Pilates",
  28: "Climb",
  29: "Indoor Climb",
  30: "Surf",
  31: "Tennis",
  32: "Table Tennis",
  33: "Badminton",
  34: "Basketball",
  35: "Soccer",
  36: "Volleyball",
  37: "Golf",
  38: "Boxing",
  100: "Other",
};

export function activityModeName(mode: number): string {
  return ACTIVITY_MODE_NAMES[mode] ?? `Mode ${mode}`;
}

/** ts = Unix timestamp in seconds (use activity.startTime, not activity.date) */
function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("pt-BR");
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export async function queryActivities(
  auth: AuthData,
  options: ActivityQueryOptions = {}
): Promise<{ activities: Activity[]; total: number }> {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - (options.days ?? 30));

  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  const params = new URLSearchParams({
    size: String(options.size ?? 20),
    pageNumber: String(options.pageNumber ?? 1),
    startDay: fmt(start),
    endDay: fmt(today),
    modeList: options.modeList ?? "",
  });

  const baseUrl = REGION_URLS[auth.region];
  const res = await fetch(`${baseUrl}/activity/query?${params}`, {
    headers: {
      accesstoken: auth.accessToken,
      yfheader: JSON.stringify({ userId: auth.userId }),
    },
  });

  const data = (await res.json()) as {
    result: string;
    message?: string;
    data?: { dataList: Activity[]; count: number; totalPage: number };
  };

  if (data.result !== "0000") {
    throw new Error(`COROS API error (/activity/query): ${data.message || data.result}`);
  }

  return {
    activities: data.data?.dataList ?? [],
    total: data.data?.count ?? 0,
  };
}

/** Search through recent activities to find one by labelId. */
export async function queryActivityDetail(
  auth: AuthData,
  labelId: string
): Promise<Activity | null> {
  // Search up to 365 days back, paginating up to 10 pages of 50
  for (let page = 1; page <= 10; page++) {
    const { activities } = await queryActivities(auth, {
      days: 365,
      size: 50,
      pageNumber: page,
    });
    if (activities.length === 0) break;
    const found = activities.find((a) => String(a.labelId) === String(labelId));
    if (found) return found;
  }
  return null;
}

// ─── Full Activity Detail ────────────────────────────────────────────────────

export interface LapItem {
  lapIndex: number;
  /** Distance in cm */
  distance: number;
  startTimestamp: number;
  endTimestamp: number;
  avgHr: number;
  maxHr: number;
  minHr: number;
  /** Pace in s/km */
  avgPace: number;
  avgCadence: number;
  avgPower: number;
  elevGain: number;
  avgGroundTime: number;
  avgStrideLength: number;
  lapType: number;
}

export interface LapGroup {
  type: number;
  lapDistance: number;
  fastLapIndexList: number[];
  lapItemList: LapItem[];
}

export interface ZoneItem {
  zoneIndex: number;
  leftScope: number;
  rightScope: number;
  percent: number;
  second: number;
}

export interface ZoneGroup {
  type: number;
  zoneItemList: ZoneItem[];
}

export interface ActivitySummaryFull {
  name: string;
  sportType: number;
  startTimestamp: number;
  endTimestamp: number;
  totalTime: number;
  /** Distance in cm */
  distance: number;
  /** Calories × 1000 */
  calories: number;
  avgHr: number;
  maxHr: number;
  /** Pace in s/km */
  avgSpeed: number;
  adjustedPace: number;
  bestKm: number;
  avgCadence: number;
  avgPower: number;
  maxPower: number;
  maxCadence: number;
  elevGain: number;
  totalDescent: number;
  trainingLoad: number;
  aerobicEffect: number;
  aerobicEffectState: number;
  anaerobicEffect: number;
  /** Ground contact time in ms */
  avgGroundTime: number;
  /** Vertical oscillation in mm */
  avgVertVibration: number;
  /** Vertical ratio in % × 10 */
  avgVertRatio: number;
  /** Step length in cm */
  avgStepLen: number;
  performance: number;
  currentVo2Max: number;
  staminaLevel7d: number;
  standardRate: number;
  planId?: string;
  hasProgram: number;
  lapDistance: number;
}

export interface WeatherInfo {
  temperature: number;
  humidity: number;
  windSpeed: number;
  windDirection: number;
  bodyFeelTemp: number;
  weatherType: number;
}

export interface SportFeelInfo {
  feelType: number;
  sportNote: string;
}

export interface ActivityDetailFull {
  summary: ActivitySummaryFull;
  lapList: LapGroup[];
  zoneList: ZoneGroup[];
  weather: WeatherInfo | null;
  sportFeelInfo: SportFeelInfo | null;
}

const FEEL_LABELS: Record<number, string> = {
  1: "😫 Muito difícil",
  2: "😓 Difícil",
  3: "😐 Normal",
  4: "😊 Bem",
  5: "🤩 Ótimo",
};

const ZONE_TYPE_LABELS: Record<number, string> = {
  126: "FC",
  130: "Pace",
  173: "Pace (treino)",
};

export function feelLabel(feelType: number): string {
  return FEEL_LABELS[feelType] ?? `Tipo ${feelType}`;
}

export async function queryActivityDetailFull(
  auth: AuthData,
  labelId: string,
  sportType: number
): Promise<ActivityDetailFull> {
  const baseUrl = REGION_URLS[auth.region];
  const res = await fetch(
    `${baseUrl}/activity/detail/query?labelId=${labelId}&sportType=${sportType}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accesstoken: auth.accessToken,
        yfheader: JSON.stringify({ userId: auth.userId }),
      },
      body: JSON.stringify({}),
    }
  );

  const data = (await res.json()) as {
    result: string;
    message?: string;
    data?: {
      summary: ActivitySummaryFull;
      lapList: LapGroup[];
      zoneList: ZoneGroup[];
      weather: WeatherInfo;
      sportFeelInfo: SportFeelInfo;
    };
  };

  if (data.result !== "0000") {
    throw new Error(
      `COROS API error (/activity/detail/query): ${data.message || data.result}`
    );
  }

  return {
    summary: data.data!.summary,
    lapList: data.data!.lapList ?? [],
    zoneList: data.data!.zoneList ?? [],
    weather: data.data!.weather ?? null,
    sportFeelInfo: data.data!.sportFeelInfo ?? null,
  };
}

export { ZONE_TYPE_LABELS, FEEL_LABELS, feelLabel as fmtFeel };

/** Format pace (s/km) → "M:SS/km" */
export function fmtPace(secPerKm: number): string {
  if (!secPerKm || secPerKm <= 0) return "–";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

export { fmtDate, fmtDuration, activityModeName as fmtMode };

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface DayMetrics {
  happenDay: number;
  /** Acute Training Load (short-term, ~7 days) */
  ati: number;
  /** Chronic Training Impulse (long-term fitness, ~42 days) */
  cti: number;
  /** Training Impulse Balance (TSB = CTL - ATL) */
  tib: number;
  /** Today's training load */
  trainingLoad: number;
  /** ATL/CTL ratio (optimal 0.8–1.5) */
  trainingLoadRatio: number;
  /** Fatigue state: 1=fresh, 2=light, 3=balanced, 4=tired, 5=very tired */
  tiredRateStateNew: number;
  /** Fatigue % */
  tiredRateNew: number;
  /** Performance state */
  performance: number;
  /** Current stamina level */
  staminaLevel: number;
  /** 7-day stamina level */
  staminaLevel7d: number;
  /** VO2max estimate */
  vo2max: number;
  /** Lactate threshold heart rate */
  lthr: number;
  /** Lactate threshold pace (s/km) */
  ltsp: number;
  /** Resting heart rate */
  rhr: number;
  /** Average sleep HRV */
  avgSleepHrv?: number;
  /** HRV baseline */
  sleepHrvBase?: number;
  /** 7-day accumulated load */
  t7d: number;
  /** 28-day accumulated load */
  t28d: number;
  /** Recommended weekly load min */
  recomendTlMin: number;
  /** Recommended weekly load max */
  recomendTlMax: number;
}

export interface SportStat {
  sportType: number;
  count: number;
  distance: number;
  duration: number;
  avgHeartRate: number;
  avgPace?: number;
  trainingLoad: number;
}

export interface ZoneArea {
  index: number;
  ratio: number;
  value: number;
}

export interface WeekSummary {
  firstDayOfWeek: number;
  trainingLoad: number;
  recomendTlMin: number;
  recomendTlMax: number;
}

export interface AnalyticsData {
  today: DayMetrics;
  sportStatistic: SportStat[];
  weekList: WeekSummary[];
  hrTimeAreaList: ZoneArea[];
  tlAreaList: ZoneArea[];
  timeAreaList: ZoneArea[];
}

const TIRED_STATE_LABELS: Record<number, string> = {
  1: "Muito descansado",
  2: "Descansado",
  3: "Equilibrado",
  4: "Cansado",
  5: "Muito cansado",
};

const PERFORMANCE_LABELS: Record<number, string> = {
  1: "Em melhora",
  2: "Mantendo",
  3: "Em recuperação",
  "-1": "Sem dados",
};

export function tiredStateLabel(state: number): string {
  return TIRED_STATE_LABELS[state] ?? `Estado ${state}`;
}

export function performanceLabel(perf: number): string {
  return PERFORMANCE_LABELS[perf] ?? `Estado ${perf}`;
}

export async function queryAnalytics(
  auth: AuthData
): Promise<AnalyticsData> {
  const baseUrl = REGION_URLS[auth.region];

  // We need any labelId to make the endpoint work; use a dummy one —
  // the endpoint returns personal metrics regardless of the activity.
  // Actually the endpoint works without labelId too when called as GET.
  const url = `${baseUrl}/analyse/query`;
  const res = await fetch(url, {
    headers: {
      accesstoken: auth.accessToken,
      yfheader: JSON.stringify({ userId: auth.userId }),
    },
  });

  const data = (await res.json()) as {
    result: string;
    message?: string;
    data?: {
      dayList: DayMetrics[];
      t7dayList: DayMetrics[];
      sportStatistic: SportStat[];
      weekList: WeekSummary[];
      summaryInfo: {
        hrTimeAreaList: ZoneArea[];
        tlAreaList: ZoneArea[];
        timeAreaList: ZoneArea[];
      };
    };
  };

  if (data.result !== "0000") {
    throw new Error(
      `COROS API error (/analyse/query): ${data.message || data.result}`
    );
  }

  const d = data.data!;
  const t7 = d.t7dayList ?? d.dayList ?? [];
  const today = t7[t7.length - 1] ?? ({} as DayMetrics);

  return {
    today,
    sportStatistic: d.sportStatistic ?? [],
    weekList: (d.weekList ?? []).slice(0, 6),
    hrTimeAreaList: d.summaryInfo?.hrTimeAreaList ?? [],
    tlAreaList: d.summaryInfo?.tlAreaList ?? [],
    timeAreaList: d.summaryInfo?.timeAreaList ?? [],
  };
}

// ─── Schedule (Calendar) ────────────────────────────────────────────────────

export interface ScheduleEntry {
  happenDay: number;       // YYYYMMDD
  executeStatus: number;   // 0=pending, 2=completed
  name: string;
  sportType: number;
  duration: number;        // seconds
  distance: number;        // cm (divide by 100 = meters)
  labelId?: string;        // present when completed (links to recorded activity)
  trainingLoad?: number;
  planName?: string;
}

export interface ScheduleResult {
  planName: string;
  entries: ScheduleEntry[];
}

export async function querySchedule(
  startDate: string,  // YYYYMMDD
  endDate: string,    // YYYYMMDD
  auth: { accessToken: string; userId: string; region: string }
): Promise<ScheduleResult> {
  const base = auth.region === "us" ? "teamapi.coros.com" : "teameuapi.coros.com";
  const headers = {
    "Content-Type": "application/json",
    accesstoken: auth.accessToken,
    yfheader: JSON.stringify({ userId: auth.userId }),
  };

  const res = await fetch(
    `https://${base}/training/schedule/query?startDate=${startDate}&endDate=${endDate}&supportRestExercise=1`,
    { method: "GET", headers }
  );
  const data = await res.json();

  if (data.result !== "0000") {
    throw new Error(`COROS API error (/training/schedule/query): ${data.message || data.result}`);
  }

  const d = data.data;
  const planName: string = d.name ?? "Plano de Treino";

  // Build program lookup by idInPlan
  const progMap: Record<string, { name: string; sportType: number; duration: number; distance: number }> = {};
  for (const p of (d.programs ?? [])) {
    if (p.idInPlan != null) {
      progMap[String(p.idInPlan)] = {
        name: p.name ?? "",
        sportType: p.sportType ?? 0,
        duration: p.duration ?? p.estimatedTime ?? 0,
        distance: p.distance ?? p.estimatedDistance ?? 0,
      };
    }
  }

  const entries: ScheduleEntry[] = [];
  for (const e of (d.entities ?? [])) {
    // Completed workouts have sportData with actual stats
    const sd = e.sportData;
    // Future workouts: look up the program definition
    const prog = progMap[String(e.idInPlan)];

    const name: string = sd?.name ?? prog?.name ?? "";
    const sportType: number = sd?.sportType ?? prog?.sportType ?? 0;
    const duration: number = sd?.duration ?? prog?.duration ?? 0;
    const distance: number = sd?.distance ?? prog?.distance ?? 0;
    const labelId: string | undefined = sd?.labelId ?? undefined;
    const trainingLoad: number | undefined = sd?.trainingLoad ?? undefined;

    entries.push({
      happenDay: e.happenDay,
      executeStatus: e.executeStatus ?? 0,
      name,
      sportType,
      duration,
      distance,
      labelId,
      trainingLoad,
    });
  }

  return { planName, entries };
}
