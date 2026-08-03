/**
 * Accessibility + responsive-layout e2e coverage for the admin SPA.
 *
 * Deliberately dependency-free: everything below is plain Playwright plus DOM
 * evaluation. `@axe-core/playwright` is NOT installed and adding a dependency
 * to this repo is a deliberate, signed-off act (see CLAUDE.md on the exact
 * pins) — so the checks here are hand-written against what
 * `admin-ui/DESIGN_SYSTEM.md` and the layout components actually intend,
 * rather than against a generic WCAG checklist.
 *
 * What the app's own design commits to, and is therefore asserted here:
 *   - `style.css` declares one global `:focus-visible { outline: 2px solid
 *     var(--signal) }` ring — so every interactive control must visibly change
 *     when focused, and "focus ring removed for aesthetics" is a regression.
 *   - `App.vue` renders a `#main-content` `<main>` landmark, a skip link that
 *     targets it, and a polite route-announcement region; `TheSidebar.vue`
 *     renders the single `<nav id="sidebar-nav">`.
 *   - `TheMobileTopbar.vue` collapses that sidebar behind a hamburger below
 *     768px (`aria-controls="sidebar-nav"` + `aria-expanded`), and
 *     `TheSidebar.vue` moves focus into the nav when it opens.
 *   - DESIGN_SYSTEM.md's "Large screens / TV mode" section forbids horizontal
 *     scrolling and puts every table inside `.table-scroll` so wide tables own
 *     their overflow instead of widening the page.
 *   - Dark mode is real (`:root[data-theme="dark"]` in `style.css`, driven by
 *     `localStorage["mcpbridge:theme"]` via `composables/useTheme.ts`), so both
 *     themes must render readable text.
 *
 * Every test here passes, but several were written against defects that were
 * real when written: two as `test.fail()` (a suppressed focus ring on the
 * search field, a skip link whose target did not exist before sign-in), and
 * three caught by the generic sweeps once the surfaces they live on were
 * covered (an unnamed load-balancing weight input, a suppressed ring in the
 * command palette, an `aria-label` shadowing the visible label on three filter
 * fields). All are fixed and kept as regression guards, each written as the
 * contract rather than as the shape of its fix, so a later refactor that
 * satisfies the contract differently still passes.
 *
 * A caution learned while writing this: a probe is only as good as the naming
 * rule it encodes. An earlier version of the combobox check accepted only
 * `aria-label`/`aria-labelledby` and reported three correctly-named filter
 * comboboxes as defects — a native `<label>` names them, and Chromium's own
 * computation confirms it. Verify a suspected a11y defect against the browser's
 * accessible name (`locator.ariaSnapshot()`) before treating it as real.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { APP_BASE_URL, BOOTSTRAP_ADMIN_PASSWORD, BOOTSTRAP_ADMIN_USERNAME, FIXTURE_BASE_URL } from "./support/env";
import { adminAuthHeaders, apiHeaders, login, registerViaApi } from "./support/admin";

/** Backend registered once for this spec so `/admin/servers/:name` has a real target. */
const A11Y_SERVER = "e2e-a11y-api";

const MOBILE = { width: 375, height: 812 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

/**
 * Sub-pixel slack for the horizontal-overflow checks. Layout maths at fractional
 * device ratios routinely lands a pixel off; anything beyond that is a real
 * layout bug, not rounding.
 */
const OVERFLOW_TOLERANCE_PX = 2;

// ── Route table ─────────────────────────────────────────────────────────────
// Adding a route to the coverage below is one entry here.

interface A11yRoute {
  /** Shown in test titles. */
  key: string;
  /** Path passed to `page.goto` (the SPA is served under /admin). */
  path: string;
  /** False only for the login page, which redirects away once a session exists. */
  authed: boolean;
  /**
   * Resolves once the route's OWN content has rendered, not just the app shell.
   * List pages go through `ListLayout.vue`, which shows a `SignalLoader` first
   * and only then the table or the empty state; `ServerDetailPage.vue` renders
   * its whole body (heading included) inside `v-else-if="detail"`.
   */
  ready(page: Page): Locator;
  /** Text of the page's single `<h1>`. */
  h1: string;
  /**
   * Optional in-page navigation to run after `ready`, for surfaces that are not
   * addressable by URL. `ServerDetailPage.vue` keeps its active tab in a local
   * `ref`, not the route, so the settings tab can only be reached by clicking
   * it — and half the server-detail controls live there.
   */
  prepare?(page: Page): Promise<void>;
}

const ROUTES: A11yRoute[] = [
  {
    key: "login",
    path: "/admin/login",
    authed: false,
    ready: (page) => page.locator("#password"),
    h1: "MCP REST Bridge",
  },
  {
    key: "servers list",
    path: "/admin/servers",
    authed: true,
    ready: (page) => page.locator(".table-card, .empty-state").first(),
    h1: "Servers",
  },
  {
    key: "server detail",
    path: `/admin/servers/${A11Y_SERVER}`,
    authed: true,
    // The tabpanel id is `${idBase}-panel` (TabStrip.vue's `tabPanelId`) with
    // idBase = "server-detail" (ServerDetailPage.vue).
    ready: (page) => page.locator("#server-detail-panel"),
    h1: A11Y_SERVER,
  },
  {
    key: "server detail (settings tab)",
    path: `/admin/servers/${A11Y_SERVER}`,
    authed: true,
    ready: (page) => page.locator("#server-detail-panel"),
    h1: A11Y_SERVER,
    // Upstream auth, load balancing and canary all live behind this tab, and
    // each renders a SelectMenu. The upstream-auth one is only mounted once its
    // editor is open, so the edit toggle is part of getting the surface on
    // screen rather than a separate thing being tested.
    prepare: async (page) => {
      await page.getByRole("tab", { name: "Settings" }).click();
      // The LB pool table is the last of the settings sections to need data, so
      // waiting for it means every section below has rendered too.
      await expect(page.locator(".lb-targets").first()).toBeVisible();
      // ServerDetailUpstreamAuth.vue keeps its form behind `v-if="uaEditing"`.
      // The toggle reads "Set credentials" or "Change" depending on whether a
      // credential already exists, so match either rather than a fixed label.
      await page
        .getByRole("button", { name: /Set credentials|Change/ })
        .first()
        .click();
      await expect(page.locator("form.ua-form").first()).toBeVisible();
    },
  },
  {
    key: "register server (form)",
    path: "/admin/servers/new",
    authed: true,
    ready: (page) => page.locator("#r-name"),
    h1: "Register a server",
  },
  {
    key: "audit log (data-heavy)",
    path: "/admin/audit-log",
    authed: true,
    ready: (page) => page.locator(".table-card, .empty-state").first(),
    h1: "Audit log",
  },
];

/** Log in when the route needs it, land on it, and wait for its own content. */
async function openRoute(page: Page, route: A11yRoute): Promise<void> {
  if (route.authed) await login(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
  await page.goto(route.path);
  await expect(route.ready(page)).toBeVisible();
  if (route.prepare) await route.prepare(page);
}

// ── DOM probes (all run inside the page; none may capture outer scope) ───────

/**
 * Every rendered `input`/`select`/`textarea` whose accessible name is empty,
 * described well enough to fix without opening a trace.
 *
 * Follows the accessible-name precedence that applies to form controls:
 * `aria-labelledby` > `aria-label` > `<label>` (via `for=` or as an ancestor,
 * which is exactly what `HTMLInputElement.labels` resolves) > `title`.
 * `placeholder` is deliberately NOT accepted — it disappears the moment the
 * field has a value and is not a substitute for a label. (The app agrees:
 * `SearchInput.vue` always emits an `aria-label`, falling back to the
 * placeholder text, precisely so its input is named without one.)
 */
async function unnamedFormControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const squash = (value: string | null): string => (value ?? "").replace(/\s+/g, " ").trim();

    const describe = (el: Element): string => {
      const bits = [el.tagName.toLowerCase()];
      if (el.id) bits.push(`#${el.id}`);
      const type = el.getAttribute("type");
      if (type) bits.push(`[type="${type}"]`);
      const name = el.getAttribute("name");
      if (name) bits.push(`[name="${name}"]`);
      const cls = squash(el.getAttribute("class"));
      if (cls) bits.push(`.${cls.split(" ").join(".")}`);
      return bits.join("");
    };

    const rendered = (el: Element): boolean => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return el.closest("[hidden]") === null && el.closest('[aria-hidden="true"]') === null;
    };

    const accessibleName = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string => {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .map((node) => (node ? squash(node.textContent) : ""))
          .filter((value) => value.length > 0)
          .join(" ");
        if (text) return text;
      }
      const ariaLabel = squash(el.getAttribute("aria-label"));
      if (ariaLabel) return ariaLabel;
      const fromLabels = Array.from(el.labels ?? [])
        .map((label) => squash(label.textContent))
        .filter((value) => value.length > 0)
        .join(" ");
      if (fromLabels) return fromLabels;
      return squash(el.getAttribute("title"));
    };

    const controls = document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input:not([type='hidden']), select, textarea",
    );
    return Array.from(controls)
      .filter((el) => rendered(el))
      .filter((el) => accessibleName(el).length === 0)
      .map((el) => describe(el));
  });
}

/**
 * Heading levels in DOM order. Screen-reader-only headings are kept on purpose
 * (`.sr-only` is clipped, not hidden — it is still in the accessibility tree);
 * `display:none` / `visibility:hidden` / `aria-hidden` subtrees are dropped,
 * which is what excludes the mobile sidebar when it is closed.
 */
async function headingOutline(page: Page): Promise<{ level: number; text: string }[]> {
  return page.evaluate(() => {
    const rendered = (el: Element): boolean => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return el.closest("[hidden]") === null && el.closest('[aria-hidden="true"]') === null;
    };
    return Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .filter((el) => rendered(el))
      .map((el) => ({
        level: Number(el.tagName.slice(1)),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      }));
  });
}

/** `<img>` elements with no `alt` attribute at all (`alt=""` for decoration is fine). */
async function imagesWithoutAlt(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("img:not([alt])")).map((el) => `img[src="${el.getAttribute("src") ?? ""}"]`),
  );
}

/**
 * Buttons that render no perceivable text and carry no author-supplied name.
 *
 * Text inside an `aria-hidden="true"` subtree does not count — that is exactly
 * how `TheMobileTopbar.vue`'s hamburger works (`<span aria-hidden="true">☰</span>`
 * plus an `aria-label`), and counting the glyph would make the check blind to a
 * regression that dropped the label.
 *
 * `CopyButton.vue` is the case worth being careful about: it is a SINGLE-ROOT
 * `<button>` BY CONTRACT (callers rely on class/attr fallthrough landing on the
 * button itself, e.g. `HoverPreview.vue` positions it absolutely), and its
 * status text is a `<Teleport to="body">`-ed `.sr-only` span that lives OUTSIDE
 * the button. So its button element genuinely has no text content, and its
 * `aria-label` is the only naming source — which this check reads correctly.
 * Do not "fix" a failure here by wrapping CopyButton in an sr-only span.
 */
async function unnamedIconButtons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const squash = (value: string | null): string => (value ?? "").replace(/\s+/g, " ").trim();

    const rendered = (el: Element): boolean => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return el.closest("[hidden]") === null && el.closest('[aria-hidden="true"]') === null;
    };

    /** textContent minus anything hidden from assistive tech. */
    const perceivableText = (el: Element): string => {
      const clone = el.cloneNode(true) as Element;
      clone.querySelectorAll('[aria-hidden="true"], svg').forEach((node) => node.remove());
      return squash(clone.textContent);
    };

    const authorName = (el: Element): string => {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .map((node) => (node ? squash(node.textContent) : ""))
          .filter((value) => value.length > 0)
          .join(" ");
        if (text) return text;
      }
      return squash(el.getAttribute("aria-label")) || squash(el.getAttribute("title"));
    };

    return Array.from(document.querySelectorAll("button"))
      .filter((el) => rendered(el))
      .filter((el) => perceivableText(el).length === 0 && authorName(el).length === 0)
      .map((el) => {
        const cls = squash(el.getAttribute("class"));
        return `button${el.id ? `#${el.id}` : ""}${cls ? `.${cls.split(" ").join(".")}` : ""}`;
      });
  });
}

/**
 * Horizontal-overflow report: `"ok"`, or a human-readable description naming the
 * widest offending element.
 *
 * Checks the document scroller AND `#main-content`. Both matter: at desktop
 * widths `App.vue`'s `.content` sets `overflow-y: auto`, which computes
 * `overflow-x` to `auto` as well, so a too-wide child scrolls *inside* the shell
 * and never moves the document scrollbar. Below 768px `.content` reverts to
 * `overflow-y: visible` and the document is the scroller instead.
 *
 * Content inside a nested scroller is exempt from the *diagnostic* (not from the
 * assertion, which cannot see it anyway): `TableCard.vue` wraps every table in
 * `.table-scroll { overflow-x: auto }` by design, so wide tables are supposed to
 * scroll themselves rather than widen the page.
 */
async function horizontalOverflowReport(page: Page, tolerance: number): Promise<string> {
  return page.evaluate((slack) => {
    const squash = (value: string | null): string => (value ?? "").replace(/\s+/g, " ").trim();

    const describe = (el: Element): string => {
      const cls = squash(el.getAttribute("class"));
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls.split(" ").join(".")}` : ""}`;
    };

    /** True when some ancestor below `scroller` clips/scrolls this node horizontally. */
    const ownedByInnerScroller = (node: Element, scroller: Element): boolean => {
      let parent = node.parentElement;
      while (parent && parent !== scroller) {
        if (getComputedStyle(parent).overflowX !== "visible") return true;
        parent = parent.parentElement;
      }
      return false;
    };

    const scrollers: { label: string; el: Element }[] = [{ label: "document", el: document.documentElement }];
    const main = document.getElementById("main-content");
    if (main) scrollers.push({ label: "#main-content", el: main });

    const problems: string[] = [];
    for (const { label, el } of scrollers) {
      const overBy = el.scrollWidth - el.clientWidth;
      if (overBy <= slack) continue;

      const edge = el.getBoundingClientRect().right;
      let worst = "";
      let worstBy = 0;
      for (const node of Array.from(el.querySelectorAll("*"))) {
        if (ownedByInnerScroller(node, el)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const past = Math.round(rect.right - edge);
        if (past > worstBy) {
          worstBy = past;
          worst = describe(node);
        }
      }
      problems.push(
        `${label} scrolls horizontally by ${overBy}px` +
          (worst ? ` — widest offender ${worst} sticks out ${worstBy}px` : ""),
      );
    }
    return problems.length === 0 ? "ok" : problems.join("; ");
  }, tolerance);
}

/** The computed properties a focus indicator could plausibly be drawn with. */
interface FocusStyle {
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
  borderColor: string;
  backgroundColor: string;
}

async function focusStyleOf(page: Page, selector: string): Promise<FocusStyle> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`focusStyleOf: no element matches ${sel}`);
    const style = getComputedStyle(el);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
      borderColor: style.borderColor,
      backgroundColor: style.backgroundColor,
    };
  }, selector);
}

/** True when the computed style draws a real, non-zero outline. */
function hasOutlineRing(style: FocusStyle): boolean {
  return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1;
}

/**
 * Every rendered form control whose `aria-label` SHADOWS its visible `<label>`.
 *
 * `aria-label` replaces a visible label rather than adding to it, so a field
 * showing "Actor" while announcing "Filter by actor…" presents two different
 * names for one control — the case WCAG 2.5.3 (Label in Name) is about, and a
 * real problem for speech input, where the user says what they can see.
 *
 * Deliberately STRICTER than 2.5.3 itself, which only requires the visible text
 * to be *contained* in the name. Containment is too weak to be a useful guard
 * here: "Actor" is a substring of "Filter by actor…", so the shadowing this
 * spec was written to catch would have passed a containment check. The codebase
 * has a stronger rule anyway — SearchInput.vue omits its `aria-label` entirely
 * when the caller supplies a visible label — so equality is the contract worth
 * pinning. A control that genuinely needs a longer name should carry no visible
 * `<label>` (the LB weight input is named per row exactly that way).
 */
async function labelShadowingViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const normalize = (value: string | null): string =>
      (value ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();

    const offenders: string[] = [];
    const controls = document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input:not([type='hidden']), select, textarea",
    );
    for (const el of controls) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const ariaLabel = normalize(el.getAttribute("aria-label"));
      if (!ariaLabel) continue;
      const visible = normalize(
        Array.from(el.labels ?? [])
          .map((label) => label.textContent ?? "")
          .join(" "),
      );
      if (!visible || visible === ariaLabel) continue;
      offenders.push(
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}: shows "${visible}", announces "${ariaLabel}"`,
      );
    }
    return offenders;
  });
}

/**
 * Every rendered `role="combobox"` with no accessible name.
 *
 * Separate from `unnamedFormControls` because a combobox is not an `<input>`
 * and so is not in that query — `SelectMenu.vue` renders a
 * `<button role="combobox">`. It also can't be checked the way icon-only
 * buttons are: `combobox` prohibits name-from-content, so the trigger's text
 * (the selected option) is NOT its name, and a combobox showing "round-robin"
 * reads as named to any content-based check while announcing only its value.
 *
 * A native `<label>` DOES count, whether associated by `for=` or by wrapping.
 * That is accname step 2C (host-language labelling), which is evaluated before
 * name-from-content and is therefore unaffected by the content prohibition —
 * verified against Chromium's own computation, which reports `combobox "State"`
 * for a `<label for>` pair and `combobox "Strategy"` for a wrapping label. An
 * earlier version of this probe accepted only `aria-*` and reported three
 * correctly-named filter comboboxes as defects.
 */
async function unnamedComboboxes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const squash = (value: string | null): string => (value ?? "").replace(/\s+/g, " ").trim();

    const rendered = (el: Element): boolean => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return el.closest("[hidden]") === null && el.closest('[aria-hidden="true"]') === null;
    };

    const authorName = (el: Element): string => {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .map((node) => (node ? squash(node.textContent) : ""))
          .filter((value) => value.length > 0)
          .join(" ");
        if (text) return text;
      }
      const ariaLabel = squash(el.getAttribute("aria-label"));
      if (ariaLabel) return ariaLabel;
      // `<button>` is a labelable element, so `.labels` resolves both `for=`
      // and ancestor `<label>` associations — the same set the browser uses.
      const labels = (el as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
      return Array.from(labels ?? [])
        .map((label) => squash(label.textContent))
        .filter((value) => value.length > 0)
        .join(" ");
    };

    const offenders: string[] = [];
    for (const el of document.querySelectorAll('[role="combobox"]')) {
      if (!rendered(el) || authorName(el)) continue;
      const cls = squash(el.getAttribute("class"));
      const owner = el.closest("section, form, fieldset");
      const ownerHint = owner ? squash(owner.className) || owner.tagName.toLowerCase() : "?";
      offenders.push(
        `${el.tagName.toLowerCase()}[role=combobox]${cls ? `.${cls.split(" ").join(".")}` : ""} in ${ownerHint}`,
      );
    }
    return offenders;
  });
}

// ── Shared fixture ──────────────────────────────────────────────────────────

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await login(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
    const auth = await adminAuthHeaders(page);
    // Tolerates the 409 a re-run against a reused dev server produces.
    await registerViaApi(page.context().request, auth, A11Y_SERVER);

    // Stand up a load-balancing pool so the targets table renders. BOTH calls
    // are needed, in this order: the table sits behind `v-if="lb"`, and `lb` is
    // only non-null once the pool CONFIG exists — adding an upstream alone
    // leaves it null and the table unmounted. Its per-row weight input is one
    // of the controls the settings-tab sweep exists to check, so without this
    // the sweep would pass by simply never seeing it.
    const lbConfig = await page.context().request.put(`${APP_BASE_URL}/admin-api/clients/${A11Y_SERVER}/lb`, {
      headers: apiHeaders(auth),
      data: { strategy: "weighted", primaryWeight: 1, enabled: true },
    });
    expect(lbConfig.status(), `lb config failed: ${await lbConfig.text()}`).toBe(200);

    const lbTarget = await page
      .context()
      .request.post(`${APP_BASE_URL}/admin-api/clients/${A11Y_SERVER}/lb/upstreams`, {
        headers: apiHeaders(auth),
        data: { baseUrl: FIXTURE_BASE_URL, weight: 3 },
      });
    // 201 the first time; a re-run against a reused server may reject a
    // duplicate, which is fine — the target from the earlier run is still there.
    expect([201, 400, 409], `unexpected lb upstream status: ${lbTarget.status()} ${await lbTarget.text()}`).toContain(
      lbTarget.status(),
    );
  } finally {
    await context.close();
  }
});

// ── Structural a11y, driven over the route table ─────────────────────────────

for (const route of ROUTES) {
  test(`a11y — ${route.key}: labelled controls, one h1, named icon buttons`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openRoute(page, route);

    // (1) Every form control is named. This is what makes a field usable with a
    // screen reader at all, and it is the check most likely to catch a new page
    // that hand-rolls an input instead of going through FormField/SearchInput.
    const unnamed = await unnamedFormControls(page);
    expect(unnamed, `unnamed form control(s) on ${route.path}: ${unnamed.join(", ")}`).toEqual([]);

    // (2) Exactly one h1, and no skipped level. Cheap, and catches a real
    // structural regression (e.g. a section heading demoted straight to h3).
    const outline = await headingOutline(page);
    const rendered = outline.map((h) => `h${h.level}:"${h.text}"`).join(" → ");
    const h1s = outline.filter((h) => h.level === 1);
    expect(h1s.length, `${route.path} must render exactly one <h1>, got: ${rendered}`).toBe(1);
    expect(h1s[0].text, `${route.path} <h1> text`).toBe(route.h1);
    expect(outline[0].level, `${route.path} must open with its <h1>, got: ${rendered}`).toBe(1);
    for (let i = 1; i < outline.length; i++) {
      expect(
        outline[i].level,
        `${route.path} skips a heading level at "${outline[i].text}" — full outline: ${rendered}`,
      ).toBeLessThanOrEqual(outline[i - 1].level + 1);
    }

    // (3) Images carry alt text, icon-only buttons carry an accessible name.
    const altless = await imagesWithoutAlt(page);
    expect(altless, `<img> without an alt attribute on ${route.path}: ${altless.join(", ")}`).toEqual([]);
    const nameless = await unnamedIconButtons(page);
    expect(nameless, `icon-only button(s) with no accessible name on ${route.path}: ${nameless.join(", ")}`).toEqual(
      [],
    );

    // (4) Comboboxes are named. Checked apart from (1) because a combobox is
    // not an <input>, and apart from (3) because the role takes no name from
    // its content — a SelectMenu showing its selected option reads as named to
    // every content-based check while announcing only that value.
    const unnamedCombos = await unnamedComboboxes(page);
    expect(unnamedCombos, `combobox(es) with no accessible name on ${route.path}: ${unnamedCombos.join(", ")}`).toEqual(
      [],
    );

    // (5) No control announces something other than the label it displays.
    const shadowed = await labelShadowingViolations(page);
    expect(shadowed, `aria-label shadows the visible label on ${route.path}: ${shadowed.join(", ")}`).toEqual([]);
  });

  test(`responsive — ${route.key}: no horizontal scrolling at mobile or desktop`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openRoute(page, route);

    for (const viewport of [MOBILE, DESKTOP]) {
      await page.setViewportSize(viewport);
      await expect(route.ready(page)).toBeVisible();
      // Polled: a viewport change re-runs layout asynchronously, and charts /
      // tables settle a frame or two later.
      await expect
        .poll(() => horizontalOverflowReport(page, OVERFLOW_TOLERANCE_PX), {
          message: `${route.path} at ${viewport.width}×${viewport.height}`,
        })
        .toBe("ok");
    }
  });
}

// ── Keyboard operability ────────────────────────────────────────────────────

test.describe("keyboard", () => {
  test("login is completable with the keyboard alone", async ({ page }) => {
    await page.goto("/admin/login");
    await expect(page.locator("#username")).toBeVisible();

    // Tab order through the form: username → password → submit. Nothing else is
    // focusable in between (the labels aren't, and the SSO link only renders
    // when OIDC is configured, which the e2e stack does not do).
    await page.locator("#username").focus();
    await expect(page.locator("#username")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#password")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeFocused();

    // …and the whole sign-in actually completes without a single click.
    await page.locator("#username").focus();
    await page.keyboard.type(BOOTSTRAP_ADMIN_USERNAME);
    await page.keyboard.press("Tab");
    await page.keyboard.type(BOOTSTRAP_ADMIN_PASSWORD);
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { name: "Servers", level: 1 })).toBeVisible();
  });

  test("focused controls get the global :focus-visible ring", async ({ page }) => {
    await page.goto("/admin/login");
    await expect(page.locator("#username")).toBeVisible();

    const restingInput = await focusStyleOf(page, "#password");
    const restingButton = await focusStyleOf(page, "form button[type='submit']");
    expect(hasOutlineRing(restingInput), "#password must not draw a ring while unfocused").toBe(false);
    expect(hasOutlineRing(restingButton), "submit must not draw a ring while unfocused").toBe(false);

    // Reach both by keyboard rather than `.focus()`: `:focus-visible` is
    // modality-dependent in Chromium, and a real Tab is what a keyboard user does.
    await page.locator("#username").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#password")).toBeFocused();
    const focusedInput = await focusStyleOf(page, "#password");

    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeFocused();
    const focusedButton = await focusStyleOf(page, "form button[type='submit']");

    // style.css: `:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px }`.
    // "Removed the focus ring because it looked noisy" is the regression this guards.
    expect(hasOutlineRing(focusedInput), `#password drew no focus ring: ${JSON.stringify(focusedInput)}`).toBe(true);
    expect(hasOutlineRing(focusedButton), `submit drew no focus ring: ${JSON.stringify(focusedButton)}`).toBe(true);
    expect(focusedInput, "#password must look different when focused").not.toEqual(restingInput);
    expect(focusedButton, "submit must look different when focused").not.toEqual(restingButton);
  });

  // Regression guard for a real defect (fixed): SearchInput.vue sets
  // `outline: none` on its `<input>`, and as a scoped rule
  // (`.search-input input[data-v-…]`) that outranks the global
  // `:focus-visible` ring in style.css. Nothing put the ring back, so tabbing
  // into the search/filter field on Servers, Audit log, Traces, Keys, Bundles
  // and Composites produced no visual change at all — WCAG 2.4.7 (Focus
  // Visible). The ring now lives on the `.search-input` wrapper, which is the
  // element that actually reads as the control.
  //
  // Asserted on the wrapper OR the input on purpose: which element carries the
  // ring is a styling decision this test should not freeze.
  test("the search field shows a focus indicator", async ({ page }) => {
    await login(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
    await page.goto("/admin/servers");
    await expect(page.locator("#d-search")).toBeVisible();

    // Sample the input AND its wrapper — a ring drawn on either would be fine,
    // so failing both is what makes this a genuine "no indicator at all".
    const restingInput = await focusStyleOf(page, "#d-search");
    const restingWrapper = await focusStyleOf(page, ".search-input:has(#d-search)");

    await page.locator("#d-search").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(page.locator("#d-search")).toBeFocused();

    const focusedInput = await focusStyleOf(page, "#d-search");
    const focusedWrapper = await focusStyleOf(page, ".search-input:has(#d-search)");

    const changed =
      JSON.stringify(focusedInput) !== JSON.stringify(restingInput) ||
      JSON.stringify(focusedWrapper) !== JSON.stringify(restingWrapper);
    expect(
      changed,
      `focusing #d-search changed nothing — input ${JSON.stringify(focusedInput)}, ` +
        `wrapper ${JSON.stringify(focusedWrapper)}`,
    ).toBe(true);
    expect(
      hasOutlineRing(focusedInput) || hasOutlineRing(focusedWrapper),
      "neither #d-search nor its .search-input wrapper draws a focus ring",
    ).toBe(true);
  });

  // Regression guard for the same defect in the command palette, which had the
  // identical `outline: none`. The reason it matters there is specific: the
  // result rows are real <button>s with `role="option"`, so they sit in the tab
  // order and Tab genuinely moves focus off the input and back. Without a ring
  // that return is invisible — which is why "the input is focused the whole
  // time anyway" is not a defence.
  test("the command palette's input shows a focus indicator", async ({ page }) => {
    await login(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
    await page.goto("/admin/servers");

    await page.getByRole("button", { name: "Open command palette" }).click();
    const panel = page.locator(".cmd-panel");
    await expect(panel).toBeVisible();

    // show() focuses the input itself, so it is already the active element.
    const input = panel.locator("input[role='combobox']");
    await expect(input).toBeFocused();
    expect(
      hasOutlineRing(await focusStyleOf(page, ".cmd-panel input[role='combobox']")),
      "the focused command-palette input draws no focus ring",
    ).toBe(true);

    // The premise of the test above: focus really can leave the input.
    await page.keyboard.press("Tab");
    await expect(input).not.toBeFocused();

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  });
});

// ── Landmarks & bypass block ────────────────────────────────────────────────

test.describe("landmarks", () => {
  test("the shell exposes one nav and one main, and the skip link reaches main", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await login(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);

    // App.vue renders `<main id="main-content">`; TheSidebar.vue renders the
    // single `<nav id="sidebar-nav">`.
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.locator("main#main-content")).toBeVisible();
    await expect(page.locator("nav#sidebar-nav")).toBeVisible();

    // Exactly one navigation landmark, which is why `TheSidebar.vue`'s `<nav>`
    // getting no `aria-label` is acceptable today. If a second nav is ever added
    // (a breadcrumb bar, a tab rail), this assertion fires — and BOTH landmarks
    // then need distinguishing accessible names, per ARIA APG.
    await expect(page.getByRole("navigation")).toHaveCount(1);

    // The bypass block: first tab stop, points at the main landmark, and moves
    // on-screen when focused (App.vue parks it at left:-9999px until :focus).
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toHaveAttribute("href", "#main-content");
    const parked = await skip.evaluate((el) => el.getBoundingClientRect().left);
    expect(parked, "the skip link should sit off-screen until focused").toBeLessThan(0);

    // Focus does not start at the top of the document: `router.afterEach`
    // parks it on `#main-content` after every real page change (WCAG 2.4.3), and
    // that node sits *after* the sidebar. Reset to the top so the next Tab
    // answers the question actually being asked — "what is the document's first
    // tab stop?".
    //
    // blur() alone is NOT enough: it clears document.activeElement, but leaves
    // Chromium's *sequential focus navigation starting point* on the blurred
    // node, so the next Tab resumes after <main> and never reaches the skip
    // link. Focusing <body> moves that starting point to the document start.
    // The temporary tabindex is what makes <body> focusable at all; it's
    // removed immediately, and -1 never puts it in the tab order regardless.
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      document.body.setAttribute("tabindex", "-1");
      document.body.focus();
      document.body.removeAttribute("tabindex");
    });
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    const revealed = await skip.evaluate((el) => el.getBoundingClientRect().left);
    expect(revealed, "the skip link must become visible once focused").toBeGreaterThanOrEqual(0);
  });

  // Regression guard for a real defect (fixed): App.vue renders the skip link
  // OUTSIDE `v-if="showShell"` but mounted `<main id="main-content">` INSIDE
  // it, so before sign-in the page's first tab stop was a "Skip to content"
  // link pointing at an element that did not exist, and the login page had no
  // landmark region at all. LoginPage.vue now owns the `<main>` itself.
  //
  // The assertion is deliberately "wherever the link renders, its target
  // exists" rather than naming the fix: moving the link inside the shell would
  // satisfy the contract too, and this test should not dictate which.
  test("the skip link's target exists wherever the link renders", async ({ page }) => {
    await page.goto("/admin/login");
    await expect(page.locator("#password")).toBeVisible();

    const skip = page.getByRole("link", { name: "Skip to content" });
    const target = page.locator("#main-content");
    expect(
      (await skip.count()) === 0 || (await target.count()) === 1,
      "the skip link renders on /admin/login but #main-content does not exist there",
    ).toBe(true);
    // The login form must sit inside a landmark either way.
    await expect(page.getByRole("main")).toHaveCount(1);
  });
});

// ── Responsive navigation ───────────────────────────────────────────────────

test("responsive — primary navigation stays reachable at mobile width", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);

  const sidebar = page.locator("#sidebar-nav");
  const hamburger = page.getByRole("button", { name: "Toggle navigation menu" });

  // Desktop: the sidebar is a permanent column and there is no hamburger
  // (TheMobileTopbar.vue's `.mobile-topbar` is `display: none` above 768px).
  await expect(sidebar).toBeVisible();
  await expect(hamburger).toBeHidden();

  // Mobile: the sidebar collapses behind the hamburger (TheSidebar.vue's
  // max-width:768px block parks it at translateX(-100%) + visibility:hidden).
  await page.setViewportSize(MOBILE);
  await expect(hamburger).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(hamburger).toHaveAttribute("aria-expanded", "false");
  await expect(hamburger).toHaveAttribute("aria-controls", "sidebar-nav");

  await hamburger.click();
  await expect(hamburger).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar).toBeVisible();

  // TheSidebar.vue moves focus into the panel on open (its `navOpen` watcher
  // calls `focusFirst`), so a keyboard user lands inside the nav, not behind it.
  await expect
    .poll(
      () => page.evaluate(() => document.getElementById("sidebar-nav")?.contains(document.activeElement) ?? false),
      {
        message: "opening the mobile nav must move focus into it",
      },
    )
    .toBe(true);

  // The nav is genuinely usable, not merely painted. Follow a link to a route
  // we are NOT already on: App.vue closes the overlay from a `route.fullPath`
  // watcher, and re-clicking the current route is an aborted navigation that
  // never changes fullPath — so it would (correctly) leave the panel open.
  // `login()` lands on /admin/servers, so Servers itself is disqualified;
  // Catalog is the neighbouring entry in the same nav group.
  const catalogLink = sidebar.getByRole("link", { name: "Catalog", exact: true });
  await expect(catalogLink).toBeVisible();
  await catalogLink.click();
  await expect(page).toHaveURL(/\/admin\/catalog$/);
  await expect(sidebar).toBeHidden();
});

// ── Colour scheme ───────────────────────────────────────────────────────────

/**
 * Text colour vs. the nearest opaque background behind it, plus the WCAG
 * contrast ratio between them.
 */
async function textContrast(
  page: Page,
  selector: string,
): Promise<{ color: string; background: string; ratio: number }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`textContrast: no element matches ${sel}`);

    const parse = (value: string): { r: number; g: number; b: number; a: number } | null => {
      const parts = value.match(/-?[\d.]+/g);
      if (!parts || parts.length < 3) return null;
      const [r, g, b] = parts.map(Number);
      return { r, g, b, a: parts.length > 3 ? Number(parts[3]) : 1 };
    };

    const luminance = (c: { r: number; g: number; b: number }): number => {
      const channel = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    };

    const fgRaw = getComputedStyle(el).color;
    const fg = parse(fgRaw);
    if (!fg) throw new Error(`textContrast: unparseable color ${fgRaw} on ${sel}`);

    // Walk up until something actually paints — `body` carries `var(--paper)`.
    let node: Element | null = el;
    let bg: { r: number; g: number; b: number; a: number } | null = null;
    let bgRaw = "";
    while (node) {
      bgRaw = getComputedStyle(node).backgroundColor;
      const parsed = parse(bgRaw);
      if (parsed && parsed.a > 0) {
        bg = parsed;
        break;
      }
      node = node.parentElement;
    }
    if (!bg) throw new Error(`textContrast: no opaque background behind ${sel}`);

    const hi = Math.max(luminance(fg), luminance(bg));
    const lo = Math.min(luminance(fg), luminance(bg));
    return { color: fgRaw, background: bgRaw, ratio: (hi + 0.05) / (lo + 0.05) };
  }, selector);
}

test("colour scheme — light and dark both render readable text", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD);
  await page.goto("/admin/servers");
  await expect(page.getByRole("heading", { name: "Servers", level: 1 })).toBeVisible();

  // Two samples that exercise both documented text tokens on the page
  // background: the h1 (`--text-primary`) and PageHeader's subtitle
  // (`--text-secondary`). DESIGN_SYSTEM.md's dark-theme block calls out having
  // tuned exactly these for contrast, so 4.5:1 is the app's own bar, not one
  // imposed from outside.
  const samples = ["h1", ".page-header .subtitle"];

  for (const theme of ["light", "dark"] as const) {
    // useTheme.ts reads localStorage["mcpbridge:theme"] at module load and
    // stamps `data-theme` on <html>, so the preference needs a reload to apply.
    await page.evaluate((value) => window.localStorage.setItem("mcpbridge:theme", value), theme);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Servers", level: 1 })).toBeVisible();

    const applied = await page.evaluate(() => ({
      dataTheme: document.documentElement.dataset.theme ?? "light",
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    }));
    expect(applied.dataTheme, `data-theme for ${theme}`).toBe(theme);
    // style.css sets `color-scheme` per theme so form controls / scrollbars
    // follow too — a missing flip leaves white native widgets on a dark page.
    expect(applied.colorScheme, `color-scheme for ${theme}`).toBe(theme);

    for (const selector of samples) {
      const { color, background, ratio } = await textContrast(page, selector);
      expect(color, `${selector} must not be painted in its own background (${theme})`).not.toBe(background);
      expect(
        ratio,
        `${selector} in ${theme} theme: ${color} on ${background} is only ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});
