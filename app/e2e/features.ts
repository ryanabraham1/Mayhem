// The feature map: what the app does, how a person reaches it, and the browser test that proves it
// works. When you add or change a feature, add or update its row and the test it names;
// app/tests/feature-map.test.ts fails when a row points at a test that doesn't exist or a test
// isn't on the map. A row without a test says so in `gap` (what a test would need), so missing
// coverage is listed instead of hidden. Reach a feature yourself with scripts/app.mjs.

export interface Feature {
  page: "Overview" | "Changes" | "Autonomous" | "State machines" | "Simulation" | "Logs" | "Robot" | "Settings" | "Everywhere";
  feature: string;
  /** How a person gets there (scripts/app.mjs steps). */
  reach: string;
  /** The browser test that proves it: "<spec file>: <test title>" (titles as written in the spec). */
  proof?: string[];
  /** No browser test yet: what one would need. */
  gap?: string;
}

export const FEATURES: Feature[] = [
  // Everywhere
  { page: "Everywhere", feature: "Every page survives random clicks, typing and keys: no crash, no sideways scroll, every control named", reach: "any page", proof: ["ui-properties.spec.ts: UI properties hold on a random walk (seed ${seed})"] },
  { page: "Everywhere", feature: "Offline setup kept across all pages and both themes", reach: "go each page; Switch to dark mode", proof: ["suite.spec.ts: simulates state inputs and keeps offline setup across all pages and themes"] },
  { page: "Everywhere", feature: "Opening a project file from outside the app switches to it and links it", reach: "open a .mayhem.json with Mayhem", proof: ["live-reload.spec.ts: opening a file from outside the app switches to it, links it and does not duplicate it"] },

  // Overview
  { page: "Overview", feature: "How the robot works: a plain description of each part", reach: "go Overview", proof: ["explainer.spec.ts: explains each part of the robot"] },

  // Changes
  { page: "Changes", feature: "Review a change by behavior and edit a CAN ID into the robot code", reach: "go Changes; pick versions", proof: ["changes.spec.ts: reviews an agent's change and edits a CAN ID into the robot code"] },
  { page: "Changes", feature: "An agent's branch: what it does, its recorded sim proof, followed to main, the robot and a log", reach: "go Changes; click the branch", proof: ["review.spec.ts: an agent's branch is reviewed by what it does, with its recorded sim proof, and followed to main, the robot and a log"] },
  { page: "Changes", feature: "3D before/after replay of an auto", reach: "go Changes; Sim proof; an auto; 3D", proof: ["replay3d.spec.ts: replays an auto before and after in 3D", "replay-frames.spec.ts: renders a 3D before/after replay frame by frame", "replay-video.spec.ts: records a 3D before/after replay video"] },
  { page: "Changes", feature: "Merge a reviewed pull request from the app", reach: "go Changes; a branch with a PR; Merge…", gap: "Needs a faked PR in the bridge (state.prs) and a test that merges and checks bridge.merges." },

  // Autonomous
  { page: "Autonomous", feature: "Author an auto, preview it, export it and reopen it", reach: "go Autonomous", proof: ["suite.spec.ts: authors an auto, previews it, exports it and reopens it in a new browser"] },
  { page: "Autonomous", feature: "Draw a route freehand into pass-throughs and a pose", reach: "go Autonomous; draw", proof: ["draw-path.spec.ts: draws a route freehand and turns it into pass-throughs and a pose"] },
  { page: "Autonomous", feature: "Pose controls and generated visual constraints", reach: "go Autonomous; a step", proof: ["constraints.spec.ts: keeps pose controls compact and provides generated visual constraints"] },
  { page: "Autonomous", feature: "Focus one leg of a route", reach: "go Autonomous; a leg", proof: ["legs.spec.ts: focuses one leg, ghosts the rest and fans out stacked goals"] },
  { page: "Autonomous", feature: "Path playback: play, pause, scrub", reach: "go Autonomous; play", proof: ["path-playback.spec.ts: animates between fixed samples, pauses, scrubs and resumes without jumping"] },
  { page: "Autonomous", feature: "Trackpad zoom and pan on the field", reach: "go Autonomous; pinch", proof: ["trackpad.spec.ts: pinch zooms the field around the cursor and two-finger scroll pans it"] },

  // State machines
  { page: "State machines", feature: "Readable edge labels and an inspectable condition", reach: "go State machines; a machine", proof: ["edge-labels.spec.ts: state-machine edges get readable, distinct labels and an inspectable condition", "edge-labels.spec.ts: long state names and source paths stay readable on state cards", "edge-labels.spec.ts: inspector exits wrap as text in a narrow window, with the target below the condition"] },
  { page: "State machines", feature: "Input categories and where derived inputs come from", reach: "go State machines; a machine; inputs", proof: ["edge-labels.spec.ts: input categories show as glyphs, group the inputs, and explain transitions", "edge-labels.spec.ts: an input derived from another machine's input names that machine and its source"] },
  { page: "State machines", feature: "Priority supervisors as a decision ladder", reach: "go State machines; a priority machine", proof: ["priority-ladder.spec.ts: a priority-select supervisor reads as a decision ladder in plain words", "edge-labels.spec.ts: a priority supervisor (every state to every state) reads as a ladder, with wires on demand"] },
  { page: "State machines", feature: "Graph layout: no overlapping labels, fits the window", reach: "go State machines", proof: ["state-graph-layout.spec.ts: robot state machines lay out with no overlapping or hidden edge labels", "state-graph-layout.spec.ts: condition chips wrap inside their cards in a narrow inspector, for every state of the robot's machines", "state-graph-layout.spec.ts: the graph gets the room: details hidden, list collapsed, one tag per state, whole graph in view"] },
  { page: "State machines", feature: "Autos as graphs with collapsed drive paths", reach: "go State machines; an autonomous routine", proof: ["auto-paths.spec.ts: long pose-chain autos show as a few cards that fit the window, and expand on click"] },
  { page: "State machines", feature: "Trackpad zoom and pan on the graph", reach: "go State machines; pinch", proof: ["trackpad.spec.ts: pinch zooms the state graph around the cursor and two-finger scroll pans it"] },

  // Simulation
  { page: "Simulation", feature: "Simulate a machine by setting its inputs", reach: "go Simulation", proof: ["suite.spec.ts: simulates state inputs and keeps offline setup across all pages and themes"] },

  // Logs
  { page: "Logs", feature: "Import a WPILOG, keep it, replay it", reach: "go Logs; Import log", proof: ["suite.spec.ts: imports WPILOG through its worker, persists it and replays it"] },
  { page: "Logs", feature: "Pull logs off the robot, find problems, share with the team cloud, open in Finder/AdvantageScope", reach: "go Robot; Log collection; List robot logs", proof: ["logs-library.spec.ts: pulls a log off the robot into the library, finds its problems, shares it with the team and reveals it"] },
  { page: "Logs", feature: "Signal-mapping editor and estimated current labels (kept in sync with 3256-Tools)", reach: "go Logs; a log; Power / Signals", gap: "A test that edits a mapping, reloads and sees it kept under robot-log-mapping:<log id>, and checks the estimated labels." },

  // Robot
  { page: "Robot", feature: "What's on the robot, how it differs from main, put main back", reach: "go Robot", proof: ["robot-now.spec.ts: shows what's on the robot, how it differs from main, and puts main back"] },
  { page: "Robot", feature: "Values: every value by kind and part, edited in place", reach: "go Robot; Values", proof: ["robot-now.spec.ts: Robot → Values lists every value by kind and part, and edits it in place"] },

  // Settings
  { page: "Settings", feature: "Link the project file: reload on disk changes, keep mine, ask on conflicts", reach: "Settings; Open project file", proof: ["live-reload.spec.ts: the linked project reloads when the file changes on disk, keeping the selection", "live-reload.spec.ts: keep mine writes this copy over the changed file", "live-reload.spec.ts: a disk change while this copy has unsaved edits asks instead of overwriting either"] },
  { page: "Settings", feature: "Choose the robot code folder", reach: "Settings; robot code folder", proof: ["live-reload.spec.ts: choosing the robot code folder opens that robot's own project, linked to its file"] },
  { page: "Settings", feature: "Agents: MCP configuration to copy", reach: "Settings; Agents and the project file", proof: ["ui-properties.spec.ts: UI properties hold on a random walk (seed ${seed})"], gap: "Only the random walk clicks it; no test checks what is copied." },
];

/** Specs that are tools (screenshots, audits), not proofs of a feature. */
export const TOOL_SPECS = ["audit.spec.ts", "docs-shots.spec.ts"];
