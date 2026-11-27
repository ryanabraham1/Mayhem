// Drive the real Mayhem app from the command line, the way a person would, and see what it shows.
// Agents use it to check their own UI changes before a person does: start it once, then send
// commands; each one prints what happened and any error the app logged.
//
//   node scripts/app.mjs start [--repo <robot repo>] [--project <file>] [--robot-logs <dir>]
//   node scripts/app.mjs go "State machines"           open a page (the top navigation)
//   node scripts/app.mjs click "Open project file"     a button, tab, link, option… by its name
//   node scripts/app.mjs fill "Team number" 3256       a field by its label
//   node scripts/app.mjs select "Season" "REEFSCAPE 2025"
//   node scripts/app.mjs press Escape
//   node scripts/app.mjs see ["<text>"]                what's on screen (accessibility tree)
//   node scripts/app.mjs screenshot [file.png]         a picture of the window (read the PNG)
//   node scripts/app.mjs wait "<text>" [--gone]        until a text appears (or goes away)
//   node scripts/app.mjs pick <path>                   the file the next open/save dialog returns
//   node scripts/app.mjs answer "<button>"             the button the next confirm dialog clicks
//   node scripts/app.mjs robot stamp|logs <value>      fake robot: build stamp JSON, or a folder of .wpilog files
//   node scripts/app.mjs calls                         what the app asked the computer to do (deploys, opens, merges…)
//   node scripts/app.mjs reload | stop
//
// It runs the app's Vite dev server (so code edits show up without a restart) in a headless
// Chromium with the desktop backend faked by scripts/desktop-bridge.mjs: files and git are real,
// the robot, the team website and GitHub are fakes, so nothing reaches a real robot or PR.
// Without --repo it makes a throwaway robot repo with the example project.
import "./suite-imports.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "app");
const HOME = join(homedir(), ".mayhem", "app-driver");
const STATE = join(HOME, "state.json");
const PAGES = ["Overview", "Changes", "Autonomous", "State machines", "Simulation", "Logs", "Robot", "Settings"];

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A throwaway robot repo with the example project, committed on main. */
function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "mayhem-app-"));
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  copyFileSync(join(ROOT, "examples/suite/competition.mayhem.json"), join(repo, "robot.mayhem.json"));
  git("add", "-A");
  git("-c", "user.name=Mayhem", "-c", "user.email=mayhem@localhost", "commit", "-q", "-m", "Robot project");
  return repo;
}

// ---- The driver process: dev server, browser, and a small command server. ----

async function daemon(options) {
  const require = createRequire(join(APP, "package.json"));
  const { chromium } = require("@playwright/test");
  const { bridgeState, createBridge, installBridge } = await import("./desktop-bridge.mjs");
  const port = options.port;
  const vite = spawn(join(APP, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: APP, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const repo = options.repo ? resolve(options.repo) : fixtureRepo();
  const state = bridgeState(repo, join(HOME, "data"));
  if (options.robotLogs) state.robot.logs = resolve(options.robotLogs);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource|\[vite\]/.test(m.text()) && errors.push(`console error: ${m.text()}`));
  page.on("dialog", (d) => d.accept());
  await installBridge(page, createBridge(state));
  await page.goto(url);
  // Open the project the way a person does: Settings → Open project file.
  const project = options.project ? resolve(options.project) : join(repo, "robot.mayhem.json");
  if (existsSync(project)) {
    state.picks.push(project);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open project file" }).click();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
  }
  let shots = 0;

  /** The first visible element with that accessible name (any clickable role), else that text. */
  async function find(name, { exact = false, nth = 0 } = {}) {
    const roles = ["button", "tab", "link", "menuitem", "option", "checkbox", "radio", "switch", "treeitem", "row"];
    for (const role of roles) {
      const all = page.getByRole(role, { name, exact });
      const visible = [];
      for (const l of await all.all()) if (await l.isVisible()) visible.push(l);
      if (visible.length) return { locator: visible[Math.min(nth, visible.length - 1)], role, count: visible.length };
    }
    const text = page.getByText(name, { exact });
    for (const l of await text.all()) if (await l.isVisible()) return { locator: l, role: "text", count: 1 };
    throw new Error(`Nothing visible named “${name}”. Run \`see\` to list what's on screen.`);
  }
  async function field(label) {
    for (const l of [page.getByLabel(label, { exact: false }), page.getByPlaceholder(label), page.getByRole("textbox", { name: label }), page.getByRole("spinbutton", { name: label }), page.getByRole("combobox", { name: label })])
      for (const x of await l.all()) if (await x.isVisible()) return x;
    throw new Error(`No visible field labeled “${label}”. Run \`see\` to list what's on screen.`);
  }
  async function heading() {
    const h = await page.locator("main h1, main h2, h1").first().textContent().catch(() => null);
    return h ? `Showing: ${h.trim().slice(0, 80)}` : "";
  }

  const commands = {
    async go([name]) {
      const pageName = PAGES.find((p) => p.toLowerCase() === String(name).toLowerCase());
      if (!pageName) throw new Error(`Pages: ${PAGES.join(", ")}`);
      await page.getByRole("button", { name: pageName, exact: true }).first().click();
      return `On ${pageName}. ${await heading()}`;
    },
    async click([name], flags) {
      const found = await find(name, { exact: !!flags.exact, nth: Number(flags.nth ?? 0) });
      await found.locator.click({ timeout: 5000 });
      return `Clicked ${found.role} “${name}”${found.count > 1 ? ` (1 of ${found.count}; --nth picks another)` : ""}. ${await heading()}`;
    },
    async hover([name]) {
      await (await find(name)).locator.hover();
      return `Hovering “${name}”.`;
    },
    async fill([label, text]) {
      const f = await field(label);
      await f.fill(String(text ?? ""));
      await f.press("Tab");
      return `Filled “${label}” with “${text}”.`;
    },
    async select([label, option]) {
      await (await field(label)).selectOption({ label: option });
      return `Selected “${option}” in “${label}”.`;
    },
    async check([label]) {
      await (await field(label)).click();
      return `Toggled “${label}”.`;
    },
    async press([key]) {
      await page.keyboard.press(key);
      return `Pressed ${key}.`;
    },
    async see([within]) {
      let scope = page.locator("body");
      if (within) {
        // A landmark ("main", "dialog", "navigation"), a named region or section, or anything findable.
        const landmark = ["main", "banner", "dialog", "navigation", "complementary", "contentinfo"].includes(within) ? page.getByRole(within).first() : null;
        const region = page.getByRole("region", { name: within }).or(page.getByRole("complementary", { name: within })).or(page.getByRole("dialog", { name: within })).or(page.getByRole("navigation", { name: within })).or(page.getByRole("group", { name: within })).first();
        scope = landmark && (await landmark.count()) ? landmark : (await region.count()) && (await region.isVisible()) ? region : (await find(within)).locator;
      }
      const tree = await scope.ariaSnapshot();
      return tree.length > 20000 ? `${tree.slice(0, 20000)}\n… (cut; run \`see "<section name>"\` for part of the page)` : tree;
    },
    async screenshot([file], flags) {
      const path = resolve(file ?? join(HOME, `shot-${++shots}.png`));
      mkdirSync(dirname(path), { recursive: true });
      await page.screenshot({ path, fullPage: !!flags.full });
      return `Saved ${path} (read it to see the window).`;
    },
    async wait([text], flags) {
      const l = page.getByText(text).first();
      await l.waitFor({ state: flags.gone ? "hidden" : "visible", timeout: Number(flags.timeout ?? 10) * 1000 });
      return flags.gone ? `“${text}” is gone.` : `“${text}” is showing.`;
    },
    async pick([path]) {
      state.picks.push(resolve(path));
      return `The next file dialog returns ${resolve(path)}.`;
    },
    async answer([button]) {
      state.answers.push(button);
      return `The next confirm dialog clicks “${button}”.`;
    },
    async robot([what, value]) {
      if (what === "stamp") state.robot.stamp = value ?? "";
      else if (what === "logs") state.robot.logs = value ? resolve(value) : "";
      else throw new Error("robot stamp '<build stamp JSON>' | robot logs <folder of .wpilog files> (empty: no robot)");
      return what === "stamp" ? (value ? "The fake robot reports that build stamp." : "No robot connected.") : value ? `The fake robot has the logs in ${resolve(value)}.` : "No robot connected.";
    },
    async calls() {
      return JSON.stringify({ deploys: state.robot.deploys, opened: state.opened, merges: state.merges, mainUpdates: state.mainUpdates, teamLibrary: state.team.map((l) => l.name) }, null, 2);
    },
    async reload() {
      await page.reload();
      return `Reloaded. ${await heading()}`;
    },
    async info() {
      return `App ${url} · robot repo ${repo} · project ${project}`;
    },
  };

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { cmd, args = [], flags = {} } = JSON.parse(body || "{}");
    let out,
      ok = true;
    try {
      if (cmd === "stop") {
        res.end(JSON.stringify({ ok: true, out: "Stopped." }));
        await browser.close();
        vite.kill();
        rmSync(STATE, { force: true });
        process.exit(0);
      }
      if (!commands[cmd]) throw new Error(`Unknown command ${cmd}. Commands: ${Object.keys(commands).join(", ")}, stop`);
      out = await commands[cmd](args, flags);
      await page.waitForTimeout(150); // let effects and errors land
    } catch (e) {
      ok = false;
      out = String(e?.message ?? e).split("\n")[0];
    }
    res.end(JSON.stringify({ ok, out, errors: errors.splice(0) }));
  });
  server.listen(0, "127.0.0.1", () => {
    writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: server.address().port, url, repo, project }));
  });
  const shutdown = () => {
    vite.kill();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ---- The command line. ----

function parse(argv) {
  const args = [],
    flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      flags[key.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = next && !next.startsWith("--") && ["repo", "project", "robot-logs", "nth", "timeout", "port"].includes(key) ? (i++, next) : true;
    } else args.push(argv[i]);
  }
  return { args, flags };
}

async function send(cmd, args, flags) {
  const s = readState();
  if (!s || !alive(s.pid)) throw new Error("The app isn't running. Start it: node scripts/app.mjs start");
  const res = await fetch(`http://127.0.0.1:${s.port}/`, { method: "POST", body: JSON.stringify({ cmd, args, flags }) });
  return res.json();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { args, flags } = parse(rest);
  if (cmd === "__daemon") return daemon(JSON.parse(args[0]));
  if (!cmd || cmd === "help") {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    return;
  }
  if (cmd === "start") {
    const s = readState();
    if (s && alive(s.pid)) {
      console.log(`Already running: ${s.url} · robot repo ${s.repo}. Stop it first to start another.`);
      return;
    }
    mkdirSync(HOME, { recursive: true });
    rmSync(STATE, { force: true });
    const options = { repo: flags.repo, project: flags.project, robotLogs: flags.robotLogs, port: Number(flags.port ?? 5199) };
    const log = openSync(join(HOME, "driver.log"), "w");
    spawn(process.execPath, [fileURLToPath(import.meta.url), "__daemon", JSON.stringify(options)], { detached: true, stdio: ["ignore", log, log] }).unref();
    for (let i = 0; i < 150 && !readState(); i++) await new Promise((r) => setTimeout(r, 200));
    const started = readState();
    if (!started) throw new Error(`The app didn't start. See ${join(HOME, "driver.log")}.`);
    console.log(`Running ${started.url} · robot repo ${started.repo} · project ${started.project}`);
    return;
  }
  const reply = await send(cmd, args, flags);
  console.log(reply.out);
  for (const e of reply.errors ?? []) console.log(`! ${e}`);
  process.exitCode = reply.ok && !(reply.errors ?? []).length ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
