import { chromium, firefox, webkit, type Locator as PwLocator, type Page } from "playwright";
import { getDb, initDb } from "../db/index.js";
import { MacroRepository, type Locator } from "../db/repository.js";
import fs from "node:fs";
import path from "node:path";

type EnvConfig = {
  baseURL?: string;
  browser?: "chromium" | "firefox" | "webkit";
  headless?: boolean;
  timeouts?: { step?: number; global?: number };
};

type EnvsFile = Record<string, EnvConfig>;

type EnvLoadResult = { config: EnvConfig | null; error?: string };

function loadEnvConfig(envName: string): EnvLoadResult {
  const filePath = path.resolve(process.cwd(), "envs.json");
  if (!fs.existsSync(filePath)) return { config: null };
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as EnvsFile;
    if (!(envName in parsed)) {
      return { config: null, error: `env '${envName}' not found in envs.json` };
    }
    return { config: parsed[envName] ?? null };
  } catch {
    return { config: null, error: "invalid envs.json" };
  }
}

function resolveLocator(page: Page, locator: Locator): PwLocator {
  switch (locator.type) {
    case "data":
    case "css":
      return page.locator(locator.value);
    case "xpath":
      return page.locator(`xpath=${locator.value}`);
    case "role":
      return page.getByRole(locator.role as any, locator.name ? { name: locator.name } : undefined);
    default:
      return page.locator("");
  }
}

async function findLocator(page: Page, locators: Locator[]): Promise<{ locator: PwLocator; used: Locator } | null> {
  for (const loc of locators) {
    const l = resolveLocator(page, loc);
    try {
      const count = await l.count();
      if (count > 0) return { locator: l.first(), used: loc };
    } catch {
      // ignore and try next
    }
  }
  return null;
}

async function ensureVisibleEnabled(locator: PwLocator, timeoutMs: number): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  await locator.waitFor({ state: "attached", timeout: timeoutMs });
  const enabled = await locator.isEnabled();
  if (!enabled) {
    throw new Error("Element is disabled");
  }
}

function resolveStepTimeout(step: { timeouts: string | null }, defaultMs: number): number {
  if (!step.timeouts) return defaultMs;
  try {
    const parsed = JSON.parse(step.timeouts) as { step?: number };
    if (typeof parsed.step === "number" && parsed.step > 0) return parsed.step;
  } catch {
    // ignore invalid json and fall back to default
  }
  return defaultMs;
}

export async function runMacro(options: {
  macroId?: string;
  env?: string;
  baseUrl?: string;
  stopOnFail?: boolean;
}): Promise<void> {
  const macroId = Number(options.macroId);
  if (!Number.isFinite(macroId)) {
    console.error("Missing or invalid --macro-id");
    process.exitCode = 1;
    return;
  }

  const envName = options.env ?? "dev";
  const envResult = loadEnvConfig(envName);
  if (envResult.error) {
    console.error(envResult.error);
    process.exitCode = 1;
    return;
  }
  const envConfig = envResult.config;

  initDb();
  const repo = new MacroRepository(getDb());
  const macro = repo.getMacro(macroId);
  if (!macro) {
    console.error(`Macro ${macroId} not found`);
    process.exitCode = 1;
    return;
  }

  const steps = repo.getAllSteps(macroId);
  if (steps.length === 0) {
    console.error("No steps found for macro");
    process.exitCode = 1;
    return;
  }

  const reportsDir = path.resolve(process.cwd(), "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const browserName = envConfig?.browser ?? "chromium";
  const launcher = browserName === "firefox" ? firefox : browserName === "webkit" ? webkit : chromium;
  const headless = envConfig?.headless ?? true;
  const stepTimeoutDefault = envConfig?.timeouts?.step ?? 5000;
  const globalTimeout = envConfig?.timeouts?.global ?? 10000;
  const stopOnFail = options.stopOnFail ?? true;

  const browser = await launcher.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const runId = repo.createRun({ macroId, envName, browser: browserName, headless });
  const runSummary: { total: number; passed: number; failed: number; skipped: number; tracePath?: string | null } = {
    total: steps.length,
    passed: 0,
    failed: 0,
    skipped: 0,
  };

  let failed = false;

  const baseUrl = options.baseUrl ?? envConfig?.baseURL ?? macro.base_url ?? null;
  if (baseUrl) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  }

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const startedAt = new Date().toISOString();
    const stepTimeout = resolveStepTimeout(step, stepTimeoutDefault);

    if (step.enabled === 0) {
      repo.addStepResult({ runId, stepId: step.id, status: "SKIPPED", startedAt, finishedAt: new Date().toISOString() });
      runSummary.skipped += 1;
      continue;
    }

    try {
      if (step.action_type === "navigation") {
        const targetUrl = step.value ?? "";
        if (targetUrl) {
          await page.waitForURL(`**${targetUrl}**`, { timeout: globalTimeout });
        }
        repo.addStepResult({ runId, stepId: step.id, status: "PASS", startedAt, finishedAt: new Date().toISOString() });
        runSummary.passed += 1;
        continue;
      }

      if (step.action_type === "waitFor") {
        if (step.value && step.value.startsWith("url:")) {
          const urlPart = step.value.slice(4);
          await page.waitForURL(`**${urlPart}**`, { timeout: globalTimeout });
          repo.addStepResult({ runId, stepId: step.id, status: "PASS", startedAt, finishedAt: new Date().toISOString() });
        } else {
          const found = await findLocator(page, step.locators);
          if (!found) throw new Error("Locator not found");
          await ensureVisibleEnabled(found.locator, stepTimeout);
          repo.addStepResult({
            runId,
            stepId: step.id,
            status: "PASS",
            startedAt,
            finishedAt: new Date().toISOString(),
            usedLocator: found.used,
          });
        }
        runSummary.passed += 1;
        continue;
      }

      if (step.action_type === "assert") {
        if (step.value && step.value.startsWith("url:")) {
          const urlPart = step.value.slice(4);
          const currentPath = new URL(page.url()).pathname;
          if (!currentPath.includes(urlPart)) {
            throw new Error(`URL does not contain ${urlPart}`);
          }
          repo.addStepResult({ runId, stepId: step.id, status: "PASS", startedAt, finishedAt: new Date().toISOString() });
          runSummary.passed += 1;
          continue;
        }
        const found = await findLocator(page, step.locators);
        if (!found) throw new Error("Locator not found");
        await ensureVisibleEnabled(found.locator, stepTimeout);
        if (step.value && step.value.startsWith("text:")) {
          const expected = step.value.slice(5);
          const text = (await found.locator.textContent()) ?? "";
          if (!text.includes(expected)) {
            throw new Error(`Text does not contain ${expected}`);
          }
        }
        repo.addStepResult({
          runId,
          stepId: step.id,
          status: "PASS",
          startedAt,
          finishedAt: new Date().toISOString(),
          usedLocator: found.used,
        });
        runSummary.passed += 1;
        continue;
      }

      const found = await findLocator(page, step.locators);
      if (!found) throw new Error("Locator not found");

      await ensureVisibleEnabled(found.locator, stepTimeout);

      switch (step.action_type) {
        case "click":
          await found.locator.click();
          break;
        case "type": {
          let value = step.value ?? "";
          if (value === "__SECRET__") {
            const secret = process.env.AUTOTESTER_SECRET_PASSWORD;
            if (!secret) throw new Error("Missing AUTOTESTER_SECRET_PASSWORD for secret field");
            value = secret;
          }
          await found.locator.fill(value);
          break;
        }
        case "select":
          await found.locator.selectOption(step.value ?? "");
          break;
        case "check":
          await found.locator.check();
          break;
        case "uncheck":
          await found.locator.uncheck();
          break;
        default:
          throw new Error(`Unsupported action_type: ${step.action_type}`);
      }

      repo.addStepResult({
        runId,
        stepId: step.id,
        status: "PASS",
        startedAt,
        finishedAt: new Date().toISOString(),
        usedLocator: found.used,
      });
      runSummary.passed += 1;
    } catch (err) {
      failed = true;
      runSummary.failed += 1;
      const screenshotPath = path.join(reportsDir, `run-${runId}-step-${step.order_index}.png`);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch {
        // ignore
      }
      repo.addStepResult({
        runId,
        stepId: step.id,
        status: "FAIL",
        startedAt,
        finishedAt: new Date().toISOString(),
        errorMessage: err instanceof Error ? err.message : String(err),
        screenshotPath,
      });
      if (screenshotPath) {
        repo.addArtifact({ runId, type: "screenshot", storageUrl: screenshotPath });
      }
      if (stopOnFail) {
        for (let j = i + 1; j < steps.length; j += 1) {
          const rest = steps[j];
          const restStart = new Date().toISOString();
          if (rest.enabled === 0) {
            repo.addStepResult({
              runId,
              stepId: rest.id,
              status: "SKIPPED",
              startedAt: restStart,
              finishedAt: new Date().toISOString(),
            });
          } else {
            repo.addStepResult({
              runId,
              stepId: rest.id,
              status: "SKIPPED",
              startedAt: restStart,
              finishedAt: new Date().toISOString(),
              errorMessage: "not executed (stop-on-fail)",
            });
          }
          runSummary.skipped += 1;
        }
        break;
      }
    }
  }

  let tracePath: string | null = null;
  if (failed) {
    tracePath = path.join(reportsDir, `run-${runId}.zip`);
    await context.tracing.stop({ path: tracePath });
    repo.addArtifact({ runId, type: "trace", storageUrl: tracePath });
    runSummary.tracePath = tracePath;
  } else {
    await context.tracing.stop();
  }

  repo.finishRun(runId, { status: failed ? "FAIL" : "PASS", summary: runSummary });

  const runStepResults = repo.getRunStepResults(runId);
  const resultById = new Map<number, (typeof runStepResults)[number]>();
  for (const r of runStepResults) {
    resultById.set(r.step_id, r);
  }
  const reportSteps = steps.map((s) => {
    const result = resultById.get(s.id);
    return {
      step_id: s.id,
      order_index: s.order_index,
      action_type: s.action_type,
      status: result?.status ?? "UNKNOWN",
      error_message: result?.error_message ?? null,
      locators: s.locators,
      value: s.value ?? null,
      enabled: s.enabled,
      timeouts: s.timeouts,
    };
  });

  const report = {
    runId,
    macroId,
    macroName: macro.name,
    envName,
    browser: browserName,
    headless,
    status: failed ? "FAIL" : "PASS",
    summary: runSummary,
    steps: reportSteps,
    artifacts: tracePath ? { trace: tracePath } : undefined,
  };

  const reportPath = path.join(reportsDir, `run-${runId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  await context.close();
  await browser.close();

  console.log(`Run ${runId} finished with status ${report.status}. Report: ${reportPath}`);

  if (failed) {
    process.exitCode = 1;
  }
}

