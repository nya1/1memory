import { nanoid } from "nanoid";
import { readConfig, workspaceKey, writeConfig } from "../config/config-store.js";
import { resolveOneMemoryPaths } from "../config/paths.js";
import { OneMemoryError } from "../core/errors.js";
import { ProfileRecord } from "../core/types.js";
import { PROFILES_TABLE, openLocalDatabase } from "../storage/lancedb.js";
import { assertStoreWritesAllowed } from "../storage/migrations-runner.js";
import { withDbWriteLock } from "../storage/db-write-mutex.js";

function now(): string {
  return new Date().toISOString();
}

function createProfile(name: string, workspace?: string, repo?: string): ProfileRecord {
  const timestamp = now();
  return {
    profile_id: `prof_${nanoid(12)}`,
    name,
    scope_path: workspace ?? repo ?? "local/default",
    workspace_paths: workspace ? [workspace] : [],
    repo_urls: repo ? [repo] : [],
    default_namespace: "default",
    read_policy: "local",
    write_policy: "local",
    retention_policy: "default",
    created_at: timestamp,
    updated_at: timestamp,
    last_activity_at: timestamp
  };
}

function profileToRow(p: ProfileRecord): Record<string, unknown> {
  return {
    profile_id: p.profile_id,
    name: p.name,
    scope_path: p.scope_path,
    workspace_paths_json: JSON.stringify(p.workspace_paths),
    repo_urls_json: JSON.stringify(p.repo_urls),
    default_namespace: p.default_namespace,
    read_policy: p.read_policy,
    write_policy: p.write_policy,
    retention_policy: p.retention_policy,
    created_at: p.created_at,
    updated_at: p.updated_at,
    last_activity_at: p.last_activity_at
  };
}

function rowToProfile(row: Record<string, unknown>): ProfileRecord {
  return {
    profile_id: String(row.profile_id),
    name: String(row.name),
    scope_path: String(row.scope_path),
    workspace_paths: JSON.parse(String(row.workspace_paths_json ?? "[]")) as string[],
    repo_urls: JSON.parse(String(row.repo_urls_json ?? "[]")) as string[],
    default_namespace: String(row.default_namespace),
    read_policy: "local",
    write_policy: "local",
    retention_policy: "default",
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_activity_at: String(row.last_activity_at)
  };
}

async function loadProfilesFromDb(): Promise<ProfileRecord[]> {
  const { db } = await openLocalDatabase();
  const table = await db.openTable(PROFILES_TABLE);
  const rows = (await table.query().toArray()) as Record<string, unknown>[];
  return rows.map(rowToProfile);
}

export async function listProfiles(): Promise<ProfileRecord[]> {
  let profiles = await loadProfilesFromDb();

  if (profiles.length === 0) {
    assertStoreWritesAllowed();
    const profile = createProfile("local_default");
    await withDbWriteLock(async () => {
      const { db } = await openLocalDatabase();
      const table = await db.openTable(PROFILES_TABLE);
      await table.add([profileToRow(profile)]);

      const paths = resolveOneMemoryPaths();
      const config = await readConfig(paths);
      config.default_profile_id = profile.profile_id;
      await writeConfig(paths, config);
    });
    profiles = [profile];
  }

  return profiles;
}

export async function resolveProfile(input: {
  profile_id?: string;
  workspace?: string;
  repo?: string;
}): Promise<ProfileRecord> {
  await listProfiles();
  const profiles = new Map((await loadProfilesFromDb()).map((p) => [p.profile_id, p]));

  if (input.profile_id) {
    const profile = profiles.get(input.profile_id);
    if (!profile) {
      throw new OneMemoryError("profile_not_found", "Profile does not exist.", "Choose an existing profile.");
    }
    return profile;
  }

  const paths = resolveOneMemoryPaths();
  const config = await readConfig(paths);
  const key = workspaceKey(input.workspace, input.repo);
  const selected = config.selected_profiles[key];

  if (selected && profiles.has(selected)) {
    return profiles.get(selected)!;
  }

  const existing = [...profiles.values()].find((profile) => {
    return (
      (input.workspace && profile.workspace_paths.includes(input.workspace)) ||
      (input.repo && profile.repo_urls.includes(input.repo))
    );
  });

  if (existing) {
    return existing;
  }

  if (input.workspace || input.repo) {
    const name =
      input.repo?.split("/").pop()?.replace(/\.git$/, "") ||
      input.workspace?.split("/").pop() ||
      "workspace";
    const profile = createProfile(name, input.workspace, input.repo);
    assertStoreWritesAllowed();
    await withDbWriteLock(async () => {
      const { db } = await openLocalDatabase();
      const table = await db.openTable(PROFILES_TABLE);
      await table.add([profileToRow(profile)]);
      const latest = await readConfig(paths);
      latest.selected_profiles[key] = profile.profile_id;
      latest.default_profile_id ??= profile.profile_id;
      await writeConfig(paths, latest);
    });
    return profile;
  }

  const defaultProfile = config.default_profile_id ? profiles.get(config.default_profile_id) : undefined;
  if (defaultProfile) {
    return defaultProfile;
  }

  return [...profiles.values()][0];
}

export async function selectProfile(input: {
  profile_id: string;
  workspace?: string;
  repo?: string;
}): Promise<ProfileRecord> {
  const profile = await resolveProfile({ profile_id: input.profile_id });
  assertStoreWritesAllowed();
  const paths = resolveOneMemoryPaths();
  await withDbWriteLock(async () => {
    const config = await readConfig(paths);
    config.selected_profiles[workspaceKey(input.workspace, input.repo)] = profile.profile_id;
    config.default_profile_id = profile.profile_id;
    await writeConfig(paths, config);
  });
  return profile;
}
