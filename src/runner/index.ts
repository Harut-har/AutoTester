import { chromium, firefox, webkit, type Locator as PwLocator, type Page } from "playwright";
import { createRepository, getDbProvider } from "../db/factory.js";
import { type Locator } from "../db/repository.js";
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

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveTargetUrl(value: string, baseUrl: string | null): string {
  if (isAbsoluteUrl(value)) return value;
  if (baseUrl && baseUrl.trim().length > 0) {
    return new URL(value, baseUrl).toString();
  }
  return value;
}

function buildUrlMatcher(value: string, baseUrl: string | null): string | RegExp {
  const resolved = resolveTargetUrl(value, baseUrl);
  if (isAbsoluteUrl(resolved)) return resolved;
  return new RegExp(escapeRegExp(resolved));
}

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

function parseCoordPair(value: string): { x: number; y: number } | null {
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function parseCssExpectation(value: string): { prop: string; expected: string } | null {
  const idx = value.indexOf(":");
  if (idx <= 0) return null;
  const prop = value.slice(0, idx).trim();
  const expected = value.slice(idx + 1).trim();
  if (!prop || !expected) return null;
  return { prop, expected };
}

export async function runMacro(options: {
  macroId?: string;
  env?: string;
  baseUrl?: string;
  stopOnFail?: boolean;
  headless?: boolean;
  timeoutMs?: number;
  waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
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

  let repo: Awaited<ReturnType<typeof createRepository>>;
  try {
    repo = await createRepository();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`cannot connect to ${getDbProvider()}: ${message}`);
    process.exitCode = 1;
    return;
  }

  const macro = await repo.getMacro(macroId);
  if (!macro) {
    console.error(`Macro ${macroId} not found`);
    process.exitCode = 1;
    return;
  }

  const steps = await repo.getAllSteps(macroId);
  if (steps.length === 0) {
    console.error("No steps found for macro");
    process.exitCode = 1;
    return;
  }

  const reportsDir = path.resolve(process.cwd(), "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const browserName = envConfig?.browser ?? "chromium";
  const launcher = browserName === "firefox" ? firefox : browserName === "webkit" ? webkit : chromium;
  const headless = options.headless ?? envConfig?.headless ?? true;
  const stepTimeoutDefault = envConfig?.timeouts?.step ?? 5000;
  const globalTimeout = envConfig?.timeouts?.global ?? 10000;
  const navigationTimeout = options.timeoutMs ?? globalTimeout;
  const waitUntil = options.waitUntil ?? "domcontentloaded";
  const stopOnFail = options.stopOnFail ?? true;

  const browser = await launcher.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const runId = await repo.createRun({ macroId, envName, browser: browserName, headless });
  const runSummary: { total: number; passed: number; failed: number; skipped: number; tracePath?: string | null } = {
    total: steps.length,
    passed: 0,
    failed: 0,
    skipped: 0,
  };

  let failed = false;

  const baseUrl = options.baseUrl ?? envConfig?.baseURL ?? macro.base_url ?? null;
  if (baseUrl) {
    await page.goto(baseUrl, { waitUntil, timeout: navigationTimeout });
  }

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const startedAt = new Date().toISOString();
    const stepTimeout = resolveStepTimeout(step, stepTimeoutDefault);

    if (step.enabled === 0) {
      await repo.addStepResult({ runId, stepId: step.id, status: "SKIPPED", startedAt, finishedAt: new Date().toISOString() });
      runSummary.skipped += 1;
      continue;
    }

    try {
      if (step.action_type === "navigation") {
        const targetUrl = step.value ?? "";
        if (!targetUrl) {
          throw new Error("Missing navigation URL");
        }
        const resolvedUrl = resolveTargetUrl(targetUrl, baseUrl);
        const response = await page.goto(resolvedUrl, { waitUntil, timeout: navigationTimeout });
        if (response && response.status() >= 400) {
          throw new Error(`Navigation failed: ${response.status()} ${response.url()}`);
        }
        const title = await page.title();
        if (title.toLowerCase().includes("not found") && title.toLowerCase().includes("werkzeug")) {
          throw new Error(`Navigation failed: Werkzeug NotFound at ${page.url()}`);
        }
        if (title.toLowerCase().includes("not found")) {
          const content = await page.content();
          if (content.includes("Werkzeug") && content.includes("Not Found")) {
            throw new Error(`Navigation failed: Werkzeug NotFound at ${page.url()}`);
          }
        }
        await repo.addStepResult({ runId, stepId: step.id, status: "PASS", startedAt, finishedAt: new Date().toISOString() });
        runSummary.passed += 1;
        continue;
      }

      if (step.action_type === "scrollTo") {
        const value = step.value ?? "";
        const coord = parseCoordPair(value);
        if (coord) {
          await page.evaluate(({ x, y }) => window.scrollTo(x, y), coord);
        } else {
          const y = Number(value);
          if (!Number.isFinite(y)) {
            throw new Error("Invalid scrollTo value (expected x,y or y)");
          }
          await page.evaluate((yy) => window.scrollTo(0, yy), y);
        }
        await repo.addStepResult({ runId, stepId: step.id, status: "PASS", startedAt, finishedAt: new Date().toISOString() });
        runSummary.passed += 1;
        continue;
      }

      if (step.action_type === "waitFor") {
        if (step.value && step.value.startsWith("url:")) {
          const urlPart = step.value.slice(4);
          const matcher = buildUrlMatcher(urlPart, baseUrl);
          await page.waitForURL(matcher, { waitUntil, timeout: navigationTimeout });
          await repo.addStepResult({ runId, stepId: step.id, status: "PASS", startedAt, finishedAt: new Date().toISOString() });
        } else {
          if (!step.locators || step.locators.length === 0) {
            throw new Error("No locators for step");
          }
          const found = await findLocator(page, step.locators);
          if (!found) throw new Error("Locator not found");
          await ensureVisibleEnabled(found.locator, stepTimeout);
          await repo.addStepResult({
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
          const matcher = buildUrlMatcher(urlPart, baseUrl);
          await page.waitForURL(matcher, { waitUntil, timeout: navigationTimeout });
          const expected = resolveTargetUrl(urlPart, baseUrl);
          if (isAbsoluteUrl(expected)) {
            if (!page.url().includes(expected)) {
              throw new Error(`URL does not contain ${expected}`);
            }
          } else {
            const currentPath = new URL(page.url()).pathname;
            if (!currentPath.includes(expected)) {
              throw new Error(`URL does not contain ${expected}`);
            }
          }
        await repo.addStepResult({ runId, stepId: step.id, status: "PASS", startedAt, finishedAt: new Date().toISOString() });
          runSummary.passed += 1;
          continue;
        }
        if (!step.locators || step.locators.length === 0) {
          throw new Error("No locators for step");
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
        await repo.addStepResult({
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

      if (!step.locators || step.locators.length === 0) {
        throw new Error("No locators for step");
      }
      const found = await findLocator(page, step.locators);
      if (!found) throw new Error("Locator not found");

      await ensureVisibleEnabled(found.locator, stepTimeout);

      switch (step.action_type) {
        case "click":
          await found.locator.click();
          break;
        case "dblclick":
          await found.locator.dblclick();
          break;
        case "hover":
          await found.locator.hover();
          break;
        case "clickAt": {
          const raw = step.value ?? "";
          let coord: { x: number; y: number } | null = null;
          if (raw.startsWith("offset:")) {
            const offset = parseCoordPair(raw.slice("offset:".length));
            if (!offset) throw new Error("Invalid clickAt offset value");
            const box = await found.locator.boundingBox();
            if (!box) throw new Error("Element has no bounding box");
            coord = { x: box.x + offset.x, y: box.y + offset.y };
          } else if (raw.startsWith("abs:")) {
            coord = parseCoordPair(raw.slice("abs:".length));
          } else {
            coord = parseCoordPair(raw);
          }
          if (!coord) throw new Error("Invalid clickAt value (expected x,y or offset:x,y)");
          await page.mouse.click(coord.x, coord.y);
          break;
        }
        case "type": {
          let value = step.value ?? "";
          if (value === "__SECRET__") {
            await repo.addStepResult({
              runId,
              stepId: step.id,
              status: "SKIPPED",
              startedAt,
              finishedAt: new Date().toISOString(),
              errorMessage: "secret value skipped",
              usedLocator: found.used,
            });
            runSummary.skipped += 1;
            continue;
          }
          await found.locator.fill(value);
          break;
        }
        case "assertCss": {
          const raw = step.value ?? "";
          const expectation = parseCssExpectation(raw);
          if (!expectation) throw new Error("Invalid assertCss value (expected prop:expected)");
          const actual = await found.locator.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), expectation.prop);
          if (!actual.trim().includes(expectation.expected)) {
            throw new Error(`CSS ${expectation.prop} does not include ${expectation.expected} (actual: ${actual.trim()})`);
          }
          break;
        }
        case "assertCursor": {
          const expected = (step.value ?? "").trim();
          if (!expected) throw new Error("Invalid assertCursor value");
          const actual = await found.locator.evaluate((el) => getComputedStyle(el).cursor);
          if (actual.trim() !== expected) {
            throw new Error(`Cursor is ${actual.trim()} (expected ${expected})`);
          }
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

      await repo.addStepResult({
        runId,
        stepId: step.id,
        status: "PASS",
        startedAt,
        finishedAt: new Date().toISOString(),
        usedLocator: found.used,
      });
      runSummary.passed += 1;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Step ${step.order_index} failed: ${errorMessage}`);
      failed = true;
      runSummary.failed += 1;
      const screenshotPath = path.join(reportsDir, `run-${runId}-step-${step.order_index}.png`);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch {
        // ignore
      }
      await repo.addStepResult({
        runId,
        stepId: step.id,
        status: "FAIL",
        startedAt,
        finishedAt: new Date().toISOString(),
        errorMessage,
        screenshotPath,
      });
      if (screenshotPath) {
        await repo.addArtifact({ runId, type: "screenshot", storageUrl: screenshotPath });
      }
      if (stopOnFail) {
        for (let j = i + 1; j < steps.length; j += 1) {
          const rest = steps[j];
          const restStart = new Date().toISOString();
          if (rest.enabled === 0) {
            await repo.addStepResult({
              runId,
              stepId: rest.id,
              status: "SKIPPED",
              startedAt: restStart,
              finishedAt: new Date().toISOString(),
            });
          } else {
            await repo.addStepResult({
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
    await repo.addArtifact({ runId, type: "trace", storageUrl: tracePath });
    runSummary.tracePath = tracePath;
  } else {
    await context.tracing.stop();
  }

  await repo.finishRun(runId, { status: failed ? "FAIL" : "PASS", summary: runSummary });

  const runStepResults = await repo.getRunStepResults(runId);
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
      screenshot_path: result?.screenshot_path ?? null,
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

