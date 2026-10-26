import { join } from "node:path";
import { mkdir, rmdir, readFile, unlink } from "node:fs/promises";
import {
  dataDir,
  settingsPath,
  readJson,
  safeWrite,
  stableNodePath,
} from "./core.mjs";
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
export async function withSettingsLock(action) {
  const file = settingsPath();
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  const lock = `${file}.derpmeter-lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      "Settings are locked. Close other installers; remove stale settings.json.derpmeter-lock only if none are running.",
    );
  }
  try {
    return await action(file);
  } finally {
    await rmdir(lock);
  }
}
export async function installStatusline(cliPath, confirm) {
  return withSettingsLock(async (file) => {
    const beforeText = await readFile(file, "utf8").catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    const settings = beforeText === null ? {} : JSON.parse(beforeText);
    if (!settings || Array.isArray(settings) || typeof settings !== "object")
      throw new Error("Invalid Claude settings.");
    const recordPath = join(dataDir(), "statusline-install.json");
    const existing = await readJson(recordPath, null);
    // Reinstalling over our own unchanged entry (e.g. after the bin moved)
    // re-points it and keeps the original backup.
    const upgrade =
      existing?.file === file &&
      JSON.stringify(settings.statusLine) ===
        JSON.stringify(existing.installed);
    if (existing && !upgrade)
      throw new Error(
        "An installation backup already exists. Restore/uninstall before installing again.",
      );
    const previous = upgrade
      ? (existing.previous ?? undefined)
      : settings.statusLine;
    if (
      previous !== undefined &&
      (previous.type !== "command" || typeof previous.command !== "string")
    )
      throw new Error(
        "Unsupported existing statusLine. Configure manually; no changes made.",
      );
    if (
      !(await confirm(
        upgrade
          ? "Update the installed DerpMeter statusline command?"
          : previous
            ? "Compose DerpMeter after your existing statusline? Its command will still run locally."
            : "Install the DerpMeter statusline in Claude user settings?",
      ))
    )
      return false;
    const installed = {
      ...(upgrade ? existing.installed : previous),
      type: "command",
      command: `${quote(stableNodePath())} ${quote(cliPath)} statusline`,
    };
    // Backup only the setting we own. Never replace unrelated settings on restore.
    await safeWrite(recordPath, {
      file,
      previous: previous ?? null,
      installed,
    });
    if ((await readFile(file, "utf8").catch(() => null)) !== beforeText)
      throw new Error(
        "Settings changed during install. No settings written; inspect the backup.",
      );
    settings.statusLine = installed;
    await safeWrite(file, settings);
    return true;
  });
}
export async function uninstallStatusline(confirm) {
  return withSettingsLock(async (file) => {
    const recordPath = join(dataDir(), "statusline-install.json");
    const record = await readJson(recordPath, null);
    if (!record || record.file !== file)
      throw new Error("No backup for this settings location.");
    const beforeText = await readFile(file, "utf8");
    const settings = JSON.parse(beforeText);
    if (
      JSON.stringify(settings.statusLine) !== JSON.stringify(record.installed)
    )
      throw new Error(
        "statusLine was changed after installation. No settings changed. Restore manually using statusline-install.json.",
      );
    if (
      !(await confirm(
        "Restore your previous statusline? Unrelated settings will be preserved.",
      ))
    )
      return false;
    if (record.previous === null) delete settings.statusLine;
    else settings.statusLine = record.previous;
    if ((await readFile(file, "utf8")) !== beforeText)
      throw new Error("Settings changed during restore. Try again.");
    await safeWrite(file, settings);
    await unlink(recordPath);
    return true;
  });
}
// Only an explicitly confirmed prior local command gets stdin. Never sent remotely.
export async function previousStatusline() {
  const record = await readJson(
    join(dataDir(), "statusline-install.json"),
    null,
  );
  return record?.file === settingsPath()
    ? record?.previous?.command
    : undefined;
}
