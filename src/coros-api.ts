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
  /** Absolute pace low in s/km (e.g. 270 = 4:30/km). Use with targetType=pace */
  paceLow?: number;
  /** Absolute pace high in s/km (e.g. 300 = 5:00/km). Use with targetType=pace */
  paceHigh?: number;
  /**
   * Pace as % of LTSP — low bound (e.g. 79 = 79%). When set, uses intensityType=3
   * which shows training zone labels in COROS app. Requires ltspSeconds.
   */
  paceLowPercent?: number;
  /**
   * Pace as % of LTSP — high bound (e.g. 86 = 86%). When set, uses intensityType=3.
   */
  paceHighPercent?: number;
  /** HR range low in bpm. Required if targetType=heartrate */
  hrLow?: number;
  /** HR range high in bpm. Required if targetType=heartrate */
  hrHigh?: number;
  /** HR as % of LTHR — low bound (e.g. 90 = 90%). When set, uses isIntensityPercent=true */
  hrLowPercent?: number;
  /** HR as % of LTHR — high bound (e.g. 95 = 95%). */
  hrHighPercent?: number;
  /** Repeat this step N times using a group (native COROS structure) */
  repeat?: number;
  /** Rest time in seconds between repeat sets (default: 0) */
  repeatRestSeconds?: number;
}

// exerciseType codes confirmed from COROS API (via /training/program/calculate response):
// 1=warmup, 2=active/interval, 3=cooldown, 4=rest
const RUN_EXERCISE_TYPE: Record<RunStepType, number> = {
  warmup: 1,
  active: 2,
  interval: 2,  // interval sprints are active steps (same type)
  rest: 4,
  cooldown: 3,
};

// targetType codes confirmed from COROS API:
// 0=open, 1=training_load, 2=time (seconds), 5=distance (centimeters)
const RUN_DURATION_TYPE: Record<RunDurationType, number> = {
  open: 0,
  training_load: 1,
  time: 2,
  distance: 5,
};

// Native COROS T-code names — COROS app recognizes these and shows localized labels
const RUN_STEP_NAMES: Record<RunStepType, string> = {
  warmup: "T1120",
  active: "T3001",
  rest: "T3001",
  cooldown: "T1122",
  interval: "T3001",
};

const RUN_STEP_OVERVIEWS: Record<RunStepType, string> = {
  warmup: "sid_run_warm_up_dist",
  active: "sid_run_training",
  rest: "sid_run_rest_time",
  cooldown: "sid_run_cool_down_dist",
  interval: "sid_run_training",
};

// Template originIds from COROS exercise catalog (US region)
const RUN_STEP_ORIGIN_IDS: Record<RunStepType, string> = {
  warmup: "425895398452936705",
  active: "426109589008859136",
  rest: "425895332954685440",
  cooldown: "425895456971866112",
  interval: "426109589008859136",
};

// sortNo spacing: top-level blocks use multiples of 16M (0x1000000)
// children inside a group use blockSortNo + childIndex * 64K (0x10000)
const BLOCK_SPACING = 16777216;
const CHILD_SPACING = 65536;

/**
 * Maps a pace % to COROS training zone (intensityCustom field).
 * Confirmed from native workouts: 79-86%→1, 93-97%→3, 103-112%→5
 */
function getIntensityZone(lowPct: number): number {
  if (lowPct >= 103) return 5;  // VO2max
  if (lowPct >= 98) return 4;   // Threshold
  if (lowPct >= 92) return 3;   // Tempo
  if (lowPct >= 87) return 2;   // Aerobic
  return 1;                      // Easy
}

/**
 * Builds intensity fields for a running step.
 *
 * isInGroup: when true (child of a group container), pace values are in ms/km
 * with intensityMultiplier=1000. When false (regular top-level step), pace values
 * are in s/km with intensityMultiplier=0. This matches native COROS data exactly.
 *
 * intensityType:
 *   0 = open (no target)
 *   1 = absolute pace → shows pace on watch, no zone label
 *   2 = heartrate (bpm or % of LTHR)
 *   3 = % of LTSP pace → shows zone label in COROS app
 */
function buildRunIntensity(
  step: RunStep,
  ltspMs: number | null,
  isInGroup = false
): {
  intensityType: number;
  intensityValue: number;
  intensityValueExtend: number;
  intensityPercent: number;
  intensityPercentExtend: number;
  intensityMultiplier: number;
  intensityDisplayUnit: number;
  intensityCustom: number;
  hrType: number;
  isIntensityPercent: boolean;
} {
  const base = {
    intensityType: 0,
    intensityValue: 0,
    intensityValueExtend: 0,
    intensityPercent: 0,
    intensityPercentExtend: 0,
    intensityMultiplier: 0,
    intensityDisplayUnit: 0,
    intensityCustom: 0,
    hrType: 0,
    isIntensityPercent: false,
  };

  const tgt = step.targetType ?? "open";

  if (tgt === "pace") {
    // Percentage-based pace (intensityType=3): shows zone label in COROS app
    if ((step.paceLowPercent != null || step.paceHighPercent != null) && ltspMs != null) {
      const lowPct = step.paceLowPercent ?? step.paceHighPercent ?? 80;
      const highPct = step.paceHighPercent ?? step.paceLowPercent ?? 80;

      // In COROS: higher % = faster pace = smaller s/km value
      // intensityValue  = faster end = LTSP / (highPct/100)  [e.g. 86% → 280 s/km]
      // intensityValueExtend = slower end = LTSP / (lowPct/100) [e.g. 79% → 305 s/km]
      const fasterMs = Math.round(ltspMs / (highPct / 100));
      const slowerMs = Math.round(ltspMs / (lowPct / 100));

      // Native COROS: group children use ms/km (multiplier=1000),
      // regular top-level steps use s/km (multiplier=0)
      const multiplier = isInGroup ? 1000 : 0;
      const faster = isInGroup ? fasterMs : Math.round(fasterMs / 1000);
      const slower = isInGroup ? slowerMs : Math.round(slowerMs / 1000);

      return {
        ...base,
        intensityType: 3,
        intensityValue: faster,
        intensityValueExtend: slower,
        intensityPercent: lowPct * 1000,
        intensityPercentExtend: highPct * 1000,
        intensityMultiplier: multiplier,
        intensityDisplayUnit: 1, // min/km
        intensityCustom: getIntensityZone(lowPct),
        isIntensityPercent: true,
      };
    }
    // Absolute pace (intensityType=1): always in ms/km with multiplier=1000
    if (step.paceLow != null || step.paceHigh != null) {
      const fasterMs = (step.paceLow ?? step.paceHigh ?? 300) * 1000;
      const slowerMs = (step.paceHigh ?? step.paceLow ?? 300) * 1000;
      return {
        ...base,
        intensityType: 1,
        intensityValue: fasterMs,
        intensityValueExtend: slowerMs,
        intensityMultiplier: 1000,
        intensityDisplayUnit: 1,
      };
    }
  } else if (tgt === "heartrate") {
    if (step.hrLowPercent != null || step.hrHighPercent != null) {
      const lowPct = step.hrLowPercent ?? step.hrHighPercent ?? 80;
      const highPct = step.hrHighPercent ?? step.hrLowPercent ?? 80;
      return {
        ...base,
        intensityType: 2,
        intensityValue: 0,
        intensityValueExtend: 0,
        intensityPercent: lowPct * 1000,
        intensityPercentExtend: highPct * 1000,
        intensityCustom: 2,
        hrType: 3,
        isIntensityPercent: true,
      };
    }
    if (step.hrLow != null || step.hrHigh != null) {
      return {
        ...base,
        intensityType: 2,
        intensityValue: step.hrLow ?? step.hrHigh ?? 0,
        intensityValueExtend: step.hrHigh ?? step.hrLow ?? 0,
        hrType: 0,
      };
    }
  }

  return base;
}

function buildRunStep(
  step: RunStep,
  sortNo: number,
  groupId: string,
  ltspMs: number | null,
  isInGroup = false
): Record<string, unknown> {
  const intensity = buildRunIntensity(step, ltspMs, isInGroup);

  let targetValue: number;
  if (step.durationType === "open") {
    targetValue = 0;
  } else if (step.durationType === "distance") {
    targetValue = step.durationValue * 100; // meters → centimeters
  } else {
    targetValue = step.durationValue;
  }

  const isDistance = step.durationType === "distance";

  return {
    id: String(sortNo),
    name: RUN_STEP_NAMES[step.type],
    overview: RUN_STEP_OVERVIEWS[step.type],
    originId: RUN_STEP_ORIGIN_IDS[step.type],
    exerciseType: RUN_EXERCISE_TYPE[step.type],
    sets: 1,
    targetType: RUN_DURATION_TYPE[step.durationType],
    targetValue,
    targetDisplayUnit: isDistance ? 1 : 0,
    ...intensity,
    restValue: 0,
    restType: 3, // 3=none
    sortNo,
    defaultOrder: 0,
    groupId,
    isGroup: false,
    isDefaultAdd: 0,
    sportType: 1,
    status: 1,
    videoInfos: [],
  };
}

function buildRunningPayload(
  name: string,
  overview: string,
  steps: RunStep[],
  ltspSeconds?: number
): object {
  const ltspMs = ltspSeconds != null ? ltspSeconds * 1000 : null;

  const exercises: Record<string, unknown>[] = [];
  let blockIndex = 0;

  for (const step of steps) {
    const repeat = step.repeat ?? 1;
    const restSec = step.repeatRestSeconds ?? 0;
    blockIndex++;
    const blockSortNo = blockIndex * BLOCK_SPACING;

    if (repeat > 1) {
      // Native COROS group structure: container (exerciseType=0) + child steps
      // Container id is used as groupId by children — server resolves relationship on save
      const containerId = String(blockSortNo);

      // Container targetValue = total duration/distance of ONE iteration
      let containerTargetType: number;
      let containerTargetValue: number;
      if (step.durationType === "distance") {
        containerTargetType = 5; // distance in cm
        // Include recovery distance only if it makes sense (e.g., fixed distance recovery)
        // For simplicity, use just the interval distance as container target
        containerTargetValue = step.durationValue * 100;
      } else {
        containerTargetType = 2; // time in seconds
        containerTargetValue = step.durationValue + restSec;
      }

      // Group container — exerciseType=0, sportType=0 (confirmed from native COROS workouts)
      exercises.push({
        id: containerId,
        name: "",
        overview: "",
        exerciseType: 0,
        isGroup: true,
        sets: repeat,
        groupId: "0",
        sortNo: blockSortNo,
        targetType: containerTargetType,
        targetValue: containerTargetValue,
        targetDisplayUnit: 0,
        intensityType: 0,
        intensityValue: 0,
        intensityValueExtend: 0,
        intensityPercent: 0,
        intensityPercentExtend: 0,
        intensityMultiplier: 0,
        intensityDisplayUnit: 0,
        intensityCustom: 0,
        hrType: 0,
        isIntensityPercent: false,
        restValue: 0,
        restType: 0,
        defaultOrder: 0,
        isDefaultAdd: 0,
        sportType: 0,  // container is sportType=0 (confirmed)
        status: 1,
        videoInfos: [],
      });

      // Child 1: the interval step (intensity in ms/km units since isInGroup=true)
      exercises.push(buildRunStep(step, blockSortNo + CHILD_SPACING, containerId, ltspMs, true));

      // Child 2: recovery jog (if rest specified and time-based)
      if (restSec > 0 && step.durationType !== "distance") {
        exercises.push({
          id: String(blockSortNo + CHILD_SPACING * 2),
          name: "T3001",
          overview: "sid_run_rest_time",
          originId: "425895332954685440",
          exerciseType: 2,
          isGroup: false,
          sets: 1,
          groupId: containerId,
          sortNo: blockSortNo + CHILD_SPACING * 2,
          targetType: 2,        // time
          targetValue: restSec,
          targetDisplayUnit: 0,
          intensityType: 0,
          intensityValue: 0,
          intensityValueExtend: 0,
          intensityPercent: 0,
          intensityPercentExtend: 0,
          intensityMultiplier: 0,
          intensityDisplayUnit: 0,
          intensityCustom: 0,
          hrType: 0,
          isIntensityPercent: false,
          restValue: 0,
          restType: 3,
          defaultOrder: 0,
          isDefaultAdd: 0,
          sportType: 1,
          status: 1,
          videoInfos: [],
        });
      }
    } else {
      // Single step (no repeat) — regular step outside any group
      exercises.push(buildRunStep(step, blockSortNo, "0", ltspMs, false));
    }
  }

  // Estimate total duration
  const totalDurationSec = steps.reduce((sum, step) => {
    const repeat = step.repeat ?? 1;
    if (step.durationType === "time") return sum + step.durationValue * repeat;
    const paceSkm = step.paceLow ?? step.paceHigh ?? 300;
    return sum + Math.round((step.durationValue / 1000) * paceSkm) * repeat;
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
  steps: RunStep[],
  ltspSecondsOverride?: number
): Promise<{ duration: number; totalSteps: number; ltspUsed?: number }> {
  const needsLtsp = steps.some(
    (s) => s.paceLowPercent != null || s.paceHighPercent != null
  );

  // Priority: explicit arg > env var > COROS profile
  let ltspSeconds: number | undefined = ltspSecondsOverride;
  if (!ltspSeconds && process.env.COROS_LTSP) {
    const parsed = parseInt(process.env.COROS_LTSP, 10);
    if (!isNaN(parsed) && parsed > 0) ltspSeconds = parsed;
  }

  if (needsLtsp && !ltspSeconds) {
    // Try to fetch LTSP from user's analytics profile
    try {
      const metrics = await queryAnalytics(auth);
      if (metrics.today.ltsp) ltspSeconds = metrics.today.ltsp;
    } catch {
      // Will throw below if still missing
    }

    if (!ltspSeconds) {
      throw new Error(
        "Pace % requer o LTSP (pace de limiar). Configure-o de uma das formas:\n" +
        "1. Variável de ambiente COROS_LTSP no mcp.json (ex: \"241\" para 4:01/km)\n" +
        "2. Parâmetro 'ltspSeconds' no tool (ex: 241)\n" +
        "3. No app COROS: Perfil → Dados Fisiológicos → Pace de Limiar Anaeróbico"
      );
    }
  }

  const payload = buildRunningPayload(name, overview, steps, ltspSeconds);

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
    ltspUsed: ltspSeconds,
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

export async function queryWorkoutDetail(
  auth: AuthData,
  workoutId: string
): Promise<unknown> {
  return apiPost(auth, "/training/program/detail/query", { id: workoutId });
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

export interface DashboardWeekRecord {
  totalValue: number;
  totalTarget: number;
  percentage: number;
}

export interface DashboardActivity {
  happenDay: number;
  distance: number;    // meters
  duration: number;    // seconds
  avgPace: number;     // s/km
  avgHeartRate: number;
  trainingLoad: number;
  sportType: number;
  mode: number;
}

export interface DashboardTarget {
  happenDay: number;
  name: string;
  estimatedValue: number; // training load estimate
}

export interface DashboardData {
  distanceRecord: DashboardWeekRecord;
  durationRecord: DashboardWeekRecord;
  tlRecord: DashboardWeekRecord;
  activities: DashboardActivity[];
  targets: DashboardTarget[];
}

export async function queryDashboard(auth: AuthData): Promise<DashboardData> {
  // dashboard/detail/query only works on the US global endpoint
  const urls = [REGION_URLS[auth.region], REGION_URLS["us"]];
  let raw: Record<string, unknown> | null = null;

  for (const base of [...new Set(urls)]) {
    const res = await fetch(`${base}/dashboard/detail/query`, {
      headers: apiHeaders(auth),
    });
    const json = await res.json() as { result: string; data?: Record<string, unknown> };
    if (json.result === "0000" && json.data) {
      raw = json.data;
      break;
    }
  }

  if (!raw) {
    throw new Error("Não foi possível obter dados do dashboard. Tente autenticar novamente.");
  }

  const weekRec = raw.currentWeekRecord as Record<string, { totalValue: number; totalTarget: number; percentage: number }> | undefined ?? {};
  const actList = (raw.sportDataList as Array<Record<string, unknown>> | undefined) ?? [];
  const tgtList = (raw.targetList as Array<Record<string, unknown>> | undefined) ?? [];

  const toRecord = (key: string): DashboardWeekRecord => ({
    totalValue: weekRec[key]?.totalValue ?? 0,
    totalTarget: weekRec[key]?.totalTarget ?? 0,
    percentage: weekRec[key]?.percentage ?? 0,
  });

  return {
    distanceRecord: toRecord("distanceRecord"),
    durationRecord: toRecord("durationRecord"),
    tlRecord: toRecord("tlRecord"),
    activities: actList.map((a) => ({
      happenDay: Number(a.happenDay ?? 0),
      distance: Number(a.distance ?? 0),
      duration: Number(a.duration ?? 0),
      avgPace: Number(a.avgPace ?? 0),
      avgHeartRate: Number(a.avgHeartRate ?? 0),
      trainingLoad: Number(a.trainingLoad ?? 0),
      sportType: Number(a.sportType ?? 0),
      mode: Number(a.mode ?? 0),
    })),
    targets: tgtList.map((t) => ({
      happenDay: Number(t.happenDay ?? 0),
      name: String(t.name ?? ""),
      estimatedValue: Number(t.estimatedValue ?? 0),
    })),
  };
}

// ─── Dashboard Summary (fitness scores, PRs, predictions) ───────────────────

export interface PersonalRecord {
  type: number;      // distance code (3=15km, 4=10km, 5=5km, 6=3km, 7=1km, 8=1mi, ...)
  record: number;    // seconds (duration PR) or s/km (pace PR)
  distance: number;  // meters
  site: string;      // activity name where PR was set
  happenDay: number; // YYYYMMDD
}

export interface RunScorePrediction {
  type: number;   // 1=long endurance, 2=medium, 4=threshold, 5=speed
  avgPace: number; // s/km
  duration: number; // seconds
}

export interface DashboardSummaryData {
  aerobicEnduranceScore: number;
  aerobicEnduranceScoreChange: number;
  anaerobicCapacityScore: number;
  anaerobicCapacityScoreChange: number;
  anaerobicEnduranceScore: number;
  anaerobicEnduranceScoreChange: number;
  lactateThresholdCapacityScore: number;
  lactateThresholdCapacityScoreChange: number;
  recoveryPct: number;
  recoveryState: number;
  fullRecoveryHours: number;
  personalRecords: PersonalRecord[]; // all-time PRs sorted by distance
  runScorePredictions: RunScorePrediction[];
  totalActivities: number;
}

export async function queryDashboardSummary(auth: AuthData): Promise<DashboardSummaryData> {
  const urls = [REGION_URLS[auth.region], REGION_URLS["us"]];
  let raw: Record<string, unknown> | null = null;

  for (const base of [...new Set(urls)]) {
    const res = await fetch(`${base}/dashboard/query`, { headers: apiHeaders(auth) });
    const json = await res.json() as { result: string; data?: Record<string, unknown> };
    if (json.result === "0000" && json.data) {
      raw = json.data;
      break;
    }
  }

  if (!raw) throw new Error("dashboard/query failed");

  const si = raw.summaryInfo as Record<string, unknown> | undefined ?? {};
  const sportDataSummary = raw.sportDataSummary as Record<string, unknown> | undefined ?? {};

  // recordDetailList[3] = type 4 = all-time sorted (best PRs per distance)
  const allRecordGroups = (si.recordDetailList as Array<{ type: number; recordList: PersonalRecord[] }> | undefined) ?? [];
  const allTimeSorted = allRecordGroups.find((g) => g.type === 4);
  const prs: PersonalRecord[] = (allTimeSorted?.recordList ?? []).filter(
    (r) => r.distance > 0 && r.record > 0 && r.type >= 2 && r.type <= 12
  );

  const runScores = (si.runScoreList as Array<Record<string, unknown>> | undefined) ?? [];

  return {
    aerobicEnduranceScore: Number(si.aerobicEnduranceScore ?? 0),
    aerobicEnduranceScoreChange: Number(si.aerobicEnduranceScoreChange ?? 0),
    anaerobicCapacityScore: Number(si.anaerobicCapacityScore ?? 0),
    anaerobicCapacityScoreChange: Number(si.anaerobicCapacityScoreChange ?? 0),
    anaerobicEnduranceScore: Number(si.anaerobicEnduranceScore ?? 0),
    anaerobicEnduranceScoreChange: Number(si.anaerobicEnduranceScoreChange ?? 0),
    lactateThresholdCapacityScore: Number(si.lactateThresholdCapacityScore ?? 0),
    lactateThresholdCapacityScoreChange: Number(si.lactateThresholdCapacityScoreChange ?? 0),
    recoveryPct: Number(si.recoveryPct ?? 0),
    recoveryState: Number(si.recoveryState ?? 0),
    fullRecoveryHours: Number(si.fullRecoveryHours ?? 0),
    personalRecords: prs,
    runScorePredictions: runScores.map((r) => ({
      type: Number(r.type ?? 0),
      avgPace: Number(r.avgPace ?? 0),
      duration: Number(r.duration ?? 0),
    })),
    totalActivities: Number(sportDataSummary.count ?? 0),
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

// Region code for CPL-coros-region cookie (EU=3, US=1)
function regionCode(region: string): number {
  return region === "us" ? 1 : 3;
}

/** Browser-like headers that mimic COROS Training Hub requests (required for write ops on schedule) */
function browserHeaders(auth: AuthData): Record<string, string> {
  const origin = auth.region === "us"
    ? "https://training.coros.com"
    : "https://trainingeu.coros.com";
  return {
    "Content-Type": "application/json",
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    accesstoken: auth.accessToken,
    yfheader: JSON.stringify({ userId: auth.userId }),
    Cookie: `CPL-coros-token=${auth.accessToken}; CPL-coros-region=${regionCode(auth.region)}`,
    origin,
    referer: `${origin}/`,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
}

export async function scheduleWorkout(
  auth: AuthData,
  workoutId: string,
  date: string // YYYYMMDD
): Promise<void> {
  const apiUrl = REGION_URLS[auth.region];

  // Step 1: fetch the full program detail via GET /training/program/detail
  // (matches the web app's fetchProgramDetail: GET /training/program/detail?id=...&supportRestExercise=1)
  const detailRes = await fetch(
    `${apiUrl}/training/program/detail?id=${workoutId}&supportRestExercise=1`,
    { method: "GET", headers: apiHeaders(auth) }
  );
  const detailData = await detailRes.json() as { result: string; message?: string; data?: Record<string, unknown> };
  if (detailData.result !== "0000") {
    if (AUTH_ERROR_CODES.has(detailData.result)) {
      throw new Error(`COROS auth error (/training/program/detail): token invalid or expired. Use authenticate_coros to re-login.`);
    }
    throw new Error(`COROS API error (/training/program/detail): ${detailData.message || detailData.result} — make sure the workout ID is valid (use list_workouts to get IDs).`);
  }
  const program = detailData.data as Record<string, unknown>;

  // Step 2: query the current schedule to get maxIdInPlan
  const now = new Date();
  const past = new Date(now); past.setDate(now.getDate() - 90);
  const future = new Date(now); future.setDate(now.getDate() + 90);
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  const schedRes = await fetch(
    `${apiUrl}/training/schedule/query?startDate=${fmt(past)}&endDate=${fmt(future)}&supportRestExercise=1`,
    { method: "GET", headers: apiHeaders(auth) }
  );
  const schedData = await schedRes.json() as {
    result: string;
    data?: {
      entities?: Array<{ happenDay: number; idInPlan: string | number; sortNoInSchedule: number }>;
      programs?: Array<{ idInPlan: string | number }>;
      maxIdInPlan?: number;
    };
  };

  const entities = schedData.data?.entities ?? [];
  const programsInPlan = schedData.data?.programs ?? [];

  // Use server-provided maxIdInPlan if available, otherwise compute from data
  let maxIdInPlan = schedData.data?.maxIdInPlan ?? 0;
  if (!maxIdInPlan) {
    for (const e of entities) {
      const v = Number(e.idInPlan);
      if (v > maxIdInPlan) maxIdInPlan = v;
    }
    for (const p of programsInPlan) {
      const v = Number(p.idInPlan);
      if (v > maxIdInPlan) maxIdInPlan = v;
    }
  }

  const idInPlan = maxIdInPlan + 1;

  // Count existing entries on the target date to determine sortNoInSchedule
  const targetDay = Number(date);
  const existingOnDate = entities.filter((e) => Number(e.happenDay) === targetDay);
  const sortNoInSchedule = existingOnDate.length > 0
    ? Math.max(...existingOnDate.map((e) => Number(e.sortNoInSchedule))) + 1
    : 1;

  // Step 3: build the schedule update payload
  // Exact format from COROS Training Hub source (addProgram function):
  //   entities: [{ happenDay, idInPlan, sortNoInSchedule }]
  //   programs: [<full program with idInPlan set>]
  //   versionObjects: [{ id: idInPlan, status: 1 }]  ← required, was missing before
  //   pbVersion: 2  ← required, was missing before
  const schedProgram = { ...program, idInPlan };

  const payload = {
    entities: [{ happenDay: Number(date), idInPlan, sortNoInSchedule }],
    programs: [schedProgram],
    versionObjects: [{ id: idInPlan, status: 1 }],
    pbVersion: 2,
  };

  const updateRes = await fetch(`${apiUrl}/training/schedule/update`, {
    method: "POST",
    headers: apiHeaders(auth),
    body: JSON.stringify(payload),
  });
  const updateData = await updateRes.json() as { result: string; message?: string };
  if (updateData.result !== "0000") {
    if (AUTH_ERROR_CODES.has(updateData.result)) {
      throw new Error(`COROS auth error (/training/schedule/update): token invalid or expired. Use authenticate_coros to re-login.`);
    }
    throw new Error(`COROS API error (/training/schedule/update): ${updateData.message || updateData.result}`);
  }
}

export async function removeScheduledWorkout(
  auth: AuthData,
  idInPlan: string // the idInPlan of the scheduled entry to remove
): Promise<void> {
  const apiUrl = REGION_URLS[auth.region];

  // Query a wide schedule range to find the entity and its planId
  const now = new Date();
  const past = new Date(now); past.setDate(now.getDate() - 90);
  const future = new Date(now); future.setDate(now.getDate() + 90);
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  const schedRes = await fetch(
    `${apiUrl}/training/schedule/query?startDate=${fmt(past)}&endDate=${fmt(future)}&supportRestExercise=1`,
    { method: "GET", headers: apiHeaders(auth) }
  );
  const schedData = await schedRes.json() as {
    result: string;
    data?: {
      entities?: Array<{ idInPlan: string | number; planId?: string | number }>;
    };
  };

  if (schedData.result !== "0000") {
    throw new Error(`COROS API error (/training/schedule/query): ${(schedData as { message?: string }).message || schedData.result}`);
  }

  const entities = schedData.data?.entities ?? [];
  const entity = entities.find((e) => String(e.idInPlan) === String(idInPlan));

  if (!entity) {
    throw new Error(`Entrada com idInPlan=${idInPlan} não encontrada na agenda. Use inspect_schedule_raw para ver os idInPlan disponíveis.`);
  }

  const planId = String(entity.planId ?? "");
  if (!planId) {
    throw new Error(`planId não encontrado para idInPlan=${idInPlan}.`);
  }

  const payload = {
    versionObjects: [{ id: String(idInPlan), planProgramId: String(idInPlan), planId, status: 3 }],
    pbVersion: 2,
  };

  const updateRes = await fetch(`${apiUrl}/training/schedule/update`, {
    method: "POST",
    headers: apiHeaders(auth),
    body: JSON.stringify(payload),
  });
  const updateData = await updateRes.json() as { result: string; message?: string };
  if (updateData.result !== "0000") {
    if (AUTH_ERROR_CODES.has(updateData.result)) {
      throw new Error(`COROS auth error (/training/schedule/update): token invalid or expired. Use authenticate_coros to re-login.`);
    }
    throw new Error(`COROS API error (/training/schedule/update): ${updateData.message || updateData.result}`);
  }
}

export async function queryScheduleRaw(
  startDate: string,
  endDate: string,
  auth: { accessToken: string; userId: string; region: string }
): Promise<unknown> {
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
  return res.json();
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

// ── User Profile ──────────────────────────────────────────────────────────────

export async function getUserProfile(
  auth: AuthData
): Promise<string> {
  // /account/query only works on teamapi.coros.com (US global endpoint)
  const urls = [REGION_URLS[auth.region], REGION_URLS["us"]];
  let data: Record<string, unknown> | null = null;

  for (const base of [...new Set(urls)]) {
    const res = await fetch(`${base}/account/query?userId=${auth.userId}`, {
      method: "GET",
      headers: apiHeaders(auth),
    });
    const json = await res.json() as { result: string; data?: Record<string, unknown> };
    if (json.result === "0000" && json.data) {
      data = json.data;
      break;
    }
  }

  if (!data) {
    throw new Error("Não foi possível obter os dados do perfil. Tente autenticar novamente.");
  }

  const fmtPace = (sPerKm: number) => {
    if (!sPerKm || sPerKm <= 0) return "—";
    const m = Math.floor(sPerKm / 60);
    const s = sPerKm % 60;
    return `${m}:${String(s).padStart(2, "0")}/km`;
  };

  const fmtBirthday = (b: number) => {
    const s = String(b);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  };

  const z = data.zoneData as Record<string, unknown> | undefined ?? {};
  const ltspZones = (z.ltspZone as Array<{ index: number; pace: number; ratio: number }> | undefined) ?? [];
  const lthrZones = (z.lthrZone as Array<{ index: number; hr: number; ratio: number }> | undefined) ?? [];

  const zoneLabels = ["Z1 Easy", "Z2 Aeróbico", "Z3 Tempo", "Z4 Limiar", "Z5 VO2max"];

  const ltspRows = ltspZones.slice(0, 5).map((z, i) =>
    `  ${zoneLabels[i] ?? `Z${i + 1}`}: ${fmtPace(z.pace)} (${z.ratio}% LTSP)`
  ).join("\n");

  const lthrRows = lthrZones.slice(0, 5).map((z, i) =>
    `  ${zoneLabels[i] ?? `Z${i + 1}`}: <${z.hr} bpm (${z.ratio}% LTHR)`
  ).join("\n");

  const sex = data.sex === 0 ? "Masculino" : "Feminino";
  const birthday = data.birthday ? fmtBirthday(Number(data.birthday)) : "—";

  return [
    `👤 **Perfil: ${data.nickname ?? "—"}**`,
    `📧 ${data.email ?? "—"}  |  ${sex}  |  Nascimento: ${birthday}`,
    `📍 País: ${data.countryCode ?? "—"}`,
    ``,
    `📏 **Dados Físicos**`,
    `  Altura: ${data.stature ?? "—"} cm`,
    `  Peso:   ${data.weight ?? "—"} kg`,
    ``,
    `❤️ **Métricas Cardíacas**`,
    `  FC Máx:   ${data.maxHr ?? z.maxHr ?? "—"} bpm`,
    `  FC Repouso: ${data.rhr ?? z.rhr ?? "—"} bpm`,
    `  LTHR (Limiar):  ${z.lthr ?? "—"} bpm`,
    ``,
    `🏃 **Métricas de Corrida**`,
    `  LTSP (Pace limiar): ${fmtPace(Number(z.ltsp ?? 0))}`,
    `  FTP (Ciclismo):     ${z.ftp ?? "—"} W`,
    ``,
    `🏃 **Zonas de Pace (LTSP)**`,
    ltspRows || "  Não disponível",
    ``,
    `❤️ **Zonas de FC (LTHR)**`,
    lthrRows || "  Não disponível",
  ].join("\n");
}
