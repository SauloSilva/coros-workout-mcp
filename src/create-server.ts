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

            const header = isRunning
              ? `**${w.name}** [${sportLabel}] (~${durationMin} min | ${w.exerciseNum || 0} etapas${dateStr})`
              : `**${w.name}** [${sportLabel}] (~${durationMin} min | ${w.totalSets || 0} sets | ${w.exerciseNum || 0} exercises${dateStr})`;

            const steps = (w.exercises || [])
              .map((ex) => {
                if (isRunning) {
                  // exerciseType: 0=aquecimento,1=treino,2=rest,3=desaquecimento,4=intervalo
                  const STEP_NAMES: Record<number, string> = {
                    0: "🔥 Aquecimento",
                    1: "🏃 Treino",
                    2: "⏸ Rest",
                    3: "❄️ Desaquecimento",
                    4: "⚡ Intervalo",
                  };
                  const stepName = STEP_NAMES[(ex.exerciseType as number)] ?? `Tipo ${ex.exerciseType}`;
                  // targetType: 0=aberto,1=carga,2=tempo(s),3=distância(m)
                  const targetType = ex.targetType as number;
                  const targetVal = ex.targetValue as number;
                  let dur: string;
                  if (targetType === 0) dur = "aberto";
                  else if (targetType === 2) dur = `${Math.round(targetVal / 60)}min`;
                  else if (targetType === 3) dur = `${(targetVal / 1000).toFixed(1)}km`;
                  else dur = `${targetVal} (carga)`;
                  // intensityType: 0=aberto,1=ritmo(ms/km),2=FC(bpm)
                  const intensityType = ex.intensityType as number;
                  const intensityLow = ex.intensityValue as number;
                  const intensityHigh = (ex as Record<string, unknown>).intensityValueExtend as number | undefined;
                  let target = "";
                  if (intensityType === 1 && intensityLow > 0) {
                    // pace stored in ms/km → convert to s/km
                    const low = fmtPace(Math.round(intensityLow / 1000));
                    if (intensityHigh != null && intensityHigh > 0) {
                      const high = fmtPace(Math.round(intensityHigh / 1000));
                      target = ` @ ${low}-${high}/km`;
                    } else {
                      target = ` @ ${low}/km`;
                    }
                  } else if (intensityType === 2 && intensityLow > 0) {
                    if (intensityHigh != null && intensityHigh > 0) {
                      target = ` @ ${intensityLow}-${intensityHigh}bpm`;
                    } else {
                      target = ` @ ${intensityLow}bpm`;
                    }
                  }
                  return `    • ${stepName}: ${dur}${target}`;
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
  });

  server.tool(
    "create_running_workout",
    "Create a running workout (with intervals, pace targets, or heart rate zones) on COROS Training Hub. Supports warmup, active (treino), rest, cooldown, and interval steps. Each step has a duration type (time/distance/training_load/open), a target type (open/pace/heartrate), and optional pace or HR range. Pace is in seconds/km (e.g. 300 = 5:00/km).",
    {
      name: z.string().describe("Workout name (e.g. 'Intervalos 5x1km')"),
      overview: z.string().default("").describe("Workout description"),
      steps: z.array(RunStepSchema).min(1).describe("Array of running steps"),
    },
    async ({ name, overview, steps }) => {
      try {
        const auth = await getValidAuth();
        if (!auth) {
          return {
            content: [{ type: "text" as const, text: "Not authenticated. Use authenticate_coros first." }],
            isError: true,
          };
        }

        const runSteps: RunStep[] = steps.map((s) => ({
          type: s.type as RunStepType,
          durationType: s.durationType as RunDurationType,
          durationValue: s.durationValue,
          targetType: s.targetType as RunTargetType,
          paceLow: s.paceLow,
          paceHigh: s.paceHigh,
          hrLow: s.hrLow,
          hrHigh: s.hrHigh,
          repeat: s.repeat,
        }));

        const result = await createRunningWorkout(auth, name, overview, runSteps);
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
            if (s.targetType === "pace" && (s.paceLow != null || s.paceHigh != null)) {
              const low = s.paceLow != null ? fmtPaceSummary(s.paceLow) : null;
              const high = s.paceHigh != null ? fmtPaceSummary(s.paceHigh) : null;
              if (low && high) target = ` @ ${low}-${high}/km`;
              else if (low) target = ` @ ${low}/km`;
              else if (high) target = ` @ ${high}/km`;
            } else if (s.targetType === "heartrate" && (s.hrLow != null || s.hrHigh != null)) {
              if (s.hrLow != null && s.hrHigh != null) target = ` @ ${s.hrLow}-${s.hrHigh}bpm`;
              else target = ` @ ${s.hrLow ?? s.hrHigh}bpm`;
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

  return server;
}
