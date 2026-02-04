import { chromium } from "playwright";
import { getDb, initDb } from "../db/index.js";
import { MacroRepository, type Locator } from "../db/repository.js";

type RecordedEvent = {
  type: "click" | "input" | "change" | "navigation" | "waitFor" | "assert";
  locators: Locator[];
  value?: string | null;
};

type MacroActionType =
  | "click"
  | "type"
  | "check"
  | "uncheck"
  | "select"
  | "navigation"
  | "waitFor"
  | "assert";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function recordMacro(options: { url?: string; name?: string }): Promise<void> {
  const url = options.url;
  const name = options.name ?? "Untitled macro";

  if (!isNonEmptyString(url)) {
    console.error("Missing --url");
    process.exitCode = 1;
    return;
  }

  initDb();
  const repo = new MacroRepository(getDb());

  const events: RecordedEvent[] = [];
  let stopRequested = false;

  function pushEvent(payload: RecordedEvent) {
    const last = events[events.length - 1];
    if (payload.type === "navigation") {
      if (last && last.type === "navigation" && last.value === payload.value) {
        return;
      }
    }
    if (payload.type === "click") {
      if (last && last.type === "click") {
        const a = JSON.stringify(last.locators[0] ?? null);
        const b = JSON.stringify(payload.locators[0] ?? null);
        if (a === b) return;
      }
    }
    events.push(payload);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.exposeBinding("__autotesterEvent", (_source, payload: RecordedEvent) => {
    pushEvent(payload);
  });

  await page.exposeBinding("__autotesterStop", async () => {
    stopRequested = true;
    await context.close();
    await browser.close();
  });

  await page.addInitScript(() => {
    function getDataSelector(el: Element): string | null {
      const dataTestId = el.getAttribute("data-testid");
      if (dataTestId) return `[data-testid="${dataTestId}"]`;
      const dataQa = el.getAttribute("data-qa");
      if (dataQa) return `[data-qa="${dataQa}"]`;
      return null;
    }

    function getRoleLocator(el: Element): { role: string; name?: string } | null {
      const role = el.getAttribute("role");
      if (!role) return null;
      const ariaLabel = el.getAttribute("aria-label");
      const text = (el.textContent || "").trim();
      let name = ariaLabel || text || undefined;
      if (name) {
        name = name.trim();
        if (name.length > 80) name = name.slice(0, 80);
      }
      return { role, name };
    }

    function cssPath(el: Element): string {
      if (el.id) return `#${el.id}`;
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let selector = current.nodeName.toLowerCase();
        if (current.id) {
          selector += `#${current.id}`;
          parts.unshift(selector);
          break;
        } else {
          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((c) => c.nodeName === current!.nodeName);
            if (siblings.length > 1) {
              const index = siblings.indexOf(current) + 1;
              selector += `:nth-of-type(${index})`;
            }
          }
        }
        parts.unshift(selector);
        current = current.parentElement;
      }
      return parts.join(" > ");
    }

    function xpath(el: Element): string {
      if (el.id) return `//*[@id="${el.id}"]`;
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.nodeName === current.nodeName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        const tagName = current.nodeName.toLowerCase();
        parts.unshift(`${tagName}[${index}]`);
        current = current.parentElement;
      }
      return "/" + parts.join("/");
    }

    function buildLocators(el: Element) {
      const locators: any[] = [];
      const dataSel = getDataSelector(el);
      if (dataSel) locators.push({ type: "data", value: dataSel });

      const role = getRoleLocator(el);
      if (role) locators.push({ type: "role", role: role.role, name: role.name });

      const css = cssPath(el);
      if (css) locators.push({ type: "css", value: css });

      const xp = xpath(el);
      if (xp) locators.push({ type: "xpath", value: xp });

      return locators;
    }

    function send(type: string, target: Element, value?: string | null) {
      const locators = buildLocators(target);
      (window as any).__autotesterEvent({ type, locators, value });
    }

    function normalizeTarget(target: Element): Element {
      return (
        target.closest('button,a,input,select,textarea,[role="button"],[data-testid],[data-qa]') ?? target
      );
    }

    let lastNormalizedClick: Element | null = null;
    let lastPointerElement: Element | null = null;

    document.addEventListener("mousemove", (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el) lastPointerElement = el;
    });

    document.addEventListener("click", (e) => {
      const target = e.target as Element | null;
      if (!target) return;
      const normalized = normalizeTarget(target);
      lastNormalizedClick = normalized;
      send("click", normalized);
    });

    const inputBuffer = new Map<string, { value: string; locators: any[]; timer: number | null }>();

    function keyFromLocators(locators: any[]): string {
      if (!locators || locators.length === 0) return "";
      const data = locators.find((l) => l.type === "data");
      if (data) return JSON.stringify(data);
      const css = locators.find((l) => l.type === "css");
      if (css) return JSON.stringify(css);
      return JSON.stringify(locators[0]);
    }

    function flushInput(key: string) {
      const entry = inputBuffer.get(key);
      if (!entry) return;
      if (entry.timer) window.clearTimeout(entry.timer);
      inputBuffer.delete(key);
      (window as any).__autotesterEvent({ type: "input", locators: entry.locators, value: entry.value });
    }

    function scheduleInput(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const locators = buildLocators(target);
      const key = keyFromLocators(locators);
      const existing = inputBuffer.get(key);
      if (existing && existing.timer) window.clearTimeout(existing.timer);
      const timer = window.setTimeout(() => flushInput(key), 400);
      inputBuffer.set(key, { value, locators, timer });
    }

    document.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement | HTMLTextAreaElement | null;
      if (!target) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const isSecret =
          target.type === "password" || target.getAttribute("autocomplete") === "current-password";
        const value = isSecret ? "__SECRET__" : target.value;
        scheduleInput(target, value);
      }
    });

    document.addEventListener(
      "blur",
      (e) => {
        const target = e.target as HTMLInputElement | HTMLTextAreaElement | null;
        if (!target) return;
        const locators = buildLocators(target);
        const key = keyFromLocators(locators);
        flushInput(key);
      },
      true
    );

    document.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement | HTMLInputElement | null;
      if (!target) return;
      if (target instanceof HTMLSelectElement) {
        send("change", target, target.value);
      } else if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
        send("change", target, target.checked ? "checked" : "unchecked");
      }
    });

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    function emitNavigation() {
      (window as any).__autotesterEvent({ type: "navigation", locators: [], value: location.href });
    }

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args as any);
      emitNavigation();
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args as any);
      emitNavigation();
      return result;
    };

    window.addEventListener("popstate", emitNavigation);
    window.addEventListener("hashchange", emitNavigation);

    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        (window as any).__autotesterStop();
      }

      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const target = lastNormalizedClick || lastPointerElement || (document.activeElement as Element | null);
        if (target) send("waitFor", normalizeTarget(target));
      }

      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        const target = lastNormalizedClick || lastPointerElement || (document.activeElement as Element | null);
        if (target) send("assert", normalizeTarget(target));
      }

      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "u") {
        e.preventDefault();
        const pathname = location.pathname || "/";
        (window as any).__autotesterEvent({ type: "assert", locators: [], value: `url:${pathname}` });
      }

      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        const text = window.prompt("Text contains:");
        if (text && text.trim().length > 0) {
          const target = lastNormalizedClick || lastPointerElement || (document.activeElement as Element | null);
          if (target) {
            const normalized = normalizeTarget(target);
            const locators = buildLocators(normalized);
            (window as any).__autotesterEvent({
              type: "assert",
              locators,
              value: `text:${text.trim()}`,
            });
          }
        }
      }
    });
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      pushEvent({ type: "navigation", locators: [], value: frame.url() });
    }
  });

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (stopRequested) {
        clearInterval(interval);
        resolve();
      }
    }, 200);

    browser.on("disconnected", () => {
      clearInterval(interval);
      resolve();
    });
  });

  if (events.length === 0) {
    console.log("No events recorded.");
    return;
  }

  const macroId = repo.createMacro({ name, baseUrl: url });
  const steps = events.map((e, idx) => {
    let actionType: MacroActionType = "click";
    let value = e.value ?? null;

    if (e.type === "click" || e.type === "navigation" || e.type === "waitFor" || e.type === "assert") {
      actionType = e.type;
    }
    if (e.type === "input") actionType = "type";
    if (e.type === "change") {
      if (value === "checked" || value === "unchecked") {
        actionType = value === "checked" ? "check" : "uncheck";
        value = null;
      } else {
        actionType = "select";
      }
    }

    return {
      orderIndex: idx + 1,
      actionType,
      locators: e.locators,
      value,
    };
  });

  repo.addSteps(macroId, steps);

  console.log(`Recorded macro ${macroId} with ${steps.length} steps.`);
}
