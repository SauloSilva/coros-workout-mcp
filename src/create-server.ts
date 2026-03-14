import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import {
  login,
  getValidAuth,
  clearAuthCache,
  resolveExercises,
  calculateWorkout,
  addWorkout,
  queryWorkouts,
  queryActivities,
  queryActivityDetail,
  queryActivityDetailFull,
  queryAnalytics,
  querySchedule,
  queryScheduleRaw,
  scheduleWorkout,
  activityModeName,
  fmtDate,
  fmtDuration,
  fmtPace,
  tiredStateLabel,
  performanceLabel,
  feelLabel,
  ZONE_TYPE_LABELS,
  queryExerciseCatalog,
  fetchI18nStrings,
  buildCatalogFromRaw,
  createRunningWorkout,
} from "./coros-api.js";
import type { RunStep, RunStepType, RunTargetType, RunDurationType } from "./coros-api.js";
import {
  searchExercises,
  findByName,
  findByCodeName,
  findById,
  getAllExercises,
  reloadCatalog,
  getCatalogPath,
} from "./exercise-catalog.js";
import { PartCode } from "./types.js";
import type { Region } from "./types.js";

export function createCorosServer(): McpServer {
  const server = new McpServer({
    name: "coros-workout",
    version: "1.0.0",
  });

  server.tool(
    "authenticate_coros",
    "Log in to COROS Training Hub. Stores auth token for subsequent calls. Also checks COROS_EMAIL/COROS_PASSWORD env vars for auto-login. WARNING: Logging in via API invalidates the web app session.",
    {
      email: z.string().email().optional().describe("COROS account email (optional if env vars set)"),
      password: z.string().optional().describe("COROS account password (optional if env vars set)"),
      region: z.enum(["us", "eu"]).default("eu").describe("API region: 'us' or 'eu'"),
    },
    async ({ email, password, region }) => {
      try {
        const loginEmail = email || process.env.COROS_EMAIL;
        const loginPassword = password || process.env.COROS_PASSWORD;
        const loginRegion = (region || process.env.COROS_REGION || "eu") as Region;

        if (!loginEmail || !loginPassword) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No credentials provided. Set COROS_EMAIL and COROS_PASSWORD environment variables, or provide email and password parameters.",
              },
            ],
          };
        }

        // Clear cache so this explicit login becomes the new source of truth
      clearAuthCache();
      const auth = await login(loginEmail, loginPassword, loginRegion);
        return {
          content: [
            {
              type: "text" as const,
              text: `Authenticated successfully. User ID: ${auth.userId}, Region: ${auth.region}. Token stored at ~/.config/coros-workout-mcp/auth.json`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Authentication failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "check_coros_auth",
    "Check if COROS authentication is available (from stored token or env vars).",
    {},
    async () => {
      const auth = await getValidAuth();
      if (auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Authenticated. User ID: ${auth.userId}, Region: ${auth.region}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "Not authenticated. Use authenticate_coros tool or set COROS_EMAIL/COROS_PASSWORD env vars.",
          },
        ],
      };
    }
  );

  server.tool(
    "search_exercises",
    "Search the COROS exercise catalog (~383 strength exercises). Filter by name, muscle group, body part, and/or equipment. Returns exercise names, muscles, equipment, and default sets/reps.",
    {
      query: z.string().optional().describe("Search by exercise name (partial match, e.g. 'bench press')"),
      muscle: z.string().optional().describe("Filter by muscle group (e.g. 'chest', 'biceps', 'glutes', 'quadriceps')"),
      bodyPart: z.string().optional().describe("Filter by body part (e.g. 'legs', 'arms', 'core', 'chest', 'back', 'shoulders')"),
      equipment: z.string().optional().describe("Filter by equipment (e.g. 'bodyweight', 'dumbbells', 'barbells', 'kettlebell', 'bands')"),
      limit: z.number().int().min(1).max(50).default(20).describe("Max results to return"),
    },
    async ({ query, muscle, bodyPart, equipment, limit }) => {
      const results = searchExercises({ query, muscle, bodyPart, equipment });
      const limited = results.slice(0, limit);

      if (limited.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No exercises found matching your search criteria.",
            },
          ],
        };
      }

      const formatted = limited.map((e) => {
        const lines = [
          `**${e.name}**`,
          `  Muscles: ${e.muscleText}${e.secondaryMuscleText ? ` (secondary: ${e.secondaryMuscleText})` : ""}`,
          `  Body parts: ${e.partText}`,
          `  Equipment: ${e.equipmentText}`,
          `  Defaults: ${e.sets} sets x ${e.targetValue} ${e.targetType === 3 ? "reps" : "seconds"}, ${e.restValue}s rest`,
        ];
        return lines.join("\n");
      });

      const header = `Found ${results.length} exercises${results.length > limit ? ` (showing first ${limit})` : ""}:\n`;
      return {
        content: [
          {
            type: "text" as const,
            text: header + formatted.join("\n\n"),
          },
        ],
      };
    }
  );

  const ExerciseInputSchema = z.object({
    name: z.string().describe("Exercise name (must match catalog exactly, e.g. 'Push-ups', 'Squats')"),
    sets: z.number().int().min(1).optional().describe("Number of sets (defaults to catalog value)"),
    reps: z.number().int().min(1).optional().describe("Reps per set (defaults to catalog value)"),
    duration: z.number().int().min(1).optional().describe("Duration in seconds per set (alternative to reps)"),
    restSeconds: z.number().int().min(0).optional().describe("Rest between sets in seconds (defaults to catalog value)"),
    weightKg: z.number().min(0).optional().describe("Weight in kg (e.g. 20 for 20kg)"),
  });

  server.tool(
    "create_workout",
    "Create a strength workout on COROS Training Hub. Resolves exercise names from the catalog, builds the full API payload, calculates metrics, and saves the workout. The workout will sync to the user's COROS watch.",
    {
      name: z.string().describe("Workout name (e.g. 'Upper Body Push')"),
      overview: z.string().default("").describe("Workout description"),
      exercises: z.array(ExerciseInputSchema).min(1).describe("Array of exercises with optional overrides"),
    },
    async ({ name, overview, exercises }) => {
      try {
        const auth = await getValidAuth();
        if (!auth) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Not authenticated. Use authenticate_coros first.",
              },
            ],
            isError: true,
          };
        }

        const missing: string[] = [];
        for (const ex of exercises) {
          if (!findByName(ex.name)) {
            missing.push(ex.name);
          }
        }
        if (missing.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Exercises not found in catalog: ${missing.map((n) => `"${n}"`).join(", ")}. Use search_exercises to find the correct names.`,
              },
            ],
            isError: true,
          };
        }

        const exercisePayloads = resolveExercises(exercises);
        const calculated = await calculateWorkout(auth, name, overview, exercisePayloads);
        await addWorkout(auth, name, overview, exercisePayloads, calculated);

        const totalSets = exercises.reduce(
          (sum, ex) => sum + (ex.sets ?? findByName(ex.name)!.sets),
          0
        );
        const exerciseSummary = exercises
          .map((ex) => {
            const catalog = findByName(ex.name)!;
            const sets = ex.sets ?? catalog.sets;
            const target = ex.reps ?? ex.duration ?? catalog.targetValue;
            const unit = (ex.reps || (!ex.duration && catalog.targetType === 3)) ? "reps" : "s";
            const weight = ex.weightKg ? ` @ ${ex.weightKg}kg` : "";
            return `  ${ex.name}: ${sets}x${target}${unit}${weight}`;
          })
          .join("\n");

        const durationMin = Math.round(calculated.duration / 60);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Workout "${name}" created successfully!`,
                `Duration: ~${durationMin} min | Sets: ${calculated.totalSets} | Training load: ${calculated.trainingLoad}`,
                ``,
                `Exercises:`,
                exerciseSummary,
                ``,
                `The workout will sync to your COROS watch.`,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create workout: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "update_exercises",
    "Fetch the latest exercise catalog from COROS APIs and rebuild the local catalog. Requires authentication. Fetches exercises from the COROS API and i18n strings for human-readable names.",
    {
      sportType: z
        .number()
        .int()
        .default(4)
        .describe("Sport type to fetch exercises for (default 4 = strength)"),
    },
    async ({ sportType }) => {
      try {
        const auth = await getValidAuth();
        if (!auth) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Not authenticated. Use authenticate_coros first.",
              },
            ],
            isError: true,
          };
        }

        let oldExercises: ReturnType<typeof getAllExercises> = [];
        let oldNames: Set<string>;
        try {
          oldExercises = getAllExercises();
          oldNames = new Set(oldExercises.map((e) => e.name));
        } catch {
          oldNames = new Set();
        }

        const [rawExercises, i18n] = await Promise.all([
          queryExerciseCatalog(auth, sportType),
          fetchI18nStrings(),
        ]);

        const { catalog, i18nMisses } = buildCatalogFromRaw(rawExercises, i18n, oldExercises);

        const newNames = new Set(catalog.map((e) => e.name));
        const added = [...newNames].filter((n) => !oldNames.has(n));
        const removed = [...oldNames].filter((n) => !newNames.has(n));

        const catalogPath = getCatalogPath();
        writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
        reloadCatalog();

        const lines = [
          `Exercise catalog updated successfully.`,
          `Total exercises: ${catalog.length}`,
        ];
        if (added.length > 0) lines.push(`New exercises (${added.length}): ${added.join(", ")}`);
        if (removed.length > 0) lines.push(`Removed exercises (${removed.length}): ${removed.join(", ")}`);
        if (added.length === 0 && removed.length === 0) lines.push("No changes in exercise list.");
        if (i18nMisses.length > 0) {
          lines.push(
            `i18n misses (${i18nMisses.length}): ${i18nMisses.slice(0, 10).join(", ")}${i18nMisses.length > 10 ? "..." : ""}`
          );
        }
        lines.push(`Catalog written to: ${catalogPath}`);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to update exercises: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_workouts",
    "List workouts from COROS Training Hub. Use sportType=1 for running workouts, sportType=4 for strength workouts, sportType=0 for all.",
    {
      name: z.string().default("").describe("Filter by workout name (optional)"),
      sportType: z.number().int().default(0).describe("Filter by sport type: 0=all, 1=running (corrida), 4=strength (musculação/força)"),
      limit: z.number().int().min(1).max(50).default(10).describe("Number of workouts to return"),
    },
    async ({ name, sportType, limit }) => {
      try {
        const auth = await getValidAuth();
        if (!auth) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Not authenticated. Use authenticate_coros first.",
              },
            ],
            isError: true,
          };
        }

        const result = (await queryWorkouts(auth, {
          name,
          sportType,
          limitSize: limit,
        })) as {
          data: Array<{
            id: string;
            name: string;
            overview: string;
            sportType: number;
            duration: number;
            totalSets: number;
            exerciseNum: number;
            estimatedTime: number;
            createTimestamp: number;
            exercises: Array<Record<string, unknown>>;
          }>;
        };

        const workouts = result.data || [];
        if (workouts.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No workouts found." }],
          };
        }

        const fmtPace = (v: number) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}/km`;

        const formatted = workouts
          .map((w) => {
            const durationMin = Math.round((w.estimatedTime || w.duration || 0) / 60);
            const date = w.createTimestamp
              ? new Date((w.createTimestamp as number) * 1000).toLocaleDateString("pt-BR")
              : "";
            const dateStr = date ? ` | ${date}` : "";
            const isRunning = w.sportType === 1;
            const sportLabel = isRunning ? "🏃 Corrida" : "💪 Musculação";

            const idStr = w.id ? ` | ID: ${w.id}` : "";
            const header = isRunning
              ? `**${w.name}** [${sportLabel}] (~${durationMin} min | ${w.exerciseNum || 0} etapas${dateStr}${idStr})`
              : `**${w.name}** [${sportLabel}] (~${durationMin} min | ${w.totalSets || 0} sets | ${w.exerciseNum || 0} exercises${dateStr}${idStr})`;

            // Build a map of groupId → sets for group containers (exerciseType=0)
            const groupSetsMap: Record<string, number> = {};
            if (isRunning) {
              for (const ex of (w.exercises || [])) {
                const rawEx2 = ex as Record<string, unknown>;
                if ((rawEx2.exerciseType as number) === 0 && (rawEx2.isGroup as boolean)) {
                  const gid = rawEx2.id as string;
                  const gsets = rawEx2.sets as number;
                  if (gid) groupSetsMap[gid] = gsets;
                }
              }
            }

            const steps = (w.exercises || [])
              .map((ex) => {
                if (isRunning) {
                  const rawEx = ex as Record<string, unknown>;

                  // Skip group containers (exerciseType=0) — they're structural, shown via children
                  if ((rawEx.exerciseType as number) === 0 && (rawEx.isGroup as boolean)) {
                    return null;
                  }

                  // T-code display names
                  const TCODE_NAMES: Record<string, string> = {
                    T1120: "🔥 Aquecimento",
                    T1122: "❄️ Desaquecimento",
                    T3001: "🏃 Treino",
                  };
                  const EXTYPE_NAMES: Record<number, string> = {
                    1: "🔥 Aquecimento",
                    2: "🏃 Treino",
                    3: "❄️ Desaquecimento",
                    4: "⏸ Rest",
                  };
                  const storedName = rawEx.name as string | undefined;
                  const stepName = (storedName && TCODE_NAMES[storedName])
                    ?? EXTYPE_NAMES[(rawEx.exerciseType as number)]
                    ?? storedName
                    ?? `Tipo ${rawEx.exerciseType}`;

                  // Check if this step is a child of a group → prefix with Nx
                  const childGroupId = rawEx.groupId as string | undefined;
                  const parentSets = childGroupId && childGroupId !== "0" ? groupSetsMap[childGroupId] : undefined;
                  const setsStr = parentSets && parentSets > 1 ? `${parentSets}× ` : "";

                  // Duration display
                  const targetType = rawEx.targetType as number;
                  const targetVal = rawEx.targetValue as number;
                  let dur: string;
                  if (targetType === 0) dur = "aberto";
                  else if (targetType === 2) {
                    dur = targetVal >= 60
                      ? `${Math.floor(targetVal / 60)}min${targetVal % 60 > 0 ? `${targetVal % 60}s` : ""}`
                      : `${targetVal}s`;
                  }
                  else if (targetType === 5) dur = `${(targetVal / 100000).toFixed(1)}km`;
                  else dur = `${targetVal} (carga)`;

                  // Intensity display
                  const intensityType = rawEx.intensityType as number;
                  const multiplier = (rawEx.intensityMultiplier as number) || 0;
                  const rawLow = rawEx.intensityValue as number;
                  const rawHigh = rawEx.intensityValueExtend as number | undefined;
                  // Normalize to s/km regardless of multiplier
                  const intensityLow = multiplier > 0 ? Math.round(rawLow / multiplier) : rawLow;
                  const intensityHigh = multiplier > 0 && rawHigh != null ? Math.round(rawHigh / multiplier) : rawHigh;
                  const pctLow = rawEx.intensityPercent as number | undefined;
                  const pctHigh = rawEx.intensityPercentExtend as number | undefined;

                  let target = "";
                  if (intensityType === 3 && pctLow != null && pctHigh != null && pctLow > 0) {
                    const pLow = Math.round(pctLow / 1000);
                    const pHigh = Math.round(pctHigh / 1000);
                    // fmtPace already includes "/km", so no extra "/km" suffix needed
                    const paceStr = intensityLow > 0 && intensityHigh != null && intensityHigh > 0
                      ? ` (${fmtPace(intensityHigh)}-${fmtPace(intensityLow)})`
                      : "";
                    target = ` @ ${pLow}-${pHigh}% LTSP${paceStr}`;
                  } else if (intensityType === 1 && intensityLow > 0) {
                    const low = fmtPace(intensityLow);
                    target = intensityHigh != null && intensityHigh > 0
                      ? ` @ ${low}-${fmtPace(intensityHigh)}/km`
                      : ` @ ${low}/km`;
                  } else if (intensityType === 2 && intensityLow > 0) {
                    const pctLow2 = rawEx.intensityPercent as number | undefined;
                    const pctHigh2 = rawEx.intensityPercentExtend as number | undefined;
                    const hrLow = pctLow2 && pctLow2 > 0 ? `${Math.round(pctLow2 / 1000)}%` : `${intensityLow}bpm`;
                    const hrHigh = intensityHigh != null && intensityHigh > 0
                      ? (pctHigh2 && pctHigh2 > 0 ? `-${Math.round(pctHigh2 / 1000)}%` : `-${intensityHigh}bpm`)
                      : "";
                    target = ` @ ${hrLow}${hrHigh}`;
                  }

                  return `    • ${setsStr}${stepName}: ${dur}${target}`;
                } else {
                  // Strength step
                  const typedEx = ex as { name: string; originId: string; exerciseType: number; sets: number; targetValue: number; targetType: number; intensityValue: number; restValue: number; part: number[] };
                  if (typedEx.exerciseType === 1) {
                    const label = typedEx.name === "T1120" ? "Warmup" : "Cool Down";
                    return `    🔥 ${label} (${typedEx.targetValue}s)`;
                  }
                  const catalog = findByCodeName(typedEx.name) || findById(typedEx.originId);
                  const exName = catalog?.name ?? typedEx.name;
                  const targetUnit = typedEx.targetType === 3 ? "reps" : "s";
                  const weight = typedEx.intensityValue > 0 ? ` @ ${(typedEx.intensityValue / 1000).toFixed(2).replace(/\.?0+$/, "")}kg` : "";
                  const rest = typedEx.restValue > 0 ? ` | rest ${typedEx.restValue}s` : "";
                  const partName = typedEx.part?.[0] != null ? (PartCode as Record<number, string>)[typedEx.part[0]] ?? "" : "";
                  const partStr = partName ? ` [${partName}]` : "";
                  return `    • ${exName}: ${typedEx.sets}x${typedEx.targetValue}${targetUnit}${weight}${rest}${partStr}`;
                }
              })
              .filter(Boolean)
              .join("\n");

            return `${header}\n${steps}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${workouts.length} workout(s):\n\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list workouts: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // COROS pace zone boundaries (confirmed from native workouts via API inspection)
  const COROS_PACE_ZONES: Record<number, { low: number; high: number }> = {
    1: { low: 79,  high: 86  },  // Easy / Recovery
    2: { low: 87,  high: 92  },  // Aerobic
    3: { low: 93,  high: 97  },  // Tempo
    4: { low: 98,  high: 102 },  // Threshold
    5: { low: 103, high: 112 },  // VO2max
  };

  const RunStepSchema = z.object({
    type: z
      .enum(["warmup", "active", "rest", "cooldown", "interval"])
      .describe("Step type: warmup=aquecimento, active=treino, rest=rest, cooldown=desaquecimento, interval=intervalo"),
    durationType: z
      .enum(["time", "distance", "training_load", "open"])
      .describe("Duration unit: 'time' (seconds) or 'distance' (meters) or 'training_load' (carga de treino) or 'open' (aberto/sem objetivo)"),
    durationValue: z
      .number()
      .int()
      .min(0)
      .describe("Duration value in seconds (if time) or meters (if distance). E.g. 600=10min, 1000=1km. Use 0 when durationType='open'."),
    targetType: z
      .enum(["open", "pace", "heartrate"])
      .default("open")
      .describe("Target type: 'open' (no target), 'pace' (s/km), 'heartrate' (bpm)"),
    paceZone: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("COROS training zone 1-5. PREFER this over paceLowPercent/paceHighPercent — sets exact COROS zone boundaries automatically. Zone 1=Easy (79-86% LTSP), Zone 2=Aerobic (87-92%), Zone 3=Tempo (93-97%), Zone 4=Threshold (98-102%), Zone 5=VO2max (103-112%). Requires targetType='pace'."),
    paceLow: z
      .number()
      .int()
      .optional()
      .describe("Minimum pace in s/km (e.g. 270 = 4:30/km). Use with targetType='pace'"),
    paceHigh: z
      .number()
      .int()
      .optional()
      .describe("Maximum pace in s/km (e.g. 300 = 5:00/km). Use with targetType='pace'"),
    hrLow: z.number().int().optional().describe("Minimum heart rate in bpm. Use with targetType='heartrate'"),
    hrHigh: z.number().int().optional().describe("Maximum heart rate in bpm. Use with targetType='heartrate'"),
    repeat: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Repeat this step N times (useful for intervals). Default: 1"),
    repeatRestSeconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Rest time in seconds between repeat sets (default: 0)"),
    paceLowPercent: z
      .number()
      .int()
      .optional()
      .describe("Pace as % of lactate threshold pace — low bound. Use paceZone instead when possible to avoid COROS zone snapping issues."),
    paceHighPercent: z
      .number()
      .int()
      .optional()
      .describe("Pace as % of lactate threshold pace — high bound. Use paceZone instead when possible."),
    hrLowPercent: z
      .number()
      .int()
      .optional()
      .describe("Heart rate as % of LTHR — low bound (e.g. 90 = 90%). Use with targetType='heartrate'."),
    hrHighPercent: z
      .number()
      .int()
      .optional()
      .describe("Heart rate as % of LTHR — high bound (e.g. 95 = 95%). Use with targetType='heartrate'."),
  });

  server.tool(
    "create_running_workout",
    `Create a running workout (with intervals, pace targets, or heart rate zones) on COROS Training Hub. Supports warmup, active (treino), rest, cooldown, and interval steps. Each step has a duration type (time/distance/training_load/open), a target type (open/pace/heartrate), and optional pace or HR range. Pace is in seconds/km (e.g. 300 = 5:00/km).

TRAINING ZONES (use paceZone field — exact COROS boundaries):
  Zone 1 = Easy/Recovery    (79-86% LTSP)  — regenerativo, volume leve
  Zone 2 = Aerobic          (87-92% LTSP)  — base aeróbica, volume progressivo
  Zone 3 = Tempo            (93-97% LTSP)  — limiar aeróbico, corrida de tempo
  Zone 4 = Threshold        (98-102% LTSP) — limiar anaeróbico, corrida de ritmo
  Zone 5 = VO2max           (103-112% LTSP)— intervalos curtos/médios, VO2max

IMPORTANT: Always use paceZone (1-5) instead of paceLowPercent/paceHighPercent when targeting a training zone. COROS snaps percentages to fixed zone boundaries — arbitrary % values may land in the wrong zone.`,
    {
      name: z.string().describe("Workout name (e.g. 'Intervalos 5x1km')"),
      overview: z.string().default("").describe("Workout description"),
      steps: z.array(RunStepSchema).min(1).describe("Array of running steps"),
      ltspSeconds: z
        .coerce.number()
        .int()
        .optional()
        .describe("Lactate threshold pace in s/km (e.g. 275 = 4:35/km). Required when using paceLowPercent/paceHighPercent if LTSP is not set in your COROS profile."),
    },
    async ({ name, overview, steps, ltspSeconds }) => {
      try {
        const auth = await getValidAuth();
        if (!auth) {
          return {
            content: [{ type: "text" as const, text: "Not authenticated. Use authenticate_coros first." }],
            isError: true,
          };
        }

        const runSteps: RunStep[] = steps.map((s) => {
          // paceZone takes priority — maps to exact COROS zone boundaries
          let paceLowPercent = s.paceLowPercent;
          let paceHighPercent = s.paceHighPercent;
          let targetType = s.targetType as RunTargetType;
          if (s.paceZone != null) {
            const zone = COROS_PACE_ZONES[s.paceZone];
            if (zone) {
              paceLowPercent = zone.low;
              paceHighPercent = zone.high;
              targetType = "pace";
            }
          }
          return {
            type: s.type as RunStepType,
            durationType: s.durationType as RunDurationType,
            durationValue: s.durationValue,
            targetType,
            paceLow: s.paceLow,
            paceHigh: s.paceHigh,
            paceLowPercent,
            paceHighPercent,
            hrLow: s.hrLow,
            hrHigh: s.hrHigh,
            hrLowPercent: s.hrLowPercent,
            hrHighPercent: s.hrHighPercent,
            repeat: s.repeat,
            repeatRestSeconds: s.repeatRestSeconds,
          };
        });

        const result = await createRunningWorkout(auth, name, overview, runSteps, ltspSeconds);
        const durationMin = Math.round(result.duration / 60);

        const fmtPaceSummary = (v: number) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
        const stepTypeLabels: Record<string, string> = {
          warmup: "Aquecimento", active: "Treino", rest: "Rest",
          cooldown: "Desaquecimento", interval: "Intervalo",
        };
        const stepSummary = steps
          .map((s) => {
            const times = s.repeat && s.repeat > 1 ? `${s.repeat}x ` : "";
            const label = stepTypeLabels[s.type] ?? s.type;
            let dur: string;
            if (s.durationType === "time") dur = `${Math.round(s.durationValue / 60)}min`;
            else if (s.durationType === "distance") dur = `${(s.durationValue / 1000).toFixed(1)}km`;
            else if (s.durationType === "open") dur = "aberto";
            else dur = `${s.durationValue} (carga)`;
            let target = "";
            if (s.targetType === "pace" || s.paceZone != null) {
              if (s.paceZone != null) {
                const z = COROS_PACE_ZONES[s.paceZone];
                target = z ? ` @ Zona ${s.paceZone} (${z.low}-${z.high}% LTSP)` : ` @ Zona ${s.paceZone}`;
              } else if (s.paceLowPercent != null || s.paceHighPercent != null) {
                const lo = s.paceLowPercent, hi = s.paceHighPercent;
                if (lo != null && hi != null) target = ` @ ${lo}-${hi}% LTSP`;
                else target = ` @ ${lo ?? hi}% LTSP`;
              } else if (s.paceLow != null || s.paceHigh != null) {
                const low = s.paceLow != null ? fmtPaceSummary(s.paceLow) : null;
                const high = s.paceHigh != null ? fmtPaceSummary(s.paceHigh) : null;
                if (low && high) target = ` @ ${low}-${high}/km`;
                else if (low) target = ` @ ${low}/km`;
                else if (high) target = ` @ ${high}/km`;
              }
            } else if (s.targetType === "heartrate") {
              if (s.hrLowPercent != null || s.hrHighPercent != null) {
                const lo = s.hrLowPercent, hi = s.hrHighPercent;
                if (lo != null && hi != null) target = ` @ ${lo}-${hi}% LTHR`;
                else target = ` @ ${lo ?? hi}% LTHR`;
              } else if (s.hrLow != null || s.hrHigh != null) {
                if (s.hrLow != null && s.hrHigh != null) target = ` @ ${s.hrLow}-${s.hrHigh}bpm`;
                else target = ` @ ${s.hrLow ?? s.hrHigh}bpm`;
              }
            }
            return `  ${times}${label}: ${dur}${target}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Treino de corrida "${name}" criado com sucesso!`,
                `Duração total: ~${durationMin} min | ${result.totalSteps} etapas`,
                result.ltspUsed
                  ? `LTSP usado: ${Math.floor(result.ltspUsed / 60)}:${String(result.ltspUsed % 60).padStart(2, "0")}/km`
                  : "",
                ``,
                `Etapas:`,
                stepSummary,
                ``,
                `O treino será sincronizado com seu relógio COROS.`,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Falha ao criar treino de corrida: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- inspect_workout_raw (debug tool) ---
  server.tool(
    "inspect_workout_raw",
    "Returns raw JSON of the first workout matching the name, for debugging exercise structure.",
    { name: z.string().describe("Workout name to inspect") },
    async ({ name }) => {
      const auth = await getValidAuth();
      if (!auth) return { content: [{ type: "text" as const, text: "Not authenticated." }], isError: true };
      const result = (await queryWorkouts(auth, { name, sportType: 1, limitSize: 3 })) as { data: unknown[] };
      const workouts = result.data || [];
      const match = workouts[0];
      if (!match) return { content: [{ type: "text" as const, text: `Workout "${name}" not found.` }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(match, null, 2) }] };
    }
  );

  // --- get_training_metrics ---
  server.tool(
    "get_training_metrics",
    "Get detailed personal training metrics from COROS: VO2max, LTHR, lactate threshold pace, resting HR, HRV, ATL/CTL/TSB (training load balance), fatigue state, HR zones distribution, and weekly load vs recommended.",
    {},
    async () => {
      try {
        const auth = await getValidAuth();
        if (!auth) throw new Error("Not authenticated. Please login first.");

        const { today, sportStatistic, weekList, hrTimeAreaList, tlAreaList } =
          await queryAnalytics(auth);

        const HR_ZONE_NAMES = ["Z1", "Z2", "Z3", "Z4", "Z5", "Z5+"];
        const TL_ZONE_NAMES = [
          "Muito fácil",
          "Fácil",
          "Moderado",
          "Difícil",
          "Muito difícil",
          "Máximo",
          "Extremo",
        ];

        const lines: string[] = ["📊 **Métricas de Treinamento — COROS**", ""];

        // ── Fitness Baseline ──────────────────────────────────────────────────
        lines.push("━━━ Fitness Base ━━━");
        if (today.vo2max) lines.push(`🫁 VO2max: ${today.vo2max} ml/kg/min`);
        if (today.lthr) lines.push(`❤️ Limiar anaeróbico (LTHR): ${today.lthr} bpm`);
        if (today.ltsp) lines.push(`🏃 Limiar anaeróbico (LTSP): ${fmtPace(today.ltsp)}`);
        if (today.rhr) lines.push(`💤 FC de repouso: ${today.rhr} bpm`);
        if (today.avgSleepHrv) {
          const hrvStatus =
            today.sleepHrvBase && today.avgSleepHrv >= today.sleepHrvBase * 0.95
              ? "✅ acima da base"
              : today.sleepHrvBase && today.avgSleepHrv >= today.sleepHrvBase * 0.8
              ? "⚠️ levemente abaixo"
              : "🔴 abaixo da base";
          lines.push(
            `🧠 HRV sono: ${today.avgSleepHrv} ms (base: ${today.sleepHrvBase ?? "–"} ms) ${hrvStatus}`
          );
        }
        lines.push("");

        // ── Training Load ─────────────────────────────────────────────────────
        lines.push("━━━ Carga de Treinamento ━━━");
        if (today.ati) lines.push(`⚡ ATL (carga aguda 7d): ${today.ati}`);
        if (today.cti) lines.push(`💪 CTL (fitness crônico): ${today.cti}`);
        if (today.tib !== undefined) {
          const tibSign = today.tib >= 0 ? "+" : "";
          lines.push(`⚖️ TSB (balanço): ${tibSign}${today.tib}`);
        }
        if (today.trainingLoadRatio) {
          lines.push(
            `📈 Ratio ATL/CTL: ${today.trainingLoadRatio.toFixed(2)} (ótimo: 0.80–1.50)`
          );
        }
        if (today.tiredRateStateNew) {
          lines.push(
            `😴 Estado de fadiga: ${tiredStateLabel(today.tiredRateStateNew)} (${today.tiredRateNew > 0 ? "+" : ""}${today.tiredRateNew}%)`
          );
        }
        if (today.performance !== undefined) {
          lines.push(`🎯 Estado de forma: ${performanceLabel(today.performance)}`);
        }
        if (today.staminaLevel) {
          lines.push(
            `🔋 Stamina atual: ${today.staminaLevel.toFixed(1)} (7d: ${today.staminaLevel7d})`
          );
        }
        lines.push("");

        // ── Accumulated Load ──────────────────────────────────────────────────
        lines.push("━━━ Carga Acumulada ━━━");
        if (today.t7d) lines.push(`📅 Últimos 7 dias: ${today.t7d}`);
        if (today.t28d) lines.push(`📅 Últimos 28 dias: ${today.t28d}`);
        if (today.recomendTlMin && today.recomendTlMax) {
          lines.push(
            `🎯 Zona semanal recomendada: ${today.recomendTlMin}–${today.recomendTlMax}`
          );
        }
        lines.push("");

        // ── Weekly Loads ──────────────────────────────────────────────────────
        if (weekList.length > 0) {
          lines.push("━━━ Carga Semanal (recentes) ━━━");
          const sortedWeeks = [...weekList].sort(
            (a, b) => b.firstDayOfWeek - a.firstDayOfWeek
          );
          for (const w of sortedWeeks.slice(0, 4)) {
            const d = String(w.firstDayOfWeek);
            const label = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
            const bar =
              w.trainingLoad >= w.recomendTlMin &&
              w.trainingLoad <= w.recomendTlMax
                ? "✅"
                : w.trainingLoad < w.recomendTlMin
                ? "⬇️"
                : "⬆️";
            lines.push(
              `  ${bar} Sem. ${label}: ${w.trainingLoad} (rec: ${w.recomendTlMin}–${w.recomendTlMax})`
            );
          }
          lines.push("");
        }

        // ── HR Zones ─────────────────────────────────────────────────────────
        if (hrTimeAreaList.length > 0) {
          lines.push("━━━ Distribuição Zonas FC (tempo) ━━━");
          for (const z of hrTimeAreaList) {
            if (z.ratio === 0) continue;
            const name = HR_ZONE_NAMES[z.index] ?? `Z${z.index + 1}`;
            const bar = "█".repeat(Math.round(z.ratio / 5));
            lines.push(`  ${name}: ${bar} ${z.ratio.toFixed(1)}%`);
          }
          lines.push("");
        }

        // ── TL Zones ─────────────────────────────────────────────────────────
        if (tlAreaList.length > 0) {
          lines.push("━━━ Distribuição Carga (intensidade) ━━━");
          for (const z of tlAreaList) {
            if (z.ratio === 0) continue;
            const name = TL_ZONE_NAMES[z.index] ?? `Z${z.index}`;
            const bar = "█".repeat(Math.round(z.ratio / 5));
            lines.push(`  ${name}: ${bar} ${z.ratio.toFixed(1)}%`);
          }
          lines.push("");
        }

        // ── Sport Stats ───────────────────────────────────────────────────────
        const relevantStats = sportStatistic.filter(
          (s) => s.sportType !== 65535 && s.count > 0
        );
        if (relevantStats.length > 0) {
          lines.push("━━━ Estatísticas por Esporte ━━━");
          for (const s of relevantStats) {
            const sport = activityModeName(s.sportType === 402 ? 22 : s.sportType === 100 ? 8 : s.sportType);
            const dist =
              s.distance > 0 ? ` | ${(s.distance / 1000).toFixed(0)} km` : "";
            const pace =
              s.avgPace && s.avgPace > 0 ? ` | Pace: ${fmtPace(s.avgPace)}` : "";
            lines.push(
              `  ${sport}: ${s.count}x | ${fmtDuration(s.duration)}${dist}${pace} | FC: ${s.avgHeartRate} bpm`
            );
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Falha ao buscar métricas: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- get_activity_details ---
  server.tool(
    "get_activity_details",
    "Get detailed metrics for a specific COROS activity by its ID (labelId). Use list_activities first to get the labelId. Returns laps by km, HR zones, running dynamics, aerobic/anaerobic effect, weather and more.",
    {
      labelId: z.string().describe("Activity ID (labelId) from list_activities"),
    },
    async ({ labelId }) => {
      try {
        const auth = await getValidAuth();
        if (!auth) throw new Error("Not authenticated. Please login first.");

        // Step 1: Find the basic activity (to get sportType)
        const basicAct = await queryActivityDetail(auth, labelId);
        if (!basicAct) {
          return {
            content: [{ type: "text" as const, text: `Atividade com ID ${labelId} não encontrada.` }],
          };
        }

        // Step 2: Fetch full details via /activity/detail/query
        const { summary: s, lapList, zoneList, weather, sportFeelInfo } =
          await queryActivityDetailFull(auth, labelId, basicAct.sportType);

        // timestamps are in centiseconds
        const startTs = Math.floor(s.startTimestamp / 100);
        const endTs = Math.floor(s.endTimestamp / 100);
        const totalSec = Math.floor(s.totalTime / 100);
        const distKm = s.distance / 100000; // cm → km
        const sport = activityModeName(basicAct.mode);
        const date = fmtDate(startTs);
        const startStr = new Date(startTs * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        const endStr = new Date(endTs * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

        const lines: string[] = [
          `🏃 **${s.name}**`,
          `📅 ${date} · ${startStr} → ${endStr} · ${sport}`,
          `🖥️ Dispositivo: ${basicAct.device || "–"}`,
        ];

        if (sportFeelInfo?.feelType && sportFeelInfo.feelType > 0) {
          lines.push(`💬 Sensação: ${feelLabel(sportFeelInfo.feelType)}`);
        }
        if (sportFeelInfo?.sportNote) lines.push(`📝 Nota: ${sportFeelInfo.sportNote}`);
        lines.push(``);

        // ── Resumo ────────────────────────────────────────────────────────────
        lines.push(`━━━ Resumo ━━━`);
        if (distKm > 0) lines.push(`📏 Distância: ${distKm.toFixed(2)} km`);
        lines.push(`⏱️ Duração: ${fmtDuration(totalSec)}`);
        if (s.trainingLoad > 0) lines.push(`💪 Training Load: ${s.trainingLoad}`);
        if (s.calories > 0) lines.push(`🔥 Calorias: ${Math.round(s.calories / 1000)} kcal`);
        if (s.aerobicEffect > 0) {
          const aerStars = "★".repeat(Math.round(s.aerobicEffect)) + "☆".repeat(5 - Math.round(s.aerobicEffect));
          lines.push(`💙 Efeito aeróbico: ${s.aerobicEffect.toFixed(1)} ${aerStars}`);
        }
        if (s.anaerobicEffect > 0) {
          const anStars = "★".repeat(Math.round(s.anaerobicEffect)) + "☆".repeat(5 - Math.round(s.anaerobicEffect));
          lines.push(`🔴 Efeito anaeróbico: ${s.anaerobicEffect.toFixed(1)} ${anStars}`);
        }
        if (s.currentVo2Max > 0) lines.push(`🫁 VO2max: ${s.currentVo2Max}`);
        lines.push(``);

        // ── Pace & Velocidade ─────────────────────────────────────────────────
        lines.push(`━━━ Pace & Velocidade ━━━`);
        if (s.avgSpeed > 0) lines.push(`🏃 Pace médio: ${fmtPace(s.avgSpeed)}`);
        if (s.adjustedPace > 0) lines.push(`⛰️ Pace ajustado (GAP): ${fmtPace(s.adjustedPace)}`);
        if (s.bestKm > 0) lines.push(`🏅 Melhor km: ${fmtPace(s.bestKm)}`);
        lines.push(``);

        // ── FC ───────────────────────────────────────────────────────────────
        lines.push(`━━━ Frequência Cardíaca ━━━`);
        if (s.avgHr > 0) lines.push(`❤️ FC média: ${s.avgHr} bpm`);
        if (s.maxHr > 0) lines.push(`🔴 FC máxima: ${s.maxHr} bpm`);
        lines.push(``);

        // ── Running Dynamics ─────────────────────────────────────────────────
        const hasDyn = s.avgCadence > 0 || s.avgPower > 0 || s.avgGroundTime > 0;
        if (hasDyn) {
          lines.push(`━━━ Dinâmica de Corrida ━━━`);
          if (s.avgCadence > 0) lines.push(`🦵 Cadência: ${s.avgCadence} spm (max: ${s.maxCadence})`);
          if (s.avgPower > 0) lines.push(`⚡ Potência: ${s.avgPower} W (max: ${s.maxPower} W)`);
          if (s.avgGroundTime > 0) lines.push(`🦶 Contato com solo: ${s.avgGroundTime} ms`);
          if (s.avgVertVibration > 0) lines.push(`↕️ Oscilação vertical: ${(s.avgVertVibration / 10).toFixed(1)} cm`);
          if (s.avgVertRatio > 0) lines.push(`📐 Ratio vertical: ${(s.avgVertRatio / 10).toFixed(1)}%`);
          if (s.avgStepLen > 0) lines.push(`👟 Comprimento da passada: ${(s.avgStepLen / 100).toFixed(2)} m`);
          lines.push(``);
        }

        // ── Elevação ─────────────────────────────────────────────────────────
        if (s.elevGain > 0 || s.totalDescent > 0) {
          lines.push(`━━━ Elevação ━━━`);
          if (s.elevGain > 0) lines.push(`⬆️ Subida: ${s.elevGain} m`);
          if (s.totalDescent > 0) lines.push(`⬇️ Descida: ${s.totalDescent} m`);
          lines.push(``);
        }

        // ── Clima ────────────────────────────────────────────────────────────
        if (weather && weather.temperature) {
          const tempC = (weather.temperature / 10).toFixed(1);
          const feelC = weather.bodyFeelTemp ? (weather.bodyFeelTemp / 10).toFixed(1) : null;
          const humidity = weather.humidity ? (weather.humidity / 10).toFixed(0) : null;
          const wind = weather.windSpeed ? (weather.windSpeed / 10).toFixed(1) : null;
          lines.push(`━━━ Clima ━━━`);
          lines.push(`🌡️ Temperatura: ${tempC}°C${feelC ? ` (sensação: ${feelC}°C)` : ""}`);
          if (humidity) lines.push(`💧 Umidade: ${humidity}%`);
          if (wind) lines.push(`💨 Vento: ${wind} km/h`);
          lines.push(``);
        }

        // ── Zonas de FC ───────────────────────────────────────────────────────
        const hrZoneGroup = zoneList.find((z) => z.type === 126);
        if (hrZoneGroup) {
          const zones = hrZoneGroup.zoneItemList.filter((z) => z.percent > 0 && z.zoneIndex > 0);
          if (zones.length > 0) {
            lines.push(`━━━ Zonas de FC (nesta atividade) ━━━`);
            const zoneNames = ["–", "Z1", "Z2", "Z3", "Z4", "Z5", "Z5+"];
            for (const z of zones) {
              const name = zoneNames[z.zoneIndex] ?? `Z${z.zoneIndex}`;
              const bar = "█".repeat(Math.max(1, Math.round(z.percent / 5)));
              const dur = fmtDuration(z.second);
              lines.push(`  ${name} (${z.leftScope}–${z.rightScope} bpm): ${bar} ${z.percent}% · ${dur}`);
            }
            lines.push(``);
          }
        }

        // ── Laps por Km ───────────────────────────────────────────────────────
        const kmLapGroup = lapList.find((g) => g.lapDistance === 100000);
        if (kmLapGroup && kmLapGroup.lapItemList.length > 0) {
          const fastIdx = kmLapGroup.fastLapIndexList ?? [];
          lines.push(`━━━ Laps por km ━━━`);
          lines.push(`  Km | Pace      | FC  | Cadência | Potência | Subida`);
          lines.push(`  ---|-----------|-----|----------|----------|-------`);
          for (const lap of kmLapGroup.lapItemList) {
            const isFast = fastIdx.includes(lap.lapIndex);
            const km = lap.distance > 0 ? (lap.distance / 100000).toFixed(2) : "–";
            const pace = lap.avgPace > 0 ? fmtPace(lap.avgPace) : "–";
            const hr = lap.avgHr > 0 ? `${lap.avgHr}` : "–";
            const cad = lap.avgCadence > 0 ? `${lap.avgCadence}` : "–";
            const pow = lap.avgPower > 0 ? `${lap.avgPower}W` : "–";
            const elev = lap.elevGain > 0 ? `+${lap.elevGain}m` : "–";
            const flag = isFast ? " ⚡" : "";
            lines.push(
              `  ${String(lap.lapIndex).padStart(2)} | ${pace.padEnd(9)} | ${hr.padEnd(3)} | ${cad.padEnd(8)} | ${pow.padEnd(8)} | ${elev}${flag}`
            );
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Falha ao buscar detalhes: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- list_activities ---
  server.tool(
    "list_activities",
    "List recorded activities (actual workouts done) from COROS watch. Returns recent activities with stats like distance, pace, HR, duration.",
    {
      days: z
        .number()
        .min(1)
        .max(365)
        .default(30)
        .describe("How many days back to look (default: 30)"),
      size: z
        .number()
        .min(1)
        .max(50)
        .default(20)
        .describe("Max number of activities to return (default: 20)"),
      pageNumber: z
        .number()
        .min(1)
        .default(1)
        .describe("Page number for pagination (default: 1)"),
    },
    async ({ days, size, pageNumber }) => {
      try {
        const auth = await getValidAuth();
        if (!auth) throw new Error("Not authenticated. Please login first.");
        const { activities, total } = await queryActivities(auth, {
          days,
          size,
          pageNumber,
        });

        if (activities.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Nenhuma atividade encontrada nos últimos ${days} dias.`,
              },
            ],
          };
        }

        const lines: string[] = [
          `📊 Atividades recentes (${activities.length} de ${total} nos últimos ${days} dias):`,
          "",
        ];

        for (const act of activities) {
          const sport = activityModeName(act.mode);
          const date = fmtDate(act.startTime);
          const dur = fmtDuration(act.totalTime);
          const parts: string[] = [];

          if (act.distance > 0) {
            parts.push(`${(act.distance / 1000).toFixed(2)} km`);
          }
          parts.push(dur);
          if (act.avgHr > 0) parts.push(`FC avg: ${act.avgHr} bpm`);
          if (act.avgSpeed > 0 && act.distance > 0) {
            // pace in min/km
            const paceSecPerKm = (act.totalTime / (act.distance / 1000));
            const pm = Math.floor(paceSecPerKm / 60);
            const ps = Math.round(paceSecPerKm % 60);
            parts.push(`Pace: ${pm}:${String(ps).padStart(2, "0")}/km`);
          }
          if (act.calorie > 0) parts.push(`${Math.round(act.calorie / 1000)} kcal`);
          if (act.trainingLoad > 0) parts.push(`Load: ${act.trainingLoad}`);

          lines.push(`• [${date}] **${act.name}** (${sport}) \`ID: ${act.labelId}\``);
          lines.push(`  ${parts.join(" | ")}`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Falha ao listar atividades: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── list_schedule ─────────────────────────────────────────────────────────
  server.tool(
    "list_schedule",
    "List the COROS training calendar (planned and completed workouts) for a date range. Shows workout name, type, status (completed/pending), duration, distance and training load.",
    {
      startDate: z
        .string()
        .optional()
        .describe("Start date in YYYYMMDD format. Defaults to 30 days ago."),
      endDate: z
        .string()
        .optional()
        .describe("End date in YYYYMMDD format. Defaults to 30 days ahead."),
    },
    async ({ startDate, endDate }) => {
      try {
        const auth = await getValidAuth();
        if (!auth) throw new Error("Não autenticado. Use authenticate_coros primeiro.");

        // Default: 30 days ago → 30 days ahead
        const now = new Date();
        const toYYYYMMDD = (d: Date) =>
          `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

        const past = new Date(now);
        past.setDate(past.getDate() - 30);
        const future = new Date(now);
        future.setDate(future.getDate() + 30);

        const start = startDate ?? toYYYYMMDD(past);
        const end = endDate ?? toYYYYMMDD(future);

        const { planName, entries } = await querySchedule(start, end, auth);

        const sportName = (t: number) => {
          if (t === 1 || t === 100) return "🏃 Corrida";
          if (t === 4 || t === 402) return "💪 Força";
          if (t === 2 || t === 200) return "🚴 Ciclismo";
          if (t === 3 || t === 300) return "🏊 Natação";
          return `Sport(${t})`;
        };

        const statusIcon = (s: number) => {
          if (s === 2) return "✅";
          if (s === 1) return "⚡";
          return "📋";
        };

        const fmtDay = (d: number) => {
          const s = String(d);
          return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
        };

        // Group by week
        const weeks: Map<string, typeof entries> = new Map();
        for (const e of entries) {
          const date = new Date(
            Number(String(e.happenDay).slice(0, 4)),
            Number(String(e.happenDay).slice(4, 6)) - 1,
            Number(String(e.happenDay).slice(6, 8))
          );
          // Monday of the week
          const day = date.getDay();
          const monday = new Date(date);
          monday.setDate(date.getDate() - ((day + 6) % 7));
          const weekKey = toYYYYMMDD(monday);
          if (!weeks.has(weekKey)) weeks.set(weekKey, []);
          weeks.get(weekKey)!.push(e);
        }

        const lines: string[] = [];
        lines.push(`📅 **Calendário — ${planName}**`);
        lines.push(`📆 Período: ${fmtDay(Number(start))} → ${fmtDay(Number(end))}`);
        lines.push("");

        for (const [weekKey, weekEntries] of weeks) {
          const wk = new Date(
            Number(weekKey.slice(0, 4)),
            Number(weekKey.slice(4, 6)) - 1,
            Number(weekKey.slice(6, 8))
          );
          const sunday = new Date(wk);
          sunday.setDate(wk.getDate() + 6);
          lines.push(`━━━ Semana ${fmtDay(Number(toYYYYMMDD(wk)))} → ${fmtDay(Number(toYYYYMMDD(sunday)))} ━━━`);

          for (const e of weekEntries) {
            const icon = statusIcon(e.executeStatus);
            const sport = sportName(e.sportType);
            const name = e.name || "(sem nome)";
            const dur = e.duration > 0 ? fmtDuration(e.duration) : "";
            const dist =
              e.distance > 0
                ? `${(e.distance / 100000).toFixed(1)}km`
                : "";
            const load = e.trainingLoad ? `TL:${e.trainingLoad}` : "";
            const labelNote = e.labelId ? ` · ID:${e.labelId}` : "";

            const parts = [dur, dist, load].filter(Boolean).join(" · ");
            lines.push(
              `  ${icon} ${fmtDay(e.happenDay)} | ${sport} | ${name}${parts ? ` · ${parts}` : ""}${labelNote}`
            );
          }
          lines.push("");
        }

        // Summary stats
        const completed = entries.filter((e) => e.executeStatus === 2);
        const pending = entries.filter((e) => e.executeStatus === 0);
        lines.push(`📊 Total: ${entries.length} treinos · ✅ ${completed.length} concluídos · 📋 ${pending.length} pendentes`);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Falha ao buscar calendário: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── inspect_schedule_raw ─────────────────────────────────────────────────
  server.tool(
    "inspect_schedule_raw",
    "Returns raw JSON of the schedule API response for debugging. Shows entities, programs, idInPlan values and full structure.",
    {
      startDate: z.string().describe("Start date YYYYMMDD"),
      endDate: z.string().describe("End date YYYYMMDD"),
    },
    async ({ startDate, endDate }) => {
      const auth = await getValidAuth();
      if (!auth) {
        return { content: [{ type: "text" as const, text: "Not authenticated." }], isError: true };
      }
      const raw = await queryScheduleRaw(startDate, endDate, auth);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(raw, null, 2) }],
      };
    }
  );

  // ── schedule_workout ──────────────────────────────────────────────────────
  server.tool(
    "schedule_workout",
    "Schedule an existing COROS workout on a specific date in the training calendar. Use list_workouts to get the workout ID first.",
    {
      workoutId: z
        .string()
        .describe("Workout ID from list_workouts (the numeric string shown after 'ID:')"),
      date: z
        .string()
        .regex(/^\d{8}$/, "Date must be in YYYYMMDD format (e.g. 20260315)")
        .describe("Date to schedule the workout in YYYYMMDD format (e.g. 20260315)"),
    },
    async ({ workoutId, date }) => {
      try {
        const auth = await getValidAuth();
        if (!auth) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Not authenticated. Use authenticate_coros first.",
              },
            ],
            isError: true,
          };
        }

        await scheduleWorkout(auth, workoutId, date);

        const fmtDay = (d: string) => `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Treino agendado para ${fmtDay(date)} com sucesso! Ele aparecerá no calendário do COROS Training Hub e sincronizará com o relógio.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Falha ao agendar treino: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}
