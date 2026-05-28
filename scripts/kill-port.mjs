import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ports = process.argv.slice(2).map(Number).filter(Number.isFinite);
const targetPorts = ports.length ? ports : [4178];

if (process.platform === "win32") {
  await killWindowsPorts(targetPorts);
} else {
  await killUnixPorts(targetPorts);
}

async function killWindowsPorts(portsToKill) {
  const stdout = await execFileAsync("netstat", ["-ano", "-p", "tcp"])
    .then((result) => result.stdout)
    .catch(() => "");
  const pids = new Set();

  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== "TCP") {
      continue;
    }

    const localAddress = columns[1] || "";
    const state = columns[3] || "";
    const pid = columns[4] || "";
    if (state.toUpperCase() !== "LISTENING") {
      continue;
    }

    if (portsToKill.some((port) => localAddress.endsWith(`:${port}`))) {
      pids.add(pid);
    }
  }

  await killPids([...pids], async (pid) => {
    await execFileAsync("taskkill", ["/PID", pid, "/F", "/T"]);
  });
}

async function killUnixPorts(portsToKill) {
  const pids = new Set();

  for (const port of portsToKill) {
    const stdout = await execFileAsync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])
      .then((result) => result.stdout)
      .catch(() => "");
    stdout.split(/\s+/).filter(Boolean).forEach((pid) => pids.add(pid));
  }

  await killPids([...pids], async (pid) => {
    process.kill(Number(pid), "SIGTERM");
  });
}

async function killPids(pids, killPid) {
  const currentPid = String(process.pid);
  const targets = pids.filter((pid) => pid && pid !== currentPid);

  if (!targets.length) {
    console.log(`No dev server process found on port(s): ${targetPorts.join(", ")}.`);
    return;
  }

  for (const pid of targets) {
    try {
      await killPid(pid);
      console.log(`Stopped process ${pid} on BrowserPilot dev port.`);
    } catch (error) {
      console.warn(`Could not stop process ${pid}: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown");
}
