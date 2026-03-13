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
  // 1. Memory cache — fastest path, shared across all concurrent calls
  if (memoryAuth && isTokenFresh(memoryAuth)) return memoryAuth;

  // 2. File cache — persists across process restarts
  const stored = loadAuth();
  if (stored && isTokenFresh(stored)) {
    memoryAuth = stored;
    return memoryAuth;
  }

  // 3. Re-authenticate via env vars — deduplicated so only ONE login happens
  //    even if multiple tool calls arrive simultaneously
  const email = process.env.COROS_EMAIL;
  const password = process.env.COROS_PASSWORD;
  const rawRegion = process.env.COROS_REGION?.toLowerCase();
  const region: Region = rawRegion === "us" || rawRegion === "eu" ? rawRegion : "eu";

  if (email && password) {
    if (!loginPromise) {
      loginPromise = login(email, password, region).finally(() => {
        loginPromise = null;
      });
    }
    memoryAuth = await loginPromise;
    return memoryAuth;
  }

  // 4. Last resort: stale stored token
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
    data: { duration: number; totalSets: number; trainingLoad: number };
  };
  return {
    duration: result.data.duration,
    totalSets: result.data.totalSets,
    trainingLoad: result.data.trainingLoad,
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
