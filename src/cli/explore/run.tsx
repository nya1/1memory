import process from "node:process";
import { render } from "ink";
import { resolveProfile } from "../../profiles/profile-service.js";
import { ExploreApp } from "./App.js";

export interface ExploreCliOptions {
  workspaceDir: string;
  profileId?: string;
}

export async function runExploreTui(options: ExploreCliOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("justmemory explore needs an interactive terminal (TTY).\n");
    process.exitCode = 1;
    return;
  }

  const profile = await resolveProfile({
    workspace: options.workspaceDir,
    profile_id: options.profileId
  });

  const instance = render(
    <ExploreApp
      workspaceDir={options.workspaceDir}
      initialProfileId={profile.profile_id}
      initialProfileName={profile.name}
    />,
    { exitOnCtrlC: true }
  );

  await instance.waitUntilExit();
}
