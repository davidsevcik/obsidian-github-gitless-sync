/**
 * Where the E2E tests run, all overridable with environment variables.
 */
export const config = {
  // SSH host of the macOS VM running Obsidian, with the Obsidian CLI enabled
  sshHost: process.env.E2E_SSH_HOST ?? "agent-vm",
  // Folder on the VM, relative to the home, that holds the E2E vaults
  vaultsDir: process.env.E2E_VAULTS_DIR ?? "Vaults",
  // Repository the tests sync with, each scenario uses its own branch
  repo: process.env.E2E_REPO ?? "kitt-assist/tmp",
  branchPrefix: "e2e/",
  pluginId: "github-gitless-sync",
};

/**
 * Token with read and write access to the contents of the test repository.
 * Never print it.
 */
export function githubToken(): string {
  const token = process.env.E2E_GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "E2E_GITHUB_TOKEN is not set, it must be a token with access to " +
        config.repo,
    );
  }
  return token;
}
