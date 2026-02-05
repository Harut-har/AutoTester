# AutoTester

UI macro recorder/runner для автотестов: record → store in DB → replay → report.

**MVP рамки**
- Стек: Node.js + Playwright.
- Формат: только CLI, без Web UI.
- Хранилище: SQLite (один файл), доступ через слой DAO/Repository для будущего перехода на PostgreSQL без ломки формата.
- Запись действий: только базовые шаги.
- Не входит в MVP: hover/drag, smart suggestions, продвинутые редакторы шагов.

**Поддерживаемые шаги (MVP)**
- `click`
- `type`
- `select`
- `check` / `uncheck`
- `navigation` (URL change)
- `waitFor` (element visible/enabled, URL; network idle — опционально, по умолчанию выключено из-за флейков на SPA)
- `assert` (visible / text contains / url contains)

## Быстрый старт (CLI)

Примеры команд:
- `record` — открыть браузер, записать действия, сохранить макрос.
- `run` — воспроизвести макрос и сформировать отчёт.
- `list` — список сохранённых макросов.
- `show-report` — показать отчёт по прогону.

Пример:

```bash
npm install
npm run pw:install

# запись
npm run cli -- record -- --url "http://127.0.0.1:3011/learning_ai/" --name "Login flow"

# запуск
npm run cli -- run --macro-id 1 --env dev --stop-on-fail true

# запуск (headed + увеличенный таймаут навигации)
npm run cli -- run --macro-id 1 --env dev --headless false --timeout-ms 30000

# список
npm run list

# показать шаги макроса
npm run macro:show -- --macro-id 1

# отключить шаг
npm run macro:disable-step -- --macro-id 1 --order 3

# переименовать макрос
npx tsx src/cli.ts macro:rename --macro-id 1 --name "Updated login flow"

# отчёт
npm run show-report -- --run-id 42 --format html
```

Пример CI запуска:

```bash
npm run run -- --macro-id 1 --env dev
echo $?
```

При `--stop-on-fail true` (по умолчанию) оставшиеся шаги помечаются `SKIPPED`.
Если шаг был `enabled=1`, в `error_message` будет `not executed (stop-on-fail)`.

## Что сохраняется в БД

Сущности (SQLite, один файл):
- `macros`: метаданные записи (id, name, description, base_url, created_at, created_by).
- `macro_steps`: шаги (order_index, action_type, locators, value, timeouts, enabled).
- `runs`: прогон (env_name, browser, headless, started_at, finished_at, status, summary).
- `run_step_results`: результат по каждому шагу (status, timing, error, used_locator).
- `artifacts`: ссылки на артефакты (screenshot/video/trace/log).

Доступ к БД должен идти через DAO/Repository слой, чтобы заменить SQLite на PostgreSQL без изменения формата данных.

## Политика локаторов

При записи шага сохраняется набор локаторов по приоритету:
- `data-testid` / `data-qa`
- role + name (Playwright-стиль)
- стабильный CSS селектор
- XPath (крайний случай)

При прогоне локаторы пробуются по порядку.

## Отчётность и артефакты

После каждого прогона сохраняются:
- статус по шагам (PASS/FAIL/ERROR/SKIPPED)
- ошибки и фактически использованный локатор
- артефакты: скрин на фейле, trace (на fail)

Форматы отчёта:
- HTML (для людей)
- JSON (для системы)
- JUnit XML (для CI)

Где искать trace:
- на fail файл `reports/run-<runId>.zip`

JUnit XML:
- файл `reports/run-<runId>.xml`

Пример JUnit (фрагмент):

```xml
<testsuite name="macro-1" tests="3" failures="1" skipped="1">
  <testcase name="step-1-click"/>
  <testcase name="step-2-assert"><failure message="Text does not contain Welcome"/></testcase>
  <testcase name="step-3-waitFor"><skipped/></testcase>
</testsuite>
```

## Горячие клавиши записи

- `Ctrl+Shift+S` — остановить запись и сохранить макрос
- `Ctrl+Shift+W` — добавить `waitFor` для последнего нормализованного элемента клика
- `Ctrl+Shift+V` — добавить `assert visible` для последнего нормализованного элемента клика
- `Ctrl+Shift+U` — добавить `assert url contains` (значение `url:<pathname>`)
- `Ctrl+Shift+T` — добавить `assert text contains` (запрос через `prompt()`)

## Конфиги окружений

Окружения задаются через конфиг (например `dev`/`stage`) и включают:
- `baseURL`
- `browser` (chromium/firefox/webkit)
- `headless`
- `timeouts` (step/global, ожидания)

Один и тот же макрос должен запускаться на разных окружениях без изменения шагов.

Пример `envs.json`:

```json
{
  "dev": {
    "baseURL": "https://dev.example.com",
    "browser": "chromium",
    "headless": true,
    "timeouts": { "step": 5000, "global": 15000 }
  },
  "stage": {
    "baseURL": "https://stage.example.com",
    "browser": "firefox",
    "headless": false
  }
}
```

## Diff/Git

Если `git diff` недоступен в текущем окружении/директории, используйте альтернативы (например, сравнение файлов вручную или через IDE).

