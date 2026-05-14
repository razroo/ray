import {
  RayError,
  hashValue,
  type InferenceRequest,
  type InferenceResponseFormat,
  type ScheduleLane,
} from "@razroo/ray-core";

export type RayTaskKind = "classify" | "summarize" | "draft" | "revise" | "extract-json";
export type TaskProfileCachePolicy = "read-write" | "bypass";
export type TaskProfileDedupePolicy = "none" | "profile-input";
export type TaskProfileApplyMode = "defaults" | "profile";

export interface RayTaskProfile {
  id: string;
  task: RayTaskKind;
  maxTokens: number;
  temperature: number;
  topP: number;
  timeoutMs: number;
  cachePolicy: TaskProfileCachePolicy;
  lane: ScheduleLane;
  dedupePolicy: TaskProfileDedupePolicy;
  responseFormat?: InferenceResponseFormat;
  metadata: Record<string, string>;
  stop?: string[];
}

export interface TaskProfileCatalog {
  profiles: RayTaskProfile[];
  defaultProfileId?: string;
}

export interface TaskProfileCatalogOptions {
  defaultProfileId?: string;
}

export interface ResolveTaskProfileRequestOptions {
  request: InferenceRequest;
  profileId?: string;
  catalog?: TaskProfileCatalog;
  mode?: TaskProfileApplyMode;
  metadata?: Record<string, string>;
  dedupePolicy?: TaskProfileDedupePolicy;
}

export interface ResolvedTaskProfileExecution {
  profileId: string;
  task: RayTaskKind;
  mode: TaskProfileApplyMode;
  lane: ScheduleLane;
  timeoutMs: number;
  cachePolicy: TaskProfileCachePolicy;
  dedupePolicy: TaskProfileDedupePolicy;
  dedupeKey?: string;
}

export interface ResolvedTaskProfileRequest {
  profile: RayTaskProfile;
  request: InferenceRequest;
  execution: ResolvedTaskProfileExecution;
}

const MAX_PROFILE_ID_CHARS = 128;
const MAX_PROFILE_TOKENS = 4_096;
const MAX_PROFILE_TIMEOUT_MS = 600_000;
const MAX_PROFILE_METADATA_ENTRIES = 32;
const MAX_PROFILE_METADATA_KEY_CHARS = 128;
const MAX_PROFILE_METADATA_VALUE_CHARS = 1_024;
const MAX_PROFILE_STOP_SEQUENCES = 16;
const MAX_PROFILE_STOP_SEQUENCE_CHARS = 256;
const MAX_PROFILES = 128;

const unsafeRecordKeys = new Set(["__proto__", "constructor", "prototype"]);
const profileKeys = new Set([
  "id",
  "task",
  "maxTokens",
  "temperature",
  "topP",
  "timeoutMs",
  "cachePolicy",
  "lane",
  "dedupePolicy",
  "responseFormat",
  "metadata",
  "stop",
]);
const catalogKeys = new Set(["profiles", "defaultProfileId"]);
const catalogOptionKeys = new Set(["defaultProfileId"]);
const resolveOptionKeys = new Set([
  "request",
  "profileId",
  "catalog",
  "mode",
  "metadata",
  "dedupePolicy",
]);

const defaultProfiles: RayTaskProfile[] = [
  {
    id: "classify",
    task: "classify",
    maxTokens: 64,
    temperature: 0,
    topP: 0.9,
    timeoutMs: 12_000,
    cachePolicy: "read-write",
    lane: "short",
    dedupePolicy: "profile-input",
    responseFormat: {
      type: "json_object",
    },
    metadata: {
      promptFamily: "task.classify",
    },
  },
  {
    id: "summarize",
    task: "summarize",
    maxTokens: 160,
    temperature: 0.2,
    topP: 0.9,
    timeoutMs: 20_000,
    cachePolicy: "read-write",
    lane: "draft",
    dedupePolicy: "profile-input",
    metadata: {
      promptFamily: "task.summarize",
    },
  },
  {
    id: "draft",
    task: "draft",
    maxTokens: 180,
    temperature: 0.35,
    topP: 0.95,
    timeoutMs: 25_000,
    cachePolicy: "bypass",
    lane: "draft",
    dedupePolicy: "none",
    metadata: {
      promptFamily: "task.draft",
    },
  },
  {
    id: "revise",
    task: "revise",
    maxTokens: 140,
    temperature: 0.25,
    topP: 0.9,
    timeoutMs: 18_000,
    cachePolicy: "bypass",
    lane: "draft",
    dedupePolicy: "none",
    metadata: {
      promptFamily: "task.revise",
    },
  },
  {
    id: "extract-json",
    task: "extract-json",
    maxTokens: 120,
    temperature: 0,
    topP: 0.9,
    timeoutMs: 14_000,
    cachePolicy: "read-write",
    lane: "short",
    dedupePolicy: "profile-input",
    responseFormat: {
      type: "json_object",
    },
    metadata: {
      promptFamily: "task.extract-json",
    },
  },
];

function objectEntries(value: object, label: string): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch {
    throw new TypeError(`${label} must not contain unreadable properties`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertKnownObjectKeys(value: object, label: string, allowedKeys: ReadonlySet<string>) {
  for (const [key] of objectEntries(value, label)) {
    if (unsafeRecordKeys.has(key)) {
      throw new TypeError(`${label} must not contain unsafe key "${key}"`);
    }

    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} must not contain unsupported key "${key}"`);
    }
  }
}

function assertBoundedString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  if (value.length > maxChars) {
    throw new RangeError(`${label} must be at most ${maxChars} characters`);
  }

  return value;
}

function assertPositiveSafeIntegerAtMost(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }

  return value;
}

function assertNumberInRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a finite number between ${minimum} and ${maximum}`);
  }

  return value;
}

function assertTaskKind(value: unknown): RayTaskKind {
  if (
    value !== "classify" &&
    value !== "summarize" &&
    value !== "draft" &&
    value !== "revise" &&
    value !== "extract-json"
  ) {
    throw new TypeError("profile task must be classify, summarize, draft, revise, or extract-json");
  }

  return value;
}

function assertCachePolicy(value: unknown): TaskProfileCachePolicy {
  if (value !== "read-write" && value !== "bypass") {
    throw new TypeError("profile cachePolicy must be read-write or bypass");
  }

  return value;
}

function assertDedupePolicy(value: unknown): TaskProfileDedupePolicy {
  if (value !== "none" && value !== "profile-input") {
    throw new TypeError("profile dedupePolicy must be none or profile-input");
  }

  return value;
}

function assertApplyMode(value: unknown): TaskProfileApplyMode {
  if (value === undefined) {
    return "defaults";
  }

  if (value !== "defaults" && value !== "profile") {
    throw new TypeError("task profile mode must be defaults or profile");
  }

  return value;
}

function assertLane(value: unknown): ScheduleLane {
  if (value !== "short" && value !== "draft") {
    throw new TypeError("profile lane must be short or draft");
  }

  return value;
}

function parseMetadataLane(value: unknown): ScheduleLane | undefined {
  if (value === "short" || value === "draft") {
    return value;
  }

  return undefined;
}

function normalizeResponseFormat(value: unknown): InferenceResponseFormat | undefined {
  if (value === undefined) {
    return undefined;
  }

  assertRecord(value, "profile responseFormat");
  assertKnownObjectKeys(value, "profile responseFormat", new Set(["type"]));

  if (value.type !== "text" && value.type !== "json_object") {
    throw new TypeError("profile responseFormat.type must be text or json_object");
  }

  return { type: value.type };
}

function normalizeMetadata(
  value: Record<string, string> | undefined,
  label: string,
): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  assertRecord(value, label);
  const entries = objectEntries(value, label);
  if (entries.length > MAX_PROFILE_METADATA_ENTRIES) {
    throw new RangeError(`${label} must contain at most ${MAX_PROFILE_METADATA_ENTRIES} entries`);
  }

  const metadata: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (unsafeRecordKeys.has(key)) {
      throw new TypeError(`${label} must not contain unsafe key "${key}"`);
    }

    assertBoundedString(key, `${label} key`, MAX_PROFILE_METADATA_KEY_CHARS);
    if (typeof entry !== "string") {
      throw new TypeError(`${label} values must be strings`);
    }

    if (entry.length > MAX_PROFILE_METADATA_VALUE_CHARS) {
      throw new RangeError(
        `${label}.${key} must be at most ${MAX_PROFILE_METADATA_VALUE_CHARS} characters`,
      );
    }

    metadata[key] = entry;
  }

  return metadata;
}

function normalizeStop(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("profile stop must be a non-empty array of strings when provided");
  }

  if (value.length > MAX_PROFILE_STOP_SEQUENCES) {
    throw new RangeError(`profile stop must contain at most ${MAX_PROFILE_STOP_SEQUENCES} entries`);
  }

  return value.map((entry, index) =>
    assertBoundedString(entry, `profile stop[${index}]`, MAX_PROFILE_STOP_SEQUENCE_CHARS),
  );
}

function normalizeProfile(value: RayTaskProfile): RayTaskProfile {
  assertRecord(value, "task profile");
  assertKnownObjectKeys(value, "task profile", profileKeys);

  const responseFormat = normalizeResponseFormat(value.responseFormat);
  const stop = normalizeStop(value.stop);
  return {
    id: assertBoundedString(value.id, "profile id", MAX_PROFILE_ID_CHARS),
    task: assertTaskKind(value.task),
    maxTokens: assertPositiveSafeIntegerAtMost(
      value.maxTokens,
      "profile maxTokens",
      MAX_PROFILE_TOKENS,
    ),
    temperature: assertNumberInRange(value.temperature, "profile temperature", 0, 2),
    topP: assertNumberInRange(value.topP, "profile topP", 0.1, 1),
    timeoutMs: assertPositiveSafeIntegerAtMost(
      value.timeoutMs,
      "profile timeoutMs",
      MAX_PROFILE_TIMEOUT_MS,
    ),
    cachePolicy: assertCachePolicy(value.cachePolicy),
    lane: assertLane(value.lane),
    dedupePolicy: assertDedupePolicy(value.dedupePolicy),
    ...(responseFormat ? { responseFormat } : {}),
    metadata: normalizeMetadata(value.metadata, "profile metadata"),
    ...(stop ? { stop } : {}),
  };
}

function cloneProfile(profile: RayTaskProfile): RayTaskProfile {
  return structuredClone(profile);
}

function normalizeCatalog(value: TaskProfileCatalog | undefined): TaskProfileCatalog {
  if (value === undefined) {
    return createDefaultTaskProfileCatalog();
  }

  assertRecord(value, "task profile catalog");
  assertKnownObjectKeys(value, "task profile catalog", catalogKeys);

  return createTaskProfileCatalog(value.profiles, {
    ...(value.defaultProfileId ? { defaultProfileId: value.defaultProfileId } : {}),
  });
}

function assertInferenceRequest(value: unknown): asserts value is InferenceRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RayError("request body must be a JSON object", {
      code: "invalid_request",
      status: 400,
    });
  }
}

function buildProfileMetadata(
  profile: RayTaskProfile,
  lane: ScheduleLane,
  cachePolicy: TaskProfileCachePolicy,
  requestMetadata: Record<string, string> | undefined,
  optionsMetadata: Record<string, string> | undefined,
): Record<string, string> {
  return normalizeMetadata(
    {
      ...profile.metadata,
      ...(requestMetadata ?? {}),
      ...(optionsMetadata ?? {}),
      rayTaskProfile: profile.id,
      rayTaskKind: profile.task,
      rayTaskCachePolicy: cachePolicy,
      promptLane: lane,
    },
    "task profile metadata",
  );
}

function resolveProfileId(catalog: TaskProfileCatalog, profileId: string | undefined): string {
  const resolved = profileId ?? catalog.defaultProfileId ?? "draft";
  return assertBoundedString(resolved, "profileId", MAX_PROFILE_ID_CHARS);
}

export function createDefaultTaskProfileCatalog(): TaskProfileCatalog {
  return {
    profiles: defaultProfiles.map(cloneProfile),
    defaultProfileId: "draft",
  };
}

export function createTaskProfileCatalog(
  profiles: readonly RayTaskProfile[],
  options: TaskProfileCatalogOptions = {},
): TaskProfileCatalog {
  assertRecord(options, "task profile catalog options");
  assertKnownObjectKeys(options, "task profile catalog options", catalogOptionKeys);

  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new TypeError("task profile catalog profiles must be a non-empty array");
  }

  if (profiles.length > MAX_PROFILES) {
    throw new RangeError(`task profile catalog must contain at most ${MAX_PROFILES} profiles`);
  }

  const normalizedProfiles = profiles.map(normalizeProfile);
  const ids = new Set<string>();
  for (const profile of normalizedProfiles) {
    if (ids.has(profile.id)) {
      throw new TypeError(`task profile catalog contains duplicate profile "${profile.id}"`);
    }
    ids.add(profile.id);
  }

  const defaultProfileId =
    options.defaultProfileId === undefined
      ? undefined
      : assertBoundedString(options.defaultProfileId, "defaultProfileId", MAX_PROFILE_ID_CHARS);
  if (defaultProfileId && !ids.has(defaultProfileId)) {
    throw new TypeError(`defaultProfileId "${defaultProfileId}" does not match a task profile`);
  }

  return {
    profiles: normalizedProfiles.map(cloneProfile),
    ...(defaultProfileId ? { defaultProfileId } : {}),
  };
}

export function listTaskProfiles(catalog?: TaskProfileCatalog): RayTaskProfile[] {
  return normalizeCatalog(catalog).profiles.map(cloneProfile);
}

export function getTaskProfile(
  profileId: string,
  catalog?: TaskProfileCatalog,
): RayTaskProfile | undefined {
  const id = assertBoundedString(profileId, "profileId", MAX_PROFILE_ID_CHARS);
  const profile = normalizeCatalog(catalog).profiles.find((candidate) => candidate.id === id);
  return profile ? cloneProfile(profile) : undefined;
}

export function requireTaskProfile(
  profileId: string,
  catalog?: TaskProfileCatalog,
): RayTaskProfile {
  const profile = getTaskProfile(profileId, catalog);
  if (!profile) {
    throw new RayError(`Unknown task profile "${profileId}"`, {
      code: "invalid_request",
      status: 400,
    });
  }

  return profile;
}

export function buildTaskProfileDedupeKey(
  profile: RayTaskProfile,
  request: InferenceRequest,
): string {
  assertInferenceRequest(request);
  const normalizedProfile = normalizeProfile(profile);
  return hashValue({
    profileId: normalizedProfile.id,
    task: normalizedProfile.task,
    input: request.input ?? "",
    system: request.system ?? "",
    templateId: request.templateId ?? "",
    templateVariables: request.templateVariables ?? {},
    responseFormat: request.responseFormat ?? normalizedProfile.responseFormat ?? { type: "text" },
  });
}

export function resolveTaskProfileRequest(
  options: ResolveTaskProfileRequestOptions,
): ResolvedTaskProfileRequest {
  assertRecord(options, "task profile resolve options");
  assertKnownObjectKeys(options, "task profile resolve options", resolveOptionKeys);
  assertInferenceRequest(options.request);

  const mode = assertApplyMode(options.mode);
  const catalog = normalizeCatalog(options.catalog);
  const profile = requireTaskProfile(resolveProfileId(catalog, options.profileId), catalog);
  const requestMetadata = normalizeMetadata(options.request.metadata, "request metadata");
  const optionsMetadata = normalizeMetadata(options.metadata, "task profile options metadata");
  const callerLane = parseMetadataLane(optionsMetadata.promptLane ?? requestMetadata.promptLane);
  const lane = mode === "defaults" ? (callerLane ?? profile.lane) : profile.lane;
  const dedupePolicy =
    options.dedupePolicy === undefined
      ? profile.dedupePolicy
      : assertDedupePolicy(options.dedupePolicy);
  const cachePolicy =
    mode === "defaults" && options.request.cache !== undefined
      ? options.request.cache
        ? "read-write"
        : "bypass"
      : profile.cachePolicy;
  const dedupeKey =
    options.request.dedupeKey ??
    (dedupePolicy === "profile-input" ? buildTaskProfileDedupeKey(profile, options.request) : "");
  const request: InferenceRequest = {
    ...options.request,
    maxTokens:
      mode === "profile" || options.request.maxTokens === undefined
        ? profile.maxTokens
        : options.request.maxTokens,
    temperature:
      mode === "profile" || options.request.temperature === undefined
        ? profile.temperature
        : options.request.temperature,
    topP:
      mode === "profile" || options.request.topP === undefined
        ? profile.topP
        : options.request.topP,
    cache: cachePolicy === "read-write",
    metadata: buildProfileMetadata(profile, lane, cachePolicy, requestMetadata, optionsMetadata),
  };

  const responseFormat =
    mode === "profile" || options.request.responseFormat === undefined
      ? profile.responseFormat
      : options.request.responseFormat;
  if (responseFormat !== undefined) {
    request.responseFormat = responseFormat;
  }

  const stop =
    mode === "profile" || options.request.stop === undefined ? profile.stop : options.request.stop;
  if (stop !== undefined) {
    request.stop = [...stop];
  }

  if (dedupeKey) {
    request.dedupeKey = dedupeKey;
  }

  return {
    profile: cloneProfile(profile),
    request,
    execution: {
      profileId: profile.id,
      task: profile.task,
      mode,
      lane,
      timeoutMs: profile.timeoutMs,
      cachePolicy,
      dedupePolicy,
      ...(dedupeKey ? { dedupeKey } : {}),
    },
  };
}
