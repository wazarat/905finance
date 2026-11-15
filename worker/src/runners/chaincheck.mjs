import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { lintSolidity } from "./solhint.mjs";

/**
 * A first look at addresses on GOAT Testnet3: what the chain and its explorer
 * say about each one. Reading only. The two hosts asked are fixed here; an
 * address a buyer supplies is only ever a parameter to them.
 */

export const CHAIN = {
  name: "GOAT Testnet3",
  id: 48816,
  rpc: "https://rpc.testnet3.goat.network",
  explorer: "https://explorer.testnet3.goat.network",
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
/** Where an EIP-1967 proxy keeps the address of its logic, and of whoever may replace it. */
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const OWNER_SELECTOR = "0x8da5cb5b";
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_SOURCE_FILES = 150;

const finding = (title, severity, location, evidence, recommendation) => ({
  title,
  severity,
  category: "observation",
  location,
  evidence: String(evidence).slice(0, 2000),
  recommendation,
});

async function rpcCall(method, params) {
  const response = await fetch(CHAIN.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${CHAIN.name} answered ${response.status}.`);
  const body = await response.json();
  if (body.error) throw new Error(String(body.error.message ?? "The chain refused the request.").slice(0, 200));
  return body.result;
}

/** What the explorer knows about a contract's source, or null when it has none. */
async function explorerContract(address) {
  const response = await fetch(`${CHAIN.explorer}/api/v2/smart-contracts/${address}`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The explorer answered ${response.status}.`);
  return response.json();
}

const asAddress = (word) => (typeof word === "string" && word.length >= 42 ? `0x${word.slice(-40)}` : ZERO);
const short = (address) => `${address.slice(0, 8)}…${address.slice(-4)}`;
const safeName = (name) => String(name).replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..").map((part) => part.replace(/[^A-Za-z0-9._@-]/g, "_")).join("/").slice(-180);

/** Write a verified contract's sources under `directory`, and say how many files that was. */
async function writeSources(directory, contract) {
  const sources = [
    { name: contract.file_path || `${contract.name || "Contract"}.sol`, text: contract.source_code },
    ...(Array.isArray(contract.additional_sources) ? contract.additional_sources : []).map((entry) => ({
      name: entry?.file_path,
      text: entry?.source_code,
    })),
  ].filter((entry) => typeof entry.text === "string" && typeof entry.name === "string" && entry.name.endsWith(".sol"));
  let bytes = 0;
  let written = 0;
  for (const source of sources.slice(0, MAX_SOURCE_FILES)) {
    bytes += Buffer.byteLength(source.text);
    if (bytes > MAX_SOURCE_BYTES) break;
    const file = path.join(directory, safeName(source.name) || `source-${written}.sol`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source.text);
    written += 1;
  }
  return written;
}

/**
 * Look at one address.
 * @param {{ rpc?: typeof rpcCall, explorer?: typeof explorerContract, runDir?: string, timeoutMs?: number }} io
 */
export async function inspectAddress(address, io) {
  const { rpc, explorer } = io;
  const findings = [];
  const notes = [];
  const code = await rpc("eth_getCode", [address, "latest"]);
  if (!code || code === "0x") {
    const [balance, sent] = await Promise.all([rpc("eth_getBalance", [address, "latest"]), rpc("eth_getTransactionCount", [address, "latest"])]);
    findings.push(
      finding(
        "This address is an account, not a contract",
        "info",
        address,
        `No contract code is stored at ${address} on ${CHAIN.name}. It has sent ${parseInt(sent, 16)} transactions and holds ${BigInt(balance)} wei.`,
        "There is no code to review at an account. If a contract was meant, check the address and the network.",
      ),
    );
    notes.push(`${address}: an account (no code).`);
    return { findings, notes };
  }
  notes.push(`${address}: a contract, ${(code.length - 2) / 2} bytes of code.`);

  const isAccount = async (other) => (await rpc("eth_getCode", [other, "latest"])) === "0x";

  // Can its logic be replaced, and by whom?
  const implementation = asAddress(await rpc("eth_getStorageAt", [address, IMPLEMENTATION_SLOT, "latest"]));
  const admin = asAddress(await rpc("eth_getStorageAt", [address, ADMIN_SLOT, "latest"]));
  let owner = ZERO;
  try {
    const answer = await rpc("eth_call", [{ to: address, data: OWNER_SELECTOR }, "latest"]);
    if (typeof answer === "string" && answer.length === 66) owner = asAddress(answer);
  } catch {
    // It has no owner() function, which is not a finding.
  }
  const upgradeable = implementation !== ZERO;
  if (upgradeable) {
    const controller = admin !== ZERO ? admin : owner;
    const single = controller !== ZERO && (await isAccount(controller));
    findings.push(
      finding(
        single ? "Its logic can be replaced by a single account" : "Its logic can be replaced (upgradeable proxy)",
        single ? "medium" : "low",
        address,
        [
          `EIP-1967 implementation slot: ${implementation}`,
          admin !== ZERO ? `EIP-1967 admin slot: ${admin}` : "EIP-1967 admin slot: empty (the logic contract decides who may upgrade)",
          owner !== ZERO ? `owner(): ${owner}` : "",
          single ? `${controller} has no code: it is an ordinary account, controlled by one key.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        single
          ? "Put upgrades behind a multi-signature wallet or a timelock, so one key cannot change what the contract does."
          : "Whoever controls upgrades can change what this contract does. Make sure users know who that is.",
      ),
    );
  } else if (owner !== ZERO && (await isAccount(owner))) {
    findings.push(finding("It is owned by a single account", "low", address, `owner(): ${owner}\n${owner} has no code: it is an ordinary account, controlled by one key.`, "If the owner can move funds or change settings, hold ownership in a multi-signature wallet."));
  }

  // Is its source published, and what does a first read of it show?
  const subjects = [{ address, label: short(address) }];
  if (upgradeable) subjects.push({ address: implementation, label: `${short(address)} logic ${short(implementation)}` });
  for (const subject of subjects) {
    const contract = await explorer(subject.address);
    if (!contract || contract.is_verified !== true) {
      findings.push(
        finding(
          subject.address === address ? "Its source code is not published" : "The logic contract's source code is not published",
          "medium",
          subject.address,
          `The explorer has no verified source for ${subject.address}.`,
          "Verify the source on the explorer. Without it, nobody can read what the contract does.",
        ),
      );
      notes.push(`${subject.address}: source not verified.`);
      continue;
    }
    const version = String(contract.compiler_version ?? "");
    notes.push(`${subject.address}: verified as ${contract.name ?? "a contract"}, compiler ${version || "unknown"}.`);
    const minor = Number(/v?0\.(\d+)\./.exec(version)?.[1] ?? 99);
    if (minor < 8) {
      findings.push(finding("It was built with a compiler older than 0.8", "low", subject.address, `Compiler: ${version}`, "Compilers before 0.8 do not check arithmetic for overflow. Review every calculation, or rebuild with a current compiler."));
    }
    if (io.runDir) {
      const folder = subject.address.toLowerCase();
      const written = await writeSources(path.join(io.runDir, folder), contract);
      if (written > 0) {
        const lint = await lintSolidity({ runDir: io.runDir, target: folder, timeoutMs: io.timeoutMs ?? 120_000 });
        if (lint.error) notes.push(`${subject.address}: the published source could not be reviewed (${lint.error}).`);
        else {
          notes.push(
            lint.files === 0
              ? `${subject.address}: its published source is library code only, which is not reviewed here.`
              : `${subject.address}: read ${lint.files} published source ${lint.files === 1 ? "file" : "files"} of its own. Library code it depends on is left out.`,
          );
          findings.push(...lint.findings.map((entry) => ({ ...entry, title: `${contract.name ?? "Contract"}: ${entry.title}` })));
        }
      }
    }
  }
  return { findings, notes };
}

const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/**
 * Look at every address a job names.
 * @param {{ source?: any, runDir?: string, timeoutMs?: number, toolVersion?: string | null }} input
 * @param {{ rpc?: (method: string, params: any[]) => Promise<any>, explorer?: (address: string) => Promise<any> }} [io] Test hook: stand in for the chain and its explorer.
 * @returns {Promise<{ tool: string, toolVersion: any, command: string, exitCode: number | null, durationMs: number, log: string, outcome: string, error?: string, findings: any[] }>}
 */
export async function runChaincheck({ source, runDir, timeoutMs, toolVersion }, io = {}) {
  const started = Date.now();
  const base = { tool: "chaincheck", toolVersion, command: `contract check on ${CHAIN.name}`, exitCode: null };
  const addresses = (Array.isArray(source?.addresses) ? source.addresses : []).filter((entry) => typeof entry === "string" && ADDRESS.test(entry)).slice(0, 10);
  if (addresses.length === 0) {
    return { ...base, durationMs: 0, log: "", outcome: "error", error: "The job names no address to look at.", findings: [] };
  }
  const every = [];
  const notes = [];
  try {
    for (const address of addresses) {
      const result = await inspectAddress(address, { rpc: io.rpc ?? rpcCall, explorer: io.explorer ?? explorerContract, runDir, timeoutMs });
      every.push(...result.findings);
      notes.push(...result.notes);
    }
  } catch (error) {
    return { ...base, durationMs: Date.now() - started, log: notes.join("\n"), outcome: "error", error: `${CHAIN.name} could not be read: ${String(error?.message ?? error).slice(0, 200)}`, findings: [] };
  }
  const findings = every
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => RANK[a.entry.severity] - RANK[b.entry.severity] || a.index - b.index)
    .map((item) => item.entry)
    .slice(0, 200);
  const serious = every.some((f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium");
  return {
    ...base,
    durationMs: Date.now() - started,
    log: [
      `Read ${addresses.length} ${addresses.length === 1 ? "address" : "addresses"} on ${CHAIN.name} (chain ${CHAIN.id}), from the chain and its explorer. Nothing was sent to any of them.`,
      ...notes,
    ].join("\n"),
    outcome: serious ? "failed" : "passed",
    findings,
  };
}
