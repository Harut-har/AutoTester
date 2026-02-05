import { Command } from "commander";
import { initDb, getDb } from "./db/index.js";
import { recordMacro } from "./recorder/index.js";
import { runMacro } from "./runner/index.js";
import { MacroRepository, type Locator } from "./db/repository.js";
import fs from "node:fs";
import path from "node:path";

const program = new Command();

program
  .name("autotester")
  .description("UI macro recorder/runner for browser tests")
  .version("0.1.0");

program
  .command("db:init")
  .description("initialize SQLite schema")
  .action(async () => {
    await initDb();
    console.log("DB initialized.");
  });

program
  .command("record")
  .description("record a macro")
  .argument("[url]", "base URL")
  .option("--url <url>", "base URL")
  .option("--name <name>", "macro name")
  .action(async (urlArg: string | undefined, options: { url?: string; name?: string }) => {
    const urlFromOption = typeof options.url === "string" ? options.url : undefined;
    const urlFromEnv = process.env.npm_config_url;
    const url = urlFromOption ?? urlArg ?? urlFromEnv;

    await initDb();
    await recordMacro({ url, name: options.name });
  });

program
  .command("run")
  .description("run a macro")
  .option("--macro-id <id>", "macro id")
  .option("--env <name>", "environment name")
  .option("--base-url <url>", "override base URL")
  .option("--stop-on-fail <bool>", "stop on first failure (default true)", "true")
  .action(async (options) => {
    await initDb();
    const stopOnFail = String(options.stopOnFail).toLowerCase() !== "false";
    await runMacro({ macroId: options.macroId, env: options.env, baseUrl: options.baseUrl, stopOnFail });
  });

program
  .command("list")
  .description("list macros")
  .action(async () => {
    await initDb();
    const repo = new MacroRepository(getDb());
    const rows = repo.list();
    if (rows.length === 0) {
      console.log("No macros found.");
      return;
    }

    const idWidth = Math.max(2, ...rows.map((r) => String(r.id).length));
    const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));

    const header = `${"ID".padEnd(idWidth)}  ${"NAME".padEnd(nameWidth)}`;
    console.log(header);
    console.log(`${"-".repeat(idWidth)}  ${"-".repeat(nameWidth)}`);
    for (const r of rows) {
      console.log(`${String(r.id).padEnd(idWidth)}  ${r.name.padEnd(nameWidth)}`);
    }
  });

function formatLocator(loc: Locator): string {
  if (loc.type === "role") {
    return `role:${loc.role}${loc.name ? `:${loc.name}` : ""}`;
  }
  return `${loc.type}:${"value" in loc ? loc.value : ""}`;
}

program
  .command("macro:show")
  .description("show macro steps")
  .option("--macro-id <id>", "macro id")
  .action(async (options) => {
    const macroId = Number(options.macroId);
    if (!Number.isFinite(macroId)) {
      console.error("Missing or invalid --macro-id");
      process.exitCode = 1;
      return;
    }

    await initDb();
    const repo = new MacroRepository(getDb());
    const steps = repo.getAllSteps(macroId);
    if (steps.length === 0) {
      console.log("No steps found.");
      return;
    }

    const header = "ORDER  EN  ACTION       LOCATORS                                  VALUE";
    console.log(header);
    console.log("-----  --  ----------  ----------------------------------------  -----");

    for (const s of steps) {
      const locs = s.locators ?? [];
      const locA = locs[0] ? formatLocator(locs[0]) : "-";
      const locB = locs[1] ? formatLocator(locs[1]) : "-";
      const locatorSummary = `${locA} | ${locB}`;
      const value = s.value ?? "";
      const action = s.action_type.padEnd(10).slice(0, 10);
      const order = String(s.order_index).padEnd(5).slice(0, 5);
      const enabled = String(s.enabled ?? 0).padEnd(2).slice(0, 2);
      const locatorCell = locatorSummary.padEnd(40).slice(0, 40);
      console.log(`${order}  ${enabled}  ${action}  ${locatorCell}  ${value}`);
    }
  });

program
  .command("macro:disable-step")
  .description("disable a macro step")
  .option("--macro-id <id>", "macro id")
  .option("--order <n>", "order index")
  .option("--step-id <id>", "step id")
  .action(async (options) => {
    const macroId = Number(options.macroId);
    const orderIndex = options.order ? Number(options.order) : NaN;
    const stepId = options.stepId ? Number(options.stepId) : NaN;

    if (Number.isFinite(stepId)) {
      await initDb();
      const repo = new MacroRepository(getDb());
      if (Number.isFinite(macroId)) {
        const ok = repo.isStepInMacro(stepId, macroId);
        if (!ok) {
          console.error("step-id does not belong to the given macro-id");
          process.exitCode = 1;
          return;
        }
      }
      const changes = repo.disableStepById(stepId);
      if (changes === 0) {
        console.error("No steps updated.");
        process.exitCode = 1;
        return;
      }
      console.log("Step disabled.");
      return;
    }

    if (!Number.isFinite(macroId)) {
      console.error("Missing or invalid --macro-id");
      process.exitCode = 1;
      return;
    }

    if (!Number.isFinite(orderIndex)) {
      console.error("Provide --order or --step-id");
      process.exitCode = 1;
      return;
    }

    await initDb();
    const repo = new MacroRepository(getDb());
    const changes = repo.disableStepByOrder(macroId, orderIndex);
    if (changes === 0) {
      console.error("No steps updated.");
      process.exitCode = 1;
      return;
    }

    console.log("Step disabled.");
  });

program
  .command("macro:rename")
  .description("rename a macro")
  .option("--macro-id <number>", "macro id")
  .option("--name <string>", "new macro name")
  .action(async (options) => {
    const macroId = Number(options.macroId);
    if (!Number.isInteger(macroId) || macroId <= 0) {
      console.error("Missing or invalid --macro-id (must be a positive integer)");
      process.exitCode = 1;
      return;
    }

    const name = String(options.name ?? "").trim();
    if (name.length === 0) {
      console.error("Missing or invalid --name (must be non-empty)");
      process.exitCode = 1;
      return;
    }

    await initDb();
    const repo = new MacroRepository(getDb());
    const renamed = repo.renameMacro({ macroId, name });
    if (!renamed) {
      console.error(`Macro ${macroId} not found.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Renamed macro ${macroId} to ${name}`);
  });

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatLocatorList(locators: Locator[] | undefined): string {
  if (!locators || locators.length === 0) return "-";
  return locators.map((l) => formatLocator(l)).join(" | ");
}

program
  .command("show-report")
  .description("show report by run id")
  .option("--run-id <id>", "run id")
  .option("--format <format>", "text|json|html|junit", "text")
  .action(async (options) => {
    const runId = Number(options.runId);
    if (!Number.isFinite(runId)) {
      console.error("Missing or invalid --run-id");
      process.exitCode = 1;
      return;
    }

    const reportPath = path.resolve(process.cwd(), "reports", `run-${runId}.json`);
    if (!fs.existsSync(reportPath)) {
      console.error(`Report not found: ${reportPath}`);
      process.exitCode = 1;
      return;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    const format = String(options.format || "text").toLowerCase();

    if (format === "json") {
      console.log(fs.readFileSync(reportPath, "utf-8"));
      return;
    }

    if (format === "html") {
      const steps = Array.isArray(report.steps) ? (report.steps as Array<{ order_index: number; action_type: string; status: string; error_message?: string | null; locators?: Locator[]; value?: string | null }>) : [];
      const rows = steps
        .map((s) => {
          const locators = formatLocatorList(s.locators);
          const value = s.value ?? "";
          const error = s.error_message ?? "";
          return `          <tr>
            <td>${escapeXml(String(s.order_index))}</td>
            <td>${escapeXml(s.action_type)}</td>
            <td>${escapeXml(locators)}</td>
            <td>${escapeXml(value)}</td>
            <td>${escapeXml(s.status)}</td>
            <td>${escapeXml(error)}</td>
          </tr>`;
        })
        .join("\n");

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AutoTester Report ${escapeXml(String(report.runId))}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
    h1 { margin: 0 0 8px; }
    .meta { margin: 0 0 16px; color: #555; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
    th { background: #f3f3f3; text-align: left; }
    .status-pass { color: #0a7b34; font-weight: 600; }
    .status-fail { color: #b00020; font-weight: 600; }
    .status-skipped { color: #8a6d3b; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Run ${escapeXml(String(report.runId))} — ${escapeXml(report.status)}</h1>
  <p class="meta">Macro: ${escapeXml(String(report.macroName ?? report.macroId))} | Env: ${escapeXml(String(report.envName ?? ""))} | Browser: ${escapeXml(String(report.browser ?? ""))}</p>
  <p class="meta">Summary: total=${escapeXml(String(report.summary?.total ?? steps.length))}, passed=${escapeXml(String(report.summary?.passed ?? 0))}, failed=${escapeXml(String(report.summary?.failed ?? 0))}, skipped=${escapeXml(String(report.summary?.skipped ?? 0))}</p>
  <table>
    <thead>
      <tr>
        <th>Order</th>
        <th>Action</th>
        <th>Locators</th>
        <th>Value</th>
        <th>Status</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>`;

      const htmlPath = path.resolve(process.cwd(), "reports", `run-${runId}.html`);
      fs.writeFileSync(htmlPath, html, "utf-8");
      console.log(`HTML report: ${htmlPath}`);
      return;
    }

    if (format === "junit") {
      await initDb();
      const repo = new MacroRepository(getDb());
      const results = repo.getRunStepResults(runId);
      const tests = report.summary?.total ?? results.length;
      const failures = report.summary?.failed ?? 0;
      const skipped = report.summary?.skipped ?? 0;
      const runMeta = repo.getRunMeta(runId);
      const envName = report.envName ?? runMeta?.env_name ?? "unknown";
      const browser = report.browser ?? runMeta?.browser ?? "unknown";
      const headlessValue =
        typeof report.headless === "boolean" ? report.headless : runMeta ? runMeta.headless === 1 : undefined;
      const headlessLabel = headlessValue === undefined ? "unknown" : headlessValue ? "headless" : "headed";
      const macroLabel = report.macroName ? String(report.macroName) : `macro-${report.macroId}`;
      const suiteName = `${macroLabel}__${envName}__${browser}__${headlessLabel}`;

      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      xml += `<testsuite name="${escapeXml(suiteName)}" tests="${tests}" failures="${failures}" skipped="${skipped}">\n`;

      for (const r of results) {
        const caseName = `step-${r.order_index}-${r.action_type}`;
        xml += `  <testcase name="${escapeXml(caseName)}">`;
        if (r.status === "FAIL") {
          const msg = r.error_message ?? "failure";
          xml += `<failure message="${escapeXml(msg)}"/>`;
        } else if (r.status === "SKIPPED") {
          xml += `<skipped/>`;
        }
        xml += `</testcase>\n`;
      }

      xml += `</testsuite>\n`;

      const junitPath = path.resolve(process.cwd(), "reports", `run-${runId}.xml`);
      fs.writeFileSync(junitPath, xml, "utf-8");
      console.log(`JUnit report: ${junitPath}`);
      return;
    }

    console.log(`Run ${report.runId} status: ${report.status}`);
    if (report.summary) {
      console.log(
        `Summary: total=${report.summary.total}, passed=${report.summary.passed}, failed=${report.summary.failed}, skipped=${report.summary.skipped ?? 0}`
      );
    }
    console.log(`Report file: ${reportPath}`);
  });

program.parseAsync(process.argv);

