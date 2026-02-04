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

const RECORDED_EVENT_TYPES: ReadonlySet<RecordedEvent["type"]> = new Set([
  "click",
  "input",
  "change",
  "navigation",
  "waitFor",
  "assert",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLocator(value: unknown): value is Locator {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<Locator>;
  if (maybe.type === "data" || maybe.type === "css" || maybe.type === "xpath") {
    return typeof maybe.value === "string";
  }
  if (maybe.type === "role") {
    return typeof maybe.role === "string" && (maybe.name === undefined || typeof maybe.name === "string");
  }
  return false;
}

function isRecordedEventPayload(payload: unknown): payload is RecordedEvent {
  if (!payload || typeof payload !== "object") return false;
  const maybe = payload as Partial<RecordedEvent>;
  if (!maybe.type || !RECORDED_EVENT_TYPES.has(maybe.type as RecordedEvent["type"])) return false;
  if (!Array.isArray(maybe.locators) || !maybe.locators.every(isLocator)) return false;
  if (!(maybe.value === undefined || maybe.value === null || typeof maybe.value === "string")) return false;
  return true;
}

export async function recordMacro(options: { url?: string; name?: string }): Promise<void> {
  const url = options.url;
  const name = options.name ?? "Untitled macro";
  const debug = process.env.AUTOTESTER_DEBUG === "1";

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

  await context.exposeBinding("__autotesterEvent", (_source, payload: unknown) => {
    if (!isRecordedEventPayload(payload)) {
      if (debug) {
        const raw =
          payload === undefined
            ? "undefined"
            : payload === null
              ? "null"
              : typeof payload === "string"
                ? payload
                : JSON.stringify(payload);
        console.log(`[recorder] ignored invalid recorder payload ${raw.slice(0, 300)}`);
      }
      return;
    }
    if (debug) console.log(`[recorder] event=${payload.type} locators=${payload.locators.length}`);
    pushEvent(payload);
  });

  await context.exposeBinding("__autotesterStop", async () => {
    stopRequested = true;
    await context.close();
    await browser.close();
  });

  await context.addInitScript((params: { debug: boolean }) => {
    const debug = params.debug;
    if (debug) {
      console.log(`[autotester] recorder init: ${location.href}`);
    }

    type BrowserLocator =
      | { type: "data"; value: string }
      | { type: "role"; role: string; name?: string }
      | { type: "css"; value: string }
      | { type: "xpath"; value: string };
    type BrowserRecorderPayload = { type: string; locators: BrowserLocator[]; value?: string | null };

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

    function buildLocators(el: Element): BrowserLocator[] {
      const locators: BrowserLocator[] = [];
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

    function emit(payload: BrowserRecorderPayload) {
      const publish = (window as { __autotesterEvent?: (event: BrowserRecorderPayload) => void }).__autotesterEvent;
      if (typeof publish !== "function") {
        if (debug) {
          console.log("[autotester] publish missing", typeof publish);
        }
        return;
      }
      if (debug) {
        console.log("[autotester] emit", payload.type, payload.locators.length);
      }
      publish(payload);
    }

    function send(type: string, target: Element, value?: string | null) {
      const locators = buildLocators(target);
      emit({ type, locators, value });
    }

    function resolveElement(target: EventTarget | null): Element | null {
      if (!target) return null;
      if (target instanceof Element) return target;
      if (target instanceof Node) return target.parentElement;
      return null;
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

    document.addEventListener(
      "click",
      (e) => {
        const target = resolveElement(e.target);
        if (!target) return;
        const normalized = normalizeTarget(target);
        if (debug) {
          console.log("[autotester] click", normalized.tagName, normalized.id || "", normalized.className || "");
        }
        lastNormalizedClick = normalized;
        send("click", normalized);
      },
      true
    );

    const inputBuffer = new Map<string, { value: string; locators: BrowserLocator[]; timer: number | null }>();

    function keyFromLocators(locators: BrowserLocator[]): string {
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
      emit({ type: "input", locators: entry.locators, value: entry.value });
    }

    function flushAllInputs() {
      for (const key of inputBuffer.keys()) {
        flushInput(key);
      }
    }

    function scheduleInput(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const locators = buildLocators(target);
      const key = keyFromLocators(locators);
      const existing = inputBuffer.get(key);
      if (existing && existing.timer) window.clearTimeout(existing.timer);
      const timer = window.setTimeout(() => flushInput(key), 250);
      inputBuffer.set(key, { value, locators, timer });
    }

    document.addEventListener(
      "input",
      (e) => {
        const target = resolveElement(e.target);
        if (!target) return;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          const isSecret =
            target.type === "password" || target.getAttribute("autocomplete") === "current-password";
          const value = isSecret ? "__SECRET__" : target.value;
          if (debug) {
            console.log("[autotester] input", target.tagName, target.type || "", value?.length ?? 0);
          }
          scheduleInput(target, value);
        }
      },
      true
    );

    document.addEventListener(
      "blur",
      (e) => {
        const target = resolveElement(e.target);
        if (!target) return;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        const locators = buildLocators(target);
        const key = keyFromLocators(locators);
        flushInput(key);
      },
      true
    );

    document.addEventListener(
      "change",
      (e) => {
        const target = resolveElement(e.target);
        if (!target) return;
        if (target instanceof HTMLSelectElement) {
          if (debug) {
            console.log("[autotester] change", target.tagName, target.value);
          }
          send("change", target, target.value);
        } else if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
          const value = target.checked ? "checked" : "unchecked";
          if (debug) {
            console.log("[autotester] change", target.tagName, value);
          }
          send("change", target, value);
        }
      },
      true
    );

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    function emitNavigation() {
      flushAllInputs();
      emit({ type: "navigation", locators: [], value: location.href });
    }

    history.pushState = function (...args: Parameters<History["pushState"]>) {
      const result = originalPushState.apply(this, args);
      emitNavigation();
      return result;
    };
    history.replaceState = function (...args: Parameters<History["replaceState"]>) {
      const result = originalReplaceState.apply(this, args);
      emitNavigation();
      return result;
    };

    window.addEventListener("popstate", emitNavigation);
    window.addEventListener("hashchange", emitNavigation);

    document.addEventListener(
      "keydown",
      (e) => {
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
          e.preventDefault();
          if (debug) console.log("[autotester] hotkey", e.key);
          flushAllInputs();
          const stop = (window as { __autotesterStop?: () => void }).__autotesterStop;
          if (typeof stop === "function") stop();
        }

        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "w") {
          e.preventDefault();
          if (debug) console.log("[autotester] hotkey", e.key);
          const target = lastNormalizedClick || lastPointerElement || (document.activeElement as Element | null);
          if (target) send("waitFor", normalizeTarget(target));
        }

        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
          e.preventDefault();
          if (debug) console.log("[autotester] hotkey", e.key);
          const target = lastNormalizedClick || lastPointerElement || (document.activeElement as Element | null);
          if (target) send("assert", normalizeTarget(target));
        }

        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "u") {
          e.preventDefault();
          if (debug) console.log("[autotester] hotkey", e.key);
          const pathname = location.pathname || "/";
          emit({ type: "assert", locators: [], value: `url:${pathname}` });
        }

        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
          e.preventDefault();
          if (debug) console.log("[autotester] hotkey", e.key);
          const text = window.prompt("Text contains:");
          if (text && text.trim().length > 0) {
            const target = lastNormalizedClick || lastPointerElement || (document.activeElement as Element | null);
            if (target) {
              const normalized = normalizeTarget(target);
              const locators = buildLocators(normalized);
              emit({ type: "assert", locators, value: `text:${text.trim()}` });
            }
          }
        }
      },
      true
    );
  }, { debug });

  const page = await context.newPage();
  if (debug) {
    page.on("console", (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`);
    });
  }

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
